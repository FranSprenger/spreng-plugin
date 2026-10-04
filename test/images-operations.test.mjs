// spreng-images: one operation id buys at most one image. The paid routes (OpenAI and KIE) reserve the operation
// on disk before the paid call, keep unclear and finished outcomes, and answer a repeat of the same operation
// from what is kept instead of paying again. All calls are mocks: no paid call is made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../plugins/spreng-images/server/server.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const PNG2 = Buffer.concat([PNG, Buffer.from('second')]);
const OPENAI_KEY = 'sk-test-openai-0000000000000000';
const KIE_KEY = 'kie-test-key-1111111111111111';

async function sandbox(source, extraEnv = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spreng-ops-'));
  const env = { CLAUDE_PLUGIN_DATA: path.join(dir, 'data'), CLAUDE_PROJECT_DIR: path.join(dir, 'project'), PATH: '', ...extraEnv };
  const deps = {
    env, fs, homedir: () => dir, now: () => new Date('2026-10-04T12:00:00Z'), sleep: async () => {},
    fetch: async () => { throw new Error('unexpected fetch'); },
    run: async () => { throw new Error('unexpected run'); },
  };
  await callTool('set_image_source', { source }, deps);
  return { dir, env, deps };
}
const res = (status, body, extra = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => PNG, headers: { get: () => 'image/png' }, ...extra });
/** Lets both concurrent calls run up to the paid call (real file I/O) before the paid answer is released. */
const settle = () => new Promise((r) => setTimeout(r, 100));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

// ---------- OpenAI ----------

function openaiFetch(counter, { body = () => ({ data: [{ b64_json: PNG.toString('base64') }] }), wait } = {}) {
  return async (url) => {
    assert.match(url, /^https:\/\/api\.openai\.com\/v1\/images\//);
    counter.posts++;
    if (wait) await wait;
    return res(200, body(counter.posts));
  };
}

test('openai: the same operationId again returns the image already made, with no second paid call', async () => {
  const { deps } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const c = { posts: 0 };
  deps.fetch = openaiFetch(c);
  const first = await callTool('make_image', { prompt: 'p', operationId: 'claim-1', outPath: 'a.png' }, deps);
  const again = await callTool('make_image', { prompt: 'p', operationId: 'claim-1', outPath: 'a.png' }, deps);
  assert.equal(c.posts, 1, 'one paid call for one operation');
  assert.equal(again.replayed, true);
  assert.equal(again.path, first.path);
  assert.deepEqual(await fs.readFile(again.path), PNG);
});

test('openai: concurrent calls with one operationId send one paid call', async () => {
  const { deps } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const c = { posts: 0 };
  const g = gate();
  deps.fetch = openaiFetch(c, { wait: g.p });
  const both = Promise.allSettled([
    callTool('make_image', { prompt: 'p', operationId: 'claim-2' }, deps),
    callTool('make_image', { prompt: 'p', operationId: 'claim-2' }, deps),
  ]);
  await settle();
  g.open();
  const results = await both;
  assert.equal(c.posts, 1, 'the second call never reaches OpenAI');
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const refused = results.find((r) => r.status === 'rejected');
  assert.match(refused.reason.message, /claim-2.*(in progress|unclear)/);
});

test('openai: a lost response is kept as unclear; the same operationId is not sent again', async () => {
  const { deps } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, null, { json: async () => { throw new Error('terminated'); } }); };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-3' }, deps), /unclear/);
  deps.fetch = async () => { posts++; throw new Error('socket hang up'); };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-3' }, deps), /claim-3.*unclear/);
  assert.equal(posts, 1, 'no second paid call after a lost answer');
});

test('openai: a network error on the paid call is unclear and never resent under the same operationId', async () => {
  const { deps } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  let posts = 0;
  deps.fetch = async () => { posts++; throw new Error('socket hang up'); };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-4' }, deps), /unclear/);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-4' }, deps), /unclear/);
  assert.equal(posts, 1);
});

test('openai: a failed file write after a paid answer keeps the image; the same operationId saves it with no second call', async () => {
  const { deps, env } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const c = { posts: 0 };
  deps.fetch = openaiFetch(c);
  const target = path.join(env.CLAUDE_PROJECT_DIR, 'out.png');
  let failOnce = true;
  deps.fs = { ...fs, writeFile: async (p, ...rest) => {
    if (p === target && failOnce) { failOnce = false; throw new Error('ENOSPC: no space left on device'); }
    return fs.writeFile(p, ...rest);
  }, copyFile: async (from, to, ...rest) => {
    if (to === target && failOnce) { failOnce = false; throw new Error('ENOSPC: no space left on device'); }
    return fs.copyFile(from, to, ...rest);
  } };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-5', outPath: 'out.png' }, deps), /ENOSPC/);
  const out = await callTool('make_image', { prompt: 'p', operationId: 'claim-5', outPath: 'out.png' }, deps);
  assert.equal(c.posts, 1, 'the paid image is not bought again');
  assert.equal(out.path, target);
  assert.deepEqual(await fs.readFile(target), PNG);
});

test('openai: a new operationId buys a new image; the same id with a different prompt is refused', async () => {
  const { deps } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const c = { posts: 0 };
  deps.fetch = openaiFetch(c);
  await callTool('make_image', { prompt: 'p', operationId: 'claim-6' }, deps);
  await assert.rejects(callTool('make_image', { prompt: 'another prompt', operationId: 'claim-6' }, deps), /claim-6.*different/);
  assert.equal(c.posts, 1);
  await callTool('make_image', { prompt: 'p', operationId: 'claim-7' }, deps);
  assert.equal(c.posts, 2);
});

