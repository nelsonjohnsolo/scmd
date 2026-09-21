const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { chmod, mkdir, mkdtemp, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { promisify } = require('node:util');

const ROOT = resolve(__dirname, '..');
const README_PATH = resolve(ROOT, 'README.md');
const readme = readFileSync(README_PATH, 'utf8');
const execFileAsync = promisify(execFile);
const PREFIX_SETUP = 'mkdir -p "$HOME/.scmd-npx"';
const PREFIX_MODE = 'chmod 700 "$HOME/.scmd-npx"';
const ISOLATED_COMMAND = 'npx -y --prefix="$HOME/.scmd-npx" --prefer-online @nelsonjohnsolo/scmd@latest';
const SHORT_COMMAND = 'npx -y @nelsonjohnsolo/scmd';
const SCREENSHOT_URL = 'https://raw.githubusercontent.com/nelsonjohnsolo/scmd/main/docs/assets/scmd-review.png';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function position(text) {
  const index = readme.indexOf(text);
  assert.notEqual(index, -1, `README must contain ${JSON.stringify(text)}`);
  return index;
}

function section(title) {
  const start = position(title);
  const nextHeading = readme.indexOf('\n## ', start + title.length);
  const end = nextHeading === -1 ? readme.length : nextHeading;
  return { start, end, text: readme.slice(start, end) };
}

test('README opens with restrained product proof before the plugin quick start', () => {
  const screenshotPattern = new RegExp(
    '!\\[([^\\]]+)\\]\\('
      + escapeRegExp(SCREENSHOT_URL)
      + '\\)',
  );
  const screenshot = readme.match(screenshotPattern);
  assert.ok(screenshot, `README must show the product screenshot at ${SCREENSHOT_URL}`);

  const screenshotIndex = screenshot.index;
  const titlePromise = /^# SCMD\b[^\n]*\n\n([^\n]+)\n/.exec(readme);
  assert.ok(titlePromise, 'README must begin with a title followed by one promise line');
  assert.match(titlePromise[1], /^SCMD reviews Claude Code's persistent memories /);

  const openingBadgeBlock = readme.slice(titlePromise.index + titlePromise[0].length, screenshotIndex).trim();
  const openingBadges = [...openingBadgeBlock.matchAll(/\[!\[([^\]]+)\]\((https?:\/\/[^)]+)\)\]\(([^)]+)\)/g)]
    .map(([, alt, imageUrl, targetUrl]) => ({ alt, imageUrl, targetUrl }));
  assert.equal(openingBadges.length, 3, 'opening should contain exactly three badges');
  assert.equal(new Set(openingBadges.map(({ targetUrl }) => targetUrl)).size, 3, 'badges should link to three distinct targets');
  const badgeContracts = [
    {
      name: 'npm',
      alt: /\bnpm\b/i,
      image: /\bnpm\b/i,
      target: /npm(?:js\.com|\.js)/i,
    },
    {
      name: 'Node >=18',
      alt: /\bnode(?:\.js)?\b.*\b18\b/i,
      image: /\bnode(?:\.js)?\b.*(?:18|%3e%3d18|>=18)/i,
      target: /node(?:js\.org|\.js)/i,
    },
    {
      name: 'MIT license',
      alt: /\bmit\b/i,
      image: /(?:\blicense\b[\s\S]*\bmit\b|\bmit\b[\s\S]*\blicense\b)/i,
      target: /(?:license|mit)/i,
    },
  ];
  for (const [index, contract] of badgeContracts.entries()) {
    const badge = openingBadges[index];
    assert.match(badge.imageUrl, /^https:\/\//, `${contract.name} badge image must use HTTPS`);
    assert.match(badge.alt, contract.alt, `badge ${index + 1} must be the ${contract.name} badge`);
    assert.match(badge.imageUrl, contract.image, `${contract.name} badge image must identify its category`);
    assert.match(badge.targetUrl, contract.target, `${contract.name} badge link must identify its category`);
  }

  const nonBadgeOpening = openingBadgeBlock.replace(/\[!\[[^\]]+\]\(https?:\/\/[^)]+\)\]\([^)]+\)/g, '').trim();
  assert.equal(nonBadgeOpening, '', 'badges must be the only content between the promise and screenshot');

  const add = position('/plugin marketplace add nelsonjohnsolo/scmd');
  const install = position('/plugin install scmd@scmd');
  const launch = readme.indexOf('/scmd:run', install);
  assert.notEqual(launch, -1, 'README must show /scmd:run after plugin installation');
  const workflow = position('Discover → Review → Confirm → Restore');
  const firstDetailedSection = /^## (?:What it does|Requirements)\b/m.exec(readme);
  assert.ok(firstDetailedSection, 'README must have a detailed section after the opening workflow');
  assert.ok(screenshotIndex < add && add < install && install < launch && launch < workflow
    && workflow < firstDetailedSection.index,
  'opening order should show screenshot, add, install, /scmd:run, workflow, then detail');

  assert.doesNotMatch(readme, /Demo GIF:\s*coming soon\./i);
  assert.match(screenshot[1], /\bSCMD\b/i, 'screenshot alt text should identify SCMD');
  assert.match(screenshot[1], /memory|memories|review deck/i, 'screenshot alt text should identify memory review');
  assert.match(screenshot[1], /\bkeep\b/i, 'screenshot alt text should name the keep action');
  assert.match(screenshot[1], /\bdelete\b/i, 'screenshot alt text should name the delete action');
  assert.ok(screenshot[1].trim().split(/\s+/).length >= 7, 'screenshot alt text should be meaningfully descriptive');

  const fallbackParagraph = readme.slice(screenshotIndex + screenshot[0].length)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .find(Boolean) || '';
  assert.ok(fallbackParagraph.length <= 260, 'fallback explanation should remain adjacent and concise');
  assert.match(fallbackParagraph, /\blocal\b[\s\S]{0,50}\breview deck\b/i,
    'fallback text should explain that SCMD is a local review deck');
  assert.match(fallbackParagraph, /\bdecisions?\b[\s\S]{0,30}\bstaged\b/i,
    'fallback text should explain that decisions are staged');
  assert.match(fallbackParagraph, /\bconfirm\b[\s\S]{0,50}\bchanges?\b/i,
    'fallback text should explain that confirmation controls changes');
});

