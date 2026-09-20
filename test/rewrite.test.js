const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { delimiter, join } = require('node:path');
const { PassThrough, Writable } = require('node:stream');

const {
  buildRewritePrompt,
  resolveClaudeLaunch,
  rewriteHttpError,
  runClaudeRewrite,
  terminateActiveRewrites,
  terminateClaudeChild,
  validateRewriteProposal,
} = require('../server');
const { startServer } = require('./server-helper');

const MEMORY = `---
name: Keep this name
description: A long description that may need tightening.
type: project
---

This is the complete memory body. It has more detail than the rewritten form needs.
`;
const FIXTURE_ID = '-Users-example-api-server/api_contract.md';

const VALID_TOP_LEVEL_PROPOSAL = `---
name: Keep this name
description: Shorter now.
type: project
---

Short body.
`;

const VALID_NESTED_PROPOSAL = `---
name: "Keep this name"
description: Shorter now.
type: ignored-top-level-value
metadata:
  type: 'project'
---

Short body.
`;

function fakeChild(onInput) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let input = '';
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      input += chunk.toString();
      callback();
    },
    final(callback) {
      callback();
      queueMicrotask(() => onInput(child, input));
    },
  });
  child.kill = (signal) => {
    child.killedWith = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

function success(child, text) {
  child.stdout.end(`${JSON.stringify({ type: 'result', result: text })}\n`);
  child.stderr.end();
  child.emit('close', 0, null);
}

function request(server, pathname, {
  body,
  headers = { 'X-SCMD-Token': server.token },
  method = 'GET',
} = {}) {
  const bytes = body === undefined
    ? undefined
    : (Buffer.isBuffer(body) ? body : Buffer.from(body));
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = http.request(new URL(pathname, server.url), {
      method,
      headers: {
        ...headers,
        ...(bytes ? { 'Content-Length': bytes.length } : {}),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        body: responseBody,
        json: response.headers['content-type']?.startsWith('application/json')
          ? JSON.parse(responseBody)
          : undefined,
      }));
    });
    outgoing.once('error', rejectRequest);
    if (bytes) outgoing.write(bytes);
    outgoing.end();
  });
}

