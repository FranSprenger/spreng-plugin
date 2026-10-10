// Set SPRENG_RECORD_SCHEMA to the app's _shared/studio-vault/record-schema.ts to also exercise
// the real save_record validator. Local preservation checks run without an app checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { read } from './helpers.mjs';
import { transcribeDir } from '../plugins/spreng-research/scripts/transcribe.mjs';
import { sourceResult, main as adLibrary } from '../plugins/spreng-research/scripts/ad-library.mjs';
import { main as collect } from '../plugins/spreng-research/scripts/collect.mjs';

const schema = process.env.SPRENG_RECORD_SCHEMA
  ? await import(pathToFileURL(path.resolve(process.env.SPRENG_RECORD_SCHEMA)).href) : null;
const noSleep = async () => {};
const response = (body) => ({ ok: true, status: 200, text: async () => body });

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-handoff-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function accepted(t, collected) {
  await t.test('save_record accepts the documented source/document/quote handoff', { skip: !schema && 'set SPRENG_RECORD_SCHEMA for app contract' }, () => {
    const { documents = [], quotes = [], competitors = [], ...source } = collected;
    // Emulate the host's documented split-record handoff. One 100,000-unit chunk per record
    // fits both the served document limit and JSON byte cap, including multibyte text.
    const chunks = documents.flatMap((doc) => {
      const parts = [];
      for (let start = 0; start < doc.text.length;) {
        let end = Math.min(start + 100000, doc.text.length);
        if (/[\uD800-\uDBFF]/.test(doc.text[end - 1])) end--;
        parts.push({ ...doc, text: doc.text.slice(start, end), sourceId: source.id });
        start = end;
      }
      assert.equal(parts.map((part) => part.text).join(''), doc.text);
      return parts;
    });
    const total = Math.max(1, chunks.length);
    for (let index = 1; index <= total; index++) {
      const payload = JSON.parse(JSON.stringify({
        schemaVersion: '1', sources: [source],
        documents: chunks[index - 1] ? [chunks[index - 1]] : [],
        quotes: index === 1 ? quotes.map((quote) => ({ ...quote, sourceId: source.id })) : [],
        competitors: index === 1 ? competitors : [],
        ...(total > 1 ? { part: { group: 'collector-handoff', index, total } } : {}),
      }));
      assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= schema.MAX_PAYLOAD_BYTES);
      const validated = schema.validateRecordPayload('research', payload);
      assert.deepEqual(validated.unknownFields, []);
      assert.equal(validated.sources[source.status], 1);
      assert.deepEqual(validated.part, payload.part ?? null);
    }
  });
}

