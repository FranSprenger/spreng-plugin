import path from 'node:path';
import { spawn } from 'node:child_process';
import { codexLaunch } from './codex-launch.mjs';
import { secret } from './routes.mjs';

// true/false are established facts; null is unknown. Never promote configuration to capability.
export function readinessState({ installed, signedIn, imageCapability }) {
  if (installed === false) return 'not_installed';
  if (signedIn === false) return 'not_signed_in';
  if (imageCapability === false) return 'no_image_capability';
  return installed === true && signedIn === true && imageCapability === true ? 'ready' : 'could_not_tell';
}

// These fixed local CLI commands cannot submit an image. Bound both time and captured output;
// never expose auth-status output, which some login modes include key fragments in.
function probe(launch, args) {
  return new Promise((resolve) => {
    const child = spawn(launch.cmd, [...launch.args, ...args], {
      ...launch.options, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let stopped = false;
    let errorCode;
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (e) { if (e.code !== 'ESRCH') errorCode = e.code; }
    };
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, errorCode, output: `${stdout}\n${stderr}`.trim() });
    };
    // Resolve at the deadline itself: a descendant that left the group can hold the pipes open,
    // so waiting for 'close' could delay the claim indefinitely.
    const stop = () => {
      stopped = true; stdout = ''; stderr = '';
      killGroup();
      child.stdout.destroy(); child.stderr.destroy();
      // Let the group kill land (the wrapper's exit), but never wait on the pipes or past one second.
      if (child.exitCode !== null || child.signalCode !== null) settle(-1);
      else { child.once('exit', () => settle(-1)); setTimeout(() => settle(-1), 1000); }
    };
    const timer = setTimeout(stop, 2500);
    const capture = (data, isStderr) => {
      if (stopped) return;
      bytes += data.length;
      if (bytes > 16 * 1024) { stop(); return; }
      if (isStderr) stderr += data; else stdout += data;
    };
    child.stdout.on('data', (data) => capture(data, false));
    child.stderr.on('data', (data) => capture(data, true));
    child.on('error', (e) => { errorCode = e.code; });
    child.on('close', (code) => {
      if (settled) return; // stop() already signalled the group; never signal a released group ID.
      killGroup(); // Also clean up descendants whose wrapper exited without waiting for them.
      settle(stopped || errorCode ? -1 : code ?? -1);
    });
  });
}

export async function checkImageReadiness(choice, deps, dataDir) {
  const source = choice?.source || null;
  const checks = { installed: null, signedIn: null, imageCapability: null };
  const result = (reason, next) => {
    const state = readinessState(checks);
    return { source, state, checks, reason, next: state === 'could_not_tell'
      ? 'Proceed to claim_native_image and tell the user: "The image tool could not be checked in advance."' : next };
  };
  if (source === 'openai' || source === 'kie') {
    checks.installed = true; // The API adapter is part of this running server.
    if (!secret(deps.env[source === 'openai' ? 'SPRENG_IMAGES_OPENAI_KEY' : 'SPRENG_IMAGES_KIE_KEY'])) {
      checks.signedIn = false;
      return result('The selected source has no configured key.', 'Set its key with /plugin configure spreng-images@spreng, restart Claude Code, then check again.');
    }
    return result('A key is configured, but its validity and image access cannot be verified locally.');
  }
  if (source !== 'codex') {
    return result(source ? 'This source has no local readiness probe.' : 'No image source is selected.');
  }
  if (process.platform === 'win32') return result('The local check cannot safely contain the Codex process tree on this platform.');

  let cwd;
  try {
    // Match generation's launch context, including wrappers that select a profile at startup.
    const workRoot = path.join(dataDir, 'work');
    await deps.fs.mkdir(workRoot, { recursive: true });
    cwd = await deps.fs.mkdtemp(path.join(workRoot, 'readiness-'));
    const launch = codexLaunch(deps.env, cwd);
    const auth = await probe(launch, ['login', 'status']);
    if (auth.errorCode === 'ENOENT') {
      // ENOENT can also mean the launch directory disappeared, which proves nothing about Codex.
      if (!(await deps.fs.stat(launch.options.cwd)).isDirectory() || !(await deps.fs.stat(cwd)).isDirectory()) {
        return result('The Codex launch context could not be established.');
      }
      checks.installed = false;
      return result('The selected Codex executable could not be found.', 'Install Codex or correct its executable path, then check again.');
    }
    if (auth.code === -1) return result('The local Codex status command could not complete.');
    checks.installed = true;
    if (auth.code === 1 && auth.output === 'Not logged in') {
      checks.signedIn = false;
      return result('Codex reports that it is not signed in.', 'Run codex login with your ChatGPT account, then check again.');
    }
    if (auth.code !== 0 || auth.output !== 'Logged in using ChatGPT') {
      return result('Codex did not provide a recognized ChatGPT sign-in status.');
    }
    checks.signedIn = true;
    const features = await probe(launch, ['features', 'list']);
    const imageRows = features.output.split('\n').filter((line) => /^image_generation\s/.test(line));
    if (features.code === 0 && imageRows.length === 1 && /^image_generation\s+(?:stable|experimental|under development)\s+false$/.test(imageRows[0].trim())) {
      checks.imageCapability = false;
      return result('Codex reports that image_generation is disabled.', 'Enable image generation in Codex or use an image-capable session, then check again.');
    }
    // An enabled feature is a runtime setting, not proof of model/account image access.
    // None of the current sources exposes sufficient offline positive capability evidence.
    return result('Codex is signed in, but local feature status cannot prove account image access.');
  } catch {
    return result('The local readiness check could not complete.');
  } finally {
    if (cwd) await deps.fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
