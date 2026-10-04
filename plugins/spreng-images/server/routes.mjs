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
// A paid create is sent once. An unclear outcome (network error, timeout, 5xx) is reported, never retried, so the
// user is never charged twice for one image.

import path from 'node:path';

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

/** Reference files as local paths: URLs are downloaded into tmpDir first (Codex and the OpenAI edit take files). */
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

export async function runCodex({ prompt, references = [], outPath, tmpDir }, deps) {
  const codexHome = deps.env.CODEX_HOME || path.join(deps.homedir(), '.codex');
  const imagesDir = path.join(codexHome, 'generated_images');
  const before = new Set(await listImages(imagesDir, deps.fs));
  const refs = await localRefs(references, tmpDir, deps);
  const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-C', tmpDir];
  for (const r of refs) args.push('-i', r);
  args.push(codexTask(prompt));
  await deps.fs.mkdir(tmpDir, { recursive: true });
  const { code, stdout, stderr } = await deps.run(deps.env.SPRENG_IMAGES_CODEX_BIN || 'codex', args, { timeoutMs: 10 * 60 * 1000 });
  if (code !== 0) throw new Error(`codex exec exited ${code}: ${String(stderr || '').trim().slice(-400) || 'no error text'}`);
  // Prefer the image Codex filed under this run's thread id; else any new image in generated_images.
  const thread = (String(stdout).match(/"thread_id"\s*:\s*"([^"]+)"/) || [])[1];
  const after = (await listImages(imagesDir, deps.fs)).filter((f) => !before.has(f));
  const mine = thread ? after.filter((f) => f.includes(thread)) : [];
  const pick = (mine.length ? mine : after).sort().at(-1);
  if (!pick) throw new Error('codex finished but no new image appeared in ' + imagesDir + ' (is the Codex CLI signed in with a ChatGPT plan that includes images?)');
  await deps.fs.mkdir(path.dirname(outPath), { recursive: true });
  await deps.fs.copyFile(pick, outPath);
  return { path: outPath, source: 'codex', madeBy: 'Codex CLI image tool', codexFile: pick };
}

export async function runOpenAI({ prompt, references = [], outPath, tmpDir, size }, deps, { key, model }) {
  if (!key) throw new Error('No OpenAI key is set. Run /plugin configure spreng-images@spreng and enter it there (never in the chat).');
  const refs = await localRefs(references, tmpDir, deps);
  const auth = { authorization: `Bearer ${key}` };
  let r;
  if (refs.length) {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    if (size) form.append('size', size);
    for (const f of refs) form.append('image[]', new Blob([await deps.fs.readFile(f)], { type: mimeOf(f) }), path.basename(f));
    r = await deps.fetch(`${OPENAI_BASE}/v1/images/edits`, { method: 'POST', headers: auth, body: form });
  } else {
    r = await deps.fetch(`${OPENAI_BASE}/v1/images/generations`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, n: 1, ...(size ? { size } : {}) }),
    });
  }
  let body;
  try { body = await r.json(); } catch { body = null; }
  if (!r.ok) throw new Error(`OpenAI answered HTTP ${r.status}: ${body?.error?.message || 'no message'}`);
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI answered without image data (data[0].b64_json).');
  await deps.fs.mkdir(path.dirname(outPath), { recursive: true });
  await deps.fs.writeFile(outPath, Buffer.from(b64, 'base64'));
  return { path: outPath, source: 'openai', madeBy: `OpenAI ${model} on the user's key` };
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

export async function runKie({ prompt, references = [], outPath, aspectRatio, kieTaskId }, deps, { key, model, pollMs = 5000, maxPolls = 120 }) {
  if (!key) throw new Error('No KIE key is set. Run /plugin configure spreng-images@spreng and enter it there (never in the chat).');
  const urls = references.filter((r) => /^https:\/\//i.test(r));
  if (urls.length !== references.length) throw new Error('KIE takes reference images as https links only.');
  const auth = { authorization: `Bearer ${key}` };
  const taskId = kieTaskId || await kieCreate(model, prompt, urls, aspectRatio, auth, deps);
  return kiePoll(taskId, outPath, model, auth, deps, { pollMs, maxPolls });
}

async function kieCreate(model, prompt, urls, aspectRatio, auth, deps) {
  let r;
  try {
    r = await deps.fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: kieInput(model, prompt, urls, aspectRatio) }),
    });
  } catch (e) {
    throw new Error(`KIE create had an unclear outcome (${e.message}); not retried. Check your KIE dashboard before asking again.`);
  }
  let body;
  try { body = await r.json(); } catch { body = null; }
  const taskId = body?.data?.taskId;
  if (!r.ok || (body?.code !== undefined && body.code !== 200) || !taskId) {
    throw new Error(`KIE did not accept the task: HTTP ${r.status}${body?.msg ? `, ${body.msg}` : ''}; not retried.`);
  }
  return taskId;
}

async function kiePoll(taskId, outPath, model, auth, deps, { pollMs, maxPolls }) {
  for (let i = 0; i < maxPolls; i++) {
    await deps.sleep(pollMs);
    const p = await deps.fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: auth });
    if (!p.ok) continue;
    const info = (await p.json())?.data || {};
    if (info.state === 'fail') throw new Error(`KIE task ${taskId} failed: ${info.failMsg || 'no reason given'}`);
    if (info.state !== 'success') continue;
    let result = info.resultJson;
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { result = {}; } }
    const url = result?.resultUrls?.[0];
    if (!url) throw new Error(`KIE task ${taskId} succeeded without a result link.`);
    const f = await deps.fetch(url);
    if (!f.ok) throw new Error(`KIE result for task ${taskId} could not be downloaded: HTTP ${f.status}`);
    await deps.fs.mkdir(path.dirname(outPath), { recursive: true });
    await deps.fs.writeFile(outPath, Buffer.from(await f.arrayBuffer()));
    return { path: outPath, source: 'kie', madeBy: `KIE ${model} on the user's key`, taskId };
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
