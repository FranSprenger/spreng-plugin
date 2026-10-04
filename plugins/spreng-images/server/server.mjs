#!/usr/bin/env node
// server.mjs: the spreng-images MCP server (stdio, no dependencies). Claude Code starts it with the user's
// settings from /plugin configure: the keys arrive only as environment variables from Claude Code's secure
// storage, are used only for the route the user chose, and are never written to disk, sent to Spreng or
// returned in a tool answer. The remembered choice (codex, openai, kie or other) is kept in
// $CLAUDE_PLUGIN_DATA/image-source.json.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SOURCES, secret, runCodex, runOpenAI, runKie, runOther } from './routes.mjs';
import { canonicalPath } from './operations.mjs';

/** Run a program without a shell; resolves with its exit code and output. */
export function runProcess(cmd, args, { timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let started = false;
    child.on('spawn', () => { started = true; });
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGTERM'), timeoutMs) : null;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, started, stdout, stderr: String(e.message) }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, started: true, stdout, stderr }); });
  });
}

export function defaultDeps(env = process.env) {
  return {
    env,
    fetch: globalThis.fetch,
    fs,
    homedir: os.homedir,
    run: runProcess,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}

function dataDir(env) {
  return secret(env.CLAUDE_PLUGIN_DATA) || path.join(os.homedir(), '.spreng-images');
}
function projectDir(env) {
  return secret(env.CLAUDE_PROJECT_DIR) || process.cwd();
}

async function onPath(cmd, env, deps) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { await deps.fs.access(path.join(dir, cmd)); return true; } catch { /* next */ }
  }
  return false;
}

export async function readChoice(deps) {
  try { return JSON.parse(await deps.fs.readFile(path.join(dataDir(deps.env), 'image-source.json'), 'utf8')); } catch { return null; }
}

