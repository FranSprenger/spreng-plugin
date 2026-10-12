// Real subprocesses, but only synthetic local launchers; no Codex, credentials or provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callTool, defaultDeps } from '../plugins/spreng-images/server/server.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

async function launcher(t, body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spreng-launch-'));
  t.after(async () => {
    // Fail-first runs intentionally expose an orphan; always kill it before removing its PID file.
    const pid = Number(await fs.readFile(path.join(dir, 'child.pid'), 'utf8').catch(() => '0'));
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const bin = path.join(dir, 'codex');
  const env = { PATH: '', SPRENG_IMAGES_CODEX_BIN: bin, CODEX_HOME: path.join(dir, 'codex-home'),
    CLAUDE_PLUGIN_DATA: path.join(dir, 'data'), CLAUDE_PROJECT_DIR: path.join(dir, 'project') };
  await fs.writeFile(bin, `#!${process.execPath}\n${body(dir, env)}\n`);
  await fs.chmod(bin, 0o755);
  const deps = defaultDeps(env);
  deps.fetch = async () => assert.fail('no network allowed');
  await callTool('set_image_source', { source: 'codex' }, deps);
  return { dir, env, deps, check: () => callTool('check_image_readiness', {}, deps) };
}

test('startup-directory profile matches generation and readiness', async (t) => {
  const s = await launcher(t, (dir, env) => `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const at = args.indexOf('-C');
const scratch = at < 0 ? null : args.splice(at, 2)[1];
const signedIn = process.cwd() === ${JSON.stringify(process.cwd())};
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.jsonl'))}, JSON.stringify({
  command: args[0], cwd: process.cwd(), scratch, signedIn,
  profile: process.env.FX3A8IMG_PROFILE, parentOnly: !!process.env.FX3A8IMG_PARENT_ONLY,
  path: process.env.PATH
}) + '\\n');
if (args[0] === 'exec') {
  if (!signedIn) process.exit(1);
  const made = ${JSON.stringify(path.join(env.CODEX_HOME, 'generated_images', 'synthetic', 'image.png'))};
  fs.mkdirSync(path.dirname(made), { recursive: true });
  fs.writeFileSync(made, Buffer.from(${JSON.stringify(PNG.toString('hex'))}, 'hex'));
  process.stdout.write('{"thread_id":"synthetic"}\\n');
} else if (args.join(' ') === 'login status') {
  process.stderr.write(signedIn ? 'Logged in using ChatGPT\\n' : 'Not logged in\\n');
  process.exitCode = signedIn ? 0 : 1;
} else if (args.join(' ') === 'features list') {
  process.stdout.write('image_generation stable true\\n');
} else process.exit(99);
`);
  s.env.FX3A8IMG_PROFILE = 'synthetic-profile';
  const oldParent = process.env.FX3A8IMG_PARENT_ONLY;
  process.env.FX3A8IMG_PARENT_ONLY = 'must-not-be-inherited';
  t.after(() => {
    if (oldParent === undefined) delete process.env.FX3A8IMG_PARENT_ONLY;
    else process.env.FX3A8IMG_PARENT_ONLY = oldParent;
  });
  const made = await callTool('make_image', { prompt: 'synthetic fixture', operationId: 'profile-match' }, s.deps);
  assert.deepEqual(await fs.readFile(made.path), PNG, 'generation succeeds with the synthetic profile');
  const readiness = await s.check();
  assert.equal(readiness.state, 'could_not_tell', 'generation signed in; readiness must not falsely block');
  assert.equal(readiness.checks.signedIn, true);
  const calls = (await fs.readFile(path.join(s.dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((c) => c.command), ['exec', 'login', 'features']);
  for (const call of calls) {
    assert.equal(call.cwd, process.cwd());
    assert.equal(call.signedIn, true);
    assert.equal(call.profile, 'synthetic-profile');
    assert.equal(call.parentOnly, false);
    assert.equal(call.path, s.env.PATH, 'wrapper receives the same unmodified PATH');
    assert.equal(path.dirname(call.scratch), path.join(s.env.CLAUDE_PLUGIN_DATA, 'work'));
  }
  assert.equal(calls[1].scratch, calls[2].scratch);
  assert.notEqual(calls[0].scratch, calls[1].scratch);
});

test('unavailable launch directory is unknown, even when spawn reports ENOENT', async (t) => {
  const s = await launcher(t, () => "process.stderr.write('Not logged in\\n'); process.exit(1);");
  t.mock.method(process, 'cwd', () => path.join(s.dir, 'missing-startup-directory'));
  const readiness = await s.check();
  assert.equal(readiness.state, 'could_not_tell');
  assert.deepEqual(readiness.checks, { installed: null, signedIn: null, imageCapability: null });
});

function isLive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}

for (const mode of ['timeout', 'overflow']) {
  test(`${mode}: readiness kills the wrapper's hanging child before returning`, { timeout: 10000 }, async (t) => {
    const s = await launcher(t, (dir) => `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.on('message', () => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'child.pid'))}, String(child.pid));
  ${mode === 'overflow' ? "process.stdout.write('x'.repeat(100000));" : ''}
});
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);
    const start = Date.now();
    const readiness = await s.check();
    assert.equal(readiness.state, 'could_not_tell');
    assert.ok(Date.now() - start < 6000, 'the probe stays bounded');
    const pid = Number(await fs.readFile(path.join(s.dir, 'child.pid'), 'utf8'));
    assert.ok(pid > 0, 'wrapper confirmed that its child started');
    assert.equal(isLive(pid), false, `${mode} left a live wrapper child after readiness returned`);
  });
}
