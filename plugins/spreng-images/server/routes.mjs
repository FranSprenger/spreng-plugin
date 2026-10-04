// routes.mjs: the four image sources of the spreng-images add-on. Each route makes ONE image from the prompt it
// is given, unchanged, and writes the file to outPath. Nothing here talks to Spreng: the Spreng upload
// (create_native_image_upload, PUT, finalize_native_image) stays the assistant's next step, the same whichever
// source made the file. Every outside call goes through deps (fetch, spawn, fs), so tests run with mocks.
//
//   codex   the user's own Codex CLI, signed in with their ChatGPT plan: `codex exec` with its built-in image
//           tool; Codex saves the image under $CODEX_HOME/generated_images/, this route copies it to outPath
//   openai  the user's own OpenAI key: POST https://api.openai.com/v1/images/generations (or /v1/images/edits
//           with reference files), one image, b64_json written to outPath
//   kie     the user's own KIE key: POST https://api.kie.ai/api/v1/jobs/createTask once, then
//           GET /api/v1/jobs/recordInfo until success or fail, then the result file is downloaded to outPath
//   other   a source the user named: no call; the answer says what to do with the file once it exists
//
// Every route that calls a provider (codex, openai, kie, and collecting a KIE task by id) runs each request as one
// operation (operations.mjs): the operation is reserved on this computer before the provider call, unclear and
// finished outcomes are kept, and the same operation again returns what is kept (the image, the KIE task, or the unclear or failed outcome) instead of paying again. An
// unclear outcome (network error, timeout, 5xx, lost answer) is reported, never retried, so the user is never
// charged twice for one image. Another image needs a new operation id.

import path from 'node:path';
import {
  operationIdFor, fingerprintOf, requestFingerprint, legacyFingerprints, earlierRecords, snapshotReferences, reserveOperation, updateOperation, releaseOperation, markUncertain, markFailed,
  completeOperation, replayOperation,
} from './operations.mjs';

export const SOURCES = ['codex', 'openai', 'kie', 'other'];
export const OPENAI_BASE = 'https://api.openai.com';
export const KIE_BASE = 'https://api.kie.ai';
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/** A configured secret, or '' when it is missing or still Claude Code's unexpanded `${user_config.x}` text. */
export function secret(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return !s || s.startsWith('${') ? '' : s;
}

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

/**
 * Reference files as local paths: URLs are downloaded into tmpDir first (Codex and the OpenAI edit take files).
 * Local references arrive here already copied into tmpDir by snapshotReferences.
 */
async function localRefs(refs = [], tmpDir, deps) {
  const out = [];
  for (const [i, ref] of refs.entries()) {
    if (!/^https?:\/\//i.test(ref)) { out.push(ref); continue; }
    const r = await deps.fetch(ref);
    if (!r.ok) throw new Error(`reference ${i + 1} could not be downloaded: HTTP ${r.status}`);
    const type = r.headers?.get?.('content-type') || '';
    const ext = /png/.test(type) ? '.png' : /webp/.test(type) ? '.webp' : '.jpg';
    const file = path.join(tmpDir, `reference-${i + 1}${ext}`);
    await deps.fs.mkdir(tmpDir, { recursive: true });
    await deps.fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
    out.push(file);
  }
  return out;
}

async function listImages(dir, fs) {
  const found = [];
  async function walk(d) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (IMAGE_EXT.test(e.name)) found.push(p);
    }
  }
  await walk(dir);
  return found;
}

/** The text handed to `codex exec`: the Spreng prompt between markers, unchanged, plus how to return the file. */
export function codexTask(prompt) {
  return [
    'Make one image with your built-in image generation tool from the prompt between the markers, word for word,',
    'using any attached images as the references the prompt describes. Do not edit or create other files.',
    'Reply with the path of the image file.',
    '<<<SPRENG_PROMPT',
    prompt,
    'SPRENG_PROMPT>>>',
  ].join('\n');
}

