// spreng-images: the one operation journal across every route, per-request work folders, and delivery checked by
// content. All calls are mocks: no paid call and no real codex run is made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callTool, runProcess } from '../plugins/spreng-images/server/server.mjs';

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

test('codex: an image saved before codex exits nonzero is never made twice for the same operationId', async () => {
  const { deps, env } = await sandbox('codex');
  let runs = 0;
  deps.run = async () => {
    runs++;
    // Codex made and saved the image, then the process failed (a timeout or a lost answer looks the same).
    const made = path.join(env.CODEX_HOME, 'generated_images', `thread-${runs}`, 'exec.png');
    await fs.mkdir(path.dirname(made), { recursive: true });
    await fs.writeFile(made, PNG);
    return { code: 1, stdout: `{"type":"thread.started","thread_id":"thread-${runs}"}\n`, stderr: 'stream disconnected' };
  };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-c4' }, deps), /exited 1.*stream disconnected.*not run again/s);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-c4' }, deps), /claim-c4.*unclear/s);
  assert.equal(runs, 1, 'the retry does not run codex again');
});

test('codex: a codex that never ran at all, or a thrown run, keep the right state', async () => {
  const { deps, env } = await sandbox('codex', { SPRENG_IMAGES_CODEX_BIN: '/nonexistent/spreng-test-codex' });
  // Proven before submission: the real process runner could not start the program, so the operation is free again.
  deps.run = runProcess;
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-c5' }, deps), /could not be started.*ENOENT/s);
  const c = { runs: 0 };
  deps.run = codexRun(env, c);
  const out = await callTool('make_image', { prompt: 'p', operationId: 'claim-c5' }, deps);
  assert.equal(c.runs, 1);
  assert.deepEqual(await fs.readFile(out.path), PNG);
  // A run whose answer was lost after it started is unclear and never run again.
  let runs = 0;
  deps.run = async () => { runs++; throw new Error('lost'); };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-c6' }, deps), /lost/);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-c6' }, deps), /claim-c6.*unclear/s);
  assert.equal(runs, 1);
});

test('the same request in two projects that share plugin data makes two images, one in each project', async () => {
  const { deps, env, dir } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  let calls = 0;
  deps.fetch = async () => { calls++; return res(200, { data: [{ b64_json: b64(`image-${calls}`) }] }); };
  const projectA = path.join(dir, 'A');
  const projectB = path.join(dir, 'B');
  await fs.mkdir(projectA, { recursive: true });
  await fs.mkdir(projectB, { recursive: true });
  const a = await callTool('make_image', { prompt: 'same', outPath: 'ad.png' }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: projectA } });
  const b = await callTool('make_image', { prompt: 'same', outPath: 'ad.png' }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: projectB } });
  assert.equal(calls, 2, 'project B gets its own image');
  assert.equal(b.replayed, undefined);
  assert.equal(await fs.realpath(path.dirname(a.path)), await fs.realpath(projectA));
  assert.equal(await fs.realpath(path.dirname(b.path)), await fs.realpath(projectB));
  assert.equal(String(await fs.readFile(path.join(projectA, 'ad.png'))), 'image-1');
  assert.equal(String(await fs.readFile(path.join(projectB, 'ad.png'))), 'image-2');
  // The same project reached through a symlink is the same project: the request is replayed, not bought again.
  const linkA = path.join(dir, 'link-to-A');
  await fs.symlink(projectA, linkA);
  const again = await callTool('make_image', { prompt: 'same', outPath: 'ad.png' }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: linkA } });
  assert.equal(calls, 2);
  assert.equal(again.replayed, true);
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
  const opsDir = path.join(env.CLAUDE_PLUGIN_DATA, 'operations-v1');
  const kept = (await fs.readdir(opsDir)).find((f) => f.endsWith('.image'));
  await fs.writeFile(path.join(opsDir, kept), 'BAD!');
  await fs.rm(first.path);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'h-3', outPath: 'h3.png' }, deps), /does not match/);
  await assert.rejects(fs.access(first.path), 'nothing wrong was written');
});

// ---------- local reference paths belong to the project ----------

/** Projects A and B each hold their own logo.png, and this process works from a third folder with another one. */
async function twoProjects(dir) {
  const projectA = path.join(dir, 'client-a');
  const projectB = path.join(dir, 'client-b');
  const elsewhere = path.join(dir, 'server-cwd');
  for (const [d, who] of [[projectA, 'logo-A'], [projectB, 'logo-B'], [elsewhere, 'logo-SERVER']]) {
    await fs.mkdir(path.join(d, 'brand'), { recursive: true });
    await fs.writeFile(path.join(d, 'brand', 'logo.png'), who);
  }
  const before = process.cwd();
  process.chdir(elsewhere);
  return { projectA, projectB, restore: () => process.chdir(before) };
}

