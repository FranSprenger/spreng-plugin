#!/usr/bin/env node
// ad-library.mjs: Meta Ad Library, logged out, first batch only, with the ad images and videos saved straight
// away (Meta's media links carry an `oe=` expiry, about four days). Writes one research source file
// (`meta-ads.json`, the research recipe's source shape) plus a `media/` folder.
//
//   node ad-library.mjs fetch --page-id <id> | --query "<words>" --out <research/sources dir> [--country ALL]
//       Opens https://www.facebook.com/ads/library/ in a fresh, logged-out headless browser (Playwright, which
//       the user installs; no login, no cookies kept), reads the ads Meta embeds in the first page, and stops:
//       Meta answers "Rate limit exceeded" to "See more" for logged-out visitors, so this never clicks it.
//   node ad-library.mjs parse --html <saved page.html> --out <dir>
//       The same, from a page the user's own browser saved (Claude Code desktop Browser pane, or File > Save).
//
// Fetches: www.facebook.com (the Ad Library page and what it loads) and the *.fbcdn.net media links of the ads
// it read. Nothing is sent anywhere else. Measured 2026-10-03 (charm-scanner-evidence/2026-10-03/free-routes):
// 29 ads for one brand page, 17 with video, from a page of about 1,300.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LIBRARY = 'https://www.facebook.com/ads/library/';

export function libraryUrl({ pageId, query, country = 'ALL' }) {
  const p = new URLSearchParams({ active_status: 'active', ad_type: 'all', country, is_targeted_country: 'false', media_type: 'all' });
  if (pageId) { p.set('search_type', 'page'); p.set('view_all_page_id', String(pageId)); }
  else { p.set('q', String(query || '')); p.set('search_type', 'keyword_unordered'); }
  return `${LIBRARY}?${p}`;
}

/** The text of every <script type="application/json"> block in a saved page. */
export function jsonScripts(html) {
  return [...String(html).matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

const template = (s) => /^\{\{.*\}\}$/.test(String(s || '').trim());
const isoDay = (sec) => (Number.isFinite(Number(sec)) && Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString().slice(0, 10) : undefined);

/** Every ad object (`ad_archive_id` + `snapshot`) inside the given JSON texts, one per id. */
export function extractAds(texts) {
  const ads = new Map();
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.ad_archive_id && o.snapshot && !ads.has(String(o.ad_archive_id))) {
      const s = o.snapshot;
      const cards = Array.isArray(s.cards) ? s.cards : [];
      const bodyText = s.body?.text;
      const cardBody = cards.map((c) => c.body).find((b) => b && !template(b));
      ads.set(String(o.ad_archive_id), {
        id: String(o.ad_archive_id),
        page: s.page_name || o.page_name || '',
        pageId: String(o.page_id || s.page_id || ''),
        start: isoDay(o.start_date),
        body: bodyText && !template(bodyText) ? bodyText : (cardBody || ''),
        title: s.title && !template(s.title) ? s.title : (cards.find((c) => c.title && !template(c.title))?.title || ''),
        link: s.link_url || cards[0]?.link_url || '',
        format: s.display_format || '',
        images: [...(s.images || []).map((i) => i.original_image_url || i.resized_image_url), ...cards.map((c) => c.original_image_url || c.resized_image_url)].filter(Boolean),
        videos: [...(s.videos || []).map((v) => v.video_hd_url || v.video_sd_url), ...cards.map((c) => c.video_hd_url || c.video_sd_url)].filter(Boolean),
      });
    }
    for (const k in o) walk(o[k]);
  };
  for (const t of texts) {
    try { walk(JSON.parse(t)); } catch { /* not JSON: skip */ }
  }
  return [...ads.values()];
}

/** When Meta's media link stops working: its `oe` parameter is a hex unix time. */
export function linkExpiry(url) {
  const oe = (String(url).match(/[?&]oe=([0-9A-Fa-f]{6,10})/) || [])[1];
  return oe ? new Date(parseInt(oe, 16) * 1000).toISOString() : undefined;
}

