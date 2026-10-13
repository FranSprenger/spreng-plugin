import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toVault } from '../plugins/spreng-research/scripts/to-vault.mjs';
test('vault conversion is deterministic, lossless across parts, and keeps blocked receipts', () => {
  const text = 'long original 🐈 '.repeat(15000);
  const input = [{ id: 'fb', kind: 'social', platform: 'facebook_comments', status: 'ok', retrievedAt: '2026-10-13T00:00:00Z', quotes: [{ text, author: 'A', parent_id: 'P', provider_item_id: 'C' }] }, { id: 'x', status: 'blocked', reason: 'login wall' }];
  const result = toVault(input, { maxBytes: 60000 });
  assert.deepEqual(result, toVault(input, { maxBytes: 60000 }));
  assert.ok(result.parts.length > 1);
  assert.equal(result.parts.flatMap(p => p.payload.documents || []).map(d => d.text).join(''), text);
  assert.equal(result.parts[0].payload.documents[0].parent_id, 'P');
  assert.ok(result.parts.some(p => p.payload.sources.some(s => s.id === '2:x' && s.status === 'blocked')));
  result.parts.forEach((p, i) => { assert.equal(p.payload.part.index, i + 1); assert.equal(p.payload.part.total, result.parts.length); assert.ok(Buffer.byteLength(JSON.stringify(p.payload)) <= 60000); });
});
test('converter payloads satisfy the app schema, including nested ad relationships', async t => {
  if (!process.env.SPRENG_RECORD_SCHEMA) return t.skip('set SPRENG_RECORD_SCHEMA for the app validator');
  const { pathToFileURL } = await import('node:url');
  const { validateRecordPayload } = await import(pathToFileURL(process.env.SPRENG_RECORD_SCHEMA));
  const result = toVault([{ id: 'meta', status: 'ok', kind: 'ad_library', retrievedAt: '2026-10-13T00:00:00Z', competitors: [{ name: 'Rival', ads: [{ text: 'Actual ad text', provider_item_id: 'ad-1' }] }] }]);
  for (const part of result.parts) validateRecordPayload('research', JSON.parse(JSON.stringify(part.payload)));
  assert.equal(result.parts[0].payload.competitors[0].ads[0].sourceId, '1:meta');
});

test('FXMCPBUILD: collector reports stay at the payload root, including repeated collectors across parts', () => {
  const result = toVault([
    { id: 'report', status: 'ok', collectorOutputs: { audience_research: 'REPORT' } },
    { id: 'report2', status: 'ok', collectorOutputs: { audience_research: 'SECOND', ad_library_scan: { ads: [{ body: 'AD' }] } } },
  ]);
  assert.deepEqual(result.parts.map(p => p.payload.collectorOutputs.audience_research), ['REPORT', 'SECOND']);
  assert.deepEqual(result.parts[1].payload.collectorOutputs.ad_library_scan.ads, [{ body: 'AD' }]);
  for (const part of result.parts) assert.equal(part.payload.sources[0].collectorOutputs, undefined);
});

test('FXMCPBUILD: converted reviewer reproduction reaches the real Studio evidence adapter', async t => {
  if (!process.env.SPRENG_RECORD_SCHEMA) return t.skip('set SPRENG_RECORD_SCHEMA for app integration');
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { resolve, dirname } = await import('node:path');
  const adapter = resolve(dirname(process.env.SPRENG_RECORD_SCHEMA), '../research-v2/studio-research.ts');
  const converted = toVault([{ id: 'report', status: 'ok', collectorOutputs: { audience_research: 'REPORT' } }]);
  const code = `import {studioResearchEntries} from ${JSON.stringify(pathToFileURL(adapter).href)};
    import {validateRecordPayload} from ${JSON.stringify(pathToFileURL(process.env.SPRENG_RECORD_SCHEMA).href)};
    const payload = ${JSON.stringify(converted.parts[0].payload)};
    validateRecordPayload('research', payload);
    const entries = await studioResearchEntries({id:'record', title:'Report', created_at:'2026-10-13T00:00:00Z', payload});
    console.log(JSON.stringify(entries));`;
  const entries = JSON.parse(execFileSync('deno', ['eval', '--node-modules-dir=manual', code], { encoding: 'utf8', cwd: dirname(process.env.SPRENG_RECORD_SCHEMA) }));
  assert.ok(entries.length > 0);
  assert.ok(entries.some(e => e.item.raw_text.includes('REPORT')));
  assert.ok(entries.some(e => e.item.raw_record.collectorOutputs?.audience_research === 'REPORT'));
});
