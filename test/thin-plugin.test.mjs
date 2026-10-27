// The listed package: plugins/spreng. It must stay thin (no scripts, hooks, lockfiles, binaries, keys or
// method text), declare exactly one connector with no headers, and carry valid directory metadata for both
// Anthropic and OpenAI. These tests fail on any of those drifting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, read, json, files, pngSize, hosts } from './helpers.mjs';
import { TOOLS as IMAGE_TOOLS } from '../plugins/spreng-images/server/server.mjs';

const P = 'plugins/spreng';
const MCP_URL = 'https://app.spreng.io/mcp';
const ALLOWED = [
  '.claude-plugin/plugin.json', 'LICENSE', 'README.md', 'assets/icon.png',
  'mcp.json', 'plugin.json', 'skills/spreng/SKILL.md', 'skills/spreng/research-first.md',
].map((f) => path.join(P, f)).sort();

// R2-fable-07: logo.png was a byte-identical copy of icon.png. The OpenAI interface takes a path per field, so both
// name the one file (as spreng-research's manifest already does).
test('logo and composerIcon name the one image file', () => {
  const i = json(`${P}/plugin.json`).extensions['com.openai'].interface;
  assert.equal(i.logo, './assets/icon.png');
  assert.equal(i.composerIcon, './assets/icon.png');
  assert.equal(json(`${P}/.claude-plugin/plugin.json`).icon, './assets/icon.png');
});