async function makeFakeClaude(t, behavior) {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-fake-claude-'));
  const executable = join(directory, 'claude');
  const logPath = join(directory, 'calls.jsonl');
  const source = [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args: process.argv.slice(2), input, env: { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT, UNRELATED_SETTING: process.env.UNRELATED_SETTING } })}\\n`);",
    behavior,
    "});",
  ].join('\n');
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, executable, logPath };
}

async function waitFor(description, condition, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

async function waitForServerExit(server, timeoutMs) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  await new Promise((resolveExit, rejectExit) => {
    const finish = () => {
      clearTimeout(timeout);
      resolveExit();
    };
    const timeout = setTimeout(() => {
      server.child.removeListener('close', finish);
      rejectExit(new Error('Timed out waiting for the SCMD server to exit.'));
    }, timeoutMs);
    server.child.once('close', finish);
  });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('rewrite proposal validation accepts preserved top-level name and type', () => {
  assert.equal(validateRewriteProposal(VALID_TOP_LEVEL_PROPOSAL, {
    name: 'Keep this name',
    type: 'project',
  }), true);
});

test('rewrite proposal validation accepts quoted scalars and nested type precedence', () => {
  assert.equal(validateRewriteProposal(VALID_NESTED_PROPOSAL, {
    name: 'Keep this name',
    type: 'project',
  }), true);
});

test('rewrite proposal validation rejects missing or unclosed frontmatter', () => {
  const source = { name: 'Keep this name', type: 'project' };

  assert.equal(validateRewriteProposal('No frontmatter\n', source), false);
  assert.equal(validateRewriteProposal('---\nname: Keep this name\ntype: project\n', source), false);
});

test('rewrite proposal validation rejects missing or changed names', () => {
  const source = { name: 'Keep this name', type: 'project' };

  assert.equal(validateRewriteProposal('---\ntype: project\n---\nBody\n', source), false);
  assert.equal(validateRewriteProposal('---\nname: A different name\ntype: project\n---\nBody\n', source), false);
});

test('rewrite proposal validation rejects missing or changed effective types', () => {
  const source = { name: 'Keep this name', type: 'project' };

  assert.equal(validateRewriteProposal('---\nname: Keep this name\n---\nBody\n', source), false);
  assert.equal(validateRewriteProposal('---\nname: Keep this name\ntype: feedback\n---\nBody\n', source), false);
  assert.equal(validateRewriteProposal(
    '---\nname: Keep this name\ntype: project\nmetadata:\n  type: feedback\n---\nBody\n',
    source,
  ), false);
});

test('rewrite prompt explicitly forbids Markdown code fences', () => {
  const prompt = buildRewritePrompt(MEMORY, 'make this shorter');

  assert.match(prompt, /Do not wrap the output in Markdown or code fences\./);
});

test('rewrite sends the full prompt to fast Claude with JSON output arguments', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    return fakeChild((child, input) => {
      call.input = input;
      success(child, 'rewritten memory');
    });
  };

  const text = await runClaudeRewrite(MEMORY, 'make this shorter', {
    spawnImpl,
    env: {
      PATH: '/fake/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'plugin',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_HOST_SESSION_ID: 'parent-session',
      UNRELATED_SETTING: 'preserved',
    },
    capability: { rewriteAvailable: true },
  });

  assert.equal(text, 'rewritten memory');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'claude');
  assert.deepEqual(calls[0].args, [
    '-p',
    '--output-format', 'json',
    '--model', 'haiku',
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.UNRELATED_SETTING, 'preserved');
  assert.equal('CLAUDECODE' in calls[0].options.env, false);
  assert.equal('CLAUDE_CODE_ENTRYPOINT' in calls[0].options.env, false);
  assert.equal('CLAUDE_CODE_CHILD_SESSION' in calls[0].options.env, false);
  assert.equal('CLAUDE_CODE_HOST_SESSION_ID' in calls[0].options.env, false);
  assert.equal(calls[0].input, buildRewritePrompt(MEMORY, 'make this shorter'));
  assert.match(calls[0].input, /Return only the complete new memory file/);
  assert.match(calls[0].input, /Preserve the existing `name` and `type`/);
  assert.match(calls[0].input, /make this shorter/);
  assert.match(calls[0].input, /This is the complete memory body/);
});

test('rewrite retries once without a model after the fast invocation fails', async () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    return fakeChild((child) => {
      if (calls.length === 1) {
        child.stderr.end('fast model is unavailable');
        child.stdout.end();
        child.emit('close', 1, null);
      } else {
        success(child, 'default model result');
      }
    });
  };

  const text = await runClaudeRewrite(MEMORY, 'make this shorter', {
    spawnImpl,
    env: { PATH: '/fake/bin' },
    capability: { rewriteAvailable: true },
  });

  assert.equal(text, 'default model result');
  assert.deepEqual(calls.map(({ args }) => args), [
    ['-p', '--output-format', 'json', '--model', 'haiku'],
    ['-p', '--output-format', 'json'],
  ]);
});

test('rewrite returns a useful local CLI error after both invocations fail', async () => {
  let calls = 0;
  const spawnImpl = () => {
    calls += 1;
    return fakeChild((child) => {
      child.stderr.end(calls === 1
        ? 'fast failed'
        : JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }));
      child.stdout.end();
      child.emit('close', 2, null);
    });
  };

  await assert.rejects(
    runClaudeRewrite(MEMORY, 'make this shorter', {
      spawnImpl,
      env: { PATH: '/fake/bin' },
      capability: { rewriteAvailable: true },
    }),
    (error) => {
      assert.equal(error.code, 'rewrite-failed');
      assert.equal(
        error.message,
        'Claude Code rewrite failed: Not logged in · Please run /login',
      );
      return true;
    },
  );
  assert.equal(calls, 2);
});

test('rewrite enforces its timeout and terminates the child', async () => {
  const children = [];
  const spawnImpl = () => {
    const child = fakeChild(() => {});
    children.push(child);
    return child;
  };

  await assert.rejects(
    runClaudeRewrite(MEMORY, 'make this shorter', {
      spawnImpl,
      env: { PATH: '/fake/bin' },
      capability: { rewriteAvailable: true },
      timeoutMs: 20,
    }),
    (error) => {
      assert.equal(error.code, 'rewrite-timeout');
      assert.match(error.message, /timed out/i);
      return true;
    },
  );
  assert.equal(children.length, 1);
  assert.equal(children[0].killedWith, 'SIGKILL');
});

test('ENOENT disables rewrite for the session and later calls do not spawn', async () => {
  let calls = 0;
  const capability = { rewriteAvailable: true };
  const spawnImpl = () => {
    calls += 1;
    const child = fakeChild(() => {});
    queueMicrotask(() => {
      const error = new Error('spawn claude ENOENT');
      error.code = 'ENOENT';
      child.emit('error', error);
    });
    return child;
  };

  await assert.rejects(
    runClaudeRewrite(MEMORY, 'make this shorter', {
      spawnImpl,
      env: { PATH: '/fake/bin' },
      capability,
    }),
    { code: 'rewrite-unavailable' },
  );
  assert.equal(capability.rewriteAvailable, false);

  await assert.rejects(
    runClaudeRewrite(MEMORY, 'try again', {
      spawnImpl,
      env: { PATH: '/fake/bin' },
      capability,
    }),
    { code: 'rewrite-unavailable' },
  );
  assert.equal(calls, 1);
});

test('POST /api/rewrite returns Claude text and retries without the fast model', async (t) => {
  const fake = await makeFakeClaude(t, [
    "  if (process.argv.includes('--model')) {",
    "    process.stderr.write('fast model unavailable\\n');",
    "    process.exitCode = 1;",
    "    return;",
    "  }",
    `  process.stdout.write(JSON.stringify({ type: 'result', result: ${JSON.stringify(VALID_TOP_LEVEL_PROPOSAL.replace('Keep this name', 'Keep the API contract small'))} }));`,
  ].join('\n'));
  const server = await startServer(t, {
    env: {
      ...process.env,
      PATH: `${fake.directory}${delimiter}${process.env.PATH || ''}`,
      FAKE_CLAUDE_LOG: fake.logPath,
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'plugin',
      UNRELATED_SETTING: 'preserved',
    },
  });

  const status = await request(server, '/api/status');
  const source = await readFile(join(
    server.root,
    '-Users-example-api-server',
    'memory',
    'api_contract.md',
  ), 'utf8');
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { rewriteAvailable: true });

  const response = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: FIXTURE_ID, instruction: 'make this shorter' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    before: source,
    text: VALID_TOP_LEVEL_PROPOSAL.replace('Keep this name', 'Keep the API contract small'),
    valid: true,
  });

  const calls = (await readFile(fake.logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls.map(({ args }) => args), [
    ['-p', '--output-format', 'json', '--model', 'haiku'],
    ['-p', '--output-format', 'json'],
  ]);
  assert.equal(calls[0].input, calls[1].input);
  assert.match(calls[0].input, /make this shorter/);
  assert.match(calls[0].input, /Prefer a compact request shape/);
  assert.deepEqual(calls[0].env, { UNRELATED_SETTING: 'preserved' });
});

test('POST /api/rewrite reports an unusable proposal and returns its exact raw text', async (t) => {
  const rawText = 'not frontmatter\n/private/secret/memory.md\n';
  const fake = await makeFakeClaude(
    t,
    `  process.stdout.write(JSON.stringify({ type: 'result', result: ${JSON.stringify(rawText)} }));`,
  );
  const server = await startServer(t, {
    env: {
      ...process.env,
      PATH: `${fake.directory}${delimiter}${process.env.PATH || ''}`,
      FAKE_CLAUDE_LOG: fake.logPath,
    },
  });

  const response = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: FIXTURE_ID, instruction: 'make this shorter' }),
  });
  const source = await readFile(join(
    server.root,
    '-Users-example-api-server',
    'memory',
    'api_contract.md',
  ), 'utf8');

  assert.equal(response.status, 200);
  assert.deepEqual(response.json, {
    before: source,
    text: rawText,
    valid: false,
    reason: 'proposal-could-not-be-used',
    message: 'The proposal could not be used.',
  });
  assert.equal(response.json.text, rawText);
  assert.doesNotMatch(response.json.message, /private|memory\.md|fixtures|projects/i);
});

test('POST /api/rewrite validates proposals against staged name and type instead of disk metadata', async (t) => {
  const staged = `---
