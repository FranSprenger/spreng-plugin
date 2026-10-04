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
// What every earlier version kept as the result of a completed OpenAI image (its madeBy names the model).
const OPENAI_RESULT = { source: 'openai', madeBy: "OpenAI gpt-image-2 on the user's key" };
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

test('upgrade: a completed earlier record with a given id names no project, so it stays unresolved everywhere: no replay, nothing sent', async () => {
  const { deps, env, A, B, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  // The earlier server saved outPath inside project A, but an image path is no proof of the project (a parent
  // folder contains it too), and the record names no project.
  await seedLegacy(env, 'claim-u3', {
    provider: 'OpenAI', fingerprint: legacyOpenAI('p'), state: 'completed', outPath: path.join(A, 'ad.png'), result: OPENAI_RESULT,
  }, 'kept-image-A');
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('new') }] }); };
  const args = { prompt: 'p', operationId: 'claim-u3', outPath: 'ad.png' };
  await assert.rejects(callTool('make_image', args, inProject(A)), /earlier version/);
  await assert.rejects(callTool('make_image', args, inProject(B)), /earlier version/);
  await assert.rejects(fs.access(path.join(B, 'ad.png')), 'project B never receives project A\'s image');
  await assert.rejects(callTool('make_image', args, inProject(A)), /earlier version/, 'still unresolved the second time');
  assert.equal(posts, 0, 'zero new submissions');
});

test('upgrade: an earlier given-id record for a different request is refused, not resent', async () => {
  const { deps, env, A, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  await seedLegacy(env, 'claim-u4', {
    provider: 'OpenAI', fingerprint: legacyOpenAI('another prompt'), state: 'completed', outPath: path.join(A, 'ad.png'), result: OPENAI_RESULT,
  }, 'kept');
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('new') }] }); };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-u4', outPath: 'ad.png' }, inProject(A)), /earlier version/);
  assert.equal(posts, 0);
});

test('upgrade: a KIE task the earlier journal accepted under a given id is never created again, nor collected for any project', async () => {
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
  await assert.rejects(callTool('make_image', args, inProject(A)), /earlier version/);
  assert.deepEqual(polled, [], 'the earlier task is not collected for a project the record does not name');
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

// ---------- automatic operation ids from earlier versions (no operationId given) ----------
// Each earlier version derived the id with its own fields, field for field as below, and kept the record in a file
// named by sha('op:' + id). Upgrading must find those records under the id that version derived.

const autoId = (fields) => 'auto-' + sha(JSON.stringify(fields)).slice(0, 16);
// f0e3ddf and 066b539: no project; references as typed.
const autoV2 = ({ source, model, prompt, references = [], aspectRatio = null, size = null, outPath = null }) => autoId({ source, model, prompt, references, aspectRatio, size, outPath });
// 816c1ae (references as typed) and a15c7cd (references resolved against the project): the canonical project folder.
const autoV3 = ({ source, model, project, prompt, references = [], aspectRatio = null, size = null, outPath = null }) => autoId({ source, model, project, prompt, references, aspectRatio, size, outPath });
// ac007f2: KIE only, no source and no project, records in kie-operations/.
const autoKieV1 = ({ model, prompt, references = [], aspectRatio = null, outPath = null }) => autoId({ model, prompt, references, aspectRatio, outPath });

async function seedAt(env, dirName, operationId, record, image) {
  const dir = path.join(env.CLAUDE_PLUGIN_DATA, dirName);
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, sha('op:' + operationId).slice(0, 32));
  const rec = { operationId, reservedAt: '2026-10-03T10:00:00.000Z', ...record };
  if (image) {
    await fs.writeFile(`${base}.image`, image);
    Object.assign(rec, { resultFile: `${base}.image`, resultSha256: sha(image) });
  }
  await fs.writeFile(`${base}.json`, JSON.stringify(rec, null, 2));
}

test('upgrade: a completed automatic-id OpenAI request from before project scoping is not sent again (with and without a typed reference)', async () => {
  const { deps, env, A, B, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  await fs.mkdir(path.join(A, 'brand'), { recursive: true });
  await fs.writeFile(path.join(A, 'brand', 'logo.png'), 'logo');
  const plain = { prompt: 'p', outPath: 'ad.png' };
  const withRef = { prompt: 'q', references: ['brand/logo.png'], outPath: 'ad2.png' };
  await seedAt(env, 'operations', autoV2({ source: 'openai', model: 'gpt-image-2', prompt: 'p', outPath: 'ad.png' }), {
    provider: 'OpenAI', fingerprint: legacyOpenAI('p'), state: 'completed', outPath: path.join(A, 'ad.png'), result: OPENAI_RESULT,
  }, 'kept-p');
  await seedAt(env, 'operations', autoV2({ source: 'openai', model: 'gpt-image-2', prompt: 'q', references: ['brand/logo.png'], outPath: 'ad2.png' }), {
    provider: 'OpenAI', fingerprint: legacyOpenAI('q', ['brand/logo.png']), state: 'completed', outPath: path.join(A, 'ad2.png'), result: OPENAI_RESULT,
  }, 'kept-q');
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('new') }] }); };
  // No project is named in these records, so they stay unresolved: no replay and no new submission, in any project.
  await assert.rejects(callTool('make_image', plain, inProject(A)), /earlier version/);
  await assert.rejects(callTool('make_image', withRef, inProject(A)), /earlier version/);
  await assert.rejects(callTool('make_image', plain, inProject(B)), /earlier version/);
  await assert.rejects(fs.access(path.join(B, 'ad.png')));
  assert.equal(posts, 0, 'zero new provider submissions after the upgrade');
});

