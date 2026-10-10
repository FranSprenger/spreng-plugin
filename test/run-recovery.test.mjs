import test from 'node:test';
import assert from 'node:assert/strict';
import { read, json } from './helpers.mjs';

const skill = read('plugins/spreng/skills/spreng/SKILL.md');
const rows = skill.split('\n').filter((line) => line.startsWith('| Carry on'))
  .map((line) => line.split('|').slice(1, 3).map((cell) => cell.trim()));
const tools = (text) => [...text.matchAll(/`((?:list|get)_native_(?:text_)?runs?)`/g)].map((m) => m[1]);

// Matches spreng-mcp/contract.ts: image runs and text runs have separate discovery tools.
for (const [request, kind] of [['research', 'buyer_read'], ['stages', 'structure'], ['angles', 'angles'], ['copy', 'ad_copy']]) {
  test(`R8-ASTRA2-01: rediscover ${request} without a run id when the image list is empty`, () => {
    const row = rows.find(([label]) => label.toLowerCase().includes(request))
      ?? rows.find(([label]) => label === 'Carry on with an earlier run');
    assert.ok(row, `missing ${request} recovery row`);
    const [list, get] = tools(row[1]);
    const saved = { runId: 'older-text-run', kind, status: 'in_progress' };
    const calls = [];
    const handlers = {
      list_native_runs: () => ({ runs: [], next: null }),
      list_native_text_runs: ({ before }) => before
        ? { runs: [saved], next: null }
        : { runs: [{ runId: 'newer-text-run' }], next: 'older-page' },
      get_native_run: () => null,
      get_native_text_run: ({ runId }) => runId === saved.runId ? saved : null,
    };
    let before;
    let recovered;
    do {
      const args = { clientId: 'saved-client', ...(before ? { before } : {}) };
      calls.push([list, args]);
      const page = handlers[list](args);
      const found = page.runs.find((run) => run.kind === kind);
      if (found) recovered = handlers[get]({ runId: found.runId });
      before = page.next;
    } while (!recovered && before);
    assert.deepEqual(recovered, saved, 'the documented route must discover the saved text work');
    assert.deepEqual(tools(row[1]), ['list_native_text_runs', 'get_native_text_run']);
    assert.deepEqual(calls, [
      ['list_native_text_runs', { clientId: 'saved-client' }],
      ['list_native_text_runs', { clientId: 'saved-client', before: 'older-page' }],
    ]);
  });
}

test('R8-ASTRA2-01: both recovery lists retain client filtering and older-page instructions', () => {
  assert.equal(rows.length, 2, 'separate image and text recovery rows');
  const image = rows.find(([label]) => /image/i.test(label));
  assert.ok(image, 'image recovery stays explicit');
  assert.deepEqual(tools(image[1]), ['list_native_runs', 'get_native_run']);
  const { free } = json('test/fixtures/spreng-mcp-tools.json');
  for (const [, route] of rows) {
    assert.match(route, /`clientId`/);
    assert.match(route, /`next`.*`before`/);
    for (const tool of tools(route)) assert.ok(free.includes(tool), tool);
  }
  const handoff = skill.split('\n').find((line) => line.startsWith('- Alternatively,'));
  assert.match(handoff, /image/);
  assert.deepEqual(tools(handoff), tools(image[1]));
});
