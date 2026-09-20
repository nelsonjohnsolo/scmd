const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { mkdtemp, rm, stat, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const PROJECT_ROOT = resolve(__dirname, '..');
const SERVER_PATH = resolve(PROJECT_ROOT, 'server.js');
const FIXTURE_ROOT = resolve(PROJECT_ROOT, 'fixtures', 'projects');
const LISTEN_MARKER = 'SCMD_TEST_LISTEN_CALLED';

function runServer(args, { timeoutMs = 1_000, env = process.env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [SERVER_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      rejectRun(new Error(`server did not exit within ${timeoutMs} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function findLaunchUrl(line) {
  const match = line.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=([a-f0-9]+)/i);
  if (!match) return;

  return { url: match[0], token: match[1] };
}

function createLaunchParser() {
  let pending = '';

  return (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();

    for (const line of lines) {
      const launch = findLaunchUrl(line);
      if (launch) return launch;
    }
  };
}

function startServer(args, { env = process.env } = {}) {
  return new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, [SERVER_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 1_000);

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveStart({ child, stdout, stderr, ...value });
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectStart(error);
    };
    const parseLaunchOutput = createLaunchParser();

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const launch = parseLaunchOutput(chunk.toString());
      if (launch) finishResolve(launch);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', finishReject);
    child.once('close', (code, signal) => {
      const reason = timedOut
        ? 'server did not print a launch URL'
        : `server exited before launch (code ${code}, signal ${signal || 'none'})`;
      finishReject(new Error(`${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function occupyLoopbackPort(t) {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  return server.address().port;
}

async function splitLaunchOutput(t) {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-stdout-preload-'));
  const preloadPath = join(directory, 'split-launch-output.js');
  await writeFile(preloadPath, `
const write = process.stdout.write.bind(process.stdout);
let split = false;
process.stdout.write = (chunk, ...args) => {
  if (!split && typeof chunk === 'string' && chunk.includes('SCMD running at ')) {
    split = true;
    const splitAt = chunk.indexOf('?token=') + '?token='.length + 8;
    write(chunk.slice(0, splitAt));
    setTimeout(() => write(chunk.slice(splitAt), ...args), 0);
    return true;
  }
  return write(chunk, ...args);
};
`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return preloadPath;
}

async function oldNodePreload(t) {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-old-node-preload-'));
  const preloadPath = join(directory, 'old-node.js');
  await writeFile(preloadPath, `
const http = require('node:http');

Object.defineProperty(process.versions, 'node', {
  configurable: true,
  enumerable: true,
  value: '17.9.1',
});

http.Server.prototype.listen = function listenMustNotRun() {
  process.stderr.write(${JSON.stringify(`${LISTEN_MARKER}\n`)});
  throw new Error('server listen called under unsupported Node');
};
`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return preloadPath;
}

test('a no-open launch prints a loopback URL with a per-launch token', async (t) => {
  const stateParent = await mkdtemp(join(tmpdir(), 'scmd-server-core-'));
  const stateDir = join(stateParent, 'state');
  t.after(() => rm(stateParent, { recursive: true, force: true }));

  const server = await startServer([
    '--root', FIXTURE_ROOT,
    '--state-dir', stateDir,
    '--port', '0',
    '--no-open',
  ]);
  t.after(() => server.child.kill('SIGTERM'));

  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+$/i);
  assert.equal(server.token.length, 32);
  await assert.rejects(stat(stateDir), { code: 'ENOENT' });
});

test('launch parsing waits for a newline when stdout splits the token', async (t) => {
  const stateParent = await mkdtemp(join(tmpdir(), 'scmd-server-core-'));
  const stateDir = join(stateParent, 'state');
  const preloadPath = await splitLaunchOutput(t);
  t.after(() => rm(stateParent, { recursive: true, force: true }));

  const server = await startServer([
    '--root', FIXTURE_ROOT,
    '--state-dir', stateDir,
    '--port', '0',
    '--no-open',
  ], {
    env: { ...process.env, NODE_OPTIONS: `--require=${preloadPath}` },
  });
  t.after(() => server.child.kill('SIGTERM'));

  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]{32}$/i);
  assert.equal(server.token.length, 32);
});

test('Node below 18 exits once without printing a URL or starting a server', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'scmd-old-node-home-'));
  const preloadPath = await oldNodePreload(t);
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await runServer([], {
    env: {
      ...process.env,
      HOME: home,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(' '),
    },
  });

  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.match(result.stderr, /Node\.js 18 or newer/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /https?:\/\/|SCMD_TEST_LISTEN_CALLED/);
});

test('a nonexistent root exits non-zero and names the supplied path', async () => {
  const missingRoot = '/nope';
  const result = await runServer(['--root', missingRoot]);

  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, new RegExp(missingRoot));
});

test('a root that is a file exits non-zero and names the supplied path', async () => {
  const fileRoot = resolve(PROJECT_ROOT, 'package.json');
  const result = await runServer(['--root', fileRoot]);

  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, new RegExp(fileRoot));
});

test('a root containing a newline is escaped in a one-line error', async () => {
  const result = await runServer(['--root', 'not-a\nroot']);

  assert.notEqual(result.code, 0);
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.match(result.stderr, /not-a\\nroot/);
});

test('an occupied loopback port exits with a one-line actionable error', async (t) => {
  const port = await occupyLoopbackPort(t);
  const result = await runServer([
    '--root', FIXTURE_ROOT,
    '--port', String(port),
    '--no-open',
  ]);

  assert.notEqual(result.code, 0);
  assert.equal(result.stderr.trim().split('\n').length, 1);
  assert.match(result.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`));
  assert.match(result.stderr, /EADDRINUSE/);
  assert.doesNotMatch(result.stderr, /node:events|Emitted 'error' event|at Server\./);
});

test('unknown flags and invalid or missing option values fail with actionable errors', async () => {
  for (const args of [
    ['--wat'],
    ['--port'],
    ['--port', 'not-a-port'],
    ['--port', '65536'],
    ['--root'],
    ['--state-dir'],
  ]) {
    const result = await runServer(args);
    assert.notEqual(result.code, 0, `${args.join(' ')} should fail`);
    assert.match(`${result.stdout}${result.stderr}`, /error|invalid|missing|unknown/i);
  }
});