name: Hand-edited API memory
description: Staged summary.
metadata:
  type: feedback
---

Staged body sentinel.
`;
  const preservedProposal = staged.replace('Staged summary.', 'Rewritten staged summary.');
  const revertedProposal = `---
name: Keep the API contract small
description: Reverted identity.
type: project
---

Staged body sentinel.
`;
  const fake = await makeFakeClaude(
    t,
    [
      `  const preserved = ${JSON.stringify(preservedProposal)};`,
      `  const reverted = ${JSON.stringify(revertedProposal)};`,
      "  const result = input.includes('preserve staged identity') ? preserved : reverted;",
      "  process.stdout.write(JSON.stringify({ type: 'result', result }));",
    ].join('\n'),
  );
  const server = await startServer(t, {
    env: {
      ...process.env,
      PATH: `${fake.directory}${delimiter}${process.env.PATH || ''}`,
      FAKE_CLAUDE_LOG: fake.logPath,
    },
  });

  const preserved = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({
      id: FIXTURE_ID,
      instruction: 'preserve staged identity',
      content: staged,
    }),
  });
  const reverted = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({
      id: FIXTURE_ID,
      instruction: 'revert to disk identity',
      content: staged,
    }),
  });

  assert.equal(preserved.status, 200);
  assert.deepEqual(preserved.json, {
    before: staged,
    text: preservedProposal,
    valid: true,
  });
  assert.equal(reverted.status, 200);
  assert.deepEqual(reverted.json, {
    before: staged,
    text: revertedProposal,
    valid: false,
    reason: 'proposal-could-not-be-used',
    message: 'The proposal could not be used.',
  });
  const calls = (await readFile(fake.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.input, /Hand-edited API memory/);
    assert.match(call.input, /Staged body sentinel/);
    assert.doesNotMatch(call.input, /Prefer a compact request shape/);
  }
});

test('GET /api/memory returns exact source only for an authenticated scanned opaque id', async (t) => {
  const server = await startServer(t);
  const memoryPath = join(
    server.root,
    '-Users-example-api-server',
    'memory',
    'api_contract.md',
  );
  const exact = await readFile(memoryPath, 'utf8');

  const response = await request(
    server,
    `/api/memory/${encodeURIComponent(FIXTURE_ID)}`,
  );
  const missingToken = await request(
    server,
    `/api/memory/${encodeURIComponent(FIXTURE_ID)}`,
    { headers: {} },
  );
  const traversal = await request(
    server,
    `/api/memory/${encodeURIComponent('../../server.js')}`,
  );

  assert.equal(response.status, 200);
  assert.equal(response.json.id, FIXTURE_ID);
  assert.equal(response.json.content, exact);
  assert.equal(missingToken.status, 401);
  assert.equal(traversal.status, 404);
  assert.doesNotMatch(traversal.body, /server\.js|fixtures|projects/i);
});

test('PATH without claude makes authenticated status unavailable', async (t) => {
  const server = await startServer(t, { env: { ...process.env, PATH: '/usr/bin' } });

  const response = await request(server, '/api/status');
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { rewriteAvailable: false });
});

test('rewrite routes preserve Host and token checks', async (t) => {
  const server = await startServer(t, { env: { ...process.env, PATH: '/usr/bin' } });

  const missingToken = await request(server, '/api/status', { headers: {} });
  const foreignHost = await request(server, '/api/rewrite', {
    method: 'POST',
    headers: { Host: 'attacker.example', 'X-SCMD-Token': server.token },
    body: JSON.stringify({ id: FIXTURE_ID, instruction: 'shorten' }),
  });
  assert.equal(missingToken.status, 401);
  assert.equal(foreignHost.status, 403);
});

test('POST /api/rewrite rejects malformed, invalid, and oversized bodies', async (t) => {
  const server = await startServer(t, { env: { ...process.env, PATH: '/usr/bin' } });

  const malformed = await request(server, '/api/rewrite', {
    method: 'POST',
    body: '{',
  });
  const invalid = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: FIXTURE_ID, instruction: '' }),
  });
  const invalidContent = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: FIXTURE_ID, instruction: 'shorten', content: 42 }),
  });
  const oversizedContent = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({
      id: FIXTURE_ID,
      instruction: 'shorten',
      content: 'x'.repeat(600 * 1024),
    }),
  });
  const oversized = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: FIXTURE_ID, instruction: 'x'.repeat(1024 * 1024) }),
  });

  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.error.code, 'invalid-json');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'invalid-request');
  assert.equal(invalidContent.status, 400);
  assert.equal(invalidContent.json.error.code, 'invalid-request');
  assert.equal(oversizedContent.status, 413);
  assert.equal(oversizedContent.json.error.code, 'rewrite-content-too-large');
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json.error.code, 'request-too-large');
});

test('POST /api/rewrite rejects an unknown opaque id without exposing a path', async (t) => {
  const server = await startServer(t, { env: { ...process.env, PATH: '/usr/bin' } });

  const response = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: '../../etc/passwd', instruction: 'shorten' }),
  });

  assert.equal(response.status, 404);
  assert.equal(response.json.error.code, 'unknown-id');
  assert.doesNotMatch(response.body, /etc\/passwd|fixtures\/projects/);
});

test('an ENOENT during rewrite switches status off for the server session', async (t) => {
  const fake = await makeFakeClaude(t, "  process.stdout.write(JSON.stringify({ result: 'unused' }));");
  const server = await startServer(t, {
    env: {
      ...process.env,
      PATH: fake.directory,
      FAKE_CLAUDE_LOG: fake.logPath,
    },
  });
  assert.deepEqual((await request(server, '/api/status')).json, { rewriteAvailable: true });
  await unlink(fake.executable);

  const first = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: FIXTURE_ID, instruction: 'shorten' }),
  });
  const status = await request(server, '/api/status');
  const second = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: FIXTURE_ID, instruction: 'shorten again' }),
  });

  assert.equal(first.status, 503);
  assert.equal(first.json.error.code, 'rewrite-unavailable');
  assert.deepEqual(status.json, { rewriteAvailable: false });
  assert.equal(second.status, 503);
  assert.equal(second.json.error.code, 'rewrite-unavailable');
});

test('quit terminates an active Claude rewrite before the server exits', async (t) => {
  const fake = await makeFakeClaude(t, [
    "  fs.writeFileSync(process.env.FAKE_CLAUDE_PID, String(process.pid));",
    "  setInterval(() => {}, 1000);",
  ].join('\n'));
  const pidPath = join(fake.directory, 'pid');
  let claudePid;
  t.after(() => {
    if (claudePid && processIsAlive(claudePid)) process.kill(claudePid, 'SIGKILL');
  });
  const server = await startServer(t, {
    env: {
      ...process.env,
      PATH: fake.directory,
      FAKE_CLAUDE_LOG: fake.logPath,
      FAKE_CLAUDE_PID: pidPath,
    },
  });

  const rewriting = request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: FIXTURE_ID, instruction: 'hang' }),
  }).catch((error) => error);
  await waitFor('the fake Claude process to start', async () => {
    try {
      claudePid = Number(await readFile(pidPath, 'utf8'));
      return Number.isInteger(claudePid) && claudePid > 0;
    } catch {
      return false;
    }
  });

  const quit = await request(server, '/api/quit', { method: 'POST' });
  assert.equal(quit.status, 200);
  await waitForServerExit(server, 2_000);
  await waitFor('the fake Claude process to stop', () => !processIsAlive(claudePid));
  await rewriting;
});

test('the no-client heartbeat terminates an active Claude rewrite on schedule', async (t) => {
  const fake = await makeFakeClaude(t, [
    "  fs.writeFileSync(process.env.FAKE_CLAUDE_PID, String(process.pid));",
    "  setInterval(() => {}, 1000);",
  ].join('\n'));
  const pidPath = join(fake.directory, 'pid');
  let claudePid;
  t.after(() => {
    if (claudePid && processIsAlive(claudePid)) process.kill(claudePid, 'SIGKILL');
  });
  const server = await startServer(t, {
    env: {
      ...process.env,
      PATH: fake.directory,
      FAKE_CLAUDE_LOG: fake.logPath,
      FAKE_CLAUDE_PID: pidPath,
    },
  });

  const rewriting = request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: FIXTURE_ID, instruction: 'hang' }),
  }).catch((error) => error);
  await waitFor('the fake Claude process to start', async () => {
    try {
      claudePid = Number(await readFile(pidPath, 'utf8'));
      return Number.isInteger(claudePid) && claudePid > 0;
    } catch {
      return false;
    }
  });

  await waitForServerExit(server, 12_000);
  await waitFor('the fake Claude process to stop', () => !processIsAlive(claudePid));
  await rewriting;
});

test('Windows command shims use a concrete cmd.exe launch without putting the prompt in arguments', async () => {
  const environment = {
    PATH: 'C:\\Tools;C:\\Other',
    PATHEXT: '.EXE;.CMD;.BAT',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  };
  const launch = resolveClaudeLaunch(environment, {
    platform: 'win32',
    isExecutable: (candidate) => candidate === 'C:\\Tools\\claude.CMD',
  });
  assert.deepEqual(launch, {
    command: 'C:\\Windows\\System32\\cmd.exe',
    argsPrefix: ['/d', '/s', '/c', 'C:\\Tools\\claude.CMD'],
    shimPath: 'C:\\Tools\\claude.CMD',
    treeKillCommand: 'C:\\Windows\\System32\\taskkill.exe',
  });

  const calls = [];
  const text = await runClaudeRewrite(MEMORY, 'instruction stays on stdin', {
    spawnImpl(command, args, options) {
      const call = { command, args, options };
      calls.push(call);
      return fakeChild((child, input) => {
        call.input = input;
        success(child, 'windows result');
      });
    },
    env: environment,
    capability: { rewriteAvailable: true, launch },
    isExecutable: () => true,
  });

  assert.equal(text, 'windows result');
  assert.equal(calls[0].command, environment.ComSpec);
  assert.deepEqual(calls[0].args.slice(0, 4), launch.argsPrefix);
  assert.equal(calls[0].args.some((argument) => argument.includes('instruction stays')), false);
  assert.match(calls[0].input, /instruction stays on stdin/);
  assert.equal(calls[0].options.shell, false);
});

test('POSIX capability resolution keeps a direct executable launch', () => {
  const launch = resolveClaudeLaunch({ PATH: '/first:/second' }, {
    platform: 'linux',
    isExecutable: (candidate) => candidate === '/second/claude',
  });
  assert.deepEqual(launch, {
    command: '/second/claude',
    argsPrefix: [],
    shimPath: '/second/claude',
  });
});

test('Windows termination kills the complete cmd shim tree with direct safe arguments', () => {
  const launch = {
    command: 'C:\\Windows\\System32\\cmd.exe',
    argsPrefix: ['/d', '/s', '/c', 'C:\\Tools\\claude.cmd'],
    shimPath: 'C:\\Tools\\claude.cmd',
    treeKillCommand: 'C:\\Windows\\System32\\taskkill.exe',
  };
  const calls = [];
  const child = {
    pid: 4321,
    kill() {
      assert.fail('child.kill fallback should not run after successful taskkill');
    },
  };

  terminateClaudeChild(child, launch, {
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [{
    command: 'C:\\Windows\\System32\\taskkill.exe',
    args: ['/PID', '4321', '/T', '/F'],
    options: { shell: false, stdio: 'ignore', windowsHide: true },
  }]);
});

test('Windows tree-kill failure and POSIX termination fall back to direct SIGKILL', () => {
  const signals = [];
  const child = { pid: 4321, kill: (signal) => signals.push(signal) };
  terminateClaudeChild(child, { treeKillCommand: 'taskkill.exe' }, {
    spawnSyncImpl: () => ({ status: 1 }),
  });
  terminateClaudeChild(child, { command: '/opt/bin/claude', argsPrefix: [] }, {
    spawnSyncImpl: () => assert.fail('POSIX termination must not invoke taskkill'),
  });
  assert.deepEqual(signals, ['SIGKILL', 'SIGKILL']);
});

test('Windows timeout, output overflow, and stdin failure all use tree termination', async () => {
  const launch = {
    command: 'C:\\Windows\\System32\\cmd.exe',
    argsPrefix: ['/d', '/s', '/c', 'C:\\Tools\\claude.cmd'],
    shimPath: 'C:\\Tools\\claude.cmd',
    treeKillCommand: 'C:\\Windows\\System32\\taskkill.exe',
  };

  for (const failure of ['timeout', 'output', 'stdin']) {
    const taskkills = [];
    let nextPid = 5000;
    const spawnImpl = () => {
      let child;
      if (failure === 'stdin') {
        child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new EventEmitter();
        child.stdin.end = () => queueMicrotask(() => (
          child.stdin.emit('error', new Error('stdin broke'))
        ));
      } else {
        child = fakeChild((startedChild) => {
          if (failure === 'output') startedChild.stdout.write('x'.repeat(33));
        });
      }
      child.pid = nextPid;
      nextPid += 1;
      child.kill = () => assert.fail('successful taskkill must avoid direct-child fallback');
      return child;
    };

    await assert.rejects(
      runClaudeRewrite(MEMORY, 'shorten', {
        capability: { rewriteAvailable: true, launch },
        env: { PATH: 'C:\\Tools' },
        isExecutable: () => true,
        maxOutputBytes: 32,
        spawnImpl,
        spawnSyncImpl(command, args, options) {
          taskkills.push({ command, args, options });
          return { status: 0 };
        },
        timeoutMs: failure === 'timeout' ? 5 : 100,
      }),
      { code: failure === 'timeout' ? 'rewrite-timeout' : (
        failure === 'output' ? 'rewrite-output-too-large' : 'rewrite-failed'
      ) },
    );

    assert.equal(taskkills.length, failure === 'timeout' ? 1 : 2);
    for (const [index, call] of taskkills.entries()) {
      assert.deepEqual(call, {
        command: launch.treeKillCommand,
        args: ['/PID', String(5000 + index), '/T', '/F'],
        options: { shell: false, stdio: 'ignore', windowsHide: true },
      });
    }
  }
});

test('Windows shutdown sweep tree-kills every tracked rewrite child', () => {
  const launch = { treeKillCommand: 'C:\\Windows\\System32\\taskkill.exe' };
  const children = new Set([
    { pid: 7001, kill: () => assert.fail('taskkill should handle the first tree') },
    { pid: 7002, kill: () => assert.fail('taskkill should handle the second tree') },
  ]);
  const calls = [];

  terminateActiveRewrites(children, launch, {
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });

  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
    { command: launch.treeKillCommand, args: ['/PID', '7001', '/T', '/F'] },
    { command: launch.treeKillCommand, args: ['/PID', '7002', '/T', '/F'] },
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test('a missing detected Windows shim disables rewrite before spawn', async () => {
  const capability = {
    rewriteAvailable: true,
    launch: {
      command: 'C:\\Windows\\System32\\cmd.exe',
      argsPrefix: ['/d', '/s', '/c', 'C:\\Tools\\claude.cmd'],
      shimPath: 'C:\\Tools\\claude.cmd',
      treeKillCommand: 'C:\\Windows\\System32\\taskkill.exe',
    },
  };
  let spawns = 0;

  await assert.rejects(
    runClaudeRewrite(MEMORY, 'shorten', {
      capability,
      env: { PATH: 'C:\\Tools' },
      isExecutable: () => false,
      spawnImpl: () => {
        spawns += 1;
        throw new Error('spawn must not run for a missing shim');
      },
    }),
    { code: 'rewrite-unavailable' },
  );
  assert.equal(spawns, 0);
  assert.equal(capability.rewriteAvailable, false);
});

test('a Windows shim removed during a failed invocation disables rewrite without retry', async () => {
  let shimExists = true;
  let spawns = 0;
  const capability = {
    rewriteAvailable: true,
    launch: {
      command: 'C:\\Windows\\System32\\cmd.exe',
      argsPrefix: ['/d', '/s', '/c', 'C:\\Tools\\claude.cmd'],
      shimPath: 'C:\\Tools\\claude.cmd',
      treeKillCommand: 'C:\\Windows\\System32\\taskkill.exe',
    },
  };

  await assert.rejects(
    runClaudeRewrite(MEMORY, 'shorten', {
      capability,
      env: { PATH: 'C:\\Tools' },
      isExecutable: () => shimExists,
      spawnImpl: () => {
        spawns += 1;
        return fakeChild((child) => {
          shimExists = false;
          child.stderr.end('cmd could not find the shim');
          child.stdout.end();
          child.emit('close', 1, null);
        });
      },
    }),
    { code: 'rewrite-unavailable' },
  );
  assert.equal(spawns, 1);
  assert.equal(capability.rewriteAvailable, false);
});

test('fast and fallback attempts share one total rewrite timeout budget', async () => {
  let clock = 0;
  const children = [];
  const startedAt = Date.now();
  const spawnImpl = () => {
    const child = fakeChild((startedChild) => {
      if (children.length === 1) {
        clock = 35;
        startedChild.stderr.end('fast failed');
        startedChild.stdout.end();
        startedChild.emit('close', 1, null);
      }
    });
    children.push(child);
    return child;
  };

  await assert.rejects(
    runClaudeRewrite(MEMORY, 'shorten', {
      spawnImpl,
      env: { PATH: '/fake/bin' },
      capability: { rewriteAvailable: true },
      timeoutMs: 40,
      nowImpl: () => clock,
    }),
    { code: 'rewrite-timeout' },
  );

  assert.equal(children.length, 2);
  assert.equal(children[1].killedWith, 'SIGKILL');
  assert.ok(Date.now() - startedAt < 25, 'fallback exceeded the remaining total budget');
});

test('rewrite kills the child when stdout or stderr exceeds the capture limit', async () => {
  for (const streamName of ['stdout', 'stderr']) {
    let child;
    await assert.rejects(
      runClaudeRewrite(MEMORY, 'shorten', {
        spawnImpl() {
          child = fakeChild((startedChild) => {
            startedChild[streamName].write('x'.repeat(33));
          });
          return child;
        },
        env: { PATH: '/fake/bin' },
        capability: { rewriteAvailable: true },
        maxOutputBytes: 32,
        timeoutMs: 100,
      }),
      { code: 'rewrite-output-too-large' },
    );
    assert.equal(child.killedWith, 'SIGKILL');
  }
});

test('stdin errors kill each attempted child and release them after close', async () => {
  const activeChildren = new Set();
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.killCount = 0;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.stdin.end = () => queueMicrotask(() => child.stdin.emit('error', new Error('stdin broke')));
    child.kill = (signal) => {
      child.killCount += 1;
      child.killedWith = signal;
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    children.push(child);
    return child;
  };

  await assert.rejects(
    runClaudeRewrite(MEMORY, 'shorten', {
      spawnImpl,
      env: { PATH: '/fake/bin' },
      capability: { rewriteAvailable: true },
      activeChildren,
      timeoutMs: 100,
    }),
    (error) => {
      assert.equal(error.code, 'rewrite-failed');
      assert.match(error.message, /stdin broke/);
      return true;
    },
  );

  assert.equal(children.length, 2);
  assert.deepEqual(children.map((child) => child.killedWith), ['SIGKILL', 'SIGKILL']);
  assert.deepEqual(children.map((child) => child.killCount), [1, 1]);
  assert.equal(activeChildren.size, 0);
});

test('changed-since-read maps to a stable path-free HTTP 409', () => {
  const error = new Error('Memory changed at /private/secret/memory.md');
  error.code = 'changed-since-read';

  assert.deepEqual(rewriteHttpError(error), {
    statusCode: 409,
    body: {
      error: {
        code: 'changed-since-read',
        message: 'Memory changed since it was read.',
      },
    },
  });
});

test('POST /api/rewrite returns path-free 409 when the memory changes during reread', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'scmd-rewrite-race-'));
  const root = join(sandbox, 'projects');
  const stateDir = join(sandbox, 'state');
  const memoryPath = join(root, 'project', 'memory', 'memory.md');
  const preloadPath = join(sandbox, 'rewrite-race-preload.js');
  await mkdir(join(root, 'project', 'memory'), { recursive: true });
  await writeFile(memoryPath, MEMORY);
  await writeFile(preloadPath, `
const fs = require('node:fs');
const originalOpen = fs.promises.open.bind(fs.promises);
let targetOpens = 0;
fs.promises.open = async (file, ...args) => {
  if (String(file) === process.env.SCMD_RACE_FILE) {
    targetOpens += 1;
    if (targetOpens === 2) fs.appendFileSync(file, '\\nchanged during rewrite\\n');
  }
  return originalOpen(file, ...args);
};
`);
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const server = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
    env: {
      ...process.env,
      PATH: '/usr/bin',
      SCMD_RACE_FILE: memoryPath,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(' '),
    },
  });

  const response = await request(server, '/api/rewrite', {
    method: 'POST',
    body: JSON.stringify({ id: 'project/memory.md', instruction: 'shorten' }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(response.json, {
    error: {
      code: 'changed-since-read',
      message: 'Memory changed since it was read.',
    },
  });
  assert.doesNotMatch(response.body, /scmd-rewrite-race|memory\.md/);
});
