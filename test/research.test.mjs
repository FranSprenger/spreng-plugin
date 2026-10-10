// spreng-research: the Ad Library helper (parse, media saved straight away, source file shape), local
// speech-to-text, and the Reddit/YouTube runner, all with mocks. One optional real check runs whisper.cpp on
// its own sample file when this computer has it (local, free).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, read, hosts, files } from './helpers.mjs';
import { extractAds, jsonScripts, libraryUrl, linkExpiry, saveMedia, sourceResult, main as adLibrary } from '../plugins/spreng-research/scripts/ad-library.mjs';
import { findTools, transcribe, transcribeDir } from '../plugins/spreng-research/scripts/transcribe.mjs';
import { main as collect } from '../plugins/spreng-research/scripts/collect.mjs';

const OE = (0x6a1b2c3d).toString(16);
const node = (id, snapshot, extra = {}) => ({ ad_archive_id: id, page_id: '1001', start_date: 1782518400, snapshot, ...extra });
const PAGE_JSON = JSON.stringify({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { result: { data: { edges: [
  { node: { collated_results: [node('11', {
    page_name: 'Example Brand', display_format: 'DCO', body: { text: '{{product.brand}}' }, images: [], videos: [],
    cards: [{ body: 'The real card copy.', title: 'Card title', link_url: 'https://example.com/a', video_hd_url: `https://video.xx.fbcdn.net/v/a.mp4?oe=${OE}` }],
  })] } },
  { node: { collated_results: [node('12', {
    page_name: 'Example Brand', display_format: 'IMAGE', body: { text: 'Plain body.' }, title: 'Head', link_url: 'https://example.com/b',
    images: [{ original_image_url: `https://scontent.xx.fbcdn.net/i/b.jpg?oe=${OE}` }], videos: [], cards: [],
  })] } },
  { node: { collated_results: [node('11', { page_name: 'dup', body: { text: 'dup' } })] } },
] } } } }]]] });
const HTML = `<html><script type="application/json">${PAGE_JSON}</script><script>var x=1</script><script type="application/json">not json</script></html>`;
const BYTES = Buffer.from('media-bytes');
const ok = (body = BYTES, type = 'video/mp4') => ({ ok: true, status: 200, headers: { get: () => type }, arrayBuffer: async () => body, text: async () => String(body) });

test('Ad Library URL: logged-out page view or keyword search, all countries, active ads', () => {
  const u = new URL(libraryUrl({ pageId: '183869772601' }));
  assert.equal(u.origin + u.pathname, 'https://www.facebook.com/ads/library/');
  assert.equal(u.searchParams.get('view_all_page_id'), '183869772601');
  assert.equal(u.searchParams.get('country'), 'ALL');
  assert.equal(new URL(libraryUrl({ query: 'insoles' })).searchParams.get('search_type'), 'keyword_unordered');
});

test('ads are read from the embedded JSON, one per id; a template body falls back to the card copy', () => {
  const ads = extractAds(jsonScripts(HTML));
  assert.deepEqual(ads.map((a) => a.id), ['11', '12']);
  assert.equal(ads[0].body, 'The real card copy.');
  assert.equal(ads[0].title, 'Card title');
  assert.equal(ads[0].videos.length, 1);
  assert.equal(ads[1].images.length, 1);
  assert.equal(ads[0].start, '2026-06-27');
});

test("media links' expiry is read from oe", () => {
  assert.equal(linkExpiry(`https://x.fbcdn.net/v.mp4?_nc=1&oe=${OE}`), new Date(0x6a1b2c3d * 1000).toISOString());
  assert.equal(linkExpiry('https://x/y.mp4'), undefined);
});

test('media is downloaded straight away into media/, a failed file is noted and the rest kept', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adlib-'));
  const ads = extractAds(jsonScripts(HTML));
  const notes = await saveMedia(ads, dir, { fetch: async (u) => (u.includes('b.jpg') ? { ok: false, status: 403 } : ok()), sleep: async () => {} });
  assert.equal(ads[0].saved.length, 1);
  assert.equal(ads[0].saved[0].kind, 'video');
  assert.deepEqual(await fs.readFile(ads[0].saved[0].file), BYTES);
  assert.ok(ads[0].saved[0].linkExpires);
  assert.match(notes[0], /ad 12: HTTP 403/);
});

