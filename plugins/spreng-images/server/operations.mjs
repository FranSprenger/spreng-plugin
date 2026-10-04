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
// One request is one operation whichever source makes it: an automatic id (no operationId given) is derived from
// the request alone (project, prompt, references, aspect ratio, size, outPath), never from the source or the model,
// so every route reserves the same record and switching image source, or two routes at the same moment, never buys
// the same request twice. Another source or model for the same request needs a new operation id.
//
// Records any earlier version kept are checked before a new record is made, by one lookup (earlierRecords) that
// reserveOperation runs for every route: every folder (operations/, and kie-operations/ for the first KIE journal),
// both file namings (one file per id; one per project and id from d107deb on), the given id or every id any version
// derived for the same request under every source and model, whichever provider wrote it. The models are the
// defaults, the models configured now, every model a kept record names (its model field, or the madeBy of a
// completed one) and every model recovered for a record that names none (below), so a model setting removed or
// replaced since still finds its records. Such a record moves to this
// project only when it is proven to be this project's (its id holds this exact canonical project folder) and is the
// same request on the same route; a record of the same request on another route refuses the operation, naming that
// provider; every other earlier record stays unresolved: the operation is refused, nothing is sent and nothing from
// that record is used.
//
// Earlier versions derived automatic ids with the model in them but kept the model only once KIE accepted a task or
// the image was made. For a record they left submitting, uncertain or failed, the model is recovered (recoveredModels):
// every image model name OpenAI and KIE have offered (KNOWN_MODELS) and every word in the record are tried, and the
// one with which this request derives the id the record holds is its model, so the record is found under that id
// (above) even after its model setting was removed or replaced. Every model this version has seen configured (kept in
// models-seen/ when the server starts and on every call) is tried too, so a model name of the user's own that no list
// and no record text holds is still found after its setting is removed. A record whose id no candidate derives is another
// request's (or made with a name this lookup cannot recover): it is left alone and blocks nothing, as does a record
// elsewhere in the journal that cannot be read. Only a record found under an id the request derives (or its given id)
// refuses it, also when that record cannot be read. This version keeps the model in every record.

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
  });
}

/** The model each source uses unless the user configured another (server.mjs); every version had these defaults. */
export const DEFAULT_MODELS = { codex: 'codex', openai: 'gpt-image-2', kie: 'nano-banana-pro' };
const MODEL_SETTINGS = ['SPRENG_IMAGES_OPENAI_MODEL', 'SPRENG_IMAGES_KIE_MODEL'];

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
const scopedFile = (dir, scope, id) => path.join(dir, `${sha(JSON.stringify(['op', scope, id])).slice(0, 32)}.json`);

// Every folder any version kept operation records in, next to each other in the plugin data folder:
// operations/ (f0e3ddf onward, every route) and kie-operations/ (ac007f2, the first KIE journal).
const JOURNAL_DIRS = ['operations', 'kie-operations'];

/**
 * Every (source, model) an earlier version could have derived an id with: codex, and OpenAI and KIE each with
 * every model known here (the defaults, the model of this call, the models configured now for either source, and
 * the models the kept records name or were recovered for, see recoveredModels).
 */
function identities(env = {}, model, recorded = []) {
  const models = new Set([DEFAULT_MODELS.openai, DEFAULT_MODELS.kie, model, ...recorded, ...configuredModels(env)]);
  return [{ source: 'codex', model: DEFAULT_MODELS.codex }, ...paidIdentities(models)];
}

/** The OpenAI and KIE models configured now (a setting Claude Code did not fill in is left out). */
function configuredModels(env = {}) {
  const out = [];
  for (const name of MODEL_SETTINGS) {
    const v = typeof env[name] === 'string' ? env[name].trim() : '';
    if (v && !v.startsWith('${')) out.push(v);
  }
  return out;
}

// Every model this version has seen configured, one file per model name, next to the journal folders
// (models-seen/), so a model setting removed since is still tried (see earlierRecords).
const SEEN_DIR = 'models-seen';

/**
 * Keep every model configured now in models-seen/ of the plugin data folder (root). Each name is its own file made
 * exclusively, so two calls at the same moment never drop a name. Run when the server starts and on every tool call.
 */
