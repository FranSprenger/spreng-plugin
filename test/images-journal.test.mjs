// spreng-images: the one operation journal across every route, per-request work folders, and delivery checked by
// content. All calls are mocks: no paid call and no real codex run is made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../plugins/spreng-images/server/server.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const OPENAI_KEY = 'sk-test-openai-0000000000000000';
const KIE_KEY = 'kie-test-key-1111111111111111';
const FIXED = new Date('2026-10-04T12:00:00Z');

async function sandbox(source, extraEnv = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spreng-journal-'));
  const env = {
    CLAUDE_PLUGIN_DATA: path.join(dir, 'data'), CLAUDE_PROJECT_DIR: path.join(dir, 'project'), CODEX_HOME: path.join(dir, 'codex'), PATH: '',
    ...extraEnv,
  };
  const deps = {
    env, fs, homedir: () => dir, now: () => FIXED, sleep: async () => {},
    fetch: async () => { throw new Error('unexpected fetch'); },
    run: async () => { throw new Error('unexpected run'); },
  };
  await callTool('set_image_source', { source }, deps);
  return { dir, env, deps };
}
const res = (status, body, extra = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => PNG, headers: { get: () => 'image/png' }, ...extra,
});
const settle = () => new Promise((r) => setTimeout(r, 100));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const b64 = (s) => Buffer.from(s).toString('base64');

// ---------- one journal for every route ----------

function codexRun(env, counter, { wait, bytes = PNG } = {}) {
  return async () => {
    counter.runs++;
    const n = counter.runs;
    if (wait) await wait;
    const made = path.join(env.CODEX_HOME, 'generated_images', `thread-${n}`, 'exec.png');
    await fs.mkdir(path.dirname(made), { recursive: true });
    await fs.writeFile(made, bytes);
    return { code: 0, stdout: `{"type":"thread.started","thread_id":"thread-${n}"}\n`, stderr: '' };
  };
}

test('codex: concurrent calls with one operationId run codex once', async () => {
  const { deps, env } = await sandbox('codex');
  const c = { runs: 0 };
  const g = gate();
  deps.run = codexRun(env, c, { wait: g.p });
  const both = Promise.allSettled([
    callTool('make_image', { prompt: 'p', operationId: 'claim-c1' }, deps),
    callTool('make_image', { prompt: 'p', operationId: 'claim-c1' }, deps),
  ]);
  await settle();
  g.open();
  const results = await both;
  assert.equal(c.runs, 1, 'one codex run for one operation');
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(results.find((r) => r.status === 'rejected').reason.message, /claim-c1.*in progress/);
});

test('codex: the same operationId after completion returns the kept image without running codex again', async () => {
  const { deps, env } = await sandbox('codex');
  const c = { runs: 0 };
  deps.run = codexRun(env, c);
  const first = await callTool('make_image', { prompt: 'p', operationId: 'claim-c2', outPath: 'c2.png' }, deps);
  const again = await callTool('make_image', { prompt: 'p', operationId: 'claim-c2', outPath: 'c2.png' }, deps);
  assert.equal(c.runs, 1);
  assert.equal(again.replayed, true);
  assert.equal(again.path, first.path);
  assert.deepEqual(await fs.readFile(again.path), PNG);
  await callTool('make_image', { prompt: 'p', operationId: 'claim-c3' }, deps);
  assert.equal(c.runs, 2, 'a new operationId is a new image');
});

test('codex: a run that left no image frees the operation, so the same operationId may run again', async () => {
  const { deps, env } = await sandbox('codex');
  let runs = 0;
  deps.run = async () => { runs++; return { code: 1, stdout: '', stderr: 'not signed in' }; };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-c4' }, deps), /exited 1.*not signed in/);
  const c = { runs: 0 };
  deps.run = codexRun(env, c);
  const out = await callTool('make_image', { prompt: 'p', operationId: 'claim-c4' }, deps);
  assert.equal(runs + c.runs, 2);
  assert.deepEqual(await fs.readFile(out.path), PNG);
});