/** Download each ad's images and videos into dir/media now, before the links expire. */
export async function saveMedia(ads, dir, { fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pace = 500, perAd = 4 } = {}) {
  const mediaDir = path.join(dir, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  const notes = [];
  for (const ad of ads) {
    ad.saved = [];
    const items = [...ad.videos.map((u) => ['video', u]), ...ad.images.map((u) => ['image', u])].slice(0, perAd);
    for (const [n, [kind, url]] of items.entries()) {
      try {
        const r = await fetch(url);
        if (!r.ok) { notes.push(`${kind} of ad ${ad.id}: HTTP ${r.status}`); continue; }
        const type = r.headers?.get?.('content-type') || '';
        const ext = kind === 'video' ? '.mp4' : /png/.test(type) ? '.png' : /webp/.test(type) ? '.webp' : '.jpg';
        const file = path.join(mediaDir, `${ad.id}-${n + 1}${ext}`);
        await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
        ad.saved.push({ kind, file, linkExpires: linkExpiry(url) });
      } catch (e) {
        notes.push(`${kind} of ad ${ad.id}: ${e.message}`);
      }
      await sleep(pace);
    }
  }
  return notes;
}

/** The research source file for these ads (the recipe's `research/sources/<id>.json` shape). */
export function sourceResult(ads, { url, notes = [], retrievedAt = new Date().toISOString() } = {}) {
  const result = { id: 'meta-ads', label: 'Meta Ad Library (logged out, first batch)', kind: 'ads', status: 'ok', retrievedAt, url, competitors: [] };
  if (!ads.length) return { ...result, status: 'failed', reason: notes[0] || 'no ads could be read from the Ad Library page' };
  const byPage = new Map();
  for (const ad of ads) {
    const key = ad.pageId || ad.page;
    if (!byPage.has(key)) byPage.set(key, { name: ad.page || key, url: ad.pageId ? libraryUrl({ pageId: ad.pageId }) : url, ads: [] });
    byPage.get(key).ads.push({
      headline: ad.title || undefined,
      text: ad.body || undefined,
      format: ad.format || undefined,
      url: `${LIBRARY}?id=${ad.id}`,
      firstSeen: ad.start,
    });
  }
  result.competitors = [...byPage.values()];
  const reason = [`first batch only: ${ads.length} ads (Meta rate-limits "See more" for logged-out visitors)`, ...notes].join('; ');
  return { ...result, reason: reason.slice(0, 1000) };
}

async function loadPlaywright(env = process.env) {
  for (const spec of [env.SPRENG_PLAYWRIGHT_PATH, 'playwright', 'playwright-core'].filter(Boolean)) {
    try { return await import(spec.startsWith('/') ? pathToFileURL(path.join(spec, 'index.mjs')).href : spec); } catch { /* next */ }
  }
  return null;
}

/** Open the page logged out and return the embedded JSON texts. */
export async function fetchPage(url, { playwright } = {}) {
  const pw = playwright || await loadPlaywright();
  if (!pw?.chromium) throw new Error('Playwright is not installed. Install it once (npm install -g playwright, then npx playwright install chromium) and set SPRENG_PLAYWRIGHT_PATH to its folder, or save the Ad Library page from your browser and use: parse --html <file>');
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    // Decline optional cookies when Meta asks; nothing is accepted on the user's behalf.
    for (const name of ['Decline optional cookies', 'Only allow essential cookies']) {
      const b = page.getByRole('button', { name });
      if (await b.count()) { await b.first().click().catch(() => {}); break; }
    }
    // Meta's first answer can be a 403 that its own script clears by reloading; give it time.
    if (!(await page.evaluate(() => document.querySelectorAll('script[type="application/json"]').length))) await page.waitForTimeout(6000);
    return await page.evaluate(() => [...document.querySelectorAll('script[type="application/json"]')].map((s) => s.textContent));
  } finally {
    await browser.close();
  }
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv, deps = {}) {
  const [mode] = argv;
  const out = arg(argv, 'out');
  if (!['fetch', 'parse'].includes(mode) || !out) {
    throw new Error('usage: ad-library.mjs fetch --page-id <id> | --query "<words>" --out <dir>   or   ad-library.mjs parse --html <file> --out <dir>');
  }
  const url = mode === 'fetch' ? libraryUrl({ pageId: arg(argv, 'page-id'), query: arg(argv, 'query'), country: arg(argv, 'country') }) : arg(argv, 'url');
  let texts;
  const notes = [];
  try {
    texts = mode === 'parse' ? jsonScripts(await fs.readFile(arg(argv, 'html'), 'utf8')) : await (deps.fetchPage || fetchPage)(url, deps);
  } catch (e) {
    texts = [];
    notes.push(e.message);
  }
  const ads = extractAds(texts).slice(0, 30);
  await fs.mkdir(out, { recursive: true });
  if (ads.length) notes.push(...await saveMedia(ads, out, deps));
  const result = sourceResult(ads, { url, notes });
  await fs.writeFile(path.join(out, 'meta-ads.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(out, 'meta-ads-raw.json'), JSON.stringify(ads, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then(
    (r) => { console.log(`${r.status}: ${r.competitors?.reduce((n, c) => n + c.ads.length, 0) || 0} ads. ${r.reason || ''}`); },
    (e) => { console.error(e.message); process.exit(2); },
  );
}
