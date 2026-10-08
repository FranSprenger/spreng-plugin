// spreng-images: each image source with mocks (no paid call, no real codex run), the remembered choice, and
// that a configured key never leaves the process in a tool answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './helpers.mjs';
import { callTool, handle, scrub, TOOLS } from '../plugins/spreng-images/server/server.mjs';
import { codexTask, kieInput, secret } from '../plugins/spreng-images/server/routes.mjs';
import { dimensionReceipt, formatPrompt, requestedFormat } from '../plugins/spreng-images/server/image-format.mjs';
import { requestFingerprint, snapshotReferences, reserveOperation, completeOperation, markUncertain } from '../plugins/spreng-images/server/operations.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const OPENAI_KEY = 'sk-test-openai-0000000000000000';
const KIE_KEY = 'kie-test-key-1111111111111111';

async function sandbox(extraEnv = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spreng-images-'));
  const env = { CLAUDE_PLUGIN_DATA: path.join(dir, 'data'), CLAUDE_PROJECT_DIR: path.join(dir, 'project'), CODEX_HOME: path.join(dir, 'codex'), PATH: '', ...extraEnv };
  const calls = [];
  const deps = {
    env, fs, homedir: () => dir, now: () => new Date('2026-10-04T12:00:00Z'), sleep: async () => {},
    fetch: async () => { throw new Error('unexpected fetch'); },
    run: async () => { throw new Error('unexpected run'); },
  };
  return { dir, env, deps, calls };
}
const res = (status, body, extra = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => PNG, headers: { get: () => 'image/png' }, ...extra });

