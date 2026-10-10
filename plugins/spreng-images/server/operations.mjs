// operations.mjs: the one journal that makes one operation id buy at most one image, used by every route that calls
// a provider (Codex, OpenAI, KIE, and collecting a KIE task by its id).
//
// Before the provider call, the operation is reserved by creating its record file exclusively (O_EXCL), so a second
// call with the same id, at the same time or later, finds the record instead of paying again. The record then
// moves through these states and is kept on this computer ($CLAUDE_PLUGIN_DATA/operations-v1/):
//
//   submitting  reserved; the paid call is being sent (or the process stopped while it was)
//   uncertain   the paid call may have been charged but no usable answer came back; never resent
//   accepted    KIE accepted the task; the same operation again collects that task
//   completed   the image is kept next to the record with its sha256; the same operation again returns it, and the
//               file at outPath is checked by content (never by size) before it is reported
//   failed      the provider finished the job without an image; the same operation again reports that
//
// Only these release the reservation, because nothing was bought: a clear refusal from a paid provider, a failure
// before the request was sent (such as a reference that could not be downloaded, or a codex program that could not
// be started), and a lost status check while collecting a KIE task by its id (collecting buys nothing). Once codex
// has started, any failure is kept as uncertain, since it may already have made the image. Another image needs a
// new operation id.
//
// The journal is one versioned folder, operations-v1/, with one record per operation, named by the canonical project
// folder AND the operation id. Every record keeps the provider and the model it was sent with. The fingerprint holds
// the project, the prompt and a hash of each reference (the content of a local file, the link itself for a URL). The
// same operation id in another project is that project's own operation, so one project never receives another
// project's kept image.
//
// A local reference is read once: its bytes are copied into the request's own work folder and hashed, and the
// provider gets that copy, so what is sent is always what was fingerprinted, even if the project file changes
// while the request runs.
//
// One request is one operation whichever source makes it: an automatic id (no operationId given) is derived from
// the request alone (project, prompt, references, aspect ratio, size, outPath), never from the source or the model,
// so every route reserves the same record. The one lookup before anything is sent is reserveOperation, which every
// route runs: switching image source or model, or two routes at the same moment, finds the record and never buys the
// same request twice. Another source or model for the same request needs a new operation id.

import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = (data) => createHash('sha256').update(data).digest('hex');

const autoId = (fields) => 'auto-' + sha(JSON.stringify(fields)).slice(0, 16);

/**
 * The operation id of a request: the one given, else one derived from everything that defines the image, including
 * the project it is saved in (the journal is shared by every project on this computer) and never the source or the
 * model (the same request on another source is the same operation).
 */
export function operationIdFor(job) {
  if (job.operationId) return String(job.operationId);
  return autoId({
    project: job.projectDir || null, prompt: job.prompt, references: job.references || [], aspectRatio: job.aspectRatio || null,
    size: job.size || null, outPath: job.requestedOutPath || null,
    ...(job.requestedSize ? { requestedSize: job.requestedSize } : {}),
  });
}

/** The model each source uses unless the user configured another (server.mjs). */
export const DEFAULT_MODELS = { codex: 'codex', openai: 'gpt-image-2', kie: 'nano-banana-pro' };

/** The journal folder in the plugin data folder (server.mjs). Records in any other folder are not read. */
export const JOURNAL_DIR = 'operations-v1';

/** What the operation buys; the same id with a different request is refused. */
export function fingerprintOf(request) {
  return sha(JSON.stringify(request));
}

const isUrl = (ref) => /^https?:\/\//i.test(ref);

/** A path with every existing folder resolved through symlinks (the part not there yet is kept as given). */
export async function canonicalPath(fs, p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    try { return path.join(await fs.realpath(head), ...tail); } catch { /* not there yet */ }
    const parent = path.dirname(head);
    if (parent === head) return path.resolve(p);
    tail.unshift(path.basename(head));
    head = parent;
  }
}

/**
 * Read each local reference once, copy those bytes into the request's own work folder (keeping the file name) and
 * hash them; a link is hashed as the link. Returns the references to hand the provider and their hashes, so the
 * provider always gets the bytes that were fingerprinted.
 */
