// Wrappers start in the server's directory; Codex receives its scratch directory through -C.
// Share executable selection and the environment unchanged between generation and local checks.
export function codexLaunch(env, tmpDir) {
  return {
    cmd: env.SPRENG_IMAGES_CODEX_BIN || 'codex',
    args: ['-C', tmpDir],
    options: { cwd: process.cwd(), env: { ...env } },
  };
}
