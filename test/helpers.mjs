import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
export const json = (p) => JSON.parse(read(p));

/** Every file under dir (relative to ROOT), recursively. */
export function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Width and height of a PNG from its IHDR chunk. */
export function pngSize(p) {
  const b = fs.readFileSync(path.join(ROOT, p));
  if (b.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${p} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/** Hosts of every https URL in a text. */
export function hosts(text) {
  return [...new Set([...String(text).matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()))];
}