export async function runCodex(job, deps) {
  const { prompt, tmpDir, stateDir } = job;
  const snap = await snapshotReferences(deps, job.references, tmpDir);
  const op = await reserveOperation(deps, stateDir, {
    project: job.projectDir,
    operationId: operationIdFor(job, 'codex', 'codex'),
    fingerprint: requestFingerprint(job, { source: 'codex' }, snap.hashes),
    legacy: legacyFingerprints(job, (references) => ({ source: 'codex', prompt, references })),
    earlier: earlierRecords(job, 'codex', 'codex'),
    provider: 'Codex CLI',
  });
  if (!op.fresh) return replayOperation(deps, op);
  const codexHome = deps.env.CODEX_HOME || path.join(deps.homedir(), '.codex');
  const imagesDir = path.join(codexHome, 'generated_images');
  let before;
  let args;
  try {
    before = new Set(await listImages(imagesDir, deps.fs));
    const refs = await localRefs(snap.refs, tmpDir, deps);
    args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-C', tmpDir];
    for (const r of refs) args.push('-i', r);
    args.push(codexTask(prompt));
    await deps.fs.mkdir(tmpDir, { recursive: true });
  } catch (e) {
    await releaseOperation(deps, op); // codex was not started
    throw e;
  }
  // From here codex may have made an image, even when it fails afterwards (a timeout, a lost answer, a nonzero
  // exit after saving). Only a codex that could not be started at all frees the operation; anything else is kept
  // as unclear and never run again for the same operation.
  let thread = null;
  const unclear = async (why) => {
    const where = thread ? ` Any image it made is in ${path.join(imagesDir, thread)}.` : '';
    await markUncertain(deps, op, why);
    return new Error(`${why}. Codex was started for operation ${op.operationId}, so it was not run again.${where} For a new image use a new operationId.`);
  };
  let ran;
  try {
    ran = await deps.run(deps.env.SPRENG_IMAGES_CODEX_BIN || 'codex', args, { timeoutMs: 10 * 60 * 1000 });
  } catch (e) {
    throw await unclear(`codex exec ended without an answer: ${e.message}`);
  }
  const { code, stdout, stderr, started } = ran;
  if (started === false) {
    await releaseOperation(deps, op); // the program never started, so nothing was made
    throw new Error(`codex could not be started: ${String(stderr || '').trim().slice(-400) || 'no error text'}`);
  }
  thread = (String(stdout).match(/"thread_id"\s*:\s*"([A-Za-z0-9_-]+)"/) || [])[1] || null;
  if (code !== 0) throw await unclear(`codex exec exited ${code}: ${String(stderr || '').trim().slice(-400) || 'no error text'}`);
  // Only an image Codex filed under THIS run's thread (generated_images/<thread_id>/) is used. Other Codex
  // sessions on this computer save into the same generated_images folder, so any other new image may belong
  // to another session (another client) and is never taken.
  if (!thread) throw await unclear('codex finished without a thread id in its output, so its image cannot be told apart from other Codex sessions; nothing was copied');
  const threadDir = path.join(imagesDir, thread);
  const pick = (await listImages(threadDir, deps.fs)).filter((f) => !before.has(f)).sort().at(-1);
  if (!pick) throw await unclear(`codex thread ${thread} finished but no new image appeared in ${threadDir}; images from other Codex sessions are never used (is the Codex CLI signed in with a ChatGPT plan that includes images?)`);
  let bytes;
  try { bytes = await deps.fs.readFile(pick); } catch (e) { throw await unclear(`the image codex made at ${pick} could not be read: ${e.message}`); }
  return completeOperation(deps, op, bytes, job.outPath, { source: 'codex', madeBy: 'Codex CLI image tool', codexFile: pick });
}

/** A clear refusal from a provider (nothing was charged): any 4xx except 408 (timeout). */
const refused = (status) => status >= 400 && status < 500 && status !== 408;

export async function runOpenAI(job, deps, { key, model }) {
  const { prompt, tmpDir, size, stateDir } = job;
  if (!key) throw new Error('No OpenAI key is set. Run /plugin configure spreng-images@spreng and enter it there (never in the chat).');
  const snap = await snapshotReferences(deps, job.references, tmpDir);
  const op = await reserveOperation(deps, stateDir, {
    project: job.projectDir,
    operationId: operationIdFor(job, 'openai', model),
    fingerprint: requestFingerprint(job, { source: 'openai', model, size: size || null }, snap.hashes),
    legacy: legacyFingerprints(job, (references) => ({ source: 'openai', model, prompt, references, size: size || null })),
    earlier: earlierRecords(job, 'openai', model),
    provider: 'OpenAI',
  });
  if (!op.fresh) return replayOperation(deps, op);

  const auth = { authorization: `Bearer ${key}` };
  let request;
  try {
    const refs = await localRefs(snap.refs, tmpDir, deps);
    if (refs.length) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      if (size) form.append('size', size);
      for (const f of refs) form.append('image[]', new Blob([await deps.fs.readFile(f)], { type: mimeOf(f) }), path.basename(f));
      request = [`${OPENAI_BASE}/v1/images/edits`, { method: 'POST', headers: auth, body: form }];
    } else {
      request = [`${OPENAI_BASE}/v1/images/generations`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt, n: 1, ...(size ? { size } : {}) }),
      }];
    }
  } catch (e) {
    await releaseOperation(deps, op); // nothing was sent
    throw e;
  }

  const unclear = async (why) => {
    await markUncertain(deps, op, why);
    return new Error(`OpenAI call for operation ${op.operationId} had an unclear outcome (${why}); it may have been charged and was not retried. Check your OpenAI account; for a new image use a new operationId.`);
  };
  let r;
  try { r = await deps.fetch(...request); } catch (e) { throw await unclear(e.message); }
  let body = null;
  let lost = null;
  try { body = await r.json(); } catch (e) { lost = e.message; }
  if (!r.ok) {
    const msg = body?.error?.message || 'no message';
    if (refused(r.status)) {
      await releaseOperation(deps, op);
      throw new Error(`OpenAI answered HTTP ${r.status}: ${msg}`);
    }
    throw await unclear(`HTTP ${r.status}: ${msg}`);
  }
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw await unclear(lost ? `the answer was lost: ${lost}` : 'the answer had no image data (data[0].b64_json)');
  return completeOperation(deps, op, Buffer.from(b64, 'base64'), job.outPath, { source: 'openai', madeBy: `OpenAI ${model} on the user's key` });
}

