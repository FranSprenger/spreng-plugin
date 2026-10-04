// youtube-comments.mjs: top comments under YouTube videos found by a search, logged out, free, no API key.
// Reads the search page and each watch page the way a browser does, then the first page of comments through
// the page's own comment request. Returns one source result for research.mjs. A network error on the search page throws
// (research.mjs records it as failed); one on a video is recorded in the reason and the other videos are kept.

/** The JSON object assigned to `name` in a YouTube page (ytInitialData and similar), or null. */
export function pageJson(html, name) {
  const at = html.indexOf(`${name} = `);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  let depth = 0;
  let inString = false;
  for (let k = start; k < html.length; k++) {
    const ch = html[k];
    if (inString) { if (ch === '\\') k++; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { try { return JSON.parse(html.slice(start, k + 1)); } catch { return null; } }
  }
  return null;
}

/** Every value stored under `key` anywhere inside `o`. */
export function findAll(o, key, acc = []) {
  if (o && typeof o === 'object') {
    if (key in o) acc.push(o[key]);
    for (const k of Object.keys(o)) findAll(o[k], key, acc);
  }
  return acc;
}

const views = (s) => Number(String(s || '').replace(/[^\d]/g, '')) || 0;

export async function youtubeComments({ query, videos = 2, pace = 3000 }, { fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const result = { id: 'youtube-comments', label: 'YouTube comments', kind: 'social', status: 'ok', retrievedAt: new Date().toISOString(), quotes: [] };
  if (!query) return { ...result, status: 'skipped', reason: 'no search words given' };
  const headers = { 'accept-language': 'en' };
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const r = await fetch(searchUrl, { headers });
  if (!r.ok) return { ...result, status: [401, 403, 429].includes(r.status) ? 'blocked' : 'failed', reason: `HTTP ${r.status} from the YouTube search page` };
  if (/consent\.youtube\.com/.test(r.url || '')) return { ...result, status: 'blocked', reason: 'YouTube showed its consent page instead of results' };
  const found = findAll(pageJson(await r.text(), 'ytInitialData'), 'videoRenderer')
    .map((v) => ({ id: v.videoId, title: v.title?.runs?.[0]?.text || '', views: views(v.viewCountText?.simpleText) }))
    .filter((v) => v.id);
  if (!found.length) return { ...result, status: 'failed', reason: 'no videos could be read from the YouTube search page' };
  result.url = searchUrl;
  const notes = [];
  async function videoComments(video, url) {
    await sleep(pace);
    const w = await fetch(url, { headers });
    if (!w.ok) { notes.push(`HTTP ${w.status} from ${url}`); return; }
    const html = await w.text();
    const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
    const clientVersion = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1];
    const initial = pageJson(html, 'ytInitialData');
    const section = findAll(initial, 'itemSectionRenderer').find((s) => s.sectionIdentifier === 'comment-item-section');
    const token = section ? findAll(section, 'token')[0] : undefined;
    if (!token || !clientVersion) { notes.push(`no comment section on ${url}`); return; }
    await sleep(pace);
    const c = await fetch(`https://www.youtube.com/youtubei/v1/next${key ? `?key=${key}` : ''}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'en' } }, continuation: token }),
    });
    if (!c.ok) { notes.push(`HTTP ${c.status} reading comments of ${url}`); return; }
    let body;
    try { body = await c.json(); } catch { notes.push(`unreadable comment reply for ${url}`); return; }
    let texts = findAll(body, 'commentEntityPayload').map((p) => p?.properties?.content?.content).filter(Boolean);
    if (!texts.length) texts = findAll(body, 'commentRenderer').map((p) => (p?.contentText?.runs || []).map((x) => x.text).join('')).filter(Boolean);
    for (const text of texts) result.quotes.push({ text: text.slice(0, 4000), url, context: `YouTube comment on "${video.title}"`.slice(0, 1000) });
    if (!texts.length) notes.push(`no comments returned for ${url}`);
  }
  for (const video of found.sort((a, b) => b.views - a.views).slice(0, videos)) {
    const url = `https://www.youtube.com/watch?v=${video.id}`;
    // A network error on one video is recorded in the reason; the comments already read are kept.
    try { await videoComments(video, url); } catch (e) { notes.push(`${url}: ${String(e?.message || e)}`); }
  }
  if (!result.quotes.length) return { ...result, status: 'failed', reason: notes.join('; ').slice(0, 1000) || 'no comments returned' };
  if (notes.length) result.reason = notes.join('; ').slice(0, 1000);
  return result;
}