test('no choice yet: make_image asks for set_image_source; status shows nothing chosen and no key', async () => {
  const { deps } = await sandbox({ SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  await assert.rejects(callTool('make_image', { prompt: 'x' }, deps), (error) => {
    assert.match(error.message, /set_image_source/);
    assert.match(error.message, /Codex/);
    assert.doesNotMatch(error.message, /openai|kie|API key/i, 'new setup does not offer a billed API by default');
    return true;
  });
  const s = await callTool('image_source_status', {}, deps);
  assert.equal(s.choice, null);
  assert.equal(s.ready.openai, true);
  assert.ok(!JSON.stringify(s).includes(OPENAI_KEY));
});

test('the choice is remembered on disk in the plugin data folder', async () => {
  const { deps, env } = await sandbox();
  await callTool('set_image_source', { source: 'other', otherName: 'Midjourney' }, deps);
  const saved = JSON.parse(await fs.readFile(path.join(env.CLAUDE_PLUGIN_DATA, 'image-source.json'), 'utf8'));
  assert.equal(saved.source, 'other');
  assert.equal((await callTool('image_source_status', {}, deps)).choice, 'other');
  await assert.rejects(callTool('set_image_source', { source: 'gemini' }, deps), /one of/);
});

test("unexpanded ${user_config.x} text counts as no key", () => {
  assert.equal(secret('${user_config.openai_api_key}'), '');
  assert.equal(secret(' '), '');
  assert.equal(secret('abc'), 'abc');
});

test('codex route: runs codex exec once with the prompt unchanged and copies the new image into the project', async () => {
  const { deps, env } = await sandbox();
  await callTool('set_image_source', { source: 'codex' }, deps);
  const old = path.join(env.CODEX_HOME, 'generated_images', 'older', 'exec-old.png');
  await fs.mkdir(path.dirname(old), { recursive: true });
  await fs.writeFile(old, PNG);
  let seen;
  deps.run = async (cmd, args) => {
    seen = { cmd, args };
    const made = path.join(env.CODEX_HOME, 'generated_images', 'thread-42', 'exec-new.png');
    await fs.mkdir(path.dirname(made), { recursive: true });
    await fs.writeFile(made, PNG);
    return { code: 0, stdout: '{"type":"thread.started","thread_id":"thread-42"}\n', stderr: '' };
  };
  const prompt = 'A ceramic mug on a wooden table, soft daylight.';
  const out = await callTool('make_image', { prompt, outPath: 'ads/one.png' }, deps);
  assert.equal(seen.cmd, 'codex');
  assert.equal(seen.args[0], 'exec');
  assert.ok(seen.args.includes('--sandbox') && seen.args[seen.args.indexOf('--sandbox') + 1] === 'read-only');
  assert.ok(seen.args.at(-1).includes(`<<<SPRENG_PROMPT\n${prompt}\nSPRENG_PROMPT>>>`), 'prompt passed word for word');
  assert.ok(!seen.args.at(-1).includes('REQUESTED FORMAT:'), 'A3: absent requestedSize keeps the prompt unchanged despite tool defaults');
  assert.equal(out.path, path.join(env.CLAUDE_PROJECT_DIR, 'ads/one.png'));
  assert.ok(out.codexFile.endsWith(path.join('thread-42', 'exec-new.png')));
  assert.deepEqual(await fs.readFile(out.path), PNG);
});

test('Codex receives requested shape, measures its returned header, and replays without regeneration', async () => {
  for (const [requestedSize, width, height] of [['square', 1024, 1024], ['portrait', 800, 1000], ['story', 900, 1600], ['landscape', 1536, 1024], ['landscape', 1600, 900]]) {
    const { deps, env } = await sandbox();
    await callTool('set_image_source', { source: 'codex' }, deps);
    let submissions = 0;
    const prompt = 'Original creative\nexact headline';
    const suffix = `REQUESTED FORMAT: ${requestedSize}. Verify the resulting dimensions; report a mismatch without silently regenerating.`;
    const actualPrompt = `${prompt}\n\n${suffix}`;
    deps.run = async (_cmd, args) => {
      submissions++;
      assert.ok(args.at(-1).includes(`<<<SPRENG_PROMPT\n${actualPrompt}\nSPRENG_PROMPT>>>`));
      const made = path.join(env.CODEX_HOME, 'generated_images', 'geometry', 'exec.png');
      const bytes = Buffer.from(PNG);
      bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
      await fs.mkdir(path.dirname(made), { recursive: true }); await fs.writeFile(made, bytes);
      return { code: 0, stdout: '{"thread_id":"geometry"}\n', stderr: '' };
    };
    const args = { prompt, requestedSize, operationId: `format-${requestedSize}` };
    const out = await callTool('make_image', args, deps);
    assert.equal(out.actualPrompt, actualPrompt);
    assert.equal(out.originalPrompt, prompt);
    assert.deepEqual(out.dimensions, { width, height });
    assert.equal(out.dimensionCheck.status, 'matches');
    assert.equal(out.dimensionCheck.verification, 'local_image_header');
    const again = await callTool('make_image', args, deps);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.dimensionCheck, out.dimensionCheck);
    assert.equal(submissions, 1);
  }
});

test('Codex keeps a nonsquare image, reports the mismatch and never purchases a replacement', async () => {
  const { deps, env } = await sandbox();
  await callTool('set_image_source', { source: 'codex' }, deps);
  let submissions = 0;
  deps.run = async () => {
    submissions++;
    const made = path.join(env.CODEX_HOME, 'generated_images', 'mismatch', 'exec.png');
    const bytes = Buffer.from(PNG); bytes.writeUInt32BE(800, 16); bytes.writeUInt32BE(1200, 20);
    await fs.mkdir(path.dirname(made), { recursive: true }); await fs.writeFile(made, bytes);
    return { code: 0, stdout: '{"thread_id":"mismatch"}\n', stderr: '' };
  };
  const args = { prompt: 'p', requestedSize: 'square', operationId: 'mismatch' };
  const out = await callTool('make_image', args, deps);
  assert.equal(out.dimensionCheck.status, 'mismatch');
  assert.match(out.dimensionCheck.warning, /800x1200/);
  assert.match(out.dimensionCheck.warning, /without automatic regeneration/);
  await callTool('make_image', args, deps);
  assert.equal(submissions, 1);
  assert.ok((await fs.stat(out.path)).size > 0);
});

test('old Codex shape-blind journals still recover the saved file without claiming a format suffix or buying again', async () => {
  const { deps, env } = await sandbox();
  await callTool('set_image_source', { source: 'codex' }, deps);
  let calls = 0;
  deps.run = async () => {
    calls++;
    const made = path.join(env.CODEX_HOME, 'generated_images', 'legacy-shape', 'image.png');
    await fs.mkdir(path.dirname(made), { recursive: true });
    await fs.writeFile(made, PNG);
    return { stdout: JSON.stringify({ type: 'thread.started', thread_id: 'legacy-shape' }) + '\n', stderr: '', code: 0 };
  };
  // The old route's fingerprint had no geometry; create that exact historical record.
  const args = { prompt: 'ORIGINAL PLATE', operationId: 'legacy-claim' };
  await callTool('make_image', args, deps);
  const out = await callTool('make_image', { ...args, requestedSize: 'square' }, deps);
  assert.equal(out.replayed, true);
  assert.equal(out.actualPrompt, args.prompt, 'the old call never carried our new suffix');
  assert.equal(out.dimensionCheck.status, 'matches');
  assert.equal(calls, 1);
  const folder = path.join(env.CLAUDE_PLUGIN_DATA, 'operations-v1');
  const file = path.join(folder, (await fs.readdir(folder)).find((n) => n.endsWith('.json')));
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.state = 'uncertain';
  await fs.writeFile(file, JSON.stringify(record));
  await assert.rejects(callTool('make_image', { ...args, requestedSize: 'square' }, deps), /outcome is unclear/);
  assert.equal(calls, 1, 'an older uncertain attempt is never submitted again');
  await assert.rejects(callTool('make_image', { ...args, prompt: 'CHANGED', requestedSize: 'square' }, deps), /different image request/);
});

// Seed the exact pre-A3 H2 fingerprint and receipt without running an image provider.
async function historicalInferredCodex(shapeArgs, format, uncertain = false) {
  const { deps, env } = await sandbox();
  await callTool('set_image_source', { source: 'codex' }, deps);
  await fs.mkdir(env.CLAUDE_PROJECT_DIR, { recursive: true });
  const projectDir = await fs.realpath(env.CLAUDE_PROJECT_DIR);
  const reference = path.join(projectDir, 'reference.png');
  await fs.writeFile(reference, PNG);
  const args = { prompt: 'H2 ORIGINAL PLATE', references: ['reference.png'], operationId: 'h2-inferred', outPath: 'original.png', ...shapeArgs };
  const job = { ...args, projectDir, references: [reference], outPath: path.join(projectDir, args.outPath),
    tmpDir: path.join(env.CLAUDE_PLUGIN_DATA, 'historical-work'), stateDir: path.join(env.CLAUDE_PLUGIN_DATA, 'operations-v1') };
  const snap = await snapshotReferences(deps, job.references, job.tmpDir);
  const op = await reserveOperation(deps, { job, model: 'codex', provider: 'Codex CLI',
    fingerprint: requestFingerprint(job, { source: 'codex', format }, snap.hashes) });
  const bytes = Buffer.from(PNG);
  const [width, height] = { square: [1024, 1024], portrait: [800, 1000], story: [900, 1600], landscape: [1600, 900] }[format];
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  const receipt = dimensionReceipt(bytes, format);
  // The old H2 landscape receipt recorded 16:9, before A3 added the native 3:2 preference.
  if (format === 'landscape') receipt.dimensionCheck.aspectRatio = '16:9';
  const historicalResult = { source: 'codex', madeBy: 'Codex CLI image tool', originalPrompt: args.prompt,
    actualPrompt: formatPrompt(args.prompt, format), ...receipt };
  if (uncertain) await markUncertain(deps, op, 'historical lost answer');
  else {
    await completeOperation(deps, op, bytes, job.outPath, historicalResult);
    await fs.rm(job.outPath); // recovery must restore the kept bytes, not merely return a stale path
  }
  let calls = 0;
  deps.run = async () => { calls++; throw new Error('historical operation must never be sent again'); };
  deps.fetch = async () => { calls++; throw new Error('historical operation must never call a provider'); };
  return { deps, args, historicalResult, bytes, reference, calls: () => calls };
}

test('H2 inferred Codex journals recover exact historical prompts and receipts with zero provider calls', async () => {
  for (const [shapeArgs, format] of [
    [{ size: '1024x1024' }, 'square'], [{ aspectRatio: '800:1000' }, 'portrait'],
    [{ aspectRatio: '9:16' }, 'story'], [{ size: '1920x1080' }, 'landscape'],
    [{ aspectRatio: '4:5', size: '1024x1024' }, 'portrait'],
  ]) {
    const saved = await historicalInferredCodex(shapeArgs, format);
    const out = await callTool('make_image', saved.args, saved.deps);
    assert.equal(out.replayed, true);
    assert.equal(out.actualPrompt, saved.historicalResult.actualPrompt, 'recovery must retain the suffix that was really sent');
    assert.deepEqual(out.dimensionCheck, saved.historicalResult.dimensionCheck, 'the saved receipt is not rewritten');
    assert.deepEqual(await fs.readFile(out.path), saved.bytes);
    assert.equal(saved.calls(), 0);
  }
});

test('H2 inferred Codex uncertain journals stay uncertain; changed prompts or references never recover', async () => {
  const uncertain = await historicalInferredCodex({ size: '1024x1024' }, 'square', true);
  await assert.rejects(callTool('make_image', uncertain.args, uncertain.deps), /outcome is unclear.*historical lost answer/);
  assert.equal(uncertain.calls(), 0);
  const completed = await historicalInferredCodex({ aspectRatio: '9:16' }, 'story');
  await assert.rejects(callTool('make_image', { ...completed.args, prompt: 'CHANGED' }, completed.deps), /different image request/);
  await fs.writeFile(completed.reference, Buffer.concat([PNG, Buffer.from('changed')]));
  await assert.rejects(callTool('make_image', completed.args, completed.deps), /different image request/);
  assert.equal(completed.calls(), 0);
});

test('fresh Codex jobs with inferred geometry still send no format suffix and replay without a second call', async () => {
  for (const shapeArgs of [{ size: '1024x1024' }, { aspectRatio: '4:5' }, { aspectRatio: '9:16' }, { size: '1920x1080' }]) {
    const { deps, env } = await sandbox();
    await callTool('set_image_source', { source: 'codex' }, deps);
    let calls = 0;
    deps.run = async (_cmd, args) => {
      calls++;
      assert.ok(args.at(-1).includes('<<<SPRENG_PROMPT\nUNSUFFIXED PLATE\nSPRENG_PROMPT>>>'));
      assert.ok(!args.at(-1).includes('REQUESTED FORMAT:'));
      const made = path.join(env.CODEX_HOME, 'generated_images', 'fresh-inferred', 'image.png');
      await fs.mkdir(path.dirname(made), { recursive: true });
      await fs.writeFile(made, PNG);
      return { code: 0, stdout: '{"thread_id":"fresh-inferred"}\n', stderr: '' };
    };
    const args = { prompt: 'UNSUFFIXED PLATE', operationId: 'fresh-inferred', ...shapeArgs };
    await callTool('make_image', args, deps);
    assert.equal((await callTool('make_image', args, deps)).replayed, true);
    assert.equal(calls, 1);
  }
});

test('format transport requires an explicit request and reports unknown headers honestly', () => {
  const sentence = 'REQUESTED FORMAT: square. Verify the resulting dimensions; report a mismatch without silently regenerating.';
  const sent = `Original\n\n${sentence}`;
  assert.equal(formatPrompt(sent, 'square'), sent, 'a recorded suffix is never duplicated');
  assert.equal(formatPrompt('Original', null), 'Original');
  assert.equal(requestedFormat({ size: '1024x1024' }), null, 'A3: size defaults cannot request a suffix');
  assert.equal(requestedFormat({ aspectRatio: '9:16' }), null, 'A3: ratio defaults cannot request a suffix');
  assert.equal(requestedFormat({ size: 'auto' }), null);
  assert.equal(requestedFormat({ aspectRatio: '1:0' }), null);
  assert.deepEqual(dimensionReceipt(Buffer.from('not an image'), 'square').dimensionCheck, {
    requestedSize: 'square', aspectRatio: '1:1', status: 'unverified', verification: 'unreadable_image_header', fullDecodeVerified: false,
  });
});

test('codex route: references given as links are downloaded and attached with -i', async () => {
  const { deps, env } = await sandbox();
  await callTool('set_image_source', { source: 'codex' }, deps);
  deps.fetch = async (url) => { assert.equal(url, 'https://kkwbfbsokgefebizzkpt.supabase.co/storage/v1/ref.png'); return res(200, null); };
  let args;
  let attached;
  deps.run = async (_c, a) => {
    args = a;
    attached = await fs.readFile(a[a.indexOf('-i') + 1]); // the work folder is removed after the request
    const made = path.join(env.CODEX_HOME, 'generated_images', 't', 'exec-1.png');
    await fs.mkdir(path.dirname(made), { recursive: true });
    await fs.writeFile(made, PNG);
    return { code: 0, stdout: '{"type":"thread.started","thread_id":"t"}\n', stderr: '' };
  };
  await callTool('make_image', { prompt: 'p', references: ['https://kkwbfbsokgefebizzkpt.supabase.co/storage/v1/ref.png'] }, deps);
  const ref = args[args.indexOf('-i') + 1];
  assert.match(ref, /reference-1\.png$/);
  assert.deepEqual(attached, PNG);
});

test('codex route: no new image is an error, not a silent success', async () => {
  const { deps } = await sandbox();
  await callTool('set_image_source', { source: 'codex' }, deps);
  deps.run = async () => ({ code: 0, stdout: '{"type":"thread.started","thread_id":"thread-1"}\n', stderr: '' });
  await assert.rejects(callTool('make_image', { prompt: 'p' }, deps), /no new image/);
});

test('codex route: an image from a concurrent session is never taken when this thread made none', async () => {
  const { deps, env } = await sandbox();
  await callTool('set_image_source', { source: 'codex' }, deps);
  const theirs = path.join(env.CODEX_HOME, 'generated_images', 'thread-other', 'exec-private.png');
  deps.run = async () => {
    // Another Codex session (another client) saves an image while this run is going; this run's thread makes none.
    await fs.mkdir(path.dirname(theirs), { recursive: true });
    await fs.writeFile(theirs, PNG);
    return { code: 0, stdout: '{"type":"thread.started","thread_id":"thread-mine"}\n', stderr: '' };
  };
  await assert.rejects(callTool('make_image', { prompt: 'p', outPath: 'ads/mine.png' }, deps), /thread-mine/);
  await assert.rejects(fs.access(path.join(env.CLAUDE_PROJECT_DIR, 'ads/mine.png')), 'nothing copied into the project');
});

test('codex route: a thread id that is only a substring of another folder does not match it', async () => {
  const { deps, env } = await sandbox();
  await callTool('set_image_source', { source: 'codex' }, deps);
  deps.run = async () => {
    const other = path.join(env.CODEX_HOME, 'generated_images', 'thread-42-other', 'exec.png');
    await fs.mkdir(path.dirname(other), { recursive: true });
    await fs.writeFile(other, PNG);
    return { code: 0, stdout: '{"type":"thread.started","thread_id":"thread-42"}\n', stderr: '' };
  };
  await assert.rejects(callTool('make_image', { prompt: 'p' }, deps), /thread-42/);
});

test('codex route: without a thread id in the output nothing is picked', async () => {
  const { deps, env } = await sandbox();
  await callTool('set_image_source', { source: 'codex' }, deps);
  deps.run = async () => {
    const made = path.join(env.CODEX_HOME, 'generated_images', 'someone', 'exec.png');
    await fs.mkdir(path.dirname(made), { recursive: true });
    await fs.writeFile(made, PNG);
    return { code: 0, stdout: '', stderr: '' };
  };
  await assert.rejects(callTool('make_image', { prompt: 'p' }, deps), /thread id/);
});

test('openai route: one generations call with the key and prompt; image written from b64_json', async () => {
  const { deps, env } = await sandbox({ SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY, SPRENG_IMAGES_OPENAI_MODEL: '${user_config.openai_image_model}' });
  await callTool('set_image_source', { source: 'openai' }, deps);
  const calls = [];
  deps.fetch = async (url, init) => { calls.push({ url, init }); return res(200, { data: [{ b64_json: PNG.toString('base64') }] }); };
  const out = await callTool('make_image', { prompt: 'the prompt', size: '1024x1024' }, deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: 'gpt-image-2', prompt: 'the prompt', n: 1, size: '1024x1024' });
  assert.deepEqual(await fs.readFile(out.path), PNG);
  assert.ok(out.path.startsWith(path.join(env.CLAUDE_PROJECT_DIR, 'spreng-images')));
});

