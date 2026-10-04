// spreng-images invariant: an operation already recorded is never bought again, whichever version or route wrote
// the record and whichever route the same operation is retried on (the user may switch image source in between).
//
// For every pair (record written by version/route A) x (retry on route B), the retry makes zero new provider
// submissions: no codex run, no OpenAI images POST, no KIE createTask. Records from the versions whose code is gone
// are seeded exactly as those versions wrote them (folder, file name, fields); records from this version are made
// by running it. All calls are mocks: no paid call and no real codex run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { callTool } from '../plugins/spreng-images/server/server.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const ENV = { SPRENG_IMAGES_OPENAI_KEY: 'sk-test-openai-0000000000000000', SPRENG_IMAGES_KIE_KEY: 'kie-test-key-1111111111111111' };
const MODEL = { codex: 'codex', openai: 'gpt-image-2', kie: 'nano-banana-pro' };
const PROVIDER = { codex: 'Codex CLI', openai: 'OpenAI', kie: 'KIE' };
const ROUTES = ['codex', 'openai', 'kie'];
const sha = (d) => createHash('sha256').update(d).digest('hex');
const autoId = (fields) => 'auto-' + sha(JSON.stringify(fields)).slice(0, 16);
const res = (status, body, extra = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => PNG, headers: { get: () => 'image/png' }, ...extra,
});

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spreng-invariant-'));
  const A = path.join(dir, 'client-A');
  await fs.mkdir(A, { recursive: true });
  await fs.writeFile(path.join(A, 'logo.png'), 'logo');
  const env = { CLAUDE_PLUGIN_DATA: path.join(dir, 'data'), CLAUDE_PROJECT_DIR: A, CODEX_HOME: path.join(dir, 'codex'), PATH: '', ...ENV };
  const deps = { env, fs, homedir: () => dir, now: () => new Date('2026-10-04T12:00:00Z'), sleep: async () => {} };
  return { dir, A, project: await fs.realpath(A), env, deps };
}

/** Provider mocks that succeed at everything and count every paid submission. */
function countingProviders(env, deps) {
  const count = { submissions: 0 };
  deps.run = async () => {
    count.submissions++;
    const made = path.join(env.CODEX_HOME, 'generated_images', `thread-retry-${count.submissions}`, 'exec.png');
    await fs.mkdir(path.dirname(made), { recursive: true });
    await fs.writeFile(made, PNG);
    return { code: 0, stdout: `{"thread_id":"thread-retry-${count.submissions}"}\n`, stderr: '' };
  };
  deps.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.openai.com/') && init.method === 'POST') {
      count.submissions++;
      return res(200, { data: [{ b64_json: PNG.toString('base64') }] });
    }
    if (String(url).endsWith('/api/v1/jobs/createTask')) { count.submissions++; return res(200, { code: 200, data: { taskId: 'task-retry' } }); }
    if (String(url).includes('/recordInfo')) return res(200, { data: { state: 'success', resultJson: { resultUrls: ['https://tempfile.example/r.png'] } } });
    return res(200, null);
  };
  return count;
}

/** A record as the earlier journals wrote it: one file per operation id, named by sha('op:' + id), no project. */
async function seed(env, dirName, operationId, record, image) {
  const dir = path.join(env.CLAUDE_PLUGIN_DATA, dirName);
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, sha('op:' + operationId).slice(0, 32));
  const rec = { operationId, ...record };
  if (image) {
    await fs.writeFile(`${base}.image`, image);
    Object.assign(rec, { resultFile: `${base}.image`, resultSha256: sha(image) });
  }
  await fs.writeFile(`${base}.json`, JSON.stringify(rec, null, 2));
}

/** A record as d107deb to 0a199a1 wrote it: operations/, file named by sha(['op', project, id]), the project in the record. */
async function seedScoped(s, operationId, record, image) {
  const dir = path.join(s.env.CLAUDE_PLUGIN_DATA, 'operations');
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, sha(JSON.stringify(['op', s.project, operationId])).slice(0, 32));
  const rec = { operationId, ...record };
  if (image) {
    await fs.writeFile(`${base}.image`, image);
    Object.assign(rec, { resultFile: `${base}.image`, resultSha256: sha(image) });
  }
  await fs.writeFile(`${base}.json`, JSON.stringify(rec, null, 2));
}

