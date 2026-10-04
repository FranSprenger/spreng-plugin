// spreng-images: records kept by the earlier journal (one file per operation id, not per project) and local
// reference files that change while a request runs. All calls are mocks: no paid call and no real codex run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { callTool } from '../plugins/spreng-images/server/server.mjs';

const OPENAI_KEY = 'sk-test-openai-0000000000000000';
const KIE_KEY = 'kie-test-key-1111111111111111';
const FIXED = new Date('2026-10-04T12:00:00Z');
const sha = (d) => createHash('sha256').update(d).digest('hex');
const b64 = (s) => Buffer.from(s).toString('base64');
const res = (status, body, extra = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => Buffer.from('x'), headers: { get: () => 'image/png' }, ...extra,
});

async function sandbox(source, extraEnv = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spreng-upgrade-'));
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

/** A record exactly as the earlier journal wrote it: keyed by the operation id alone, with no project field. */
async function seedLegacy(env, operationId, record, image) {
  const dir = path.join(env.CLAUDE_PLUGIN_DATA, 'operations');
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, sha('op:' + operationId).slice(0, 32));
  const rec = { operationId, reservedAt: '2026-10-03T10:00:00.000Z', ...record };
  if (image) {
    await fs.writeFile(`${base}.image`, image);
    Object.assign(rec, { resultFile: `${base}.image`, resultSha256: sha(image) });
  }
  await fs.writeFile(`${base}.json`, JSON.stringify(rec, null, 2));
}
// The earlier fingerprints, field for field.
const legacyOpenAI = (prompt, references = [], size = null, model = 'gpt-image-2') => sha(JSON.stringify({ source: 'openai', model, prompt, references, size }));
const legacyKie = (prompt, references = [], aspectRatio = null, model = 'nano-banana-pro') => sha(JSON.stringify({ source: 'kie', model, prompt, references, aspectRatio }));

// ---------- records from the earlier journal ----------

test('upgrade: an unclear OpenAI record from the earlier journal is never sent again', async () => {
  const { deps, env, A, B, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  await seedLegacy(env, 'claim-u1', { provider: 'OpenAI', fingerprint: legacyOpenAI('p'), state: 'uncertain', reason: 'HTTP 502' });
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('new') }] }); };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-u1' }, inProject(A)), /claim-u1/);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-u1' }, inProject(B)), /claim-u1/);
  assert.equal(posts, 0, 'no new submission for an operation the earlier journal kept as unclear');
});

test('upgrade: a codex run the earlier journal kept as submitting is never run again', async () => {
  const { deps, env, A, inProject } = await sandbox('codex');
  await seedLegacy(env, 'claim-u2', { provider: 'Codex CLI', fingerprint: sha(JSON.stringify({ source: 'codex', prompt: 'p', references: [] })), state: 'submitting' });
  let runs = 0;
  deps.run = async () => { runs++; return { code: 0, stdout: '', stderr: '' }; };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-u2' }, inProject(A)), /claim-u2/);
  assert.equal(runs, 0);
});

test('upgrade: a completed earlier record is replayed in its own project, and never handed to another project', async () => {
  const { deps, env, A, B, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  // The earlier server saved outPath as the project folder it was given (not resolved through symlinks).
  await seedLegacy(env, 'claim-u3', {
    provider: 'OpenAI', fingerprint: legacyOpenAI('p'), state: 'completed', outPath: path.join(A, 'ad.png'), result: { source: 'openai' },
  }, 'kept-image-A');
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('new') }] }); };
  const args = { prompt: 'p', operationId: 'claim-u3', outPath: 'ad.png' };
  const a = await callTool('make_image', args, inProject(A));
  assert.equal(a.replayed, true);
  assert.equal(String(await fs.readFile(path.join(A, 'ad.png'))), 'kept-image-A');
  await assert.rejects(callTool('make_image', args, inProject(B)), /earlier version/);
  await assert.rejects(fs.access(path.join(B, 'ad.png')), 'project B never receives project A\'s image');
  const a2 = await callTool('make_image', args, inProject(A));
  assert.equal(a2.replayed, true, 'the record moved to project A is found again');
  assert.equal(posts, 0, 'zero new submissions');
});

test('upgrade: an earlier record in this project for a different request is refused, not resent', async () => {
  const { deps, env, A, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  await seedLegacy(env, 'claim-u4', {
    provider: 'OpenAI', fingerprint: legacyOpenAI('another prompt'), state: 'completed', outPath: path.join(A, 'ad.png'), result: {},
  }, 'kept');
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('new') }] }); };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-u4', outPath: 'ad.png' }, inProject(A)), /different image request/);
  assert.equal(posts, 0);
});

test('upgrade: a KIE task the earlier journal accepted is collected in its project, never created again', async () => {
  const { deps, env, A, B, inProject } = await sandbox('kie', { SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  const refs = ['https://cdn.example/logo.png'];
  await seedLegacy(env, 'claim-u5', {
    provider: 'KIE', fingerprint: legacyKie('p', refs), state: 'accepted', taskId: 'task-old', model: 'nano-banana-pro', outPath: path.join(A, 'ad.png'),
  });
  let creates = 0;
  const polled = [];
  deps.fetch = async (url) => {
    if (url.endsWith('/createTask')) { creates++; return res(200, { code: 200, data: { taskId: 'task-new' } }); }
    if (url.includes('/recordInfo')) {
      polled.push(new URL(url).searchParams.get('taskId'));
      return res(200, { data: { state: 'success', resultJson: { resultUrls: ['https://tempfile.example/old.png'] } } });
    }
    return res(200, null, { arrayBuffer: async () => Buffer.from('kie old task') });
  };
  const args = { prompt: 'p', references: refs, operationId: 'claim-u5', outPath: 'ad.png' };
  await assert.rejects(callTool('make_image', args, inProject(B)), /earlier version/);
  const a = await callTool('make_image', args, inProject(A));
  assert.equal(a.resumed, true);
  assert.deepEqual(polled, ['task-old']);
  assert.equal(String(await fs.readFile(path.join(A, 'ad.png'))), 'kie old task');
  assert.equal(creates, 0, 'zero new submissions');
});

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