test('the listed plugin holds only manifests, one skill, README, LICENSE and one image', () => {
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

test('the tool fixture is the served tools/list: a free list, a paid list, and tools as their union (R2-fable-06)', () => {
  const { free, paid, tools } = json('test/fixtures/spreng-mcp-tools.json');
  assert.ok(Array.isArray(free) && Array.isArray(paid), 'captured per plan');
  assert.equal(free.length, 41, 'a free account is served 41 tools');
  for (const t of ['studio_start', 'create_client', 'save_record', 'get_records', 'studio_catalog', 'studio_get', 'delete_client',
    'list_native_text_runs', 'get_image_preferences', 'set_prompt_handling', 'save_brand_asset']) assert.ok(free.includes(t), t);
  assert.ok(!free.includes('get_saved_images') && paid.includes('get_saved_images'), 'Gallery is a paid-account tool');
  assert.deepEqual([...tools].sort(), [...new Set([...free, ...paid])].sort());
});

test('review cases: five positive and three negative, positive ones name only tools the connector has', () => {
  // The reviewers' account is a free account (charm-scanner scripts/seed-reviewer-account.mjs): its list is the check.
  const { free: tools } = json('test/fixtures/spreng-mcp-tools.json');
  const { positive, negative } = json(`${P}/plugin.json`).extensions['com.openai'].review.test_cases;
  assert.equal(positive.length, 5);
  assert.equal(negative.length, 3);
  for (const c of positive) {
    assert.ok(c.description && c.prompt && c.tools_triggered && c.expected_behavior);
    for (const t of c.tools_triggered.split(',').map((s) => s.trim())) assert.ok(tools.includes(t), `unknown tool ${t}`);
  }
  for (const c of negative) assert.ok(c.description && c.prompt);
});

// The directory reviewers sign in to an account seeded with one made-up brand (charm-scanner
// scripts/seed-reviewer-account.mjs, BRAND). Every review case that names a brand must name that one.
const REVIEWER_BRAND = 'Brindlefen Candle Co.';

test('review cases name the brand the reviewer account is seeded with', () => {
  const raw = read(`${P}/plugin.json`);
  assert.doesNotMatch(raw, /Mossgate/, 'the reviewer account has no Mossgate Pottery client');
  const { positive, negative } = json(`${P}/plugin.json`).extensions['com.openai'].review.test_cases;
  assert.ok(positive[0].expected_behavior.includes(REVIEWER_BRAND), 'the list case names the seeded client');
  for (const c of positive.slice(1)) assert.ok(c.prompt.includes(REVIEWER_BRAND), `case "${c.description}" names the seeded client`);
  assert.ok(negative.some((c) => c.prompt.includes(REVIEWER_BRAND)), 'the video refusal case names the seeded client');
});

// Directory links must open real pages. Checked 2026-10-09 against the deployed route tables: app.spreng.io
// serves /docs/plugin, /support, /privacy and /terms (charm-scanner src/App.tsx, PUBLIC_PLUGIN_PAGE_PATHS);
// spreng.io routes only /, /privacy, /terms, /dpa, /subprocessors, /refund, /meta-data-deletion, /security and
// /contact, and renders "Page not found" for /docs/plugin and /support.
const DIRECTORY_PAGES = {
  docs: 'https://app.spreng.io/docs/plugin',
  support: 'https://spreng.io/contact',
  privacy: 'https://spreng.io/privacy',
  terms: 'https://spreng.io/terms',
};

test('manifest and README directory links point at pages that exist', () => {
  const c = json(`${P}/.claude-plugin/plugin.json`);
  assert.equal(c.documentationUrl, DIRECTORY_PAGES.docs);
  assert.equal(c.supportUrl, DIRECTORY_PAGES.support);
  assert.equal(c.privacyPolicyUrl, DIRECTORY_PAGES.privacy);
  assert.equal(c.termsOfServiceUrl, DIRECTORY_PAGES.terms);
  const i = json(`${P}/plugin.json`).extensions['com.openai'].interface;
  assert.equal(i.supportURL, DIRECTORY_PAGES.support);
  assert.equal(i.privacyPolicyURL, DIRECTORY_PAGES.privacy);
  assert.equal(i.termsOfServiceURL, DIRECTORY_PAGES.terms);
  const readme = read(`${P}/README.md`);
  for (const u of Object.values(DIRECTORY_PAGES).filter((u) => u !== DIRECTORY_PAGES.docs)) assert.ok(readme.includes(u), `README names ${u}`);
  assert.doesNotMatch(readme, /https:\/\/spreng\.io\/(docs|support)/, 'spreng.io has no docs or support page');
});

test('the skill names only connector tools or the add-on readiness tool and carries no method text', () => {
  const { tools } = json('test/fixtures/spreng-mcp-tools.json');
  const skill = read(`${P}/skills/spreng/SKILL.md`);
  assert.match(skill, /^---\nname: spreng\ndescription: [^\n]+\n---\n/);
  const named = [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]).filter((n) => !['operationId'].includes(n));
  for (const n of named) {
    const localReadiness = n === 'check_image_readiness' && IMAGE_TOOLS.some((t) => t.name === n);
    assert.ok(tools.includes(n) || localReadiness, `skill names ${n}, which neither connector nor add-on provides`);
  }
  assert.ok(skill.split('\n').length < 85, 'router stays short including the A8 readiness gate');
});

test('R9-FABLE-05: sign-in routes claude.ai through its custom connector setup', () => {
  const skill = read(`${P}/skills/spreng/SKILL.md`);
  const claude = skill.split('\n').find((line) => line.includes('claude.ai:'));
  assert.ok(claude, 'claude.ai has its own setup instructions');
  assert.match(claude, /Customize > Connectors > (?:\+ Add > )?Add custom connector/);
  assert.ok(claude.includes(MCP_URL), 'the custom connector uses the native endpoint');
  assert.match(claude, /Sign in now/);
  assert.doesNotMatch(claude, /Connect button on the plugin/);
  assert.match(skill, /Codex app and ChatGPT: the Connect button on the plugin\./);
  assert.match(skill, /Codex CLI: `codex mcp login spreng`/);
  assert.match(skill, /Claude Code: run `\/mcp`, pick `spreng`, sign in\./);
});

test('image review cases use receipt completion without generated-image uploads', () => {
  const cases = json(`${P}/plugin.json`).extensions['com.openai'].review.test_cases.positive;
  const imageCases = cases.filter((c) => c.tools_triggered.includes('claim_native_image'));
  assert.equal(imageCases.length, 2);
  for (const c of imageCases) {
    assert.ok(c.tools_triggered.includes('finalize_native_image'));
    assert.ok(!c.tools_triggered.includes('create_native_image_upload'));
    assert.match(c.expected_behavior, /image stays with the host|image with the host/);
    assert.match(c.expected_behavior, /Spreng keeps no copy/);
    assert.doesNotMatch(c.expected_behavior, /Gallery/);
  }
});

test('both image routers follow served completion steps and preserve the host file', () => {
  for (const file of [`${P}/skills/spreng/SKILL.md`, 'plugins/spreng-images/skills/image-source/SKILL.md']) {
    const skill = read(file);
    assert.match(skill, /claim's `next`/);
    assert.match(skill, /only (?:if|when) it returns `signedUrl`/);
    assert.match(skill, /`uploadNeeded: false`/);
    assert.match(skill, /`assetId`, `actualPrompt` and `host`/);
    assert.match(skill, /Spreng keeps no copy|without a Gallery copy/);
  }
});

test('first-run image setup precedes claim and gives Claude Code a concrete Codex route', () => {
  const skill = read(`${P}/skills/spreng/SKILL.md`);
  assert.match(skill, /Before calling `claim_native_image`, check/);
  assert.match(skill, /claude plugin install spreng-images@spreng/);
  assert.match(skill, /choose Codex/);
  assert.match(skill, /imageSource: codex_cli/);
  assert.match(skill, /Before `claim_native_image`, call `check_image_readiness`/);
  assert.match(skill, /For ready, claim normally\. For could_not_tell, claim normally/);
  assert.match(skill, /account's own usage limits/);
  assert.match(skill, /list_native_runs/);
  assert.doesNotMatch(skill, /waitingFor: image_context|set_creative_rules|get_creative_rules/);
  for (const file of [`${P}/skills/spreng/SKILL.md`, `${P}/README.md`, 'plugins/spreng-images/skills/image-source/SKILL.md', 'plugins/spreng-images/README.md']) {
    assert.match(read(file), /connector always sends the Prompt Plate plus (?:your|the user.s) own inputs/);
    assert.doesNotMatch(read(file), /turn (?:creative )?rules on|set_creative_rules|get_creative_rules/i);
  }
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

// R2-fable-05: the prompt command form was unverified, so the skill names no exact form. R2-fable-01: the connector
// serves the saved-research record format, not a research method, and the skill says exactly that.
test('the skill claims no unverified command form and promises no research method', () => {
  const skill = read(`${P}/skills/spreng/SKILL.md`);
  assert.doesNotMatch(skill, /\/spreng:/, 'no unverified /spreng:<name> command form');
  assert.doesNotMatch(skill, /research method/i);
  assert.match(skill, /`studio_get` with kind sop and slug research-vault gives the record format/);
});

// LOOP-99 (R3-fable-06, DIAG-R3 A): the router names the research chain in the connector's order, buyer_read included,
// because angles and ad copy read the newest completed buyer read and the connector's chain otherwise never makes one.
test('the skill names the research chain in the served order, buyer read before angles and ad copy', () => {
  const skill = read(`${P}/skills/spreng/SKILL.md`);
  const line = skill.split('\n').find((l) => /\bstructure\b.*\bstack\b/.test(l));
  assert.ok(line, 'a line names the research chain');
  const chain = line.slice(line.search(/\bstructure\b/));
  const order = ['structure', 'verify', 'decide_message', 'mechanism', 'product', 'offer', 'stack', 'buyer_read', 'angles', 'ad_copy']
    .map((k) => chain.search(new RegExp(`\\b${k}\\b`)));
  assert.ok(order.every((i) => i >= 0), `every kind is named: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'named in the served order');
  assert.match(chain, /brand_voice/);
  assert.match(chain, /`get_workflow`/);
});

test('R10-FABLE-03: brand document and person photo routes cover upload, list and removal', () => {
  const row = read(`${P}/skills/spreng/SKILL.md`).split('\n').find((line) => line.startsWith('| Add, list or remove a brand document or person photo |'));
  assert.ok(row);
  for (const text of ['create_brand_asset_upload', 'brand_document', 'person_photo', 'PUT', 'save_brand_asset', 'list_brand_attachments', 'remove_brand_attachment', 'listed path']) assert.ok(row.includes(text), text);
});
