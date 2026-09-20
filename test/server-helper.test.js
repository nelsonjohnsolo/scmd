const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const { createReadyLineParser, startServer } = require('./server-helper');

const FIXTURE_ROOT = resolve(__dirname, '..', 'fixtures', 'projects');

test('waits for a complete stdout line before accepting a launch token', () => {
  const parser = createReadyLineParser();

  assert.equal(
    parser.push('Listening at http://127.0.0.1:12345/?token=split'),
    undefined,
  );
  assert.deepEqual(
    parser.push('-token\n'),
    {
      url: 'http://127.0.0.1:12345/?token=split-token',
      token: 'split-token',
    },
  );
});

test('startServer reports an explicit state directory and does not own its cleanup', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'scmd-helper-state-'));
  const stateDir = join(sandbox, 'explicit-state');
  const marker = join(stateDir, 'owned-by-caller');
  await mkdir(stateDir);
  await writeFile(marker, 'keep');
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const server = await startServer(undefined, {
    serverArgs: [
      '--root', FIXTURE_ROOT,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  t.after(server.cleanup);

  assert.equal(server.stateDir, stateDir);
  await server.cleanup();
  assert.equal(await readFile(marker, 'utf8'), 'keep');
});

test('startServer injects, reports, and cleans up its owned state directory', async () => {
  const server = await startServer(undefined, {
    serverArgs: ['--root', FIXTURE_ROOT, '--port', '0', '--no-open'],
  });
  const flagIndex = server.launchArgs.lastIndexOf('--state-dir');

  assert.notEqual(flagIndex, -1);
  assert.equal(server.launchArgs[flagIndex + 1], server.stateDir);
  assert.equal((await stat(server.stateDir)).isDirectory(), true);

  await server.cleanup();
  await assert.rejects(stat(server.stateDir), { code: 'ENOENT' });
});
