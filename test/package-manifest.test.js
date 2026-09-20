const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const {
  access,
  mkdtemp,
  readFile,
  rm,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(__dirname, '..');
const PACKED_PATHS = [
  'LICENSE',
  'README.md',
  'index.html',
  'package.json',
  'plugin/.claude-plugin/plugin.json',
  'plugin/commands/run.md',
  'server.js',
];

test('package exposes the exact zero-dependency public release', async () => {
  const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const marketplace = JSON.parse(await readFile(
    join(PROJECT_ROOT, '.claude-plugin', 'marketplace.json'),
    'utf8',
  ));

  assert.equal(manifest.name, '@nelsonjohnsolo/scmd');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(marketplace.metadata.version, manifest.version);
  assert.equal(marketplace.plugins[0].version, manifest.version);
  assert.deepEqual(manifest.bin, { scmd: 'server.js' });
  assert.deepEqual(manifest.engines, { node: '>=18' });
  assert.deepEqual(manifest.publishConfig, { access: 'public' });
  assert.deepEqual(manifest.files, [
    'server.js',
    'index.html',
    'plugin/',
    'README.md',
    'LICENSE',
  ]);
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundleDependencies',
    'bundledDependencies',
  ]) {
    assert.equal(Object.hasOwn(manifest, field), false, `${field} must be absent`);
  }

  const cacheDirectory = await mkdtemp(join(tmpdir(), 'scmd-npm-cache-'));
  try {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const { stdout } = await execFileAsync(npmCommand, [
      'pack',
      '--dry-run',
      '--json',
      '--cache', cacheDirectory,
    ], {
      cwd: PROJECT_ROOT,
      maxBuffer: 1024 * 1024,
    });
    const [pack] = JSON.parse(stdout);

    assert.equal(pack.version, manifest.version);
    assert.deepEqual(pack.files.map(({ path }) => path), PACKED_PATHS);
    const serverEntry = pack.files.find(({ path }) => path === 'server.js');
    assert.notEqual(serverEntry.mode & 0o111, 0, 'server.js must be executable');
    await assert.rejects(access(join(PROJECT_ROOT, pack.filename)), { code: 'ENOENT' });
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
  await assert.rejects(access(cacheDirectory), { code: 'ENOENT' });
});