test('openai: without an operationId the same request is still one operation', async () => {
  const { deps } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const c = { posts: 0 };
  deps.fetch = openaiFetch(c);
  await callTool('make_image', { prompt: 'p', outPath: 'same.png' }, deps);
  const again = await callTool('make_image', { prompt: 'p', outPath: 'same.png' }, deps);
  assert.equal(c.posts, 1);
  assert.equal(again.replayed, true);
});

test('openai: a refused request (HTTP 400) charged nothing, so the same operationId may be sent again', async () => {
  const { deps } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  let posts = 0;
  deps.fetch = async () => { posts++; return posts === 1 ? res(400, { error: { message: 'bad size' } }) : res(200, { data: [{ b64_json: PNG.toString('base64') }] }); };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-8' }, deps), /HTTP 400.*bad size/);
  const out = await callTool('make_image', { prompt: 'p', operationId: 'claim-8' }, deps);
  assert.equal(posts, 2);
  assert.deepEqual(await fs.readFile(out.path), PNG);
});

test('openai: an HTTP 500 answer is unclear and kept', async () => {
  const { deps } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  let posts = 0;
  deps.fetch = async () => { posts++; return res(500, { error: { message: 'server error' } }); };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-9' }, deps), /unclear/);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-9' }, deps), /unclear/);
  assert.equal(posts, 1);
});

// ---------- KIE ----------

function kieFetch(state, { createWait, createAnswer } = {}) {
  return async (url) => {
    if (url.endsWith('/createTask')) {
      state.creates++;
      if (createWait) await createWait;
      if (createAnswer) return createAnswer(state.creates);
      return res(200, { code: 200, data: { taskId: `task_${state.creates}` } });
    }
    if (url.includes('/recordInfo')) {
      state.polls.push(url.split('taskId=')[1]);
      return res(200, { data: { state: 'success', resultJson: { resultUrls: [`https://tempfile.example/${url.split('taskId=')[1]}.png`] } } });
    }
    if (url.startsWith('https://tempfile.example/')) return res(200, null, { arrayBuffer: async () => (url.includes('task_1') ? PNG : PNG2) });
    throw new Error(url);
  };
}

test('kie: concurrent calls with one operationId create one task', async () => {
  const { deps } = await sandbox('kie', { SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  const s = { creates: 0, polls: [] };
  const g = gate();
  deps.fetch = kieFetch(s, { createWait: g.p });
  const both = Promise.allSettled([
    callTool('make_image', { prompt: 'p', operationId: 'claim-k1' }, deps),
    callTool('make_image', { prompt: 'p', operationId: 'claim-k1' }, deps),
  ]);
  await settle();
  g.open();
  const results = await both;
  assert.equal(s.creates, 1, 'one paid create');
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const refused = results.find((r) => r.status === 'rejected');
  assert.match(refused.reason.message, /claim-k1.*(in progress|unclear)/);
});

test('kie: the same operationId after completion returns the finished image, with no second create', async () => {
  const { deps } = await sandbox('kie', { SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  const s = { creates: 0, polls: [] };
  deps.fetch = kieFetch(s);
  const first = await callTool('make_image', { prompt: 'p', operationId: 'claim-k2' }, deps);
  const again = await callTool('make_image', { prompt: 'p', operationId: 'claim-k2' }, deps);
  assert.equal(s.creates, 1);
  assert.equal(again.replayed, true);
  assert.equal(again.taskId, 'task_1');
  assert.equal(again.path, first.path);
  assert.deepEqual(await fs.readFile(again.path), PNG);
  const other = await callTool('make_image', { prompt: 'p', operationId: 'claim-k3' }, deps);
  assert.equal(s.creates, 2, 'a new operationId is a new purchase');
  assert.equal(other.taskId, 'task_2');
});

test('kie: an ambiguous create answer (HTTP 200 without a task id) is kept as unclear and never resent', async () => {
  const { deps } = await sandbox('kie', { SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  const s = { creates: 0, polls: [] };
  deps.fetch = kieFetch(s, { createAnswer: () => res(200, { data: {} }) });
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-k4' }, deps), /unclear/);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-k4' }, deps), /claim-k4.*unclear/);
  assert.equal(s.creates, 1);
});

test('kie: an HTTP 502 create answer is unclear and never resent', async () => {
  const { deps } = await sandbox('kie', { SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  const s = { creates: 0, polls: [] };
  deps.fetch = kieFetch(s, { createAnswer: () => res(502, null) });
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-k5' }, deps), /unclear/);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-k5' }, deps), /unclear/);
  assert.equal(s.creates, 1);
});

test('kie: a clear refusal (code 402, no credits) charged nothing, so the same operationId may be sent again', async () => {
  const { deps } = await sandbox('kie', { SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  const s = { creates: 0, polls: [] };
  deps.fetch = kieFetch(s, { createAnswer: (n) => (n === 1 ? res(200, { code: 402, msg: 'Credits insufficient' }) : res(200, { code: 200, data: { taskId: 'task_1' } })) });
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-k6' }, deps), /did not accept.*Credits insufficient/);
  const out = await callTool('make_image', { prompt: 'p', operationId: 'claim-k6' }, deps);
  assert.equal(s.creates, 2);
  assert.equal(out.taskId, 'task_1');
});

test('kie: a task that failed on KIE is kept; the same operationId reports it without a new create', async () => {
  const { deps } = await sandbox('kie', { SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  let creates = 0;
  deps.fetch = async (url) => {
    if (url.endsWith('/createTask')) { creates++; return res(200, { code: 200, data: { taskId: `task_${creates}` } }); }
    if (url.includes('/recordInfo')) return res(200, { data: { state: 'fail', failMsg: 'content filtered' } });
    throw new Error(url);
  };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-k7' }, deps), /content filtered/);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-k7' }, deps), /claim-k7.*failed.*content filtered.*new operationId/);
  assert.equal(creates, 1);
});
