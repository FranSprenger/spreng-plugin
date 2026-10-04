// spreng-images: local reference files that change while a request runs, and nested projects. All calls are mocks:
// no paid call and no real codex run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../plugins/spreng-images/server/server.mjs';

const OPENAI_KEY = 'sk-test-openai-0000000000000000';
const FIXED = new Date('2026-10-04T12:00:00Z');
const b64 = (s) => Buffer.from(s).toString('base64');
const res = (status, body, extra = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => Buffer.from('x'), headers: { get: () => 'image/png' }, ...extra,
});

async function sandbox(source, extraEnv = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spreng-references-'));
  const A = path.join(dir, 'client-A');
  const B = path.join(dir, 'client-B');
  await fs.mkdir(A, { recursive: true });
  await fs.mkdir(B, { recursive: true });
  const env = { CLAUDE_PLUGIN_DATA: path.join(dir, 'data'), CLAUDE_PROJECT_DIR: A, CODEX_HOME: path.join(dir, 'codex'), PATH: '', ...extraEnv };
  const deps = {
    env, fs, homedir: () => dir, now: () => FIXED, sleep: async () => {},
    fetch: async () => { throw new Error('unexpected fetch'); },
    run: async () => { throw new Error('unexpected run'); },
  };
  await callTool('set_image_source', { source }, deps);
  const inProject = (p) => ({ ...deps, env: { ...env, CLAUDE_PROJECT_DIR: p } });
  return { dir, env, deps, A, B, inProject };
}

// ---------- a reference is read once ----------

/** brand/logo.png in project A holds v1 until it is first read, then v2: the change lands mid-request. */
async function changingLogo(deps, A) {
  const logo = path.join(A, 'brand', 'logo.png');
  await fs.mkdir(path.dirname(logo), { recursive: true });
  await fs.writeFile(logo, 'logo v1');
  const real = await fs.realpath(logo);
  let changed = false;
  deps.fs = {
    ...fs,
    readFile: async (p, ...rest) => {
      const out = await fs.readFile(p, ...rest);
      if (!changed && String(p) === real) { changed = true; await fs.writeFile(logo, 'logo v2'); }
      return out;
    },
  };
  return logo;
}

test('openai: the reference sent is the one fingerprinted, even when the project file changes mid-request', async () => {
  const { deps, A, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  await changingLogo(deps, A);
  const sent = [];
  deps.fetch = async (_url, init) => {
    sent.push(Buffer.from(await init.body.get('image[]').arrayBuffer()).toString());
    return res(200, { data: [{ b64_json: b64(`made from ${sent.at(-1)}`) }] });
  };
  const args = { prompt: 'p', references: ['brand/logo.png'], operationId: 'snap-1', outPath: 'ad.png' };
  await callTool('make_image', args, inProject(A));
  assert.deepEqual(sent, ['logo v1'], 'OpenAI received the bytes that were hashed');
  // The project file is now v2: the same id is a different request and is refused; nothing is replayed for it.
  await assert.rejects(callTool('make_image', args, inProject(A)), /different image request/);
  assert.equal(sent.length, 1);
});

test('codex: the attached reference is a copy of the fingerprinted bytes, never the project file itself', async () => {
  const { deps, env, A, inProject } = await sandbox('codex');
  const logo = await changingLogo(deps, A);
  let attached = null;
  let attachedPath = null;
  deps.run = async (_cmd, args) => {
    attachedPath = args[args.indexOf('-i') + 1];
    attached = String(await fs.readFile(attachedPath));
    const made = path.join(env.CODEX_HOME, 'generated_images', 't1', 'exec.png');
    await fs.mkdir(path.dirname(made), { recursive: true });
    await fs.writeFile(made, 'img');
    return { code: 0, stdout: '{"type":"thread.started","thread_id":"t1"}\n', stderr: '' };
  };
  await callTool('make_image', { prompt: 'p', references: ['brand/logo.png'], operationId: 'snap-2' }, inProject(A));
  assert.equal(attached, 'logo v1');
  assert.notEqual(await fs.realpath(path.dirname(attachedPath)).catch(() => path.dirname(attachedPath)), await fs.realpath(path.dirname(logo)));
  assert.equal(path.basename(attachedPath), 'logo.png', 'the file keeps its name');
});

// ---------- nested projects ----------

test('nested projects: the same operation id in /clients/A and /clients are two operations; the parent never gets the child\'s image', async () => {
  const { deps, dir, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const parent = path.join(dir, 'clients');
  const child = path.join(parent, 'A');
  await fs.mkdir(child, { recursive: true });
  let n = 0;
  deps.fetch = async () => { n++; return res(200, { data: [{ b64_json: b64(`image ${n}`) }] }); };
  const c = await callTool('make_image', { prompt: 'p', operationId: 'claim-n2', outPath: 'ad.png' }, inProject(child));
  assert.equal(c.replayed, undefined);
  const p = await callTool('make_image', { prompt: 'p', operationId: 'claim-n2', outPath: 'A/ad2.png' }, inProject(parent));
  assert.notEqual(p.replayed, true, 'not a replay of the child operation');
  assert.equal(String(await fs.readFile(path.join(child, 'ad.png'))), 'image 1');
  assert.equal(String(await fs.readFile(path.join(child, 'ad2.png'))), 'image 2');
  const again = await callTool('make_image', { prompt: 'p', operationId: 'claim-n2', outPath: 'ad.png' }, inProject(child));
  assert.equal(again.replayed, true);
  assert.equal(n, 2);
});
