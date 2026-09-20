const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { startServer } = require('./server-helper');

const BROWSER_MARKER = 'SCMD_TEST_BROWSER ';

async function browserSpawnPreload(t) {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-browser-preload-'));
  const preload = join(directory, 'browser-spawn.js');
  await writeFile(preload, `
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const fs = require('node:fs');

Object.defineProperty(process, 'platform', {
  configurable: true,
  value: process.env.SCMD_TEST_PLATFORM,
});

if (process.env.SCMD_TEST_EXPECTED_ROOT) {
  const statSync = fs.statSync.bind(fs);
  fs.statSync = (target, ...args) => {
    if (target !== process.env.SCMD_TEST_EXPECTED_ROOT) {
      const error = new Error('unexpected root: ' + target);
      error.code = 'ENOENT';
      throw error;
    }
    return statSync(target, ...args);
  };
}

childProcess.spawn = (command, args, options) => {
  process.stdout.write(${JSON.stringify(BROWSER_MARKER)} + JSON.stringify({ command, args, options }) + '\\n');
  const child = new EventEmitter();
  child.unref = () => {};
  if (process.env.SCMD_TEST_BROWSER_ERROR) {
    process.nextTick(() => child.emit('error', new Error('opener unavailable')));
  }
  return child;
};
`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return preload;
}

async function waitForBrowserInvocation(server, timeoutMs = 1_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const line = server.output().stdout
      .split('\n')
      .find((candidate) => candidate.startsWith(BROWSER_MARKER));
    if (line) return JSON.parse(line.slice(BROWSER_MARKER.length));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`browser opener was not called\n${server.output().stdout}`);
}

for (const [platform, command, argsForUrl] of [
  ['darwin', 'open', (url) => [url]],
  ['linux', 'xdg-open', (url) => [url]],
  ['win32', 'cmd.exe', (url) => ['/d', '/s', '/c', 'start', '""', url]],
]) {
  test(`default launch uses the ${platform} browser opener without a shell`, async (t) => {
    const preload = await browserSpawnPreload(t);
    const server = await startServer(t, {
      noOpen: false,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${preload}`,
        SCMD_TEST_PLATFORM: platform,
      },
    });

    const invocation = await waitForBrowserInvocation(server);
    assert.equal(invocation.command, command);
    assert.deepEqual(invocation.args, argsForUrl(server.url));
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.detached, true);
    if (platform === 'win32') {
      assert.equal(invocation.options.windowsVerbatimArguments, true);
    }
  });
}

test('--no-open suppresses the browser opener', async (t) => {
  const preload = await browserSpawnPreload(t);
  const server = await startServer(t, {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      SCMD_TEST_PLATFORM: 'darwin',
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.doesNotMatch(server.output().stdout, new RegExp(BROWSER_MARKER));
});

test('an unavailable browser opener does not crash the server', async (t) => {
  const preload = await browserSpawnPreload(t);
  const server = await startServer(t, {
    noOpen: false,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      SCMD_TEST_PLATFORM: 'linux',
      SCMD_TEST_BROWSER_ERROR: '1',
    },
  });

  await waitForBrowserInvocation(server);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const response = await fetch(server.url);

  assert.equal(response.status, 200);
  assert.equal(server.child.exitCode, null);
});

test('a zero-argument launch uses isolated HOME defaults and opens the browser', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'scmd-default-home-'));
  await mkdir(join(home, '.claude', 'projects'), { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));

  const preload = await browserSpawnPreload(t);
  const server = await startServer(t, {
    noOpen: false,
    serverArgs: [],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
      SCMD_TEST_PLATFORM: 'darwin',
      SCMD_TEST_EXPECTED_ROOT: join(home, '.claude', 'projects'),
    },
  });

  assert.deepEqual(server.launchArgs, []);
  const invocation = await waitForBrowserInvocation(server);
  assert.equal(invocation.command, 'open');
  assert.deepEqual(invocation.args, [server.url]);

  const closed = once(server.child, 'close');
  const response = await fetch(new URL('/api/quit', server.url), {
    method: 'POST',
    headers: { 'X-SCMD-Token': server.token },
  });
  const [code, signal] = await closed;

  assert.equal(response.status, 200);
  assert.equal(code, 0);
  assert.equal(signal, null);
});