test('the source file has the research shape: competitors with ads, first-batch reason; none read = failed', () => {
  const ads = extractAds(jsonScripts(HTML));
  const r = sourceResult(ads, { url: 'https://www.facebook.com/ads/library/?q=x', retrievedAt: 't' });
  assert.equal(r.id, 'meta-ads');
  assert.equal(r.status, 'ok');
  assert.match(r.reason, /first batch only: 2 ads/);
  assert.deepEqual(Object.keys(r.competitors[0]), ['name', 'url', 'ads']);
  assert.deepEqual(r.competitors[0].ads[0], { headline: 'Card title', text: 'The real card copy.', format: 'DCO', url: 'https://www.facebook.com/ads/library/?id=11', firstSeen: '2026-06-27' });
  assert.equal(sourceResult([], { notes: ['Playwright is not installed'] }).status, 'failed');
});

test('parse mode end to end from a saved page: meta-ads.json, raw file and media written', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adlib-'));
  const html = path.join(dir, 'page.html');
  await fs.writeFile(html, HTML);
  const out = path.join(dir, 'sources');
  const r = await adLibrary(['parse', '--html', html, '--out', out], { fetch: async () => ok(), sleep: async () => {} });
  assert.equal(r.status, 'ok');
  const saved = JSON.parse(await fs.readFile(path.join(out, 'meta-ads.json'), 'utf8'));
  assert.equal(saved.competitors[0].ads.length, 2);
  assert.equal((await fs.readdir(path.join(out, 'media'))).length, 2);
});

test('fetch mode without Playwright writes a failed source with the install hint instead of stopping', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'adlib-'));
  const r = await adLibrary(['fetch', '--page-id', '1', '--out', out], { fetchPage: async () => { throw new Error('Playwright is not installed. Install it once'); } });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /Playwright is not installed/);
});

test('fetch mode never clicks "See more" (first batch only)', () => {
  const code = read('plugins/spreng-research/scripts/ad-library.mjs').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /getByText|PaginationQuery|Lihat lebih|mouse\.wheel/);
  assert.equal(code.match(/\.click\(/g).length, 1, 'the only click is declining optional cookies');
});

test('speech to text: ffmpeg then whisper-cli on this computer; transcripts land in meta-ads.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stt-'));
  const video = path.join(dir, 'media', '11-1.mp4');
  await fs.mkdir(path.dirname(video), { recursive: true });
  await fs.writeFile(video, BYTES);
  await fs.writeFile(path.join(dir, 'meta-ads.json'), JSON.stringify({ id: 'meta-ads', status: 'ok', reason: 'first batch only: 1 ads', competitors: [] }));
  await fs.writeFile(path.join(dir, 'meta-ads-raw.json'), JSON.stringify([{ id: '11', page: 'Example Brand', saved: [{ kind: 'video', file: video }] }]));
  const runs = [];
  const run = async (cmd, args) => {
    runs.push(cmd);
    if (cmd === 'whisper-cli') await fs.writeFile(`${args[args.indexOf('-of') + 1]}.txt`, ' I fill the bottle\nwith water. ');
    return { code: 0, stdout: '', stderr: '' };
  };
  const r = await transcribeDir(dir, { tools: { whisper: 'whisper-cli', ffmpeg: 'ffmpeg', model: '/m.bin', missing: [] }, run, tmp: dir });
  assert.deepEqual(runs, ['ffmpeg', 'whisper-cli']);
  assert.equal(r.transcribed, 1);
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'meta-ads.json'), 'utf8'));
  assert.deepEqual(saved.documents[0], { title: 'Ad 11 video (Example Brand)', kind: 'transcript', text: 'I fill the bottle with water.', url: 'https://www.facebook.com/ads/library/?id=11' });
});