test('upgrade: an automatic-id request from the project-scoped versions is replayed in its own project (typed and resolved reference forms)', async () => {
  const { deps, env, A, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  await fs.mkdir(path.join(A, 'brand'), { recursive: true });
  await fs.writeFile(path.join(A, 'brand', 'logo.png'), 'logo');
  const project = await fs.realpath(A);
  const resolved = path.join(project, 'brand', 'logo.png');
  // 816c1ae: references as typed.
  await seedAt(env, 'operations', autoV3({ source: 'openai', model: 'gpt-image-2', project, prompt: 'p', references: ['brand/logo.png'], outPath: 'ad.png' }), {
    provider: 'OpenAI', fingerprint: legacyOpenAI('p', ['brand/logo.png']), state: 'completed', outPath: path.join(A, 'ad.png'), result: OPENAI_RESULT,
  }, 'kept-typed');
  // a15c7cd: references resolved against the project.
  await seedAt(env, 'operations', autoV3({ source: 'openai', model: 'gpt-image-2', project, prompt: 'q', references: [resolved], outPath: 'ad2.png' }), {
    provider: 'OpenAI', fingerprint: legacyOpenAI('q', [resolved]), state: 'completed', outPath: path.join(A, 'ad2.png'), result: OPENAI_RESULT,
  }, 'kept-resolved');
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('new') }] }); };
  const a = await callTool('make_image', { prompt: 'p', references: ['brand/logo.png'], outPath: 'ad.png' }, inProject(A));
  assert.equal(a.replayed, true);
  assert.equal(String(await fs.readFile(path.join(A, 'ad.png'))), 'kept-typed');
  const b = await callTool('make_image', { prompt: 'q', references: ['brand/logo.png'], outPath: 'ad2.png' }, inProject(A));
  assert.equal(b.replayed, true);
  assert.equal(String(await fs.readFile(path.join(A, 'ad2.png'))), 'kept-resolved');
  assert.equal(posts, 0, 'zero new provider submissions after the upgrade');
});

test('upgrade: a codex run with an automatic id from before project scoping is never run again', async () => {
  const { deps, env, A, inProject } = await sandbox('codex');
  await seedAt(env, 'operations', autoV2({ source: 'codex', model: 'codex', prompt: 'p' }), {
    provider: 'Codex CLI', fingerprint: sha(JSON.stringify({ source: 'codex', prompt: 'p', references: [] })), state: 'submitting',
  });
  let runs = 0;
  deps.run = async () => { runs++; return { code: 0, stdout: '', stderr: '' }; };
  await assert.rejects(callTool('make_image', { prompt: 'p' }, inProject(A)), /earlier version/);
  assert.equal(runs, 0);
});