for (const [name, transcript] of [
  ['terminal sentinel beyond 20000 characters', 'x'.repeat(20000) + '終わり🙂TAIL'],
  ['Unicode transcript requiring split records', ('漢🙂\\"'.repeat(60000)) + '終わり🙂TAIL'],
]) {
  test(`R7-ASTRA2-01: preserves ${name}`, async (t) => {
    const dir = await directory(t);
    await fs.writeFile(path.join(dir, 'meta-ads.json'), JSON.stringify({ id: 'meta-ads', kind: 'ad_library', status: 'ok' }));
    await fs.writeFile(path.join(dir, 'meta-ads-raw.json'), JSON.stringify([
      { id: '11', page: 'Example Brand', saved: [{ kind: 'video', file: path.join(dir, '11.mp4') }] },
    ]));
    const receipt = await transcribeDir(dir, {
      tools: { whisper: 'whisper-cli', ffmpeg: 'ffmpeg', model: '/synthetic-model.bin', missing: [] }, tmp: dir,
      run: async (cmd, args) => {
        if (cmd === 'whisper-cli') await fs.writeFile(`${args[args.indexOf('-of') + 1]}.txt`, transcript);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const collected = JSON.parse(await fs.readFile(path.join(dir, 'meta-ads.json'), 'utf8'));
    assert.deepEqual(receipt, { transcribed: 1, failed: 0 });
    assert.equal(collected.documents[0].kind, 'transcript');
    assert.ok(collected.documents[0].text === transcript, `preserved ${collected.documents[0].text.length} of ${transcript.length} units`);
    assert.equal(collected.documents[0].url, 'https://www.facebook.com/ads/library/?id=11');
    if (name.includes('split')) {
      assert.ok(transcript.length > 200000);
      assert.ok(Buffer.byteLength(JSON.stringify(collected)) > 512 * 1024);
    }
    await accepted(t, collected);
  });
}

function assertExcerpt(collected, original, index) {
  const quote = collected.quotes[index];
  const document = collected.documents?.[index];
  assert.ok(document?.text === original, `full text of item ${index} retained in documents`);
  assert.equal(document.kind, 'other');
  assert.equal(document.url, quote.url);
  assert.ok(quote.text.length <= 4000);
  assert.ok(original.startsWith(quote.text));
  assert.ok(quote.text.isWellFormed(), 'excerpt does not split a Unicode surrogate pair');
  assert.ok(quote.context.endsWith(`excerpt: first ${quote.text.length} of ${original.length} UTF-16 code units; full text in document "${document.title}"`));
  assert.ok(quote.context.length <= 1000);
}

test('R7-ASTRA2-01: Reddit keeps long posts and comments with honest excerpts, including failed-thread fallback', async (t) => {
  const long = 'x'.repeat(3999) + '🙂漢'.repeat(800) + 'REDDIT-TAIL';
  const url = 'https://www.reddit.com/r/example/comments/1/post/';
  const entry = (title, text, link = url) => `<entry><title>${title}</title><link href="${link}"/><author><name>reader</name></author><content type="html">${text}</content></entry>`;
  for (const failedThread of [false, true]) {
    const out = await directory(t);
    const result = await collect(['reddit', '--query', 'example', '--out', out, '--threads', '1'], {
      pace: 0, sleep: noSleep,
      fetch: async (u) => u.includes('search.rss') ? response(`<feed>${entry('Post', long)}</feed>`)
        : failedThread ? { ok: false, status: 403 }
          : response(`<feed>${entry('Post', long)}${entry('', long, `${url}c1/`)}</feed>`),
    });
    const collected = JSON.parse(await fs.readFile(path.join(out, 'reddit.json'), 'utf8'));
    assert.equal(result.status, 'ok');
    assertExcerpt(collected, `Post: ${long}`, 0);
    if (!failedThread) assertExcerpt(collected, long, 1);
    await accepted(t, collected);
  }
});

test('R7-ASTRA2-01: YouTube keeps full long comments for both response formats with honest Unicode excerpts', async (t) => {
  const long = 'x'.repeat(3999) + '🙂漢'.repeat(800) + 'YOUTUBE-TAIL';
  for (const comment of [
    { commentEntityPayload: { properties: { content: { content: long } } } },
    { commentRenderer: { contentText: { runs: [{ text: long }] } } },
  ]) {
    const out = await directory(t);
    const result = await collect(['youtube', '--query', 'example', '--out', out, '--videos', '1'], {
      pace: 0, sleep: noSleep,
      fetch: async (url) => {
        if (url.includes('/results?')) return response(`ytInitialData = ${JSON.stringify({ videoRenderer: { videoId: 'v1', title: { runs: [{ text: 'Title'.repeat(250) }] } } })};`);
        if (url.includes('/watch?')) return response('"INNERTUBE_CLIENT_VERSION":"test"; ytInitialData = {"itemSectionRenderer":{"sectionIdentifier":"comment-item-section","token":"continuation"}};');
        assert.ok(url.includes('/youtubei/v1/next'));
        return { ok: true, json: async () => comment };
      },
    });
    const collected = JSON.parse(await fs.readFile(path.join(out, 'youtube-comments.json'), 'utf8'));
    assert.equal(result.status, 'ok');
    assertExcerpt(collected, long, 0);
    await accepted(t, collected);
  }
});

test('R7-ASTRA2-01: collector guidance preserves documents and orders split records using the served schema', () => {
  const skill = read('plugins/spreng-research/skills/research-collectors/SKILL.md');
  assert.match(skill, /full posts and comments.*`documents\[\]`/s);
  assert.match(skill, /excerpts.*`quotes\[\]`/s);
  assert.match(skill, /split.*`part\.group`.*`part\.index`.*`part\.total`/s);
  assert.match(skill, /sourceId.*URL.*order/s);
});

test('R7-ASTRA2-02: Meta success, empty and blocked-page failures use an accepted source kind', async (t) => {
  const out = await directory(t);
  const results = [
    sourceResult([{ id: '11', page: 'Example Brand', pageId: '1001', body: 'Example ad.', start: '2026-10-10' }]),
    sourceResult([]),
    await adLibrary(['fetch', '--page-id', '1001', '--out', out], {
      fetchPage: async () => { throw new Error('HTTP 403: blocked page'); },
    }),
  ];
  assert.deepEqual(results.map((result) => result.status), ['ok', 'failed', 'failed']);
  assert.match(results[2].reason, /403/);
  for (const collected of results) {
    // Exercise the real validator before checking the expected producer vocabulary.
    await accepted(t, collected);
    assert.equal(collected.kind, 'ad_library');
  }
});