test('openai: a relative reference is read from its own project, never from the server working folder', async () => {
  const { deps, env, dir } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const { projectA, projectB, restore } = await twoProjects(dir);
  try {
    const sent = {};
    deps.fetch = async (url, init) => {
      assert.match(url, /\/v1\/images\/edits$/);
      sent[init.body.get('prompt')] = Buffer.from(await init.body.get('image[]').arrayBuffer()).toString();
      return res(200, { data: [{ b64_json: b64(`image ${init.body.get('prompt')}`) }] });
    };
    await callTool('make_image', { prompt: 'A', references: ['brand/logo.png'], operationId: 'rel-a' }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: projectA } });
    await callTool('make_image', { prompt: 'B', references: ['brand/logo.png'], operationId: 'rel-b' }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: projectB } });
    assert.deepEqual(sent, { A: 'logo-A', B: 'logo-B' });
  } finally { restore(); }
});

test('codex: a relative reference is attached as the absolute project file', async () => {
  const { deps, env, dir } = await sandbox('codex');
  const { projectA, projectB, restore } = await twoProjects(dir);
  try {
    const attached = [];
    let n = 0;
    deps.run = async (_cmd, args) => {
      const i = ++n;
      const ref = args[args.indexOf('-i') + 1];
      assert.ok(path.isAbsolute(ref), `codex gets an absolute path, not ${ref}`);
      attached.push(String(await fs.readFile(ref)));
      const made = path.join(env.CODEX_HOME, 'generated_images', `r${i}`, 'exec.png');
      await fs.mkdir(path.dirname(made), { recursive: true });
      await fs.writeFile(made, PNG);
      return { code: 0, stdout: `{"type":"thread.started","thread_id":"r${i}"}\n`, stderr: '' };
    };
    await callTool('make_image', { prompt: 'A', references: ['brand/logo.png'], operationId: 'crel-a' }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: projectA } });
    await callTool('make_image', { prompt: 'B', references: ['brand/logo.png'], operationId: 'crel-b' }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: projectB } });
    assert.deepEqual(attached, ['logo-A', 'logo-B']);
  } finally { restore(); }
});

test('one operationId with the same relative reference in another project is that project\'s own operation, never a replay', async () => {
  const { deps, env, dir } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const { projectA, projectB, restore } = await twoProjects(dir);
  try {
    let posts = 0;
    deps.fetch = async (_url, init) => { posts++; return res(200, { data: [{ b64_json: b64(`image ${posts} from ${Buffer.from(await init.body.get('image[]').arrayBuffer())}`) }] }); };
    await callTool('make_image', { prompt: 'p', references: ['brand/logo.png'], operationId: 'shared-id', outPath: 'ad.png' }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: projectA } });
    const b = await callTool('make_image', { prompt: 'p', references: ['brand/logo.png'], operationId: 'shared-id', outPath: 'ad.png' }, { ...deps, env: { ...env, CLAUDE_PROJECT_DIR: projectB } });
    assert.equal(posts, 2);
    assert.equal(b.replayed, undefined);
    assert.equal(String(await fs.readFile(path.join(projectA, 'ad.png'))), 'image 1 from logo-A');
    assert.equal(String(await fs.readFile(path.join(projectB, 'ad.png'))), 'image 2 from logo-B');
  } finally { restore(); }
});

// ---------- operation ids are scoped by project ----------

/** Two project folders that share one plugin data folder (one journal). */
async function projectsAB(dir) {
  const A = path.join(dir, 'client-A');
  const B = path.join(dir, 'client-B');
  await fs.mkdir(A, { recursive: true });
  await fs.mkdir(B, { recursive: true });
  return { A, B };
}
const inProject = (deps, env, project) => ({ ...deps, env: { ...env, CLAUDE_PROJECT_DIR: project } });

for (const refs of [[], ['https://cdn.example/shared-logo.png']]) {
  const label = refs.length ? 'with the same link reference' : 'without references';
  test(`openai: one explicit operationId in two projects, ${label}, makes one image per project and never replays across`, async () => {
    const { deps, env, dir } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
    const { A, B } = await projectsAB(dir);
    let posts = 0;
    deps.fetch = async (url) => {
      if (url.startsWith('https://cdn.example/')) return res(200, null);
      posts++;
      return res(200, { data: [{ b64_json: b64(`image-${posts}`) }] });
    };
    const args = { prompt: 'same prompt', references: refs, operationId: 'shared-claim', outPath: 'ad.png' };
    const a = await callTool('make_image', args, inProject(deps, env, A));
    const b = await callTool('make_image', args, inProject(deps, env, B));
    assert.equal(posts, 2, 'project B paid for its own image');
    assert.equal(b.replayed, undefined, 'project B never receives a replay of project A');
    assert.equal(await fs.realpath(path.dirname(b.path)), await fs.realpath(B));
    assert.equal(String(await fs.readFile(path.join(A, 'ad.png'))), 'image-1');
    assert.equal(String(await fs.readFile(path.join(B, 'ad.png'))), 'image-2');
    // Each project's own repeat replays its own image and buys nothing.
    const a2 = await callTool('make_image', args, inProject(deps, env, A));
    const b2 = await callTool('make_image', args, inProject(deps, env, B));
    assert.equal(posts, 2);
    assert.equal(a2.path, a.path);
    assert.equal(b2.replayed, true);
    assert.equal(await fs.realpath(path.dirname(b2.path)), await fs.realpath(B));
  });
}