test('README leads with one-line utility copy and the plugin launch path', () => {
  const titlePromise = /^# SCMD\b[^\n]*\n\n([^\n]+)\n/.exec(readme);
  assert.ok(titlePromise, 'README must begin with a title followed by one promise line');
  assert.match(titlePromise[0], /^# SCMD\b/);
  assert.match(titlePromise[1], /^SCMD reviews Claude Code's persistent memories /);
  assert.ok(titlePromise[1].length <= 160, 'description should remain one concise line');

  const requirements = section('## Requirements');
  const requirementPosition = (term) => {
    const offset = requirements.text.indexOf(term);
    assert.notEqual(offset, -1, `Requirements must mention ${JSON.stringify(term)}`);
    return requirements.start + offset;
  };
  const node = requirementPosition('Node.js 18');
  const npm = requirementPosition('npm');
  const npx = requirementPosition('npx');
  const add = position('/plugin marketplace add nelsonjohnsolo/scmd');
  const install = position('/plugin install scmd@scmd');
  const launch = readme.indexOf('/scmd:run', install);
  assert.notEqual(launch, -1, 'README must show /scmd:run after plugin installation');
  const workflow = position('Discover → Review → Confirm → Restore');
  const prefixSetup = position(PREFIX_SETUP);
  const prefixMode = position(PREFIX_MODE);
  const isolated = position(ISOLATED_COMMAND);
  const shorthand = position(SHORT_COMMAND);
  const terminal = position('### Direct from a terminal');
  assert.ok(add < install && install < launch && launch < workflow && workflow < requirements.start,
    'plugin quick start and workflow must precede detailed requirements');
  assert.ok(requirements.start < node && requirements.start < npm && requirements.start < npx);
  assert.ok(requirements.start < terminal && terminal < prefixSetup && prefixSetup < prefixMode
    && prefixMode < isolated && isolated < shorthand,
  'requirements must precede the isolated terminal launch commands');
  assert.match(requirements.text, /Windows.*Git Bash.*\/scmd:run.*shell snippets/is);
});

test('README recommends an isolated fresh release and warns about the shorthand', () => {
  const terminal = position('### Direct from a terminal');
  const isolated = position(ISOLATED_COMMAND);
  const shorthand = position(SHORT_COMMAND);
  assert.match(readme.slice(terminal, isolated), /recommend/i);
  assert.match(readme.slice(isolated, shorthand + SHORT_COMMAND.length + 300), /trusted director/i);
  assert.match(readme.slice(shorthand, shorthand + SHORT_COMMAND.length + 300), /npm.*project-local package/is);
  assert.doesNotMatch(readme, /--prefix="\$HOME\/\.scmd"/);
});

test('README names every read/write boundary', () => {
  assert.match(readme, /~\/\.claude\/projects\/\*\/memory\/\*\.md/);
  assert.match(readme, /default.*~\/\.claude\/projects/is);
  assert.match(readme, /--root <dir>/);
  assert.match(readme, /CLAUDE_CONFIG_DIR/);
  assert.match(readme, /custom.*auto-memory root/is);
  assert.match(readme, /MEMORY\.md/);
  assert.match(readme, /session.*\.jsonl/is);
  assert.match(readme, /CLAUDE\.md/);
  assert.match(readme, /~\/\.scmd\/reviewed\.json/);
  assert.match(readme, /~\/\.scmd\/trash\//);
  assert.match(readme, /restore.*writes.*memory.*MEMORY\.md/is);
  assert.match(readme, /purge.*permanently deletes.*selected trash run/is);
  assert.match(readme, /only after you confirm|only when you apply/i);
});

test('README states the local privacy boundary before ending with Why', () => {
  const privacy = position('## Privacy');
  const why = position('## Why');
  assert.ok(privacy < why);
  assert.match(readme.slice(privacy, why), /127\.0\.0\.1/);
  assert.match(readme.slice(privacy, why), /every API request.*token/is);
  assert.doesNotMatch(readme.slice(privacy, why), /protects every request/i);
  assert.match(readme.slice(privacy, why), /no telemetry/i);
  assert.match(readme.slice(privacy, why), /rewrite text.*local Claude Code CLI.*account/is);
  const prose = readme.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  assert.equal(prose.includes('!'), false, 'product copy should not use exclamation marks');
  assert.doesNotMatch(readme, /\b(?:Codex|employer|handoff|generated by AI|AI-generated code)\b/i);
  assert.match(readme.slice(why), /AI.*calling him [“"]daddy[”"].*start of every reply/is);
  assert.match(readme.slice(why), /wife saw it/is);
  assert.match(readme.slice(why), /did not know why/is);
  assert.match(readme.slice(why), /in (?:Claude Code )?memory/is);
  assert.match(readme.slice(why), /persistent memor/is);
});

test('README local links resolve to files and never point at a missing GIF', () => {
  const links = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)];
  for (const [, rawTarget] of links) {
    const target = rawTarget.trim().replace(/^<|>$/g, '').split('#')[0];
    if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
    const resolved = resolve(dirname(README_PATH), decodeURIComponent(target));
    assert.ok(existsSync(resolved), `broken local README link: ${rawTarget}`);
  }
  assert.doesNotMatch(readme, /!\[[^\]]*\]\([^)]*\.gif(?:[)#]|$)/i);
});

test('README screenshot is a 1440x960 PNG asset', () => {
  const screenshot = readFileSync(resolve(ROOT, 'docs/assets/scmd-review.png'));
  assert.deepEqual(
    screenshot.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.equal(screenshot.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(screenshot.readUInt32BE(16), 1440);
  assert.equal(screenshot.readUInt32BE(20), 960);
});

test('documented setup makes the isolated prefix usable from a clean home', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'scmd-readme-prefix-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const home = join(sandbox, 'home');
  const packageDir = join(sandbox, 'package');
  const prefix = join(home, '.scmd-npx');
  await mkdir(home);
  await mkdir(packageDir);
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: 'scmd-prefix-probe',
    version: '1.0.0',
    bin: { 'scmd-prefix-probe': 'cli.js' },
  }));
  await writeFile(join(packageDir, 'cli.js'), '#!/usr/bin/env node\nconsole.log("PREFIX_OK")\n');
  await chmod(join(packageDir, 'cli.js'), 0o755);

  assert.equal(existsSync(prefix), false);
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(prefix, 0o700);
    assert.equal((await stat(prefix)).mode & 0o077, 0, 'prefix must not grant group or other permissions');
  }
  const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const { stdout } = await execFileAsync(npxCommand, [
    '-y',
    `--prefix=${prefix}`,
    `--package=file:${packageDir}`,
    'scmd-prefix-probe',
  ], {
    cwd: sandbox,
    env: {
      ...process.env,
      HOME: home,
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_CACHE: join(sandbox, 'cache'),
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    },
    timeout: 20_000,
  });
  assert.match(stdout, /PREFIX_OK/);
});
