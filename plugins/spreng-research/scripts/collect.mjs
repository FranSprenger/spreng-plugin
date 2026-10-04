#!/usr/bin/env node
// collect.mjs: run one of the logged-out public collectors and write its research source file.
//
//   node collect.mjs reddit  --query "<search words>" --out <research/sources dir> [--threads 3]
//   node collect.mjs youtube --query "<search words>" --out <research/sources dir> [--videos 2]
//
// reddit fetches https://www.reddit.com/search.rss and each thread's .rss feed, one read a minute (Reddit
// answers "too many requests" when read faster), with one slower retry on a 429 and none after that.
// youtube fetches https://www.youtube.com/results and each watch page, then the first page of comments
// through https://www.youtube.com/youtubei/v1/next, the request the YouTube page itself makes.
// Nothing is sent anywhere else. Logged out: no account, no key, no cookies kept.

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { reddit } from './sources/reddit.mjs';
import { youtubeComments } from './sources/youtube-comments.mjs';

export async function main(argv, deps = {}) {
  const [source] = argv;
  const get = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const out = get('out');
  const query = get('query');
  if (!['reddit', 'youtube'].includes(source) || !out) throw new Error('usage: collect.mjs reddit|youtube --query "<words>" --out <dir>');
  let result;
  try {
    result = source === 'reddit'
      ? await reddit({ query, threads: Number(get('threads') || 3), ...(deps.pace !== undefined ? { pace: deps.pace } : {}) }, deps)
      : await youtubeComments({ query, videos: Number(get('videos') || 2), ...(deps.pace !== undefined ? { pace: deps.pace } : {}) }, deps);
  } catch (e) {
    const id = source === 'reddit' ? 'reddit' : 'youtube-comments';
    result = { id, label: id, kind: 'social', status: 'failed', reason: String(e?.message || e).slice(0, 500), quotes: [] };
  }
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, `${result.id}.json`), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then(
    (r) => console.log(`${r.id}: ${r.status}, ${r.quotes?.length || 0} quotes${r.reason ? `. ${r.reason}` : ''}`),
    (e) => { console.error(e.message); process.exit(2); },
  );
}
