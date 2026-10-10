#!/usr/bin/env node
// transcribe.mjs: speech to text on this computer, for the ad videos ad-library.mjs saved. Nothing is uploaded:
// it runs the user's own whisper.cpp (`whisper-cli`) and `ffmpeg` and a model file already on disk.
//
//   node transcribe.mjs --dir <research/sources dir>      every saved video in meta-ads-raw.json; the transcripts
//                                                          go into meta-ads.json as documents of kind transcript
//   node transcribe.mjs --file <video or audio file>      prints one transcript
//
// Without whisper-cli, ffmpeg or a model it says which is missing and how to get it; the research run goes on
// without transcripts. Install on a Mac: `brew install whisper-cpp ffmpeg`, then put a model such as
// ggml-base.en.bin (148 MB, from https://huggingface.co/ggerganov/whisper.cpp) in ~/.cache/whisper-cpp-models/
// or point SPRENG_WHISPER_MODEL at it. This script downloads nothing.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { documentExcerpt } from './sources/excerpt.mjs';

export function runProcess(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const MODEL_NAMES = ['ggml-base.en.bin', 'ggml-small.en.bin', 'ggml-tiny.en.bin', 'ggml-base.bin', 'ggml-small.bin', 'ggml-medium.en.bin'];

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function which(cmd, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) if (dir && await exists(path.join(dir, cmd))) return path.join(dir, cmd);
  return null;
}

/** whisper-cli, ffmpeg and a model on this computer, or what is missing. */
export async function findTools(env = process.env, home = os.homedir()) {
  const whisper = env.SPRENG_WHISPER_CLI || await which('whisper-cli', env);
  const ffmpeg = env.SPRENG_FFMPEG || await which('ffmpeg', env);
  let model = env.SPRENG_WHISPER_MODEL && await exists(env.SPRENG_WHISPER_MODEL) ? env.SPRENG_WHISPER_MODEL : null;
  for (const dir of [path.join(home, '.cache', 'whisper-cpp-models'), path.join(home, '.cache', 'whisper'), '/opt/homebrew/share/whisper-cpp', '/usr/local/share/whisper-cpp']) {
    if (model) break;
    for (const name of MODEL_NAMES) if (await exists(path.join(dir, name))) { model = path.join(dir, name); break; }
  }
  const missing = [!whisper && 'whisper-cli (brew install whisper-cpp)', !ffmpeg && 'ffmpeg (brew install ffmpeg)', !model && 'a whisper model file (ggml-base.en.bin in ~/.cache/whisper-cpp-models/ or SPRENG_WHISPER_MODEL)'].filter(Boolean);
  return { whisper, ffmpeg, model, missing };
}

/** One file to text: ffmpeg makes 16 kHz mono WAV, whisper-cli writes a .txt beside it. */
export async function transcribe(file, tools, { run = runProcess, tmp = os.tmpdir() } = {}) {
  const base = path.join(tmp, `spreng-stt-${path.basename(file).replace(/\W+/g, '-')}-${process.pid}`);
  const wav = `${base}.wav`;
  const conv = await run(tools.ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-ar', '16000', '-ac', '1', wav]);
  if (conv.code !== 0) throw new Error(`ffmpeg could not read ${file}: ${conv.stderr.trim()}`);
  const stt = await run(tools.whisper, ['-m', tools.model, '-f', wav, '-l', 'auto', '-nt', '-np', '-otxt', '-of', base]);
  if (stt.code !== 0) throw new Error(`whisper-cli failed on ${file}: ${stt.stderr.trim()}`);
  const text = (await fs.readFile(`${base}.txt`, 'utf8')).replace(/\s+/g, ' ').trim();
  await Promise.all([fs.rm(wav, { force: true }), fs.rm(`${base}.txt`, { force: true })]);
  return text;
}

/** Transcribe every saved ad video and add the transcripts to meta-ads.json as documents. */
export async function transcribeDir(dir, deps = {}) {
  const tools = deps.tools || await findTools();
  const resultPath = path.join(dir, 'meta-ads.json');
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  if (result.kind === 'ads') result.kind = 'ad_library';
  if (tools.missing?.length) {
    const reason = [result.reason, `video transcripts skipped: this computer has no ${tools.missing.join(', ')}`].filter(Boolean).join('; ');
    result.reason = documentExcerpt(result, reason, 1000, 'Meta Ad Library diagnostics', result.url);
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
    return { transcribed: 0, skipped: tools.missing };
  }
  const ads = JSON.parse(await fs.readFile(path.join(dir, 'meta-ads-raw.json'), 'utf8'));
  result.documents = result.documents || [];
  const notes = [];
  let n = 0;
  for (const ad of ads) {
    for (const saved of (ad.saved || []).filter((s) => s.kind === 'video')) {
      try {
        const text = await transcribe(saved.file, tools, deps);
        if (text) { result.documents.push({ title: `Ad ${ad.id} video (${ad.page})`, kind: 'transcript', text, url: `https://www.facebook.com/ads/library/?id=${ad.id}` }); n++; }
      } catch (e) { notes.push(e.message); }
    }
  }
  if (notes.length) result.reason = documentExcerpt(result, [result.reason, ...notes].filter(Boolean).join('; '), 1000, 'Meta Ad Library diagnostics', result.url);
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
  return { transcribed: n, failed: notes.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const get = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  (async () => {
    if (get('dir')) { console.log(JSON.stringify(await transcribeDir(get('dir')))); return; }
    if (!get('file')) throw new Error('usage: transcribe.mjs --dir <research/sources dir> | --file <video>');
    const tools = await findTools();
    if (tools.missing.length) throw new Error(`missing: ${tools.missing.join(', ')}`);
    console.log(await transcribe(get('file'), tools));
  })().catch((e) => { console.error(e.message); process.exit(2); });
}