test('codex: one explicit operationId in two projects runs codex once per project and never replays across', async () => {
  const { deps, env, dir } = await sandbox('codex');
  const { A, B } = await projectsAB(dir);
  let n = 0;
  deps.run = async () => {
    const i = ++n;
    const made = path.join(env.CODEX_HOME, 'generated_images', `t${i}`, 'exec.png');
    await fs.mkdir(path.dirname(made), { recursive: true });
    await fs.writeFile(made, `codex-${i}`);
    return { code: 0, stdout: `{"type":"thread.started","thread_id":"t${i}"}\n`, stderr: '' };
  };
  const args = { prompt: 'same prompt', operationId: 'shared-claim', outPath: 'ad.png' };
  await callTool('make_image', args, inProject(deps, env, A));
  const b = await callTool('make_image', args, inProject(deps, env, B));
  assert.equal(n, 2);
  assert.equal(b.replayed, undefined);
  assert.equal(String(await fs.readFile(path.join(A, 'ad.png'))), 'codex-1');
  assert.equal(String(await fs.readFile(path.join(B, 'ad.png'))), 'codex-2');
});

test('kie: one explicit operationId in two projects creates one task per project; collecting one task id is per project too', async () => {
  const { deps, env, dir } = await sandbox('kie', { SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  const { A, B } = await projectsAB(dir);
  let creates = 0;
  deps.fetch = async (url) => {
    if (url.endsWith('/createTask')) { creates++; return res(200, { code: 200, data: { taskId: `task-${creates}` } }); }
    if (url.includes('/recordInfo')) {
      const id = new URL(url).searchParams.get('taskId');
      return res(200, { data: { state: 'success', resultJson: { resultUrls: [`https://tempfile.example/${id}.png`] } } });
    }
    const id = url.split('/').pop();
    return { ...res(200, null), arrayBuffer: async () => Buffer.from(`kie ${id}`) };
  };
  const args = { prompt: 'same prompt', references: ['https://cdn.example/shared-logo.png'], operationId: 'shared-claim', outPath: 'ad.png' };
  await callTool('make_image', args, inProject(deps, env, A));
  const b = await callTool('make_image', args, inProject(deps, env, B));
  assert.equal(creates, 2);
  assert.equal(b.replayed, undefined);
  assert.equal(String(await fs.readFile(path.join(A, 'ad.png'))), 'kie task-1.png');
  assert.equal(String(await fs.readFile(path.join(B, 'ad.png'))), 'kie task-2.png');
  // Collecting one task id in project A, then in project B: B's file is saved in B, never at A's path.
  const ca = await callTool('make_image', { prompt: 'p', kieTaskId: 'task_9', outPath: 'collected.png' }, inProject(deps, env, A));
  const cb = await callTool('make_image', { prompt: 'p', kieTaskId: 'task_9', outPath: 'collected.png' }, inProject(deps, env, B));
  assert.equal(await fs.realpath(path.dirname(ca.path)), await fs.realpath(A));
  assert.equal(await fs.realpath(path.dirname(cb.path)), await fs.realpath(B));
  assert.equal(String(await fs.readFile(path.join(B, 'collected.png'))), 'kie task_9.png');
  assert.equal(creates, 2, 'collecting never creates');
});

test('the operation fingerprint includes the reference content: the same id after the project file changed is refused before any call', async () => {
  const { deps, env, dir } = await sandbox('openai', { SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  const { A } = await projectsAB(dir);
  await fs.mkdir(path.join(A, 'brand'), { recursive: true });
  await fs.writeFile(path.join(A, 'brand', 'logo.png'), 'logo v1');
  let posts = 0;
  deps.fetch = async () => { posts++; return res(200, { data: [{ b64_json: b64('img') }] }); };
  const args = { prompt: 'p', references: ['brand/logo.png'], operationId: 'ref-hash', outPath: 'ad.png' };
  await callTool('make_image', args, inProject(deps, env, A));
  const again = await callTool('make_image', args, inProject(deps, env, A));
  assert.equal(again.replayed, true, 'the unchanged file replays');
  await fs.writeFile(path.join(A, 'brand', 'logo.png'), 'logo v2');
  await assert.rejects(callTool('make_image', args, inProject(deps, env, A)), /already used for a different image request/);
  assert.equal(posts, 1);
});