export const TOOLS = [
  {
    name: 'image_source_status',
    title: 'Image source status',
    description: 'Shows which image source the user chose (codex, openai, kie or other, or none yet) and which sources are ready on this computer. Never shows a key.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'set_image_source',
    title: 'Remember the image source',
    description: 'Saves the image source the user picked, on this computer only: codex (their Codex CLI signed in with ChatGPT), openai (their own OpenAI key), kie (their own KIE key) or other (a source they name). Keys are entered with /plugin configure, never through this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: SOURCES },
        otherName: { type: 'string', description: 'For source other: what the user calls that source.' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'make_image',
    title: 'Make one image with the chosen source',
    description: 'Makes one image from the prompt as given with the image source the user chose, and saves the file on this computer. Uses the user\'s own Codex plan or their own OpenAI or KIE account, which may cost them on that account. One operationId buys at most one image in each project: the same operationId again in that project returns what is kept instead of paying again, and an unclear outcome is reported, not retried. Then upload the file to Spreng with create_native_image_upload as usual.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt, exactly as Spreng\'s claim gave it (brief.renderPrompt) or as adapted and recorded.' },
        references: { type: 'array', items: { type: 'string' }, description: 'Reference images: https links or local file paths. Relative paths are inside the project.' },
        outPath: { type: 'string', description: 'Where to save the image. Relative paths are inside the project. Default: spreng-images/<time>.png in the project.' },
        aspectRatio: { type: 'string', description: 'For KIE, such as 1:1 or 9:16.' },
        size: { type: 'string', description: 'For OpenAI, such as 1024x1024 or auto.' },
        kieTaskId: { type: 'string', description: 'Collect a KIE task that was still running, instead of starting a new one.' },
        operationId: { type: 'string', description: 'Names this image purchase; pass the Spreng claim id. One operationId buys at most one image in each project: the same operationId again in that project returns the image already made (or collects the KIE task already accepted, or reports an unclear or failed outcome) and never pays again. For another image, use a new operationId. Without one, the same request in the same project is treated as the same operation.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

export async function callTool(name, args = {}, deps = defaultDeps()) {
  const env = deps.env;
  if (name === 'image_source_status') {
    const choice = await readChoice(deps);
    return {
      choice: choice?.source || null,
      otherName: choice?.otherName || undefined,
      ready: {
        codex: await onPath('codex', env, deps) || Boolean(secret(env.SPRENG_IMAGES_CODEX_BIN)),
        openai: Boolean(secret(env.SPRENG_IMAGES_OPENAI_KEY)),
        kie: Boolean(secret(env.SPRENG_IMAGES_KIE_KEY)),
        other: true,
      },
      remembered: path.join(dataDir(env), 'image-source.json'),
    };
  }
  if (name === 'set_image_source') {
    if (!SOURCES.includes(args.source)) throw new Error(`source must be one of ${SOURCES.join(', ')}`);
    const dir = dataDir(env);
    await deps.fs.mkdir(dir, { recursive: true });
    const saved = { source: args.source, ...(args.otherName ? { otherName: String(args.otherName).slice(0, 200) } : {}), savedAt: deps.now().toISOString() };
    await deps.fs.writeFile(path.join(dir, 'image-source.json'), JSON.stringify(saved, null, 2));
    return { saved: saved.source, otherName: saved.otherName };
  }
  if (name === 'make_image') {
    const choice = await readChoice(deps);
    if (!choice?.source) throw new Error('No image source chosen yet: ask the user once (codex, openai, kie or other) and call set_image_source.');
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt is required.');
    const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
    const unique = `${stamp}-${randomUUID().slice(0, 8)}`;
    // The canonical project folder: every operation is kept under this folder and its operation id (and the folder is
    // part of its fingerprint), so one project never receives another project's image from the shared journal.
    const project = await canonicalPath(deps.fs, projectDir(env));
    const outPath = path.resolve(projectDir(env), args.outPath || path.join('spreng-images', `${unique}.png`));
    if (choice.source === 'other') return runOther({ otherName: choice.otherName, outPath });
    // Each request gets its own work folder (downloaded references, the Codex working folder), removed afterwards,
    // so two requests at the same moment never read each other's files.
    const workRoot = path.join(dataDir(env), 'work');
    await deps.fs.mkdir(workRoot, { recursive: true });
    const tmpDir = await deps.fs.mkdtemp(path.join(workRoot, 'req-'));
    // A local reference is the project's file: a relative path is resolved against the project folder here, before
    // the operation is fingerprinted and before any route reads it, never against this server's working folder or
    // the Codex work folder. Links stay as they are.
    const references = (args.references || []).map((r) => (/^https?:\/\//i.test(r) ? r : path.resolve(project, r)));
    const job = {
      prompt: args.prompt, references, typedReferences: args.references || [], outPath, tmpDir, size: args.size, aspectRatio: args.aspectRatio,
      kieTaskId: args.kieTaskId, operationId: args.operationId, requestedOutPath: args.outPath, projectDir: project, stateDir: path.join(dataDir(env), 'operations'),
    };
    try {
      if (choice.source === 'codex') return await runCodex(job, deps);
      if (choice.source === 'openai') return await runOpenAI(job, deps, { key: secret(env.SPRENG_IMAGES_OPENAI_KEY), model: secret(env.SPRENG_IMAGES_OPENAI_MODEL) || 'gpt-image-2' });
      if (choice.source === 'kie') return await runKie(job, deps, { key: secret(env.SPRENG_IMAGES_KIE_KEY), model: secret(env.SPRENG_IMAGES_KIE_MODEL) || 'nano-banana-pro' });
      throw new Error(`The remembered image source "${choice.source}" is not one of ${SOURCES.join(', ')}; call set_image_source again.`);
    } finally {
      await deps.fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

/** Remove any configured key from text before it leaves this process. */
export function scrub(text, env) {
  let out = String(text);
  for (const k of [env.SPRENG_IMAGES_OPENAI_KEY, env.SPRENG_IMAGES_KIE_KEY].map(secret)) if (k) out = out.split(k).join('[key]');
  return out;
}

export async function handle(msg, deps = defaultDeps()) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'spreng-images', version: '0.1.0' } } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const out = await callTool(params?.name, params?.arguments || {}, deps);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: scrub(JSON.stringify(out), deps.env) }] } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: scrub(e.message, deps.env) }] } };
    }
  }
  if (id === undefined) return null; // a notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const deps = defaultDeps();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const reply = await handle(msg, deps);
      if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
    }
  });
}
