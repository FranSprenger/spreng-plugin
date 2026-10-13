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