test('kie: concurrent collections of one kieTaskId check KIE once', async () => {
  const { deps } = await sandbox('kie', { SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  let polls = 0;
  let creates = 0;
  const g = gate();
  deps.fetch = async (url) => {
    if (url.endsWith('/createTask')) { creates++; return res(200, { code: 200, data: { taskId: 'x' } }); }
    if (url.includes('/recordInfo')) { polls++; await g.p; return res(200, { data: { state: 'success', resultJson: { resultUrls: ['https://tempfile.example/r.png'] } } }); }
    return res(200, null);
  };
  const both = Promise.allSettled([
    callTool('make_image', { prompt: 'p', kieTaskId: 'task_77' }, deps),
    callTool('make_image', { prompt: 'p', kieTaskId: 'task_77' }, deps),
  ]);
  await settle();
  g.open();
  const results = await both;
  assert.equal(creates, 0);
  assert.equal(polls, 1, 'one collection of the task');
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const again = await callTool('make_image', { prompt: 'p', kieTaskId: 'task_77' }, deps);
  assert.equal(polls, 1, 'a collected task is returned from what is kept');
  assert.equal(again.replayed, true);
  assert.deepEqual(await fs.readFile(again.path), PNG);
});

// ---------- per-request work folders ----------

test('openai: concurrent requests with the same clock keep their own reference files', async () => {
  const { deps, env } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  // Both requests download their reference before either reads it back, the order that mixed them before.
  let refWrites = 0;
  const bothWritten = gate();
  deps.fs = {
    ...fs,
    writeFile: async (p, ...rest) => {
      const out = await fs.writeFile(p, ...rest);
      if (/reference-/.test(String(p)) && ++refWrites === 2) bothWritten.open();
      return out;
    },
    readFile: async (p, ...rest) => {
      if (/reference-/.test(String(p))) await bothWritten.p;
      return fs.readFile(p, ...rest);
    },
  };
  const sent = {};
  deps.fetch = async (url, init) => {
    if (url.startsWith('https://refs.example/')) {
      const who = url.endsWith('a.png') ? 'client-A' : 'client-B';
      return res(200, null, { arrayBuffer: async () => Buffer.from(who) });
    }
    assert.match(url, /\/v1\/images\/edits$/);
    const blob = init.body.get('image[]');
    sent[init.body.get('prompt')] = Buffer.from(await blob.arrayBuffer()).toString();
    return res(200, { data: [{ b64_json: b64(`image for ${init.body.get('prompt')}`) }] });
  };
  await Promise.all([
    callTool('make_image', { prompt: 'A', references: ['https://refs.example/a.png'], operationId: 'ref-a' }, deps),
    callTool('make_image', { prompt: 'B', references: ['https://refs.example/b.png'], operationId: 'ref-b' }, deps),
  ]);
  assert.deepEqual(sent, { A: 'client-A', B: 'client-B' }, 'each request sent only its own reference');
  const work = path.join(env.CLAUDE_PLUGIN_DATA, 'work');
  const left = await fs.readdir(work).catch(() => []);
  assert.deepEqual(left, [], 'downloaded references are removed after the request');
});

test('codex: concurrent requests attach different reference files', async () => {
  const { deps, env } = await sandbox('codex');
  deps.fetch = async (url) => res(200, null, { arrayBuffer: async () => Buffer.from(url) });
  const attached = [];
  let n = 0;
  const g = gate();
  deps.run = async (_cmd, args) => {
    const i = ++n;
    const ref = args[args.indexOf('-i') + 1];
    if (i === 1) await g.p; else g.open();
    attached.push(String(await fs.readFile(ref)));
    const made = path.join(env.CODEX_HOME, 'generated_images', `t${i}`, 'exec.png');
    await fs.mkdir(path.dirname(made), { recursive: true });
    await fs.writeFile(made, PNG);
    return { code: 0, stdout: `{"type":"thread.started","thread_id":"t${i}"}\n`, stderr: '' };
  };
  await Promise.all([
    callTool('make_image', { prompt: 'A', references: ['https://refs.example/a.png'], operationId: 'cx-a' }, deps),
    callTool('make_image', { prompt: 'B', references: ['https://refs.example/b.png'], operationId: 'cx-b' }, deps),
  ]);
  assert.deepEqual(attached.sort(), ['https://refs.example/a.png', 'https://refs.example/b.png']);
});

test('openai: two requests without outPath at the same moment save to two files', async () => {
  const { deps } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  deps.fetch = async (_url, init) => res(200, { data: [{ b64_json: b64(`made from ${JSON.parse(init.body).prompt}`) }] });
  const [a, b] = await Promise.all([
    callTool('make_image', { prompt: 'one', operationId: 'd-1' }, deps),
    callTool('make_image', { prompt: 'two', operationId: 'd-2' }, deps),
  ]);
  assert.notEqual(a.path, b.path);
  assert.equal(String(await fs.readFile(a.path)), 'made from one');
  assert.equal(String(await fs.readFile(b.path)), 'made from two');
});

// ---------- delivery checked by content ----------

test('a new image replaces an equal-size file already at outPath', async () => {
  const { deps, env } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const target = path.join(env.CLAUDE_PROJECT_DIR, 'same-size.png');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'OLD!');
  deps.fetch = async () => res(200, { data: [{ b64_json: b64('NEW!') }] });
  const out = await callTool('make_image', { prompt: 'p', operationId: 'h-1', outPath: 'same-size.png' }, deps);
  assert.equal(String(await fs.readFile(out.path)), 'NEW!');
});

test('a replay rewrites outPath when an equal-size different file took its place', async () => {
  const { deps } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('NEW!') }] }); };
  const first = await callTool('make_image', { prompt: 'p', operationId: 'h-2', outPath: 'h2.png' }, deps);
  await fs.writeFile(first.path, 'OLD!');
  const again = await callTool('make_image', { prompt: 'p', operationId: 'h-2', outPath: 'h2.png' }, deps);
  assert.equal(posts, 1);
  assert.equal(String(await fs.readFile(again.path)), 'NEW!');
});

test('a kept image that no longer matches its record is never delivered', async () => {
  const { deps, env } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  deps.fetch = async () => res(200, { data: [{ b64_json: b64('NEW!') }] });
  const first = await callTool('make_image', { prompt: 'p', operationId: 'h-3', outPath: 'h3.png' }, deps);
  const opsDir = path.join(env.CLAUDE_PLUGIN_DATA, 'operations');
  const kept = (await fs.readdir(opsDir)).find((f) => f.endsWith('.image'));
  await fs.writeFile(path.join(opsDir, kept), 'BAD!');
  await fs.rm(first.path);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'h-3', outPath: 'h3.png' }, deps), /does not match/);
  await assert.rejects(fs.access(first.path), 'nothing wrong was written');
});
