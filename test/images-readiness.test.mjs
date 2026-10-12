// Offline readiness: fake CLIs and keys only. No provider or credential store is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callTool, defaultDeps, handle, TOOLS } from '../plugins/spreng-images/server/server.mjs';
import { read } from './helpers.mjs';

const UNKNOWN_NEXT = 'Proceed to claim_native_image and tell the user: "The image tool could not be checked in advance."';
const SKILLS = ['plugins/spreng/skills/spreng/SKILL.md', 'plugins/spreng-images/skills/image-source/SKILL.md'];
const MISSING_GATE = 'For not_installed, not_signed_in or no_image_capability, show its `reason` and `next`, keep the plan unclaimed, and stop.';

function assertUnknownProceeds(result) {
  assert.equal(result.state, 'could_not_tell');
  assert.equal(result.next, UNKNOWN_NEXT);
}

async function fixture(t, { source = 'codex', auth = 'Logged in using ChatGPT', authCode = 0,
  features = 'image_generation stable true', featureCode = 0, installed = true, extraEnv = {}, behavior = '' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spreng-readiness-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'codex');
  const trace = path.join(dir, 'calls.jsonl');
  if (installed) {
    await fs.writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROBE_TRACE, JSON.stringify({ args, cwd: process.cwd(), leaked: !!process.env.A8_PARENT_ONLY }) + '\\n');
${behavior}
if (args.join(' ') === 'login status') {
  process.stderr.write(${JSON.stringify(auth)} + '\\n'); process.exit(${authCode});
}
if (args.join(' ') === 'features list') {
  process.stdout.write(${JSON.stringify(features)} + '\\n'); process.exit(${featureCode});
}
process.stderr.write('unexpected command'); process.exit(99);
`);
    await fs.chmod(bin, 0o755);
  }
  const env = { PATH: dir, CLAUDE_PLUGIN_DATA: path.join(dir, 'data'),
    CLAUDE_PROJECT_DIR: path.join(dir, 'project'), PROBE_TRACE: trace, ...extraEnv };
  const deps = defaultDeps(env);
  deps.fetch = async () => assert.fail('readiness must never fetch');
  deps.run = async () => assert.fail('readiness must never run generation');
  if (source) await callTool('set_image_source', { source }, deps);
  const calls = async () => {
    try { return (await fs.readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  return { dir, bin, deps, calls, check: () => callTool('check_image_readiness', {}, deps) };
}

test('readiness tool is local, read-only and takes no caller readiness assertions', () => {
  const tool = TOOLS.find((t) => t.name === 'check_image_readiness');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
});

test('all five states: only complete positive evidence classifies as ready', async () => {
  const { readinessState } = await import('../plugins/spreng-images/server/readiness.mjs');
  // Synthetic evaluator evidence, NOT a claim that a current provider exposes an offline positive proof.
  for (const [checks, expected] of [
    [{ installed: true, signedIn: true, imageCapability: true }, 'ready'],
    [{ installed: false, signedIn: null, imageCapability: null }, 'not_installed'],
    [{ installed: true, signedIn: false, imageCapability: null }, 'not_signed_in'],
    [{ installed: true, signedIn: true, imageCapability: false }, 'no_image_capability'],
    [{ installed: true, signedIn: true, imageCapability: null }, 'could_not_tell'],
  ]) assert.equal(readinessState(checks), expected);
});

test('not_installed: neither PATH nor a configured missing executable can start', async (t) => {
  for (const extraEnv of [{}, { SPRENG_IMAGES_CODEX_BIN: '/no-such-a8img-codex' }]) {
    const s = await fixture(t, { installed: false, extraEnv });
    const r = await s.check();
    assert.equal(r.state, 'not_installed');
    assert.equal(r.next, 'Install Codex or correct its executable path, then check again.');
    assert.deepEqual(await s.calls(), []);
  }
});

test('not_signed_in: explicit logged-out status stops before any capability probe', async (t) => {
  const s = await fixture(t, { auth: 'Not logged in', authCode: 1 });
  const r = await s.check();
  assert.equal(r.state, 'not_signed_in');
  assert.equal(r.next, 'Run codex login with your ChatGPT account, then check again.');
  assert.deepEqual((await s.calls()).map((c) => c.args), [['login', 'status']]);
});

test('no_image_capability: the selected runtime explicitly disables image_generation', async (t) => {
  const s = await fixture(t, { features: 'image_generation\tstable\tfalse' });
  const r = await s.check();
  assert.equal(r.state, 'no_image_capability');
  assert.equal(r.checks.imageCapability, false);
  assert.equal(r.next, 'Enable image generation in Codex or use an image-capable session, then check again.');
  const calls = await s.calls();
  assert.deepEqual(calls.map((c) => c.args), [['login', 'status'], ['features', 'list']]);
  assert.equal(calls[0].cwd, calls[1].cwd);
  assert.ok(calls[0].cwd.startsWith(await fs.realpath(s.deps.env.CLAUDE_PLUGIN_DATA)));
  assert.deepEqual(await fs.readdir(path.join(s.deps.env.CLAUDE_PLUGIN_DATA, 'work')), []);
});

test('could_not_tell proceeds to claim: ChatGPT sign-in plus enabled image feature is not account capability proof', async (t) => {
  const s = await fixture(t);
  const r = await s.check();
  assertUnknownProceeds(r);
  assert.deepEqual(r.checks, { installed: true, signedIn: true, imageCapability: null });
  assert.match(r.reason, /account|access/);
  assert.ok(r.next);
  assert.deepEqual((await fs.readdir(s.deps.env.CLAUDE_PLUGIN_DATA)).sort(), ['image-source.json', 'work']);
});

test('unknown, failed and contradictory local outputs never establish readiness or absence', async (t) => {
  for (const opts of [
    { auth: 'status unavailable', authCode: 1 },
    { auth: 'Logged in using ChatGPT', authCode: 1 },
    { auth: 'Not logged in', authCode: 0 },
    { auth: 'Logged in using an API key: fake-private-key' },
    { features: '' },
    { features: 'image_generation stable true', featureCode: 1 },
    { features: 'image_generation stable false', featureCode: 1 },
    { features: 'image_generation stable true\nimage_generation stable false' },
    { features: 'image_generation unknown false' },
  ]) {
    const s = await fixture(t, opts);
    const r = await s.check();
    assert.equal(r.state, 'could_not_tell', JSON.stringify(opts));
    assertUnknownProceeds(r);
    assert.ok(!JSON.stringify(r).includes('fake-private-key'));
  }
});

test('nonexecutable files and broken probes are unknown, not ready', async (t) => {
  const s = await fixture(t);
  await fs.chmod(s.bin, 0o644);
  assertUnknownProceeds(await s.check());
});

test('a hanging or excessive-output probe is bounded and returns unknown', async (t) => {
  for (const behavior of [
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return;",
    "process.stdout.write('x'.repeat(100000)); process.exit(0);",
  ]) {
    const s = await fixture(t, { behavior });
    const start = Date.now();
    assertUnknownProceeds(await s.check());
    assert.ok(Date.now() - start < 6000);
  }
});

test('selected API routes: absent/placeholder key is unsigned; present key alone remains unknown', async (t) => {
  for (const [source, name] of [['openai', 'SPRENG_IMAGES_OPENAI_KEY'], ['kie', 'SPRENG_IMAGES_KIE_KEY']]) {
    for (const key of ['', '  ', '${user_config.key}', 'fake-private-key']) {
      const s = await fixture(t, { source, extraEnv: { [name]: key } });
      const r = await s.check();
      assert.equal(r.state, key === 'fake-private-key' ? 'could_not_tell' : 'not_signed_in');
      if (r.state === 'could_not_tell') assertUnknownProceeds(r);
      else assert.equal(r.next, 'Set its key with /plugin configure spreng-images@spreng, restart Claude Code, then check again.');
      assert.ok(!JSON.stringify(r).includes('fake-private-key'));
      assert.deepEqual(await s.calls(), []);
    }
  }
});

test('no selected source and other have no local capability proof', async (t) => {
  for (const source of [null, 'other']) {
    const s = await fixture(t, { source });
    const r = await s.check();
    assert.equal(r.state, 'could_not_tell');
    assert.equal(r.source, source);
    assertUnknownProceeds(r);
    assert.deepEqual(await s.calls(), []);
  }
});

test('the configured executable is probed using only the supplied environment', async (t) => {
  const s = await fixture(t);
  s.deps.env.SPRENG_IMAGES_CODEX_BIN = s.bin;
  s.deps.env.PATH = '';
  process.env.A8_PARENT_ONLY = 'must-not-reach-child';
  try { assert.equal((await s.check()).state, 'could_not_tell'); }
  finally { delete process.env.A8_PARENT_ONLY; }
  assert.ok((await s.calls()).every((c) => !c.leaked));
});

test('relative executable and PATH entries resolve from the server directory, as generation does', async (t) => {
  for (const configured of [true, false]) {
    const s = await fixture(t);
    if (configured) s.deps.env.SPRENG_IMAGES_CODEX_BIN = path.relative(process.cwd(), s.bin);
    else s.deps.env.PATH = path.relative(process.cwd(), s.dir);
    assert.equal((await s.check()).state, 'could_not_tell');
    assert.equal((await s.calls()).length, 2);
  }
});

test('MCP reply carries the readiness state; source status reports configuration without a ready flag', async (t) => {
  const s = await fixture(t, { source: 'openai', extraEnv: { SPRENG_IMAGES_OPENAI_KEY: 'fake-private-key' } });
  const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'check_image_readiness', arguments: {} } }, s.deps);
  assert.equal(reply.result.isError, undefined);
  assertUnknownProceeds(JSON.parse(reply.result.content[0].text));
  const status = await callTool('image_source_status', {}, s.deps);
  assert.equal(status.ready, undefined);
  assert.equal(status.configured.openai, true);
});

test('a failed local readiness check still proceeds to claim with the advance-check notice', async (t) => {
  const s = await fixture(t);
  s.deps.fs = { ...s.deps.fs, mkdir: async () => { throw new Error('unavailable local folder'); } };
  assertUnknownProceeds(await s.check());
  assert.deepEqual(await s.calls(), []);
});

test('both skills and the tool description require the check without a ready-only gate', () => {
  for (const file of SKILLS) {
    const skill = read(file);
    assert.match(skill, /Before (?:calling )?`claim_native_image`, call `check_image_readiness`/);
    assert.doesNotMatch(skill, /Only `ready` permits a claim|For every other state|After a ready result/);
  }
  const tool = TOOLS.find((t) => t.name === 'check_image_readiness');
  assert.match(tool.description, /Only not_installed, not_signed_in and no_image_capability block a claim/);
  assert.match(tool.description, /ready and could_not_tell proceed/);
});

// The remote claim is performed by the agent following these shipped instructions, not this server.
for (const state of ['ready', 'could_not_tell', 'not_installed', 'not_signed_in', 'no_image_capability']) {
  test(`both skills: ${state} ${state === 'ready' || state === 'could_not_tell' ? 'proceeds to claim' : 'blocks with the existing reason and fix-it message'}`, () => {
    for (const file of SKILLS) {
      const skill = read(file);
      const instruction = state === 'ready' ? 'For ready, claim normally.'
        : state === 'could_not_tell' ? 'For could_not_tell, claim normally and tell the user: "The image tool could not be checked in advance."'
        : MISSING_GATE;
      assert.ok(skill.includes(instruction), `${file}: ${state} claim instruction`);
    }
  });
}

test('Codex setup accepts unknown readiness so it cannot prevent a later claim', () => {
  assert.match(read(SKILLS[0]), /After ready or could_not_tell, call `studio_start` with `imageSource: codex_cli`/);
});
