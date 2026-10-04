// spreng-images invariant: an operation already recorded is never bought again, whichever route wrote the record and
// whichever route the same operation is retried on (the user may switch image source, or change the model settings,
// in between).
//
// For every (route A, outcome) x (model settings change) x (operation id form) x (retry route B), the record is made
// by running this version on route A, and two retries on route B make zero new provider submissions: no codex run, no
// OpenAI images POST, no KIE createTask. A different request on route B is still made (one submission). The outcomes
// include a crash after submitting: the provider call never returns, so the record stays "submitting". All calls are
// mocks: no paid call and no real codex run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { callTool } from '../plugins/spreng-images/server/server.mjs';
import { JOURNAL_DIR } from '../plugins/spreng-images/server/operations.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const ENV = { SPRENG_IMAGES_OPENAI_KEY: 'sk-test-openai-0000000000000000', SPRENG_IMAGES_KIE_KEY: 'kie-test-key-1111111111111111' };
const PROVIDER = { codex: 'Codex CLI', openai: 'OpenAI', kie: 'KIE' };
const ROUTES = ['codex', 'openai', 'kie'];
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

/** Set the OpenAI and KIE model settings ({} removes both). */
function setModels(env, models) {
  delete env.SPRENG_IMAGES_OPENAI_MODEL;
  delete env.SPRENG_IMAGES_KIE_MODEL;
  if (models.openai) env.SPRENG_IMAGES_OPENAI_MODEL = models.openai;
  if (models.kie) env.SPRENG_IMAGES_KIE_MODEL = models.kie;
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

const OUTCOMES = { codex: ['completed', 'uncertain', 'crashed'], openai: ['completed', 'uncertain', 'crashed'], kie: ['accepted', 'completed', 'failed', 'uncertain', 'crashed'] };

/**
 * Run this version on route A with a given outcome, leaving its record in the journal. "crashed": the paid call is
 * sent and never returns (the process stopped while it was out), so the record stays "submitting".
 */
async function write(s, route, outcome, args) {
  await callTool('set_image_source', { source: route }, s.deps);
  let sent;
  const submitted = new Promise((resolve) => { sent = resolve; });
  const crash = () => { sent(); return new Promise(() => {}); };
  // Reference links download on every route (codex and OpenAI take files); only the paid calls below have outcomes.
  s.deps.fetch = async () => res(200, null);
  if (route === 'codex') {
    s.deps.run = async () => {
      if (outcome === 'crashed') return crash();
      if (outcome === 'uncertain') throw new Error('timed out');
      const made = path.join(s.env.CODEX_HOME, 'generated_images', 'thread-a', 'exec.png');
      await fs.mkdir(path.dirname(made), { recursive: true });
      await fs.writeFile(made, PNG);
      return { code: 0, stdout: '{"thread_id":"thread-a"}\n', stderr: '' };
    };
  }
  if (route === 'openai') {
    s.deps.fetch = async (url, init = {}) => {
      if (init.method !== 'POST') return res(200, null);
      if (outcome === 'crashed') return crash();
      if (outcome === 'uncertain') throw new Error('socket hang up');
      return res(200, { data: [{ b64_json: PNG.toString('base64') }] });
    };
  }
  if (route === 'kie') {
    s.deps.fetch = async (url) => {
      if (String(url).endsWith('/createTask')) {
        if (outcome === 'crashed') return crash();
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
  const call = callTool('make_image', args, s.deps).catch(() => {});
  if (outcome === 'crashed') await submitted; else await call;
}

async function retry(s, routeB, args) {
  await callTool('set_image_source', { source: routeB }, s.deps);
  const count = countingProviders(s.env, s.deps);
  let outcome;
  try { const r = await callTool('make_image', args, s.deps); outcome = r.replayed ? 'replayed' : 'returned'; } catch (e) { outcome = `refused: ${e.message.slice(0, 400)}`; }
  return { submissions: count.submissions, outcome };
}

// The OpenAI and KIE model settings when the record is made, and when the request is retried.
const CUSTOM = { openai: 'gpt-image-1.5', kie: 'nano-banana-2' };
const OTHER = { openai: 'gpt-image-1', kie: 'gpt-image-2' };
const MODEL_CHANGES = {
  'defaults unchanged': [{}, {}],
  'defaults, then set': [{}, CUSTOM],
  'set, then replaced': [CUSTOM, OTHER],
  'set, then removed': [CUSTOM, {}],
};

// The same request with a given operationId, and without one (the id is derived from the request) with no reference,
// a link (every route takes links) and a local file (codex and OpenAI only; KIE takes links only).
const REQUESTS = [
  { operationId: 'op-1' },
  {},
  { references: ['https://cdn.example/logo.png'] },
  { references: ['logo.png'] },
];
const takes = (route, req) => route !== 'kie' || !(req.references || []).some((r) => !/^https:\/\//.test(r));

test('invariant: a recorded operation is never submitted again, for every route x outcome x model change x id form x retry route', async () => {
  const failures = [];
  let pairs = 0;
  for (const routeA of ROUTES) {
    for (const outcome of OUTCOMES[routeA]) {
      for (const [change, [before, after]] of Object.entries(MODEL_CHANGES)) {
        for (const req of REQUESTS) {
          if (!takes(routeA, req)) continue;
          for (const routeB of ROUTES) {
            if (!takes(routeB, req)) continue;
            const s = await sandbox();
            const args = { prompt: 'p', outPath: 'ad.png', ...req };
            setModels(s.env, before);
            await write(s, routeA, outcome, args);
            setModels(s.env, after);
            const first = await retry(s, routeB, args);
            const second = await retry(s, routeB, args);
            const other = await retry(s, routeB, { prompt: 'another', outPath: 'b.png' });
            pairs++;
            const at = `${routeA} ${outcome}, models ${change}, ${JSON.stringify(req)} -> retry on ${routeB}`;
            if (first.submissions + second.submissions !== 0) failures.push(`${at}: ${first.submissions + second.submissions} new submission(s) (${first.outcome} | ${second.outcome})`);
            if (other.submissions !== 1 || other.outcome !== 'returned') failures.push(`${at}: another request was not made (${other.outcome})`);
          }
        }
      }
    }
  }
  assert.ok(pairs > 400, `the matrix ran (${pairs} pairs)`);
  assert.deepEqual(failures, [], `${failures.length} of ${pairs} pairs failed:\n${failures.join('\n')}`);
});

test('journal: every record is kept in operations-v1/, one file per project and operation id, naming its provider and model', async () => {
  for (const route of ROUTES) {
    const s = await sandbox();
    setModels(s.env, CUSTOM);
    await write(s, route, 'uncertain', { prompt: 'p', outPath: 'ad.png' });
    const dir = path.join(s.env.CLAUDE_PLUGIN_DATA, 'operations-v1');
    const names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    assert.equal(names.length, 1, route);
    const kept = JSON.parse(await fs.readFile(path.join(dir, names[0]), 'utf8'));
    assert.equal(kept.provider, PROVIDER[route], route);
    assert.equal(kept.model, route === 'codex' ? 'codex' : CUSTOM[route], route);
    assert.equal(kept.project, s.project, route);
    assert.equal(kept.state, 'uncertain', route);
    assert.deepEqual((await fs.readdir(s.env.CLAUDE_PLUGIN_DATA)).sort(), ['image-source.json', 'operations-v1', 'work'], 'no other journal folder');
  }
  assert.equal(JOURNAL_DIR, 'operations-v1');
});

test('journal: the same request after a model change is refused naming the source and model it was sent with', async () => {
  const s = await sandbox();
  await write(s, 'openai', 'uncertain', { prompt: 'p', outPath: 'ad.png' });
  setModels(s.env, CUSTOM);
  const r = await retry(s, 'openai', { prompt: 'p', outPath: 'ad.png' });
  assert.equal(r.submissions, 0);
  assert.match(r.outcome, /^refused: This request was already sent to OpenAI gpt-image-2 as operation auto-/);
  const k = await retry(s, 'kie', { prompt: 'p', outPath: 'ad.png' });
  assert.equal(k.submissions, 0);
  assert.match(k.outcome, /^refused: This request was already sent to OpenAI gpt-image-2 .*nothing was sent to KIE nano-banana-2/);
});

test('invariant: the same request sent at the same moment on two routes buys one image', async () => {
  const { runOpenAI, runKie } = await import('../plugins/spreng-images/server/routes.mjs');
  const s = await sandbox();
  const count = countingProviders(s.env, s.deps);
  const stateDir = path.join(s.env.CLAUDE_PLUGIN_DATA, JOURNAL_DIR);
  const job = async (name) => {
    const tmpDir = path.join(s.dir, `work-${name}`);
    await fs.mkdir(tmpDir, { recursive: true });
    return { prompt: 'p', references: [], outPath: path.join(s.A, 'ad.png'), tmpDir, requestedOutPath: 'ad.png', projectDir: s.project, stateDir };
  };
  const results = await Promise.allSettled([
    runOpenAI(await job('a'), s.deps, { key: ENV.SPRENG_IMAGES_OPENAI_KEY, model: 'gpt-image-2' }),
    runKie(await job('b'), s.deps, { key: ENV.SPRENG_IMAGES_KIE_KEY, model: 'nano-banana-pro', pollMs: 0 }),
  ]);
  assert.equal(count.submissions, 1, `one paid submission in all: ${results.map((r) => r.status === 'fulfilled' ? 'made' : r.reason.message.slice(0, 80)).join(' | ')}`);
});
