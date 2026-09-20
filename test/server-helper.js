const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { homedir, tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');

const READY_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s'"<>]*/g;

function outputFrom(stdout, stderr) {
  return `stdout:\n${stdout || '(empty)'}\nstderr:\n${stderr || '(empty)'}`;
}

function findLaunchUrl(line) {
  const matches = line.match(URL_PATTERN) || [];

  for (const candidate of matches) {
    try {
      const url = new URL(candidate);
      const token = url.searchParams.get('token');
      if (token) return { url: url.href, token };
    } catch {
      // Continue looking if a log line happens to include a malformed URL.
    }
  }
}

function createReadyLineParser() {
  let tail = '';

  return {
    push(chunk) {
      const lines = `${tail}${chunk}`.split('\n');
      tail = lines.pop();

      for (const line of lines) {
        const launch = findLaunchUrl(line);
        if (launch) return launch;
      }
    },
  };
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolveClose) => {
    const finish = () => {
      clearTimeout(timeout);
      child.removeListener('close', finish);
      resolveClose();
    };
    const timeout = setTimeout(finish, timeoutMs);
    child.once('close', finish);
  });
}

async function startServer(t, {
  readyTimeoutMs = READY_TIMEOUT_MS,
  noOpen = true,
  env = process.env,
  serverArgs,
} = {}) {
  const root = resolve(__dirname, '..', 'fixtures', 'projects');
  let launchArgs;
  let stateDir;
  let ownsStateDir = false;

  if (serverArgs === undefined) {
    stateDir = await mkdtemp(join(tmpdir(), 'scmd-state-'));
    ownsStateDir = true;
    launchArgs = ['--root', root, '--state-dir', stateDir, '--port', '0'];
  } else {
    launchArgs = [...serverArgs];
    const stateFlagIndex = launchArgs.lastIndexOf('--state-dir');
    if (stateFlagIndex !== -1 && launchArgs[stateFlagIndex + 1]) {
      stateDir = resolve(launchArgs[stateFlagIndex + 1]);
    } else if (launchArgs.length > 0) {
      stateDir = await mkdtemp(join(tmpdir(), 'scmd-state-'));
      ownsStateDir = true;
      launchArgs.push('--state-dir', stateDir);
    } else {
      stateDir = join(env.HOME || env.USERPROFILE || homedir(), '.scmd');
    }
  }
  if (serverArgs === undefined && noOpen) launchArgs.push('--no-open');
  const args = [resolve(__dirname, '..', 'server.js'), ...launchArgs];

  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let stdout = '';
  let stderr = '';
  let cleanupPromise;
  let settled = false;
  let spawnError;

  const cleanup = async () => {
    if (cleanupPromise) return cleanupPromise;

    cleanupPromise = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await waitForClose(child, STOP_TIMEOUT_MS);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'close');
        }
      }
      if (ownsStateDir) await rm(stateDir, { recursive: true, force: true });
    })();

    return cleanupPromise;
  };

  if (t) t.after(cleanup);

  const ready = new Promise((resolveReady, rejectReady) => {
    const lineParser = createReadyLineParser();
    const timeout = setTimeout(() => {
      finishReject(new Error(
        `SCMD server did not print a localhost launch URL containing a token within ${readyTimeoutMs} ms.\n${outputFrom(stdout, stderr)}`,
      ));
    }, readyTimeoutMs);

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveReady(value);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectReady(error);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const launch = lineParser.push(chunk);
      if (launch) finishResolve(launch);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      const reason = spawnError
        ? `Could not start SCMD server: ${spawnError.message}`
        : `SCMD server exited before it printed a localhost launch URL containing a token (code ${code}, signal ${signal || 'none'}).`;
      finishReject(new Error(
        `${reason}\n${outputFrom(stdout, stderr)}`,
      ));
    });
  });

  try {
    const { url, token } = await ready;
    return {
      url,
      token,
      launchArgs,
      root,
      stateDir,
      child,
      cleanup,
      output: () => ({ stdout, stderr }),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = { createReadyLineParser, startServer };