test('openai route: references go to /v1/images/edits as image[] files', async () => {
  const { deps, dir } = await sandbox({ SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  await callTool('set_image_source', { source: 'openai' }, deps);
  const local = path.join(dir, 'ref.png');
  await fs.writeFile(local, PNG);
  let call;
  deps.fetch = async (url, init) => { call = { url, init }; return res(200, { data: [{ b64_json: PNG.toString('base64') }] }); };
  await callTool('make_image', { prompt: 'p', references: [local] }, deps);
  assert.equal(call.url, 'https://api.openai.com/v1/images/edits');
  assert.ok(call.init.body instanceof FormData);
  assert.equal(call.init.body.getAll('image[]').length, 1);
  assert.equal(call.init.body.get('prompt'), 'p');
});

test('openai route: without a key it points to /plugin configure and makes no call', async () => {
  const { deps } = await sandbox({ SPRENG_IMAGES_OPENAI_KEY: '${user_config.openai_api_key}' });
  await callTool('set_image_source', { source: 'openai' }, deps);
  await assert.rejects(callTool('make_image', { prompt: 'p' }, deps), /plugin configure spreng-images@spreng/);
});

test('kie route: one createTask, polls recordInfo to success, downloads the result', async () => {
  const { deps } = await sandbox({ SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  await callTool('set_image_source', { source: 'kie' }, deps);
  const calls = [];
  let polls = 0;
  deps.fetch = async (url, init = {}) => {
    calls.push(url);
    if (url.endsWith('/createTask')) {
      assert.equal(init.headers.authorization, `Bearer ${KIE_KEY}`);
      assert.deepEqual(JSON.parse(init.body), { model: 'nano-banana-pro', input: { prompt: 'p', aspect_ratio: '9:16', image_input: ['https://x.example/r.png'] } });
      return res(200, { code: 200, data: { taskId: 'task_1' } });
    }
    if (url.includes('/recordInfo')) {
      polls++;
      return res(200, { data: polls < 2 ? { state: 'generating' } : { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://tempfile.example/out.png'] }) } });
    }
    if (url === 'https://tempfile.example/out.png') return res(200, null);
    throw new Error(url);
  };
  const out = await callTool('make_image', { prompt: 'p', references: ['https://x.example/r.png'], aspectRatio: '9:16' }, deps);
  assert.equal(calls.filter((u) => u.endsWith('/createTask')).length, 1);
  assert.equal(out.taskId, 'task_1');
  assert.deepEqual(await fs.readFile(out.path), PNG);
});

test('kie route: an unclear create is reported and never sent twice', async () => {
  const { deps } = await sandbox({ SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  await callTool('set_image_source', { source: 'kie' }, deps);
  let creates = 0;
  deps.fetch = async () => { creates++; throw new Error('socket hang up'); };
  await assert.rejects(callTool('make_image', { prompt: 'p' }, deps), /unclear outcome.*not retried/);
  assert.equal(creates, 1);
});

test('kie route: a task id collects a running task without creating another', async () => {
  const { deps } = await sandbox({ SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  await callTool('set_image_source', { source: 'kie' }, deps);
  const urls = [];
  deps.fetch = async (url) => {
    urls.push(url);
    if (url.includes('/recordInfo')) return res(200, { data: { state: 'success', resultJson: { resultUrls: ['https://tempfile.example/o.png'] } } });
    return res(200, null);
  };
  await callTool('make_image', { prompt: 'p', kieTaskId: 'task_9' }, deps);
  assert.ok(!urls.some((u) => u.endsWith('/createTask')));
  assert.ok(urls[0].endsWith('taskId=task_9'));
});

test('kie route: a polling network error keeps the task id; the same call again resumes it with no second create', async () => {
  const { deps, env } = await sandbox({ SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  await callTool('set_image_source', { source: 'kie' }, deps);
  let creates = 0;
  let pollFails = true;
  const polled = [];
  deps.fetch = async (url) => {
    if (url.endsWith('/createTask')) { creates++; return res(200, { code: 200, data: { taskId: `task_${creates}` } }); }
    if (url.includes('/recordInfo')) {
      if (pollFails) throw new Error('socket hang up');
      polled.push(url.split('taskId=')[1]);
      return res(200, { data: { state: 'success', resultJson: { resultUrls: ['https://tempfile.example/o.png'] } } });
    }
    if (url === 'https://tempfile.example/o.png') return res(200, null);
    throw new Error(url);
  };
  const args = { prompt: 'p', aspectRatio: '1:1' };
  const first = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'make_image', arguments: args } }, deps);
  assert.equal(first.result.isError, true);
  assert.match(first.result.content[0].text, /task_1/, 'the error keeps the task id');
  assert.match(first.result.content[0].text, /socket hang up/);
  assert.equal(creates, 1);
  const kept = await fs.readdir(path.join(env.CLAUDE_PLUGIN_DATA, 'operations-v1'));
  assert.equal(kept.length, 1, 'the task id is on disk');
  pollFails = false;
  const out = await callTool('make_image', args, deps);
  assert.equal(creates, 1, 'no second paid create');
  assert.equal(out.taskId, 'task_1');
  assert.equal(out.resumed, true);
  assert.deepEqual(polled, ['task_1'], 'the resumed call polls the first task');
  assert.deepEqual(await fs.readFile(out.path), PNG);
  const again = await callTool('make_image', args, deps);
  assert.equal(creates, 1, 'the same request after it finished returns the kept image, never a second purchase');
  assert.equal(again.replayed, true);
  assert.equal(again.taskId, 'task_1');
  await callTool('make_image', { ...args, operationId: 'claim-next' }, deps);
  assert.equal(creates, 2, 'another image needs a new operationId');
});

test('kie route: an operationId names the operation; a different one starts its own task', async () => {
  const { deps } = await sandbox({ SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  await callTool('set_image_source', { source: 'kie' }, deps);
  let creates = 0;
  deps.fetch = async (url) => {
    if (url.endsWith('/createTask')) { creates++; return res(200, { code: 200, data: { taskId: `task_${creates}` } }); }
    throw new Error('socket hang up');
  };
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-a' }, deps), /task_1.*claim-a|claim-a.*task_1/);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-a' }, deps), /task_1/);
  assert.equal(creates, 1);
  await assert.rejects(callTool('make_image', { prompt: 'p', operationId: 'claim-b' }, deps), /task_2/);
  assert.equal(creates, 2);
});

test('kie route: a polling HTTP error answer is kept in the error with the task id', async () => {
  const { deps } = await sandbox({ SPRENG_IMAGES_KIE_KEY: KIE_KEY });
  await callTool('set_image_source', { source: 'kie' }, deps);
  deps.fetch = async (url) => {
    if (url.endsWith('/createTask')) return res(200, { code: 200, data: { taskId: 'task_7' } });
    if (url.includes('/recordInfo')) return res(200, { data: { state: 'success', resultJson: { resultUrls: ['https://tempfile.example/o.png'] } } });
    return res(500, null);
  };
  await assert.rejects(callTool('make_image', { prompt: 'p' }, deps), /task_7/);
});

test('kie input: reference field per documented model, refused for others', () => {
  assert.deepEqual(kieInput('gpt-image-2-image-to-image', 'p', ['https://a/b.png']), { prompt: 'p', input_urls: ['https://a/b.png'] });
  assert.throws(() => kieInput('some-model', 'p', ['https://a/b.png']), /only wired/);
});

test('other route: no call; says what to do next', async () => {
  const { deps } = await sandbox();
  await callTool('set_image_source', { source: 'other', otherName: 'my design tool' }, deps);
  const out = await callTool('make_image', { prompt: 'p' }, deps);
  assert.equal(out.source, 'other');
  assert.match(out.next, /my design tool.*finalize_native_image.*upload only when/);
});

test('a key never appears in a tool answer, even inside a provider error', async () => {
  const { deps } = await sandbox({ SPRENG_IMAGES_OPENAI_KEY: OPENAI_KEY });
  await callTool('set_image_source', { source: 'openai' }, deps);
  deps.fetch = async () => res(401, { error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } });
  const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'make_image', arguments: { prompt: 'p' } } }, deps);
  assert.equal(reply.result.isError, true);
  assert.ok(!JSON.stringify(reply).includes(OPENAI_KEY));
  assert.match(reply.result.content[0].text, /\[key\]/);
  assert.equal(scrub(`a ${KIE_KEY} b`, { SPRENG_IMAGES_KIE_KEY: KIE_KEY }), 'a [key] b');
});

test('codex task text keeps the prompt between markers and adds no creative direction', () => {
  const t = codexTask('P');
  assert.match(t, /<<<SPRENG_PROMPT\nP\nSPRENG_PROMPT>>>/);
  assert.doesNotMatch(t, /lighting|colou?r|style|font|composition|camera|mood/i);
});

test('the real server answers initialize and tools/list over stdio', async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'plugins/spreng-images/server/server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  for (let i = 0; i < 50 && lines.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  child.kill();
  const [init, list] = lines.map((l) => JSON.parse(l));
  assert.equal(init.result.serverInfo.name, 'spreng-images');
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
});

// Model-facing wording (tool descriptions and the image-source skill) changes only with the owner's prior permission.
// Pinned tool text retains the 2026-10-05 receipt routing; the skill includes owner-authorized
// 2026-10-07 H2 setup guidance. No creative direction was added.
test('model-facing wording: the spreng-images tool descriptions and the image-source skill are the approved text', async () => {
  const { createHash } = await import('node:crypto');
  const hash = (d) => createHash('sha256').update(d).digest('hex');
  const make = TOOLS.find((t) => t.name === 'make_image');
  assert.doesNotMatch(make.description, /whichever source/);
  assert.doesNotMatch(make.inputSchema.properties.operationId.description, /switching source/);
  const skill = await fs.readFile(path.join(ROOT, 'plugins/spreng-images/skills/image-source/SKILL.md'));
  assert.doesNotMatch(String(skill), /also after switching source/);
  assert.equal(hash(JSON.stringify(TOOLS)), 'deb0538b46f12104ab643cf852df707afdb84f62defd3da14a77ca155006718c', 'tool descriptions with owner-delegated format transport 2026-10-07');
  assert.equal(hash(skill), '0b76945792104ce07ab1581ae67ab32126903a2f9049599d9983f5838c6f3e1b', 'image-source skill with H2 setup, approved shape transport and 2026-10-08 connector policy');
});
