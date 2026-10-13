// reddit.mjs: Reddit posts and comments through Reddit's public RSS feeds, logged out, free.
// Browser connectors and built-in browsers are alternatives when available. Reddit answers
// "too many requests" when feeds are read faster than about one a minute, so reads are paced and a 429 gets
// one slower retry, no more. Returns one source result for research.mjs. A network error on the search feed throws
// (research.mjs records it as failed); one on a thread is recorded in the reason and the other threads are kept.

import { addQuote } from './quote.mjs';

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const clean = (s) => decode(decode(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Atom entries of a Reddit RSS feed as { title, link, author, date, text }. */
export function entries(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: (e.match(/<id>([^<]+)<\/id>/) || [, ''])[1],
    title: clean((e.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]),
    link: (e.match(/<link href="([^"]+)"/) || [, ''])[1],
    author: clean((e.match(/<author>\s*<name>([\s\S]*?)<\/name>/) || [, ''])[1]),
    date: (e.match(/<updated>([^<]+)<\/updated>/) || [, ''])[1],
    text: clean((e.match(/<content type="html">([\s\S]*?)<\/content>/) || [, ''])[1]),
  }));
}

/**
 * Search Reddit for `query`, then read the comment feeds of the first `threads` posts.
 * deps: { fetch, sleep } (injected by tests); pace is the wait between feed reads in ms.
 */
export async function reddit({ query, threads = 3, pace = 60000 }, { fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), checkpoint = async () => {} } = {}) {
  const result = { id: 'reddit', label: 'Reddit (public RSS)', kind: 'social', status: 'ok', retrievedAt: new Date().toISOString(), quotes: [] };
  if (!query) return { ...result, status: 'skipped', reason: 'no search words given' };
  const read = async (url) => {
    let r = await fetch(url);
    if (r.status === 429) {
      await sleep(pace * 2);
      r = await fetch(url);
      if (r.status === 429) return { code: 429, error: `HTTP 429 from ${url} after one slower retry` };
    }
    if (!r.ok) return { code: r.status, error: `HTTP ${r.status} from ${url}` };
    return { list: entries(await r.text()) };
  };
  const search = await read(`https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&limit=25`);
  if (search.error) return { ...result, status: [401, 403, 429].includes(search.code) ? 'blocked' : 'failed', reason: search.error };
  const posts = search.list.filter((e) => /\/comments\//.test(e.link));
  result.url = `https://www.reddit.com/search/?q=${encodeURIComponent(query)}`;
  const quote = (e, link) => ({ platform: 'reddit', provider_item_id: e.id, author: e.author, source_created_at: e.date || undefined, captured_at: result.retrievedAt, text: [e.title, e.text].filter(Boolean).join(': '), url: link, speaker: e.author || undefined, context: e.date ? `Reddit, ${e.date}` : 'Reddit' });
  const failed = [];
  result.coverage = 'Public RSS search and selected thread feeds, not exhaustive';
  result.raw_record = { remainingThreads: posts.slice(threads).map(p => p.link) };
  for (const post of posts.slice(0, threads)) {
    await sleep(pace);
    const url = `${post.link.replace(/\/?$/, '/')}.rss`;
    // A network error on one thread is recorded like an HTTP error; what was read before it is kept.
    const thread = await read(url).catch((e) => ({ error: `${url}: ${String(e?.message || e)}` }));
    if (thread.error) { failed.push(thread.error); addQuote(result, quote(post, post.link)); await checkpoint(result); continue; }
    const [op, ...comments] = thread.list;
    addQuote(result, quote(op || post, post.link));
    for (const c of comments) if (c.text) addQuote(result, { ...quote({ ...c, title: '' }, c.link || post.link), parent_id: post.id });
    await checkpoint(result);
  }
  if (!posts.length) result.reason = 'the search feed returned no posts';
  else if (failed.length) result.reason = `${Math.min(posts.length, threads) - failed.length} of ${Math.min(posts.length, threads)} threads read; ${failed.join('; ')}`.slice(0, 500);
  return result;
}