test('speech to text missing: the source file says what is missing and nothing runs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stt-'));
  await fs.writeFile(path.join(dir, 'meta-ads.json'), JSON.stringify({ id: 'meta-ads', status: 'ok', reason: 'first batch only: 1 ads' }));
  const tools = await findTools({ PATH: '' }, dir);
  assert.equal(tools.missing.length >= 2, true);
  const r = await transcribeDir(dir, { tools });
  assert.equal(r.transcribed, 0);
  assert.match(JSON.parse(await fs.readFile(path.join(dir, 'meta-ads.json'), 'utf8')).reason, /video transcripts skipped: this computer has no whisper-cli/);
});

const SAMPLE = '/opt/homebrew/share/whisper-cpp/jfk.wav';
test('real local speech to text on whisper.cpp\'s own sample (skipped when this computer lacks it)', { skip: !existsSync(SAMPLE) }, async (t) => {
  const tools = await findTools();
  if (tools.missing.length) return t.skip(`missing ${tools.missing.join(', ')}`);
  const text = await transcribe(SAMPLE, tools);
  assert.match(text, /ask not what your country can do for you/i);
});

test('reddit runner: writes reddit.json from the public feeds (mocked), paced and logged out', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-'));
  const urls = [];
  const feed = (entries) => `<feed>${entries.map((e) => `<entry><title>${e.t}</title><link href="${e.l}"/><author><name>${e.a}</name></author><updated>2026-09-01T00:00:00Z</updated><content type="html">${e.c}</content></entry>`).join('')}</feed>`;
  const fetch = async (u) => {
    urls.push(u);
    if (u.startsWith('https://www.reddit.com/search.rss')) return { ok: true, status: 200, text: async () => feed([{ t: 'Heel pain', l: 'https://www.reddit.com/r/x/comments/1/heel/', a: 'u1', c: 'It hurts' }]) };
    return { ok: true, status: 200, text: async () => feed([{ t: 'Heel pain', l: 'https://www.reddit.com/r/x/comments/1/heel/', a: 'u1', c: 'It hurts' }, { t: 'c', l: 'https://www.reddit.com/r/x/comments/1/heel/c1/', a: 'u2', c: 'Same here' }]) };
  };
  const r = await collect(['reddit', '--query', 'heel pain', '--out', out, '--threads', '1'], { fetch, sleep: async () => {}, pace: 0 });
  assert.equal(r.status, 'ok');
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.startsWith('https://www.reddit.com/')));
  assert.equal(JSON.parse(await fs.readFile(path.join(out, 'reddit.json'), 'utf8')).quotes.length, 2);
});

test('youtube runner: a blocked search becomes a blocked source file, not a crash', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'collect-'));
  const r = await collect(['youtube', '--query', 'heel pain', '--out', out], { fetch: async () => ({ ok: false, status: 429 }), sleep: async () => {}, pace: 0 });
  assert.equal(r.status, 'blocked');
  assert.ok(existsSync(path.join(out, 'youtube-comments.json')));
});

test('README discloses every host the research scripts fetch', () => {
  const readme = read('plugins/spreng-research/README.md');
  const code = files('plugins/spreng-research/scripts').map((f) => readFileSync(path.join(ROOT, f), 'utf8')).join('\n')
    .replace(/https:\/\/docs\.kie\.ai\S*/g, '');
  for (const h of hosts(code)) {
    const base = h.split('.').slice(-2).join('.');
    assert.ok(readme.includes(h) || readme.includes(base), `README does not disclose ${h}`);
  }
});

// LOOP-99 R4-fable-04: the connector takes research only through save_record (no tool reads the collectors' files), so
// the skill names that save step and the record fields each file's content goes into, and claims no direct read.
test('the collectors skill names the save step into connector research, not a method that reads its files', () => {
  const skill = read('plugins/spreng-research/skills/research-collectors/SKILL.md');
  assert.doesNotMatch(skill, /shape the Spreng research method reads/);
  assert.match(skill, /`?save_record`?\s+with\s+kind\s+research/);
  assert.match(skill, /`?studio_get`?\s+with\s+kind\s+sop\s+and\s+slug\s+research-vault/);
  for (const field of ['sources[]', 'quotes[]', 'sourceId', 'competitors[].ads[]']) assert.ok(skill.includes(field), field);
});