test('upgrade: a KIE task accepted by the first journal (kie-operations/, automatic or given id) is never created again', async () => {
  const { deps, env, A, inProject } = await sandbox('kie', { SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  const refs = ['https://cdn.example/logo.png'];
  await seedAt(env, 'kie-operations', autoKieV1({ model: 'nano-banana-pro', prompt: 'p', references: refs, outPath: 'ad.png' }), {
    taskId: 'task-auto', model: 'nano-banana-pro', outPath: path.join(A, 'ad.png'), acceptedAt: '2026-10-03T10:00:00.000Z',
  });
  await seedAt(env, 'kie-operations', 'claim-k1', {
    taskId: 'task-given', model: 'nano-banana-pro', outPath: path.join(A, 'ad3.png'), acceptedAt: '2026-10-03T10:00:00.000Z',
  });
  let creates = 0;
  deps.fetch = async (url) => {
    if (url.endsWith('/createTask')) { creates++; return res(200, { code: 200, data: { taskId: 'task-new' } }); }
    return res(200, { data: { state: 'success', resultJson: { resultUrls: ['https://tempfile.example/x.png'] } } });
  };
  await assert.rejects(callTool('make_image', { prompt: 'p', references: refs, outPath: 'ad.png' }, inProject(A)), /earlier version/);
  await assert.rejects(callTool('make_image', { prompt: 'p', references: refs, operationId: 'claim-k1', outPath: 'ad3.png' }, inProject(A)), /earlier version/);
  assert.equal(creates, 0, 'zero new KIE creates');
});

// ---------- nested projects ----------

test('nested projects: an earlier record whose image sits in /clients/A is never replayed for /clients, and nothing is sent', async () => {
  const { deps, env, dir, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const parent = path.join(dir, 'clients');
  const child = path.join(parent, 'A');
  await fs.mkdir(child, { recursive: true });
  await seedLegacy(env, 'claim-n1', {
    provider: 'OpenAI', fingerprint: legacyOpenAI('p'), state: 'completed', outPath: path.join(child, 'ad.png'), result: OPENAI_RESULT,
  }, 'child-image');
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('new') }] }); };
  for (const args of [{ prompt: 'p', operationId: 'claim-n1', outPath: 'A/ad.png' }, { prompt: 'p', operationId: 'claim-n1', outPath: 'ad.png' }]) {
    await assert.rejects(callTool('make_image', args, inProject(parent)), /earlier version/);
  }
  await assert.rejects(fs.access(path.join(parent, 'ad.png')), 'the parent project never receives the child project\'s image');
  assert.equal(posts, 0);
});

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

test('nested projects: an automatic-id record made in /clients/A (project-scoped versions) is never replayed for /clients', async () => {
  const { deps, env, dir, inProject } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const parent = path.join(dir, 'clients');
  const child = path.join(parent, 'A');
  await fs.mkdir(child, { recursive: true });
  const project = await fs.realpath(child);
  await seedAt(env, 'operations', autoV3({ source: 'openai', model: 'gpt-image-2', project, prompt: 'p', outPath: 'ad.png' }), {
    provider: 'OpenAI', fingerprint: legacyOpenAI('p'), state: 'completed', outPath: path.join(child, 'ad.png'), result: OPENAI_RESULT,
  }, 'child-image');
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('parent image') }] }); };
  const p = await callTool('make_image', { prompt: 'p', outPath: 'ad.png' }, inProject(parent));
  assert.notEqual(p.replayed, true);
  assert.equal(String(await fs.readFile(path.join(parent, 'ad.png'))), 'parent image', 'the parent never receives the child project\'s image');
  assert.equal(posts, 1, 'the parent request is its own operation');
  const c = await callTool('make_image', { prompt: 'p', outPath: 'ad.png' }, inProject(child));
  assert.equal(c.replayed, true);
  assert.equal(String(await fs.readFile(path.join(child, 'ad.png'))), 'child-image');
  assert.equal(posts, 1, 'the child request is replayed, not sent again');
});
