// The listed package: plugins/spreng. It must stay thin (no scripts, hooks, lockfiles, binaries, keys or
// method text), declare exactly one connector with no headers, and carry valid directory metadata for both
// Anthropic and OpenAI. These tests fail on any of those drifting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, read, json, files, pngSize, hosts } from './helpers.mjs';

const P = 'plugins/spreng';
const MCP_URL = 'https://app.spreng.io/mcp';
const ALLOWED = [
  '.claude-plugin/plugin.json', 'LICENSE', 'README.md', 'assets/icon.png', 'assets/logo.png',
  'mcp.json', 'plugin.json', 'skills/spreng/SKILL.md',
].map((f) => path.join(P, f)).sort();

test('the listed plugin holds only manifests, one skill, README, LICENSE and two images', () => {
  assert.deepEqual(files(P), ALLOWED);
  for (const f of files(P)) {
    const size = fs.statSync(path.join(ROOT, f)).size;
    assert.ok(size < 256 * 1024, `${f} is ${size} bytes`);
  }
});

test('Claude Code manifest: one http connector to /mcp, no headers, no userConfig, directory fields', () => {
  const m = json(`${P}/.claude-plugin/plugin.json`);
  assert.equal(m.name, 'spreng');
  assert.deepEqual(Object.keys(m.mcpServers), ['spreng']);
  assert.deepEqual(m.mcpServers.spreng, { type: 'http', url: MCP_URL });
  assert.equal(m.userConfig, undefined);
  for (const k of ['documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl']) assert.match(m[k], /^https:\/\//, k);
  assert.ok(fs.existsSync(path.join(ROOT, P, m.icon)));
  assert.ok(m.license && m.description && m.author?.name && m.version);
});

test('Agent Plugins manifest and mcp.json: same identity, one streamable-http server, OpenAI listing limits', () => {
  const claude = json(`${P}/.claude-plugin/plugin.json`);
  const m = json(`${P}/plugin.json`);
  const mcp = json(`${P}/mcp.json`);
  assert.equal(m.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.equal(m.name, claude.name);
  assert.equal(m.version, claude.version);
  assert.equal(m.description, claude.description);
  assert.deepEqual(mcp.mcpServers, { spreng: { type: 'streamable-http', url: MCP_URL } });
  const o = m.extensions['com.openai'];
  const i = o.interface;
  assert.ok(i.displayName.length <= 30 && i.shortDescription.length <= 30, 'display name and subtitle at most 30');
  assert.ok(i.longDescription.length <= 4000 && i.developerName.length <= 80);
  assert.ok(i.defaultPrompt.length <= 3 && i.defaultPrompt.every((p) => p.length <= 128));
  for (const k of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) assert.match(i[k], /^https:\/\//, k);
  assert.match(i.brandColor, /^#[0-9A-F]{6}$/i);
  for (const k of ['logo', 'composerIcon']) {
    const { width, height } = pngSize(path.join(P, i[k]));
    assert.ok(width === height && width >= 48 && width <= 4096, `${k} must be square, 48 to 4096 px`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, P, o.onboardingSkill)));
  assert.equal(o.apps, undefined, 'ZIPs with app references cannot be submitted');
  assert.equal(o.hooks, undefined, 'ZIPs with lifecycle hooks cannot be submitted');
});

test('review cases: five positive and three negative, positive ones name only tools the connector has', () => {
  const { tools } = json('test/fixtures/spreng-mcp-tools.json');
  const { positive, negative } = json(`${P}/plugin.json`).extensions['com.openai'].review.test_cases;
  assert.equal(positive.length, 5);
  assert.equal(negative.length, 3);
  for (const c of positive) {
    assert.ok(c.description && c.prompt && c.tools_triggered && c.expected_behavior);
    for (const t of c.tools_triggered.split(',').map((s) => s.trim())) assert.ok(tools.includes(t), `unknown tool ${t}`);
  }
  for (const c of negative) assert.ok(c.description && c.prompt);
});

test('the skill names only connector tools and carries no method text', () => {
  const { tools } = json('test/fixtures/spreng-mcp-tools.json');
  const skill = read(`${P}/skills/spreng/SKILL.md`);
  assert.match(skill, /^---\nname: spreng\ndescription: [^\n]+\n---\n/);
  const named = [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]).filter((n) => !['operationId'].includes(n));
  for (const n of named) assert.ok(tools.includes(n), `skill names ${n}, which the connector does not have`);
  assert.ok(skill.split('\n').length < 80, 'router stays short');
});

test('image review cases use receipt completion without generated-image uploads', () => {
  const cases = json(`${P}/plugin.json`).extensions['com.openai'].review.test_cases.positive;
  const imageCases = cases.filter((c) => c.tools_triggered.includes('claim_native_image'));
  assert.equal(imageCases.length, 2);
  for (const c of imageCases) {
    assert.ok(c.tools_triggered.includes('finalize_native_image'));
    assert.ok(!c.tools_triggered.includes('create_native_image_upload'));
    assert.match(c.expected_behavior, /image stays with the host|image with the host/);
    assert.match(c.expected_behavior, /no upload or Gallery copy/);
  }
});

test('both image routers follow served completion steps and preserve the host file', () => {
  for (const file of [`${P}/skills/spreng/SKILL.md`, 'plugins/spreng-images/skills/image-source/SKILL.md']) {
    const skill = read(file);
    assert.match(skill, /claim's `next`/);
    assert.match(skill, /only (?:if|when) it returns `signedUrl`/);
    assert.match(skill, /`uploadNeeded: false`/);
    assert.match(skill, /`assetId`, `actualPrompt` and `host`/);
    assert.match(skill, /no Gallery copy|without a Gallery copy/);
  }
});

test('first-run image setup precedes claim and gives Claude Code a concrete Codex route', () => {
  const skill = read(`${P}/skills/spreng/SKILL.md`);
  assert.match(skill, /Before calling `claim_native_image`, check/);
  assert.match(skill, /claude plugin install spreng-images@spreng/);
  assert.match(skill, /choose Codex/);
  assert.match(skill, /imageSource: codex_cli/);
  assert.match(skill, /account's own usage limits/);
  assert.match(skill, /list_native_runs/);
  const source = read('plugins/spreng-images/skills/image-source/SKILL.md');
  assert.match(source, /Do not offer a billed API source by default/);
  assert.match(source, /Keep an existing source choice/);
});

test('listed text has no commerce wording, no em dashes and no key handling', () => {
  const texts = ['README.md', 'skills/spreng/SKILL.md', 'plugin.json', '.claude-plugin/plugin.json'].map((f) => [f, read(`${P}/${f}`)]);
  texts.push(['marketplace entry', JSON.stringify(json('.claude-plugin/marketplace.json').plugins.find((p) => p.name === 'spreng'))]);
  for (const [f, t] of texts) {
    assert.doesNotMatch(t, /\b(free|pricing|prices?|upgrades?|credits?|trials?|subscriptions?|checkout|discount|upsell)\b/i, `${f}: commerce wording`);
    assert.doesNotMatch(t, /—/, `${f}: em dash`);
    assert.doesNotMatch(t, /api[_ ]?key|sk-[a-z0-9]|KIE|OPENAI_API_KEY|Bearer /i, `${f}: key handling`);
  }
});

test('README discloses every destination the plugin names', () => {
  const readme = read(`${P}/README.md`);
  // $schema links are editor hints, not places the plugin sends anything.
  const named = hosts([read(`${P}/.claude-plugin/plugin.json`), read(`${P}/mcp.json`), read(`${P}/skills/spreng/SKILL.md`)].join('\n').replace(/"\$schema": "[^"]+"/g, ''));
  for (const h of named) assert.ok(readme.includes(h), `README does not mention ${h}`);
  assert.ok(readme.replace(/```[\s\S]*?```/g, '').split(/\s+/).length >= 40, 'README at least 40 words outside code');
});

test('marketplaces: Claude lists the three plugins by relative path; Codex lists spreng and research only', () => {
  const claude = json('.claude-plugin/marketplace.json');
  assert.equal(claude.name, 'spreng');
  assert.deepEqual(claude.plugins.map((p) => p.name), ['spreng', 'spreng-images', 'spreng-research']);
  for (const p of claude.plugins) assert.ok(fs.existsSync(path.join(ROOT, p.source, '.claude-plugin/plugin.json')), p.source);
  const codex = json('.agents/plugins/marketplace.json');
  assert.deepEqual(codex.plugins.map((p) => p.name), ['spreng', 'spreng-research']);
  for (const p of codex.plugins) {
    assert.ok(fs.existsSync(path.join(ROOT, p.source.path, 'plugin.json')), p.source.path);
    assert.ok(p.policy.installation && p.policy.authentication && p.category);
  }
});
