#!/usr/bin/env node
// Deterministic, offline source transport. No research interpretation or network access.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => { const h = hash(value); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const chunks = (text, size) => {
  const result = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    result.push(text.slice(at, end)); at = end;
  }
  return result;
};

export function toVault(results, { title = 'Host research', maxBytes = 512 * 1024 } = {}) {
  const fields = ['quotes', 'documents', 'competitors', 'proof', 'quantified_stakes'];
  const parts = [];
  let current = { schemaVersion: '1', sources: [] };
  const finish = () => { if (Object.keys(current).length > 1 && (current.sources.length || fields.some(k => current[k]?.length))) parts.push(current); current = { schemaVersion: '1', sources: [] }; };
  const add = (field, entry, source) => {
    const withEntry = () => ({ ...current, sources: current.sources.some(s => s.id === source.id) ? current.sources : [...current.sources, source], [field]: [...(current[field] || []), entry] });
    let next = withEntry();
    const limit = field === 'documents' ? 50 : field === 'competitors' ? 100 : field === 'quotes' ? 500 : 200;
    if (bytes(next) > maxBytes - 200 || (current[field]?.length || 0) >= limit || next.sources.length > 500) { finish(); next = withEntry(); }
    if (bytes(next) > maxBytes - 200) throw new Error('One structured entry exceeds the vault payload size; split its original fields before saving');
    current = next;
  };
  results.forEach((result, index) => {
    const { quotes = [], documents = [], competitors = [], proof = [], quantified_stakes = [], collectorOutputs, ...receipt } = result;
    const source = { ...receipt, id: `${index + 1}:${result.id || 'source'}`, status: result.status || 'ok', itemCount: quotes.length + documents.length + competitors.length + proof.length + quantified_stakes.length };
    if (collectorOutputs !== undefined) {
      // Each report keeps its own root output, including repeated collector names across results.
      finish();
      current = { schemaVersion: '1', sources: [source], collectorOutputs };
      if (bytes(current) > maxBytes - 200) throw new Error('One structured entry exceeds the vault payload size; split its original fields before saving');
      finish();
    }
    // Preserve diagnostics and collector-specific structures rather than silently dropping them.
    for (const [field, entries] of Object.entries({ quotes, documents, competitors, proof, quantified_stakes })) {
      for (const raw of entries) {
        const entry = { ...raw, sourceId: source.id, captured_at: raw.captured_at || result.retrievedAt };
        if (field === 'competitors' && Array.isArray(entry.ads)) entry.ads = entry.ads.map(ad => ({ ...ad, sourceId: source.id }));
        if ((field === 'quotes' && entry.text?.length > 4000) || (field === 'documents' && (entry.text?.length > 200000 || bytes(entry) > maxBytes / 2))) {
          const pieces = chunks(entry.text, Math.min(50000, Math.floor(maxBytes / 12)));
          pieces.forEach((text, n) => add('documents', { ...entry, kind: 'other', text, title: `${entry.title || 'Original source'} (${n + 1}/${pieces.length})`, raw_record: { ...entry.raw_record, original_field: field, text_part: n + 1, text_parts: pieces.length } }, source));
        } else add(field, entry, source);
      }
    }
    if (!current.sources.some(s => s.id === source.id) && !parts.some(p => p.sources.some(s => s.id === source.id))) {
      if (bytes({ ...current, sources: [...current.sources, source] }) > maxBytes - 200 || current.sources.length >= 500) finish();
      current.sources.push(source);
    }
  });
  finish();
  const group = hash(JSON.stringify(parts)).slice(0, 32);
  return { title, group, parts: parts.map((payload, i) => ({ operationId: uuid(`${group}:${i}`), payload: parts.length > 1 ? { ...payload, part: { group, index: i + 1, total: parts.length } } : payload })) };
}

export async function main(argv) {
  const at = argv.indexOf('--out');
  if (at < 0 || !argv[at + 1]) throw new Error('usage: to-vault.mjs --out <dir> <source.json>...');
  const out = argv[at + 1];
  const files = argv.filter((_, i) => i !== at && i !== at + 1).sort();
  const results = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(file, 'utf8'))));
  const manifest = toVault(results);
  await fs.mkdir(out, { recursive: true });
  for (const [i, part] of manifest.parts.entries()) await fs.writeFile(path.join(out, `part-${i + 1}.json`), JSON.stringify(part.payload, null, 2));
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
