import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callTool, TOOLS } from '../plugins/spreng-images/server/server.mjs';
import { reserveOperation, updateOperation, JOURNAL_DIR } from '../plugins/spreng-images/server/operations.mjs';
import { read } from './helpers.mjs';

test('R7-fable-05: image skill routes dropped replies to receipt recovery with only the claim id', () => {
  const skill = read('plugins/spreng-images/skills/image-source/SKILL.md');
  assert.match(skill, /dropped reply[\s\S]*`recover_image`[\s\S]*claim id[\s\S]*`operationId`/);
  assert.match(skill, /no prompt, reference links or provider call/i);
  assert.match(skill, /(?:fresh|refreshed) reference links/);
  assert.match(skill, /no completed receipt[\s\S]*state[\s\S]*nothing/i);
  assert.doesNotMatch(skill, /the same `operationId` again returns the image already made/);
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spreng-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { CLAUDE_PLUGIN_DATA: path.join(dir, 'data'), CLAUDE_PROJECT_DIR: path.join(dir, 'project') };
  await fs.mkdir(env.CLAUDE_PROJECT_DIR);
  env.CLAUDE_PROJECT_DIR = await fs.realpath(env.CLAUDE_PROJECT_DIR);
  const deps = { env, fs, now: () => new Date('2026-10-10T00:00:00Z'),
    fetch: async () => { throw new Error('unexpected network call'); },
    run: async () => { throw new Error('unexpected process'); } };
  return { dir, env, deps, stateDir: path.join(env.CLAUDE_PLUGIN_DATA, JOURNAL_DIR) };
}

test('R6-ASTRA2-07: signed-reference refresh recovers the original bytes by operationId without another submission', async (t) => {
  const { deps, env, dir, stateDir } = await fixture(t);
  const bytes = Buffer.from('synthetic image bytes');
  let submissions = 0;
  deps.env.SPRENG_IMAGES_OPENAI_KEY = 'synthetic-test-value';
  await callTool('set_image_source', { source: 'openai' }, deps);
  deps.fetch = async (url) => {
    if (url.startsWith('https://references.example/')) return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => bytes };
    submissions++;
    return { ok: true, json: async () => ({ data: [{ b64_json: bytes.toString('base64') }] }) };
  };
  const job = { prompt: 'unchanged prompt', operationId: 'asset-1', outPath: 'image.png', references: ['https://references.example/person.png?token=old'] };
  const made = await callTool('make_image', job, deps);
  for (const changed of [
    { references: ['https://references.example/person.png?token=new'] },
    { references: ['https://references.example/different.png?token=new'] },
    { prompt: 'different prompt' },
  ]) await assert.rejects(callTool('make_image', { ...job, ...changed }, deps), /different image request/);
  assert.equal(submissions, 1);
  delete env.SPRENG_IMAGES_OPENAI_KEY;
  await fs.rm(path.join(env.CLAUDE_PLUGIN_DATA, 'image-source.json'));
  deps.fetch = async () => { throw new Error('recovery must not call any network'); };
  await fs.rm(made.path);
  const before = await fs.readdir(stateDir);
  const recovered = await callTool('recover_image', { operationId: job.operationId }, deps);
  assert.equal(recovered.operationId, made.operationId);
  assert.equal(recovered.path, made.path);
  assert.equal(recovered.replayed, true);
  assert.deepEqual(await fs.readFile(recovered.path), bytes);
  assert.deepEqual(await fs.readdir(stateDir), before);
  const alias = path.join(dir, 'alias');
  await fs.symlink(env.CLAUDE_PROJECT_DIR, alias);
  assert.equal((await callTool('recover_image', { operationId: job.operationId }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: alias } })).path, made.path);
  const other = await callTool('recover_image', { operationId: job.operationId }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: path.join(dir, 'other') } });
  assert.equal(other.state, 'not_found');
  assert.equal(other.recovered, false);
  assert.equal(other.path, undefined);
  const kept = before.find((name) => name.endsWith('.image'));
  await fs.writeFile(path.join(stateDir, kept), 'corrupted');
  await assert.rejects(callTool('recover_image', { operationId: job.operationId }, deps), /changed or damaged/);
  assert.equal(submissions, 1);
});

test('R6-ASTRA2-07: recovery reports missing and unfinished operations without reserving or submitting', async (t) => {
  const { deps, env, stateDir } = await fixture(t);
  const missing = await callTool('recover_image', { operationId: 'missing' }, deps);
  assert.deepEqual([missing.state, missing.recovered], ['not_found', false]);
  await assert.rejects(fs.access(stateDir), { code: 'ENOENT' });
  for (const state of ['submitting', 'accepted', 'uncertain', 'failed']) {
    const op = await reserveOperation(deps, { job: { operationId: state, projectDir: env.CLAUDE_PROJECT_DIR, stateDir }, fingerprint: 'synthetic', provider: 'KIE', model: 'test' });
    await updateOperation(deps, op, { state, ...(state === 'accepted' ? { taskId: 'existing-task' } : {}) });
    const before = await fs.readFile(op.file, 'utf8');
    const result = await callTool('recover_image', { operationId: state }, deps);
    assert.deepEqual([result.state, result.recovered, result.path], [state, false, undefined]);
    if (state === 'accepted') assert.equal(result.taskId, 'existing-task');
    assert.equal(await fs.readFile(op.file, 'utf8'), before);
    await fs.writeFile(op.file, '{');
    assert.equal((await callTool('recover_image', { operationId: state }, deps)).state, 'unreadable');
  }
});

test('R6-ASTRA2-07: recovery tool needs only an operationId and advertises local idempotent restoration', () => {
  const tool = TOOLS.find((tool) => tool.name === 'recover_image');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['operationId']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['operationId']);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});