/** The fingerprint d107deb to 0a199a1 gave a request: the route's fields, the project, the prompt, a hash per reference. */
function scopedFingerprint(s, route, args) {
  const hashes = (args.references || []).map((r) => (/^https?:\/\//i.test(r) ? sha('url:' + r) : sha('logo')));
  const fields = route === 'codex' ? { source: 'codex' } : route === 'openai' ? { source: 'openai', model: MODEL.openai, size: null } : { source: 'kie', model: MODEL.kie, aspectRatio: null };
  return sha(JSON.stringify({ ...fields, project: s.project, prompt: args.prompt, references: hashes }));
}

/** The fingerprint the earlier journal gave a request on a route (references as that version saw them). */
function legacyFingerprint(route, prompt, references) {
  if (route === 'codex') return sha(JSON.stringify({ source: 'codex', prompt, references }));
  if (route === 'openai') return sha(JSON.stringify({ source: 'openai', model: MODEL.openai, prompt, references, size: null }));
  return sha(JSON.stringify({ source: 'kie', model: MODEL.kie, prompt, references, aspectRatio: null }));
}

/** The fields of a record in a given state, as the earlier journal (f0e3ddf to a15c7cd) kept them. */
function legacyRecord(route, state, A, fingerprint) {
  const rec = { provider: PROVIDER[route], fingerprint, state, reservedAt: '2026-10-03T10:00:00.000Z' };
  if (state === 'uncertain' || state === 'failed') rec.reason = 'seeded';
  if (state === 'accepted') Object.assign(rec, { taskId: 'task-old', model: MODEL.kie, outPath: path.join(A, 'ad.png') });
  if (state === 'completed') Object.assign(rec, { outPath: path.join(A, 'ad.png'), result: { source: route } });
  return rec;
}

/** Run this version on route A with a given outcome, leaving its record in the journal. */
async function writeWithThisVersion(s, route, outcome, args) {
  await callTool('set_image_source', { source: route }, s.deps);
  // Reference links download on every route (codex and OpenAI take files); only the paid calls below have outcomes.
  s.deps.fetch = async () => res(200, null);
  if (route === 'codex') {
    s.deps.run = outcome === 'completed'
      ? async () => {
        const made = path.join(s.env.CODEX_HOME, 'generated_images', 'thread-a', 'exec.png');
        await fs.mkdir(path.dirname(made), { recursive: true });
        await fs.writeFile(made, PNG);
        return { code: 0, stdout: '{"thread_id":"thread-a"}\n', stderr: '' };
      }
      : async () => { throw new Error('timed out'); };
  }
  if (route === 'openai') {
    s.deps.fetch = outcome === 'completed'
      ? async () => res(200, { data: [{ b64_json: PNG.toString('base64') }] })
      : async (url, init = {}) => { if (init.method === 'POST') throw new Error('socket hang up'); return res(200, null); };
  }
  if (route === 'kie') {
    s.deps.fetch = async (url) => {
      if (String(url).endsWith('/createTask')) {
        if (outcome === 'uncertain') throw new Error('socket hang up');
        return res(200, { code: 200, data: { taskId: 'task-a' } });
      }
      if (String(url).includes('/recordInfo')) {
        if (outcome === 'accepted') throw new Error('status check lost');
        if (outcome === 'failed') return res(200, { data: { state: 'fail', failMsg: 'nsfw' } });
        return res(200, { data: { state: 'success', resultJson: { resultUrls: ['https://tempfile.example/a.png'] } } });
      }
      return res(200, null);
    };
  }
  await callTool('make_image', args, s.deps).catch(() => {});
}

// Every way a version of this add-on recorded an operation. Each writer gets the request args it was made with and
// returns nothing; the record is left in the journal.
function writers() {
  const out = [];
  const states = { codex: ['submitting', 'uncertain', 'completed', 'failed'], openai: ['submitting', 'uncertain', 'completed', 'failed'], kie: ['submitting', 'uncertain', 'accepted', 'completed', 'failed'] };
  const thisVersion = { codex: ['completed', 'uncertain'], openai: ['completed', 'uncertain'], kie: ['accepted', 'completed', 'failed', 'uncertain'] };
  // ac007f2: KIE only, kie-operations/, only accepted tasks are left on disk (finished ones were removed).
  out.push({
    name: 'ac007f2 kie accepted (kie-operations/)', route: 'kie',
    write: async (s, args, id) => seed(s.env, 'kie-operations', id, { taskId: 'task-old', model: MODEL.kie, outPath: path.join(s.A, 'ad.png'), acceptedAt: '2026-10-03T10:00:00.000Z' }),
    derivedId: (s, args) => autoId({ model: MODEL.kie, prompt: args.prompt, references: args.references || [], aspectRatio: null, outPath: args.outPath }),
  });
  // f0e3ddf, 066b539, 816c1ae, a15c7cd: operations/, sha('op:' + id), no project field.
  for (const route of ROUTES) {
    for (const state of states[route]) {
      const write = async (s, args, id, refsSeen) => seed(s.env, 'operations', id, legacyRecord(route, state, s.A, legacyFingerprint(route, args.prompt, refsSeen)), state === 'completed' ? PNG : null);
      // f0e3ddf and 066b539: no project in the automatic id, references as typed.
      out.push({ name: `f0e3ddf/066b539 ${route} ${state}`, route, write, refs: 'typed',
        derivedId: (s, args) => autoId({ source: route, model: MODEL[route], prompt: args.prompt, references: args.references || [], aspectRatio: null, size: null, outPath: args.outPath }) });
      // 816c1ae: the canonical project in the automatic id, references as typed.
      out.push({ name: `816c1ae ${route} ${state}`, route, write, refs: 'typed',
        derivedId: (s, args) => autoId({ source: route, model: MODEL[route], project: s.project, prompt: args.prompt, references: args.references || [], aspectRatio: null, size: null, outPath: args.outPath }) });
      // a15c7cd: the canonical project in the automatic id, references resolved against the project.
      out.push({ name: `a15c7cd ${route} ${state}`, route, write, refs: 'resolved',
        derivedId: (s, args) => autoId({ source: route, model: MODEL[route], project: s.project, prompt: args.prompt, references: resolved(s, args), aspectRatio: null, size: null, outPath: args.outPath }) });
    }
  }
  // d107deb to 0a199a1: operations/, file named by sha(['op', project, id]), the id derived with the route's source and
  // model (references resolved against the project), the record holding the project and the current fingerprint.
  for (const route of ROUTES) {
    for (const state of states[route]) {
      out.push({ name: `d107deb..0a199a1 ${route} ${state}`, route,
        write: async (s, args, id) => seedScoped(s, id, { ...legacyRecord(route, state, s.A, scopedFingerprint(s, route, args)), project: s.project }, state === 'completed' ? PNG : null),
        derivedId: (s, args) => autoId({ source: route, model: MODEL[route], project: s.project, prompt: args.prompt, references: resolved(s, args), aspectRatio: null, size: null, outPath: args.outPath }) });
    }
  }
  // This version: made by running it.
  for (const route of ROUTES) {
    for (const outcome of thisVersion[route]) out.push({ name: `this version ${route} ${outcome}`, route, live: (s, args) => writeWithThisVersion(s, route, outcome, args) });
  }
  return out;
}

const resolved = (s, args) => (args.references || []).map((r) => (/^https?:\/\//i.test(r) ? r : path.join(s.project, r)));

async function retry(s, routeB, args) {
  await callTool('set_image_source', { source: routeB }, s.deps);
  const count = countingProviders(s.env, s.deps);
  let outcome;
  try { const r = await callTool('make_image', args, s.deps); outcome = r.replayed ? 'replayed' : 'returned'; } catch (e) { outcome = `refused: ${e.message.slice(0, 80)}`; }
  return { submissions: count.submissions, outcome };
}

test('invariant: a recorded operation is never submitted again, for every (version/route that wrote it) x (route it is retried on)', async () => {
  const failures = [];
  let pairs = 0;
  for (const w of writers()) {
    // 1) The same explicit operationId, retried on every route (the user switched image source in between).
    for (const routeB of ROUTES) {
      const s = await sandbox();
      const args = { prompt: 'p', operationId: 'op-1', outPath: 'ad.png' };
      if (w.live) await w.live(s, args); else await w.write(s, args, 'op-1', []);
      const { submissions, outcome } = await retry(s, routeB, args);
      pairs++;
      if (submissions !== 0) failures.push(`${w.name} -> retry on ${routeB} with operationId: ${submissions} new submission(s) (${outcome})`);
    }
    // 2) The same request without an operationId, retried on every route that takes its references (the user switched
    // image source in between): the id is derived again, under every form any version derived it, for every route.
    // References: none, a link (every route takes links) and a local file as typed (codex and OpenAI only; KIE takes
    // links only).
    const refVariants = [[], ['https://cdn.example/logo.png'], ...(w.route === 'kie' ? [] : [['logo.png']])];
    for (const references of refVariants) {
      for (const routeB of ROUTES) {
        if (routeB === 'kie' && references.some((r) => !/^https:\/\//.test(r))) continue;
        const s = await sandbox();
        const args = { prompt: 'p', outPath: 'ad.png', ...(references.length ? { references } : {}) };
        if (w.live) await w.live(s, args);
        else await w.write(s, args, w.derivedId(s, args), w.refs === 'resolved' ? resolved(s, args) : references);
        const { submissions, outcome } = await retry(s, routeB, args);
        pairs++;
        if (submissions !== 0) failures.push(`${w.name} -> retry on ${routeB} without operationId, references ${JSON.stringify(references)}: ${submissions} new submission(s) (${outcome})`);
      }
    }
  }
  assert.ok(pairs > 400, `the matrix ran (${pairs} pairs)`);
  assert.deepEqual(failures, [], `${failures.length} of ${pairs} pairs bought the same operation again:\n${failures.join('\n')}`);
});

test('invariant: a request made with a configured (non-default) KIE model is not bought again on OpenAI, from this version or the first journal', async () => {
  const MODEL_KIE = 'seedream-v4';
  for (const writer of ['this version', 'f0e3ddf']) {
    const s = await sandbox();
    s.env.SPRENG_IMAGES_KIE_MODEL = MODEL_KIE;
    const args = { prompt: 'p', outPath: 'ad.png' };
    if (writer === 'this version') {
      await callTool('set_image_source', { source: 'kie' }, s.deps);
      s.deps.fetch = async (url) => {
        if (String(url).endsWith('/createTask')) return res(200, { code: 200, data: { taskId: 'task-a' } });
        throw new Error('status check lost');
      };
      await callTool('make_image', args, s.deps).catch(() => {});
    } else {
      await seed(s.env, 'operations', autoId({ source: 'kie', model: MODEL_KIE, prompt: 'p', references: [], aspectRatio: null, size: null, outPath: 'ad.png' }), {
        provider: 'KIE', fingerprint: sha(JSON.stringify({ source: 'kie', model: MODEL_KIE, prompt: 'p', references: [], aspectRatio: null })), state: 'accepted', taskId: 'task-old', model: MODEL_KIE,
      });
    }
    const { submissions, outcome } = await retry(s, 'openai', args);
    assert.equal(submissions, 0, `${writer}: ${outcome}`);
  }
});

test('invariant: the same request sent at the same moment on two routes buys one image', async () => {
  const { runOpenAI, runKie } = await import('../plugins/spreng-images/server/routes.mjs');
  const s = await sandbox();
  const count = countingProviders(s.env, s.deps);
  const stateDir = path.join(s.env.CLAUDE_PLUGIN_DATA, 'operations');
  const job = async (name) => {
    const tmpDir = path.join(s.dir, `work-${name}`);
    await fs.mkdir(tmpDir, { recursive: true });
    return { prompt: 'p', references: [], typedReferences: [], outPath: path.join(s.A, 'ad.png'), tmpDir, requestedOutPath: 'ad.png', projectDir: s.project, stateDir };
  };
  const results = await Promise.allSettled([
    runOpenAI(await job('a'), s.deps, { key: ENV.SPRENG_IMAGES_OPENAI_KEY, model: MODEL.openai }),
    runKie(await job('b'), s.deps, { key: ENV.SPRENG_IMAGES_KIE_KEY, model: MODEL.kie, pollMs: 0 }),
  ]);
  assert.equal(count.submissions, 1, `one paid submission in all: ${results.map((r) => r.status === 'fulfilled' ? 'made' : r.reason.message.slice(0, 80)).join(' | ')}`);
});

test('upgrade: a request recorded by d107deb to 0a199a1 is still replayed or collected on its own route, and refused naming that provider on another', async () => {
  for (const [route, state, expect] of [['openai', 'completed', 'replayed'], ['codex', 'completed', 'replayed'], ['kie', 'accepted', 'returned']]) {
    const s = await sandbox();
    const args = { prompt: 'p', outPath: 'ad.png', references: ['https://cdn.example/logo.png'] };
    const id = autoId({ source: route, model: MODEL[route], project: s.project, prompt: 'p', references: args.references, aspectRatio: null, size: null, outPath: 'ad.png' });
    await seedScoped(s, id, { ...legacyRecord(route, state, s.A, scopedFingerprint(s, route, args)), project: s.project }, state === 'completed' ? PNG : null);
    const same = await retry(s, route, args);
    assert.deepEqual(same, { submissions: 0, outcome: expect }, `${route} ${state} on its own route`);
    const other = await retry(s, route === 'openai' ? 'kie' : 'openai', args);
    assert.equal(other.submissions, 0);
    assert.match(other.outcome, new RegExp(`refused: This request was already sent to ${PROVIDER[route]}`));
  }
});