export async function snapshotReferences(deps, references = [], workDir) {
  const refs = [];
  const hashes = [];
  for (const [i, ref] of references.entries()) {
    if (isUrl(ref)) { refs.push(ref); hashes.push(sha('url:' + ref)); continue; }
    let data;
    try { data = await deps.fs.readFile(ref); } catch (e) { throw new Error(`reference ${i + 1} (${ref}) could not be read: ${e.message}; nothing was sent.`); }
    const copy = path.join(workDir, `local-${i + 1}`, path.basename(ref));
    await deps.fs.mkdir(path.dirname(copy), { recursive: true });
    await deps.fs.writeFile(copy, data, { flag: 'wx' });
    refs.push(copy);
    hashes.push(sha(data));
  }
  return { refs, hashes };
}

/** The fingerprint of a request in a project: the project, the prompt, the reference hashes and the route's fields. */
export function requestFingerprint(job, fields, referenceHashes) {
  return fingerprintOf({ ...fields, project: job.projectDir || null, prompt: job.prompt, references: referenceHashes });
}

async function writeAtomic(deps, file, data) {
  const tmp = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await deps.fs.writeFile(tmp, data);
  await deps.fs.rename(tmp, file);
}

async function readRecord(deps, file) {
  try { return JSON.parse(await deps.fs.readFile(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    return null; // there, but not readable (being written)
  }
}

/** The record file of an operation: one per canonical project folder and operation id. */
const recordFile = (dir, project, id) => path.join(dir, `${sha(JSON.stringify(['op', project, id])).slice(0, 32)}.json`);

const stateOf = (saved) => (saved.state ? ` (${saved.state}${saved.reason ? `: ${saved.reason}` : ''}${saved.taskId ? `, task ${saved.taskId}` : ''})` : '');

/** A source and its model as named in an answer (Codex has no model setting). */
const via = (provider, model) => (provider === 'Codex CLI' || !model ? provider : `${provider} ${model}`);

/** The same request was already sent through another source or model: refuse, naming it. */
function sentElsewhere(saved, provider, model) {
  const before = via(saved.provider, saved.model);
  const now = via(provider, model);
  const collect = saved.taskId && saved.state !== 'completed' && saved.state !== 'failed' ? ` Choosing ${before} again, the same request collects that task.` : '';
  return new Error(`This request was already sent to ${before} as operation ${saved.operationId}${stateOf(saved)} in this project; nothing was sent to ${now} and nothing was bought again.${collect} Check your ${saved.provider} account; for a new image from ${now}, use a new operationId.`);
}

/**
 * Reserve an operation before the paid call, for every route: the one lookup before anything is sent. The operation
 * id is derived here (or the given one used) and its record file is created exclusively in the journal. Returns
 * { fresh: true } when this call owns it, or { fresh: false } with the kept record when the same request already has
 * one. A kept record of another request under the same id, or of the same request on another source or model, refuses
 * the call: nothing is sent.
 */
export async function reserveOperation(deps, { job, model, fingerprint, provider, legacyFingerprint }) {
  const operationId = operationIdFor(job);
  const project = job.projectDir || null;
  const file = recordFile(job.stateDir, project, operationId);
  const record = { operationId, project, provider, model, fingerprint, state: 'submitting', reservedAt: deps.now().toISOString() };
  await deps.fs.mkdir(job.stateDir, { recursive: true });
  try {
    await deps.fs.writeFile(file, JSON.stringify(record, null, 2), { flag: 'wx' });
    return { fresh: true, file, record, operationId, provider };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const saved = await readRecord(deps, file);
  if (!saved) {
    throw new Error(`Operation ${operationId} is in progress in another call (its record is being written); it was not sent again.`);
  }
  // Codex formerly ignored geometry. An exact old request can recover its original receipt, never submit again.
  const legacy = saved.provider === provider && saved.model === model && saved.fingerprint === legacyFingerprint;
  if (saved.fingerprint !== fingerprint && !legacy) {
    if (saved.provider !== provider || saved.model !== model) throw sentElsewhere(saved, provider, model);
    throw new Error(`Operation ${operationId} was already used for a different image request; nothing was sent. recover_image with this operationId retrieves an already-made image. Use a new operationId for a new image.`);
  }
  return { fresh: false, file, record: saved, operationId, provider, legacy };
}

export async function updateOperation(deps, op, fields) {
  op.record = { ...op.record, ...fields };
  await writeAtomic(deps, op.file, JSON.stringify(op.record, null, 2));
}

/** A clear refusal: nothing was charged, so the operation id is free again. */
export async function releaseOperation(deps, op) {
  await deps.fs.rm(op.file, { force: true });
}

/** Keep the operation as unclear (best effort: if this write fails, the record stays "submitting", also never resent). */
export async function markUncertain(deps, op, reason) {
  try { await updateOperation(deps, op, { state: 'uncertain', reason, at: deps.now().toISOString() }); } catch { /* still reserved */ }
}

export async function markFailed(deps, op, reason) {
  try { await updateOperation(deps, op, { state: 'failed', reason, at: deps.now().toISOString() }); } catch { /* still reserved */ }
}

/**
 * Save the kept image at outPath, checked by content: the kept file must match the hash in its record, a file
 * already at outPath is left alone only when its content is the same, and the copy is read back and checked.
 */
async function deliver(deps, resultFile, outPath, expectedSha) {
  const kept = await deps.fs.readFile(resultFile);
  const keptSha = sha(kept);
  if (expectedSha && keptSha !== expectedSha) {
    throw new Error(`the image kept at ${resultFile} does not match its record (it was changed or damaged), so it was not used`);
  }
  const want = expectedSha || keptSha;
  const there = await deps.fs.readFile(outPath).catch(() => null);
  if (there && sha(there) === want) return;
  await deps.fs.mkdir(path.dirname(outPath), { recursive: true });
  await deps.fs.copyFile(resultFile, outPath);
  const written = await deps.fs.readFile(outPath);
  if (sha(written) !== want) throw new Error(`the file written at ${outPath} does not match the kept image`);
}

/**
 * The paid image arrived: keep it with the record first (the durable receipt), then save it at outPath. A failed
 * save at outPath leaves the operation completed, so the same operation again saves it without paying.
 */
export async function completeOperation(deps, op, bytes, outPath, result) {
  const resultFile = op.file.replace(/\.json$/, '.image');
  try {
    await writeAtomic(deps, resultFile, bytes);
    await updateOperation(deps, op, {
      state: 'completed', outPath, resultFile, resultSha256: sha(bytes), result, completedAt: deps.now().toISOString(),
    });
  } catch (e) {
    await markUncertain(deps, op, `the image was made but could not be kept on this computer: ${e.message}`);
    throw new Error(`${op.provider} made the image for operation ${op.operationId} (it may be charged) but it could not be kept on this computer (${e.message}); it was not sent again. Free some disk space; for a new image use a new operationId.`);
  }
  try {
    await deliver(deps, resultFile, outPath, op.record.resultSha256);
  } catch (e) {
    throw new Error(`The image for operation ${op.operationId} is made and kept on this computer, but saving it at ${outPath} failed (${e.message}). The same make_image request again saves it without buying another.`);
  }
  return { ...result, path: outPath, operationId: op.operationId };
}

/** The answer for an operation that already exists and is not a KIE task still to collect. */
export async function replayOperation(deps, op) {
  const r = op.record;
  if (r.state === 'completed') {
    try {
      await deliver(deps, r.resultFile, r.outPath, r.resultSha256);
    } catch (e) {
      throw new Error(`The image for operation ${op.operationId} is kept on this computer, but saving it at ${r.outPath} failed (${e.message}). Nothing was bought again.`);
    }
    return { ...r.result, path: r.outPath, operationId: op.operationId, replayed: true };
  }
  if (r.state === 'failed') {
    throw new Error(`Operation ${op.operationId} failed: ${r.reason}. It was not sent again; use a new operationId to try again.`);
  }
  const why = r.state === 'uncertain' && r.reason ? ` (${r.reason})` : '';
  throw new Error(`Operation ${op.operationId} was sent to ${r.provider || op.provider} at ${r.reservedAt} and is in progress in another call, or its outcome is unclear${why}. It was not sent again, so nothing more is charged. Check your ${r.provider || op.provider} account; for a new image use a new operationId.`);
}

/** Local receipt lookup, independent of the original prompt, expiring reference links and source configuration. */
export async function recoverOperation(deps, { stateDir, projectDir, operationId }) {
  const file = recordFile(stateDir, projectDir || null, operationId);
  const record = await readRecord(deps, file);
  if (!record) return {
    operationId, state: record === undefined ? 'not_found' : 'unreadable', recovered: false,
    warning: 'No completed image receipt could be read in this project.',
  };
  if (record.state !== 'completed') return {
    operationId, state: record.state, recovered: false,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    warning: 'This operation has no completed image receipt yet. Nothing was sent.',
  };
  return replayOperation(deps, { file, record, operationId, provider: record.provider });
}