/** KIE input for the two image models whose reference field is documented. */
export function kieInput(model, prompt, references, aspectRatio) {
  const input = { prompt };
  if (aspectRatio) input.aspect_ratio = aspectRatio;
  if (references.length) {
    if (/nano-banana/i.test(model)) input.image_input = references; // https://docs.kie.ai/market/google/pro-image-to-image
    else if (/gpt-image/i.test(model)) input.input_urls = references; // https://docs.kie.ai/market/gpt/gpt-image-2-image-to-image
    else throw new Error(`references are only wired for nano-banana and gpt-image models on KIE, not "${model}"`);
  }
  return input;
}

export async function runKie(job, deps, { key, model, pollMs = 5000, maxPolls = 120 }) {
  const { prompt, references = [], aspectRatio, kieTaskId, stateDir } = job;
  if (!key) throw new Error('No KIE key is set. Run /plugin configure spreng-images@spreng and enter it there (never in the chat).');
  const urls = references.filter((r) => /^https:\/\//i.test(r));
  if (urls.length !== references.length) throw new Error('KIE takes reference images as https links only.');
  const auth = { authorization: `Bearer ${key}` };
  if (kieTaskId) return collectKie(job, deps, { auth, model, pollMs, maxPolls });

  const op = await reserveOperation(deps, stateDir, {
    project: job.projectDir,
    operationId: operationIdFor(job, 'kie', model),
    // KIE takes links only (checked above), so each reference is hashed as its link and nothing local is read.
    fingerprint: requestFingerprint(job, { source: 'kie', model, aspectRatio: aspectRatio || null }, (await snapshotReferences(deps, urls, job.tmpDir)).hashes),
    legacy: legacyFingerprints(job, (references) => ({ source: 'kie', model, prompt, references, aspectRatio: aspectRatio || null })),
    earlier: earlierRecords(job, 'kie', model),
    provider: 'KIE',
  });
  let taskId;
  let outPath = job.outPath;
  let resumed = false;
  if (!op.fresh) {
    if (op.record.state !== 'accepted' || !op.record.taskId) return replayOperation(deps, op);
    // KIE accepted this operation's task earlier and it was not collected: collect it, never create another.
    taskId = op.record.taskId;
    outPath = op.record.outPath || outPath;
    resumed = true;
  } else {
    try {
      taskId = await kieCreate(model, prompt, urls, aspectRatio, auth, deps, op.operationId);
    } catch (e) {
      if (e.kieRefused) await releaseOperation(deps, op);
      else await markUncertain(deps, op, e.message);
      throw e;
    }
    try {
      await updateOperation(deps, op, { state: 'accepted', taskId, model, outPath, acceptedAt: deps.now().toISOString() });
    } catch (e) {
      throw new Error(`KIE accepted task ${taskId} but it could not be saved on this computer (${e.message}); call make_image with kieTaskId ${taskId} to collect it instead of asking again.`);
    }
  }
  let got;
  try {
    got = await kiePoll(taskId, auth, deps, { pollMs, maxPolls });
  } catch (e) {
    if (e.kieFinished) await markFailed(deps, op, e.message);
    else e.message += ` [KIE task ${taskId}, operation ${op.operationId}: the same make_image request again (or operationId ${op.operationId}) collects this task without creating another]`;
    throw e;
  }
  const out = await completeOperation(deps, op, got.bytes, outPath, { source: 'kie', madeBy: `KIE ${model} on the user's key`, taskId });
  return { ...out, resumed };
}

/** Collect a KIE task by its id (no create): one collection per task id, and the collected image is kept. */
async function collectKie(job, deps, { auth, model, pollMs, maxPolls }) {
  const { kieTaskId, stateDir } = job;
  const op = await reserveOperation(deps, stateDir, {
    project: job.projectDir,
    operationId: `kie-task-${kieTaskId}`,
    fingerprint: fingerprintOf({ source: 'kie', collect: String(kieTaskId), project: job.projectDir || null }),
    legacy: [fingerprintOf({ source: 'kie', collect: String(kieTaskId) })],
    earlier: earlierRecords({ ...job, operationId: `kie-task-${kieTaskId}` }, 'kie-collect', model),
    provider: 'KIE',
  });
  if (!op.fresh) return replayOperation(deps, op);
  let got;
  try {
    got = await kiePoll(kieTaskId, auth, deps, { pollMs, maxPolls });
  } catch (e) {
    if (e.kieFinished) await markFailed(deps, op, e.message);
    else await releaseOperation(deps, op); // collecting buys nothing, so it may be tried again
    throw e;
  }
  return completeOperation(deps, op, got.bytes, job.outPath, { source: 'kie', madeBy: `KIE ${model} on the user's key`, taskId: kieTaskId });
}

async function kieCreate(model, prompt, urls, aspectRatio, auth, deps, operationId) {
  const unclear = (why) => new Error(`KIE create for operation ${operationId} had an unclear outcome (${why}); it may have been accepted and charged, so it was not retried. Check your KIE dashboard; for a new image use a new operationId.`);
  let r;
  try {
    r = await deps.fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: kieInput(model, prompt, urls, aspectRatio) }),
    });
  } catch (e) {
    throw unclear(e.message);
  }
  let body;
  try { body = await r.json(); } catch { body = null; }
  const taskId = body?.data?.taskId;
  const code = typeof body?.code === 'number' ? body.code : undefined;
  if (r.ok && (code === undefined || code === 200) && taskId) return taskId;
  // A clear refusal (HTTP 4xx, or KIE's own 4xx code in a 200 answer, such as 402 for no credits) charged nothing.
  if (refused(r.status) || (r.ok && code !== undefined && refused(code))) {
    throw Object.assign(new Error(`KIE did not accept the task: HTTP ${r.status}${code !== undefined ? `, code ${code}` : ''}${body?.msg ? `, ${body.msg}` : ''}; nothing was charged.`), { kieRefused: true });
  }
  throw unclear(`HTTP ${r.status}${code !== undefined ? `, code ${code}` : ''}${body?.msg ? `, ${body.msg}` : ''}${taskId ? '' : ', no task id'}`);
}

