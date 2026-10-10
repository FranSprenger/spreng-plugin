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

// Produced by sourceResult at d139ff7, before the source-kind correction.
const legacyAds = JSON.parse(read('test/fixtures/meta-ads-legacy.json'));
const transcriptionTools = { whisper: 'whisper-cli', ffmpeg: 'ffmpeg', model: '/synthetic-model.bin', missing: [] };

async function savedVideo(dir) {
  const file = path.join(dir, '11.mp4');
  await fs.writeFile(path.join(dir, 'meta-ads-raw.json'), JSON.stringify([
    { id: '11', page: 'Example Brand', saved: [{ kind: 'video', file }] },
  ]));
  return file;
}

test('RX7-C-01: legacy Meta files validate after transcription and missing-tool handoffs', async (t) => {
  for (const missing of [false, true]) await t.test(missing ? 'missing tools' : 'transcribed video', async (t) => {
    const dir = await directory(t);
    await fs.writeFile(path.join(dir, 'meta-ads.json'), JSON.stringify(legacyAds));
    if (!missing) await savedVideo(dir);
    const transcript = 'The complete spoken ad. LEGACY-TAIL';
    const receipt = await transcribeDir(dir, {
      tools: missing ? { missing: ['whisper-cli'] } : transcriptionTools, tmp: dir,
      run: async (cmd, args) => {
        assert.equal(missing, false, 'missing-tool handoff must not start a process');
        if (cmd === 'whisper-cli') await fs.writeFile(`${args[args.indexOf('-of') + 1]}.txt`, transcript);
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const collected = JSON.parse(await fs.readFile(path.join(dir, 'meta-ads.json'), 'utf8'));
    await accepted(t, collected);
    assert.equal(collected.kind, 'ad_library');
    assert.deepEqual(collected.competitors, legacyAds.competitors);
    assert.equal(receipt.transcribed, missing ? 0 : 1);
    if (missing) assert.match(collected.reason, /video transcripts skipped/);
    else assert.equal(collected.documents[0].text, transcript);
  });
});

function assertDocumentExcerpt(collected, original, excerpt, limit, url) {
  const document = collected.documents?.find((doc) => doc.text === original);
  assert.ok(document, 'the complete original value is reachable in documents');
  assert.equal(document.kind, 'other');
  assert.equal(document.url, url);
  assert.ok(excerpt.length <= limit, 'bounded field fits the real validator');
  assert.ok(excerpt.isWellFormed(), 'excerpt does not split a Unicode surrogate pair');
  assert.match(excerpt, /excerpt.*omitted.*full text in document/is);
  assert.ok(excerpt.includes(`"${document.title}"`), 'excerpt identifies the full document');
  const prefix = excerpt.slice(0, excerpt.indexOf('\n[excerpt'));
  assert.ok(prefix.length > 0 && original.startsWith(prefix), 'excerpt preserves the original prefix');
}

test('RX7-C-02: long Meta ad bodies retain full documents and labeled validator-safe excerpts', async (t) => {
  for (const [name, body] of [
    ['at limit', 'a'.repeat(8000)],
    ['review reproduction', 'a'.repeat(8000) + 'BODY-TAIL'],
    ['Unicode boundary', 'a' + '🙂'.repeat(4000)],
    ['split document', '漢🙂'.repeat(100000) + 'BODY-TAIL'],
  ]) await t.test(name, async (t) => {
    const out = await directory(t);
    const result = await adLibrary(['fetch', '--page-id', '1001', '--out', out], {
      fetchPage: async () => [JSON.stringify({ ad_archive_id: '11', page_id: '1001', snapshot: {
        page_name: 'Example Brand', title: 'Headline', body: { text: body }, images: [], videos: [],
      } })], sleep: noSleep,
    });
    const collected = JSON.parse(await fs.readFile(path.join(out, 'meta-ads.json'), 'utf8'));
    assert.deepEqual(collected, JSON.parse(JSON.stringify(result)));
    assert.equal(collected.status, 'ok');
    await accepted(t, collected);
    const ad = collected.competitors[0].ads[0];
    assert.equal(ad.headline, 'Headline');
    if (body.length <= 8000) {
      assert.equal(ad.text, body);
      assert.equal(collected.documents, undefined);
    } else assertDocumentExcerpt(collected, body, ad.text, 8000, ad.url);
    const raw = JSON.parse(await fs.readFile(path.join(out, 'meta-ads-raw.json'), 'utf8'));
    assert.ok(raw[0].body === body, 'raw ad text also stays complete');
  });
});

test('RX7-C-03: failed Meta fetches preserve complete diagnostics behind labeled bounded reasons', async (t) => {
  for (const length of [1000, 1001, 1068]) await t.test(`${length} units`, async (t) => {
    const prefix = 'Page fetch: ', tail = 'DIAGNOSTIC-TAIL!';
    const diagnostic = prefix + 'x'.repeat(length - prefix.length - tail.length) + tail;
    assert.equal(diagnostic.length, length);
    const out = await directory(t);
    const result = await adLibrary(['fetch', '--page-id', '1001', '--out', out], {
      fetchPage: async () => { throw new Error(diagnostic); },
    });
    const collected = JSON.parse(await fs.readFile(path.join(out, 'meta-ads.json'), 'utf8'));
    assert.deepEqual(collected, JSON.parse(JSON.stringify(result)));
    assert.equal(collected.status, 'failed');
    await accepted(t, collected);
    if (length <= 1000) {
      assert.equal(collected.reason, diagnostic);
      assert.equal(collected.documents, undefined);
    } else assertDocumentExcerpt(collected, diagnostic, collected.reason, 1000, collected.url);
  });
});

test('RX7-C-03: Meta success and empty results preserve all diagnostic notes', async (t) => {
  const notes = ['a' + '🙂'.repeat(550), 'SECOND-DIAGNOSTIC-TAIL'];
  for (const ads of [[], [{ id: '11', page: 'Example Brand', body: 'Ad text' }]]) await t.test(ads.length ? 'success' : 'empty', async (t) => {
    const collected = sourceResult(ads, { notes });
    const full = ads.length ? [sourceResult(ads).reason, ...notes].join('; ') : notes.join('; ');
    await accepted(t, collected);
    assertDocumentExcerpt(collected, full, collected.reason, 1000, undefined);
    assert.equal(collected.status, ads.length ? 'ok' : 'failed');
  });
});

test('RX7-C-03: transcription failures and missing tools preserve full appended diagnostics', async (t) => {
  for (const failure of ['missing', 'ffmpeg', 'whisper-cli']) await t.test(failure, async (t) => {
    const dir = await directory(t);
    const file = await savedVideo(dir);
    const input = { ...legacyAds, kind: 'ad_library', reason: 'Original collection note.' };
    await fs.writeFile(path.join(dir, 'meta-ads.json'), JSON.stringify(input));
    const diagnostic = 'Failure: ' + 'x'.repeat(1068) + 'DIAGNOSTIC-TAIL';
    const receipt = await transcribeDir(dir, {
      tools: failure === 'missing' ? { missing: [diagnostic] } : transcriptionTools, tmp: dir,
      run: async (cmd) => ({ code: cmd === failure ? 1 : 0, stdout: '', stderr: diagnostic }),
    });
    assert.equal(receipt.transcribed, 0);
    const collected = JSON.parse(await fs.readFile(path.join(dir, 'meta-ads.json'), 'utf8'));
    const detail = failure === 'missing' ? `video transcripts skipped: this computer has no ${diagnostic}`
      : failure === 'ffmpeg' ? `ffmpeg could not read ${file}: ${diagnostic}` : `whisper-cli failed on ${file}: ${diagnostic}`;
    await accepted(t, collected);
    assertDocumentExcerpt(collected, `${input.reason}; ${detail}`, collected.reason, 1000, input.url);
    assert.equal(collected.status, input.status);
    assert.deepEqual(collected.competitors, input.competitors);
  });
});

test('RX7-C-03: the save handoff includes full ad text and diagnostic documents', () => {
  const skill = read('plugins/spreng-research/skills/research-collectors/SKILL.md');
  assert.match(skill, /full .*ad text.*`documents\[\]`/s);
  assert.match(skill, /full diagnostics.*`documents\[\]`/s);
});

test('all social collector outcome handoffs validate against save_record', async (t) => {
  for (const source of ['reddit', 'youtube']) {
    for (const outcome of ['skipped', 'empty', 'blocked', 'failed', 'exception']) await t.test(`${source}: ${outcome}`, async (t) => {
      const out = await directory(t);
      const argv = [source, '--out', out, ...(outcome === 'skipped' ? [] : ['--query', 'example'])];
      const result = await collect(argv, {
        pace: 0, sleep: noSleep,
        fetch: async () => {
          if (outcome === 'skipped') assert.fail('skipped source must not fetch');
          if (outcome === 'exception') throw new Error('Offline test: network unavailable');
          if (outcome === 'empty') return response(source === 'reddit' ? '<feed></feed>' : 'ytInitialData = {};');
          return { ok: false, status: outcome === 'blocked' ? 403 : 500 };
        },
      });
      const collected = JSON.parse(await fs.readFile(path.join(out, `${result.id}.json`), 'utf8'));
      const expected = outcome === 'empty' ? (source === 'reddit' ? 'ok' : 'failed') : outcome === 'exception' ? 'failed' : outcome;
      assert.equal(collected.status, expected);
      await accepted(t, collected);
    });
  }
});
