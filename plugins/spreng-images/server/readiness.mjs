import path from 'node:path';
import { execFile } from 'node:child_process';
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
function probe(cmd, args, env, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, cwd, encoding: 'utf8', timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
        errorCode: error?.code, output: `${stdout}\n${stderr}`.trim() });
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

  let cwd;
  try {
    // Match generation's fresh work directory so project-level settings are not mistaken for
    // the settings of the Codex runtime that make_image will actually launch.
    const workRoot = path.join(dataDir, 'work');
    await deps.fs.mkdir(workRoot, { recursive: true });
    cwd = await deps.fs.mkdtemp(path.join(workRoot, 'readiness-'));
    const selected = secret(deps.env.SPRENG_IMAGES_CODEX_BIN) || 'codex';
    const bin = selected.includes(path.sep) ? path.resolve(selected) : selected;
    const env = { ...deps.env };
    if (typeof env.PATH === 'string') env.PATH = env.PATH.split(path.delimiter).map((dir) => path.resolve(dir || '.')).join(path.delimiter);
    const auth = await probe(bin, ['login', 'status'], env, cwd);
    if (auth.errorCode === 'ENOENT') {
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
    const features = await probe(bin, ['features', 'list'], env, cwd);
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