/** An error after which the task is over on KIE's side, so there is nothing left to resume. */
function finished(message) {
  return Object.assign(new Error(message), { kieFinished: true });
}

/** Poll a KIE task until it finishes; resolves with the downloaded result bytes. */
async function kiePoll(taskId, auth, deps, { pollMs, maxPolls }) {
  for (let i = 0; i < maxPolls; i++) {
    await deps.sleep(pollMs);
    let p;
    try {
      p = await deps.fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: auth });
    } catch (e) {
      throw new Error(`KIE status check for task ${taskId} failed (${e.message}).`);
    }
    if (!p.ok) continue;
    let info;
    try { info = (await p.json())?.data || {}; } catch (e) { throw new Error(`KIE status for task ${taskId} could not be read (${e.message}).`); }
    if (info.state === 'fail') throw finished(`KIE task ${taskId} failed: ${info.failMsg || 'no reason given'}`);
    if (info.state !== 'success') continue;
    let result = info.resultJson;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = {}; } }
    const url = result?.resultUrls?.[0];
    if (!url) throw finished(`KIE task ${taskId} succeeded without a result link.`);
    let f;
    try { f = await deps.fetch(url); } catch (e) { throw new Error(`KIE result for task ${taskId} could not be downloaded (${e.message}).`); }
    if (!f.ok) throw new Error(`KIE result for task ${taskId} could not be downloaded: HTTP ${f.status}`);
    return { bytes: Buffer.from(await f.arrayBuffer()) };
  }
  throw new Error(`KIE task ${taskId} was still running after ${maxPolls} checks; call make_image with kieTaskId ${taskId} later instead of asking again.`);
}

export function runOther({ otherName, outPath }) {
  return {
    path: outPath,
    source: 'other',
    madeBy: otherName || 'a source the user named',
    next: `Make the image with ${otherName || 'that source'} from the prompt as given, save the file at ${outPath}, then continue with create_native_image_upload as usual.`,
  };
}