export async function rememberModels(deps, root) {
  const models = configuredModels(deps.env);
  if (!models.length) return;
  const dir = path.join(root, SEEN_DIR);
  await deps.fs.mkdir(dir, { recursive: true });
  for (const model of models) {
    try {
      await deps.fs.writeFile(path.join(dir, `${sha('model:' + model).slice(0, 32)}.json`), JSON.stringify({ model, seenAt: deps.now().toISOString() }), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

/** Every model kept in models-seen/ (a file that cannot be read is skipped). */
async function seenModels(deps, root) {
  let names;
  try { names = await deps.fs.readdir(path.join(root, SEEN_DIR)); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const kept = await readRecord(deps, path.join(root, SEEN_DIR, name));
    if (typeof kept?.model === 'string' && kept.model) out.push(kept.model);
  }
  return out;
}

/** OpenAI and KIE, each with every model given (a model name set for one source may have been set for the other). */
function paidIdentities(models) {
  const out = [];
  for (const source of ['openai', 'kie']) for (const m of models) if (m && m !== DEFAULT_MODELS.codex) out.push({ source, model: m });
  return out;
}

/**
 * Every automatic id any version derived for this request with the given (source, model) pairs:
 * [{ id, bound, scoped }] (see earlierRecords).
 */
function derivedIds(job, idents) {
  const { prompt } = job;
  const project = job.projectDir || null;
  const aspectRatio = job.aspectRatio || null;
  const size = job.size || null;
  const outPath = job.requestedOutPath || null;
  const resolved = job.references || [];
  const typed = job.typedReferences || resolved;
  const ids = [];
  for (const { source, model: m } of idents) {
    if (project) {
      // a15c7cd (named by id) and d107deb to 0a199a1 (named by project and id): references resolved against the project.
      ids.push({ id: autoId({ source, model: m, project, prompt, references: resolved, aspectRatio, size, outPath }), bound: true, scoped: true });
      // 816c1ae: references as typed.
      ids.push({ id: autoId({ source, model: m, project, prompt, references: typed, aspectRatio, size, outPath }), bound: true });
    }
    // f0e3ddf and 066b539: no project, references as typed.
    ids.push({ id: autoId({ source, model: m, prompt, references: typed, aspectRatio, size, outPath }), bound: false });
    // ac007f2: no source and no project (its KIE route kept these in kie-operations/); KIE runs every model listed.
    if (source === 'kie') ids.push({ id: autoId({ model: m, prompt, references: typed, aspectRatio, outPath }), bound: false });
  }
  return ids;
}

/**
 * THE lookup of earlier records, the only one: every file any earlier version of this add-on could have kept for
 * this operation, in every journal folder and under both file namings, whichever provider wrote it, under the given
 * operation id or under every id any version derived for the same request with any source and model. reserveOperation
 * runs it for every route before anything is sent, so no route chooses where to look. Returns
 * [{ file, operationId, bound, scoped }]: bound is true only for an automatic id that holds this canonical project
 * folder, the one proof that the record was made in this project (a given id, or an automatic id from before the
 * project was part of it, proves nothing about the project); scoped marks a file named by project and id
 * (d107deb to 0a199a1), whose record holds the current fingerprint.
 */
export function earlierRecords(job, env, model, recorded = []) {
  const root = path.dirname(job.stateDir);
  const out = [];
  const add = (file, operationId, bound, scoped) => { if (!out.some((e) => e.file === file)) out.push({ file, operationId, bound, scoped }); };
  if (job.operationId) {
    // The given id: the file named by project and id is this version's own record; earlier ones were named by id.
    const id = String(job.operationId);
    for (const dir of JOURNAL_DIRS) add(legacyFile(path.join(root, dir), id), id, false, false);
    return out;
  }
  const project = job.projectDir || null;
  for (const { id, bound, scoped } of derivedIds(job, identities(env, model, recorded))) {
    if (scoped) add(scopedFile(job.stateDir, project, id), id, true, true);
    for (const dir of JOURNAL_DIRS) add(legacyFile(path.join(root, dir), id), id, bound, false);
  }
  return out;
}

/** Every record file in every journal folder, read: [{ file, record }] (record null when it cannot be read). */
async function journalRecords(deps, root) {
  const out = [];
  for (const dir of JOURNAL_DIRS) {
    let names;
    try { names = await deps.fs.readdir(path.join(root, dir)); } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(root, dir, name);
      const record = await readRecord(deps, file);
      if (record !== undefined) out.push({ file, record });
    }
  }
  return out;
}

const MADE_BY = /^(?:OpenAI|KIE) (.+) on the user's key$/;

/** The model a kept record names: its model field, the model in a completed record's madeBy, or codex; else undefined. */
export function recordedModel(record) {
  if (!record || typeof record !== 'object') return undefined;
  if (typeof record.model === 'string' && record.model) return record.model;
  const made = typeof record.result?.madeBy === 'string' ? record.result.madeBy.match(MADE_BY) : null;
  if (made) return made[1];
  if (record.provider === 'Codex CLI') return DEFAULT_MODELS.codex;
  return undefined;
}

/**
 * Image model names OpenAI and KIE have offered: with the words in a record, the candidates for the model an earlier
 * version made a record with when the record does not name it. A candidate is used only when an id derived with it
 * for this request is the id the record holds, so a name that was never used matches nothing.
 */
export const KNOWN_MODELS = [
  'dall-e-2', 'dall-e-3', 'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2-mini', 'chatgpt-image-latest',
  'nano-banana', 'nano-banana-pro', 'nano-banana-2', 'nano-banana-edit', 'google/nano-banana', 'google/nano-banana-edit',
  'google/nano-banana-pro', 'google/nano-banana-2', 'google/pro-image-to-image', 'gpt-image-2-text-to-image', 'gpt-image-2-image-to-image',
  'gpt/gpt-image-2-text-to-image', 'gpt/gpt-image-2-image-to-image', 'gpt4o-image', '4o-image', 'seedream-v4', 'seedream-4.0', 'seedream-4.5',
  'bytedance/seedream-v4-text-to-image', 'bytedance/seedream-v4-edit', 'flux-kontext-pro', 'flux-kontext-max', 'imagen4', 'imagen4-fast',
  'imagen4-ultra', 'google/imagen4', 'google/imagen4-fast', 'google/imagen4-ultra', 'ideogram/v3', 'qwen/text-to-image', 'qwen/image-edit',
];

/** Every word in a record's text fields (an error kept as its reason may name the model), as model candidates. */
function wordsOf(value, out = new Set(), depth = 0) {
  if (typeof value === 'string') {
    for (const w of value.split(/[\s"'`()[\]{},;]+/)) {
      const word = w.replace(/^[.:]+|[.:]+$/g, '');
      if (word.length > 1 && word.length <= 100) out.add(word);
    }
  } else if (value && typeof value === 'object' && depth < 3) {
    for (const v of Object.values(value)) wordsOf(v, out, depth + 1);
  }
  return out;
}

/**
 * The models recovered for the automatic-id records an earlier version kept without naming their model (OpenAI and KIE
 * left submitting, uncertain or failed before acceptance): a candidate (KNOWN_MODELS, or a word in such a record) with
 * which this request derives the id such a record holds. The lookup then finds that record under its id like any
 * other; a record whose id no candidate derives is another request's, or one this lookup cannot recover.
 */
export function recoveredModels(job, journal) {
  const unnamed = journal.filter(({ record }) => record && typeof record.operationId === 'string'
    && record.operationId.startsWith('auto-') && recordedModel(record) === undefined);
  if (!unnamed.length) return [];
  const held = new Set(unnamed.map(({ record }) => record.operationId));
  const candidates = new Set(KNOWN_MODELS);
  for (const { record } of unnamed) wordsOf(record, candidates);
  return [...candidates].filter((m) => derivedIds(job, paidIdentities([m])).some(({ id }) => held.has(id)));
}

/** The provider that wrote a record: its provider field, else KIE for the first KIE journal (kie-operations/). */
const writtenBy = (saved, file) => saved?.provider || (path.basename(path.dirname(file)) === 'kie-operations' ? 'KIE' : undefined);

const stateOf = (saved) => (saved?.state ? ` (${saved.state}${saved.reason ? `: ${saved.reason}` : ''}${saved.taskId ? `, task ${saved.taskId}` : ''})` : saved?.taskId ? ` (accepted, task ${saved.taskId})` : '');

/** The same request was already sent through another source: refuse, naming it. */
function sentElsewhere(saved, provider) {
  const collect = saved.taskId && saved.state !== 'completed' && saved.state !== 'failed' ? ` Choosing ${saved.provider} again, the same request collects that task.` : '';
  return new Error(`This request was already sent to ${saved.provider} as operation ${saved.operationId}${stateOf(saved)} in this project; nothing was sent to ${provider} and nothing was bought again.${collect} Check your ${saved.provider} account; for a new image from ${provider}, use a new operationId.`);
}

/**
 * Check the earlier records before a new record is made. A record proven to be this project's and of the same request
 * on the same route is moved to it (the earlier files are kept); any other earlier record refuses the operation
 * without sending anything or using anything from it.
 */
async function adoptEarlier(deps, { scope, operationId, model, fingerprint, legacy = [], earlier = [], provider, file }) {
  for (const entry of earlier) {
    const saved = await readRecord(deps, entry.file);
    if (saved === undefined) continue;
    const via = writtenBy(saved, entry.file) || provider;
    const proven = saved && scope && entry.bound && saved.operationId === entry.operationId && (!entry.scoped || (saved.project ?? null) === scope);
    if (!proven) {
      throw new Error(`Operation ${operationId} has a record from an earlier version of this add-on${stateOf(saved)} that does not show it belongs to this project; nothing was sent and nothing from that record was used. Check your ${via} account; for a new image use a new operationId.`);
    }
    const same = entry.scoped ? saved.fingerprint === fingerprint : legacy.includes(saved.fingerprint);
    if (!same) {
      const by = writtenBy(saved, entry.file);
      if (by && by !== provider) throw sentElsewhere({ ...saved, provider: by }, provider);
      throw new Error(`Operation ${operationId} was already used for a different image request; nothing was sent. Use a new operationId for a new image.`);
    }
    // The same request on the same route: made with this route's model, which the moved record keeps.
    const moved = { ...saved, operationId, project: scope, model: saved.model || model, fingerprint, movedFrom: path.basename(entry.file), movedAt: deps.now().toISOString() };
    try {
      await deps.fs.writeFile(file, JSON.stringify(moved, null, 2), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // another call moved it at the same moment
    }
    return true;
  }
  return false;
}

/**
 * Reserve an operation before the paid call, for every route: the operation id is derived here (or the given one
 * used), and the earlier records are checked here with the one lookup (earlierRecords). Returns { fresh: true }
 * when this call owns it, or { fresh: false } with the kept record when the operation already exists (in this
 * project, or moved here from an earlier record).
 */
export async function reserveOperation(deps, { job, model, fingerprint, legacy, provider }) {
  const { stateDir } = job;
  const operationId = operationIdFor(job);
  const scope = job.projectDir || null;
  const file = scopedFile(stateDir, scope, operationId);
  // A request without an operationId is looked up under every model a kept record names or was recovered for, so the
  // journal is read first.
  const root = path.dirname(stateDir);
  const journal = job.operationId ? [] : await journalRecords(deps, root);
  if (!job.operationId) await rememberModels(deps, root).catch(() => {}); // best effort: the journal check below still runs
  const seen = job.operationId ? [] : await seenModels(deps, root);
  const recorded = [...journal.map((e) => recordedModel(e.record)).filter(Boolean), ...recoveredModels(job, journal), ...seen];
  const earlier = earlierRecords(job, deps.env, model, recorded).filter((e) => e.file !== file);
  const record = { operationId, project: scope, provider, model, fingerprint, state: 'submitting', reservedAt: deps.now().toISOString() };
  await deps.fs.mkdir(stateDir, { recursive: true });
  if ((await readRecord(deps, file)) === undefined) {
    await adoptEarlier(deps, { scope, operationId, model, fingerprint, legacy, earlier, provider, file });
  }
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
    if (saved.provider && saved.provider !== provider) throw sentElsewhere(saved, provider);
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
