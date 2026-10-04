// operations.mjs: the one journal that makes one operation id buy at most one image, used by every route that calls
// a provider (Codex, OpenAI, KIE, and collecting a KIE task by its id).
//
// Before the provider call, the operation is reserved by creating its record file exclusively (O_EXCL), so a second
// call with the same id, at the same time or later, finds the record instead of paying again. The record then
// moves through these states and is kept on this computer ($CLAUDE_PLUGIN_DATA/operations/):
//
//   submitting  reserved; the paid call is being sent (or the process stopped while it was)
//   uncertain   the paid call may have been charged but no usable answer came back; never resent
//   accepted    KIE accepted the task; the same operation again collects that task
//   completed   the image is kept next to the record with its sha256; the same operation again returns it, and the
//               file at outPath is checked by content (never by size) before it is reported
//   failed      the provider finished the job without an image; the same operation again reports that
//
// Only these release the reservation, because nothing was bought: a clear refusal from a paid provider, a Codex run
// that left no image (Codex uses the user's plan, not a per-image charge), and a lost status check while collecting
// a KIE task by its id (collecting buys nothing). Another image needs a new operation id.

import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = (data) => createHash('sha256').update(data).digest('hex');

/** The operation id of a request: the one given, else one derived from everything that defines the image. */
export function operationIdFor(job, source, model) {
  if (job.operationId) return String(job.operationId);
  return 'auto-' + sha(JSON.stringify({
    source, model, prompt: job.prompt, references: job.references || [], aspectRatio: job.aspectRatio || null,
    size: job.size || null, outPath: job.requestedOutPath || null,
  })).slice(0, 16);
}

/** What the operation buys; the same id with a different request is refused. */
export function fingerprintOf(request) {
  return sha(JSON.stringify(request));
}

async function writeAtomic(deps, file, data) {
  const tmp = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  await deps.fs.writeFile(tmp, data);
  await deps.fs.rename(tmp, file);
}

/**
 * Reserve an operation before the paid call. Returns { fresh: true } when this call owns it, or { fresh: false }
 * with the kept record when the operation already exists.
 */
export async function reserveOperation(deps, stateDir, { operationId, fingerprint, provider }) {
  const file = path.join(stateDir, `${sha('op:' + operationId).slice(0, 32)}.json`);
  const record = { operationId, provider, fingerprint, state: 'submitting', reservedAt: deps.now().toISOString() };
  await deps.fs.mkdir(stateDir, { recursive: true });
  try {
    await deps.fs.writeFile(file, JSON.stringify(record, null, 2), { flag: 'wx' });
    return { fresh: true, file, record, operationId, provider };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let saved = null;
  try { saved = JSON.parse(await deps.fs.readFile(file, 'utf8')); } catch { saved = null; }
  if (!saved) {
    throw new Error(`Operation ${operationId} is in progress in another call (its record is being written); it was not sent again.`);
  }
  if (saved.fingerprint !== fingerprint) {
    throw new Error(`Operation ${operationId} was already used for a different image request; nothing was sent. Use a new operationId for a new image.`);
  }
  return { fresh: false, file, record: saved, operationId, provider };
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
