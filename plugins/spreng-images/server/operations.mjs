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
// Only these release the reservation, because nothing was bought: a clear refusal from a paid provider, a failure
// before the request was sent (such as a reference that could not be downloaded, or a codex program that could not
// be started), and a lost status check while collecting a KIE task by its id (collecting buys nothing). Once codex
// has started, any failure is kept as uncertain, since it may already have made the image. Another image needs a
// new operation id.
//
// Operation ids are scoped by project: the record is found by the canonical project folder AND the operation id,
// and the fingerprint holds the project, the prompt and a hash of each reference (the content of a local file, the
// link itself for a URL). The same operation id in another project is that project's own operation, so one
// project never receives another project's kept image.
//
// A local reference is read once: its bytes are copied into the request's own work folder and hashed, and the
// provider gets that copy, so what is sent is always what was fingerprinted, even if the project file changes
// while the request runs.
//
// Records from the earlier journals (one file per operation id, no project: operations/, and kie-operations/ for
// the first KIE journal) are checked before a new record is made, under every id an earlier version derived for
// the same request, so upgrading never sends an operation again. Such a record moves to this project only when its
// file name was derived from this exact canonical project folder (an automatic id from the versions that put the
// project in it); every other earlier record stays unresolved: the operation is refused, nothing is sent and
// nothing from that record is used.

import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = (data) => createHash('sha256').update(data).digest('hex');

/**
 * The operation id of a request: the one given, else one derived from everything that defines the image,
 * including the project it is saved in (the journal is shared by every project on this computer).
 */
export function operationIdFor(job, source, model) {
  if (job.operationId) return String(job.operationId);
  return 'auto-' + sha(JSON.stringify({
    source, model, project: job.projectDir || null, prompt: job.prompt, references: job.references || [], aspectRatio: job.aspectRatio || null,
    size: job.size || null, outPath: job.requestedOutPath || null,
  })).slice(0, 16);
}

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

/**
 * The fingerprints the earlier journal gave the same request (fields in its order, references as the paths or links
 * it was given: resolved against the project, or as typed before that), to recognise its records.
 */
export function legacyFingerprints(job, fieldsFor) {
  const forms = [job.references || [], job.typedReferences || job.references || []];
  return [...new Set(forms.map((references) => fingerprintOf(fieldsFor(references))))];
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

const legacyFile = (dir, id) => path.join(dir, `${sha('op:' + id).slice(0, 32)}.json`);
const autoId = (fields) => 'auto-' + sha(JSON.stringify(fields)).slice(0, 16);

/**
 * Where the earlier journals may hold this request: [{ file, operationId, bound }], each id as that version derived
 * it (fields in its order). bound is true only for an automatic id that holds this canonical project folder, the
 * one proof that the record was made in this project; a given id, or an automatic id from before the project was
 * part of it, proves nothing about the project.
 */
export function earlierRecords(job, source, model) {
  const kieDir = path.join(path.dirname(job.stateDir), 'kie-operations');
  const dirs = source === 'kie' ? [job.stateDir, kieDir] : [job.stateDir];
  if (job.operationId) {
    const id = String(job.operationId);
    return dirs.map((dir) => ({ file: legacyFile(dir, id), operationId: id, bound: false }));
  }
  const { prompt } = job;
  const project = job.projectDir || null;
  const aspectRatio = job.aspectRatio || null;
  const size = job.size || null;
  const outPath = job.requestedOutPath || null;
  const resolved = job.references || [];
  const typed = job.typedReferences || resolved;
  const out = [];
  const add = (dir, fields, bound) => {
    const id = autoId(fields);
    if (!out.some((e) => e.operationId === id && e.file === legacyFile(dir, id))) out.push({ file: legacyFile(dir, id), operationId: id, bound });
  };
  // 816c1ae (references as typed) and a15c7cd (resolved against the project): the canonical project is in the id.
  if (project) for (const references of [resolved, typed]) add(job.stateDir, { source, model, project, prompt, references, aspectRatio, size, outPath }, true);
  // f0e3ddf and 066b539: no project, references as typed.
  add(job.stateDir, { source, model, prompt, references: typed, aspectRatio, size, outPath }, false);
  // ac007f2: KIE only, no source and no project, kept in kie-operations/.
  if (source === 'kie') add(kieDir, { model, prompt, references: typed, aspectRatio, outPath }, false);
  return out;
}

/**
 * Check the earlier journals before a new record is made. A record whose id was derived from this project is moved
 * to it (the earlier files are kept); any other earlier record refuses the operation without sending anything or
 * using anything from it.
 */
async function adoptLegacy(deps, { scope, operationId, fingerprint, legacy = [], earlier = [], provider, file }) {
  for (const entry of earlier) {
    const saved = await readRecord(deps, entry.file);
    if (saved === undefined) continue;
    const via = saved?.provider || provider;
    if (!saved || !scope || !entry.bound || saved.operationId !== entry.operationId) {
      const state = saved?.state ? ` (${saved.state}${saved.reason ? `: ${saved.reason}` : ''})` : saved?.taskId ? ' (accepted)' : '';
      throw new Error(`Operation ${operationId} has a record from an earlier version of this add-on${state} that does not show it belongs to this project; nothing was sent and nothing from that record was used. Check your ${via} account; for a new image use a new operationId.`);
    }
    if (!legacy.includes(saved.fingerprint)) {
      throw new Error(`Operation ${operationId} was already used for a different image request; nothing was sent. Use a new operationId for a new image.`);
    }
    const moved = { ...saved, operationId, project: scope, fingerprint, movedFrom: path.basename(entry.file), movedAt: deps.now().toISOString() };
    try {
      await deps.fs.writeFile(file, JSON.stringify(moved, null, 2), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // another call moved it at the same moment
    }
    return;
  }
}

/**
 * Reserve an operation before the paid call. Returns { fresh: true } when this call owns it, or { fresh: false }
 * with the kept record when the operation already exists (in this project, or moved here from the earlier journal).
 */
export async function reserveOperation(deps, stateDir, { project, operationId, fingerprint, legacy, earlier, provider }) {
  const scope = project || null;
  const file = path.join(stateDir, `${sha(JSON.stringify(['op', scope, operationId])).slice(0, 32)}.json`);
  const record = { operationId, project: scope, provider, fingerprint, state: 'submitting', reservedAt: deps.now().toISOString() };
  await deps.fs.mkdir(stateDir, { recursive: true });
  if ((await readRecord(deps, file)) === undefined) await adoptLegacy(deps, { scope, operationId, fingerprint, legacy, earlier, provider, file });
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
  if ((saved.project ?? null) !== scope) {
    throw new Error(`Operation ${operationId} belongs to another project; nothing was sent and nothing from that project was used.`);
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
