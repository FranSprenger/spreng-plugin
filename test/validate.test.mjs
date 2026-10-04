// `claude plugin validate --strict` on every plugin and the marketplace (exit code), plus a broken copy that
// must fail, so this check is known to be able to fail. Skipped when the claude CLI is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
const validate = (dir) => spawnSync('claude', ['plugin', 'validate', dir, '--strict'], { encoding: 'utf8', cwd: ROOT });

for (const dir of ['plugins/spreng', 'plugins/spreng-images', 'plugins/spreng-research', '.']) {
  test(`claude plugin validate --strict ${dir} exits 0`, { skip: !hasClaude && 'claude CLI not installed' }, () => {
    const r = validate(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}

test('a copy with a plain-http connector fails strict validation', { skip: !hasClaude && 'claude CLI not installed' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spreng-bad-'));
  fs.cpSync(path.join(ROOT, 'plugins/spreng'), tmp, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(tmp, '.claude-plugin/plugin.json'), 'utf8'));
  m.mcpServers.spreng.url = 'http://app.spreng.io/mcp';
  m.mcpServers.spreng.headers = { Authorization: '${user_config.missing_key}' };
  fs.writeFileSync(path.join(tmp, '.claude-plugin/plugin.json'), JSON.stringify(m));
  assert.notEqual(validate(tmp).status, 0);
});
