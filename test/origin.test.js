const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const serverModule = require('../server');
const { startServer } = require('./server-helper');

const FIXTURE_ROOT = resolve(__dirname, '..', 'fixtures', 'projects');
const FIXTURE_PROJECT = '-Users-example-my-side-project';
const FIXTURE_MEMORY = 'project_context.md';
const FIXTURE_ID = `${FIXTURE_PROJECT}/${FIXTURE_MEMORY}`;
const FETCH_TIMEOUT_MS = 5_000;

function record(type, message, timestamp) {
  return JSON.stringify({ type, message, timestamp });
}

function textUser(text, timestamp = '2026-09-18T08:01:00.000Z') {
  return record('user', {
    role: 'user',
    content: [{ type: 'text', text }],
  }, timestamp);
}

function toolResult(timestamp = '2026-09-18T08:01:05.000Z') {
  return record('user', {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_write', content: 'done' }],
  }, timestamp);
}

function writeCall(filePath, timestamp = '2026-09-18T08:01:10.000Z') {
  return record('assistant', {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_write',
      name: 'Write',
      input: { file_path: filePath, content: 'memory text' },
    }],
  }, timestamp);
}

function editCall(filePath, timestamp = '2026-09-18T08:01:10.000Z') {
  return record('assistant', {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_edit',
      name: 'Edit',
      input: { file_path: filePath, old_string: 'old', new_string: 'new' },
    }],
  }, timestamp);
}

function noWriteAssistant(timestamp = '2026-09-18T08:01:10.000Z') {
  return record('assistant', {
    role: 'assistant',
    content: [{ type: 'text', text: 'No memory write in this turn.' }],
  }, timestamp);
}

function lines(...values) {
  return `${values.join('\n')}\n`;
}

async function request(server, pathname, options = {}) {
  const token = Object.prototype.hasOwnProperty.call(options, 'token')
    ? options.token
    : server.token;
  const { host } = options;
  const url = new URL(pathname, server.url);
  const headers = {};
  if (token !== undefined) headers['X-SCMD-Token'] = token;
  if (host !== undefined) headers.Host = host;

  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = http.request(url, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        headers: response.headers,
        body,
      }));
    });
    outgoing.once('error', rejectRequest);
    outgoing.setTimeout(options.timeoutMs || FETCH_TIMEOUT_MS, () => {
      outgoing.destroy(new Error('origin request timed out'));
    });
    outgoing.end();
  });
}

function originPath(id) {
  return `/api/origin/${encodeURIComponent(id)}`;
}

async function createRoot(t) {
  const sandbox = await mkdtemp(join(tmpdir(), 'scmd-origin-'));
  const root = join(sandbox, 'projects');
  await mkdir(root);
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return root;
}

async function addMemory(root, {
  projectId = 'target-project',
  fileName = 'note.md',
  originSessionId,
} = {}) {
  const projectPath = join(root, projectId);
  const memoryPath = join(projectPath, 'memory');
  const frontmatter = [
    '---',
    'name: Origin test',
    'description: Origin lookup fixture.',
    ...(originSessionId ? [`originSessionId: ${originSessionId}`] : []),
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
  await mkdir(memoryPath, { recursive: true });
  await writeFile(join(memoryPath, fileName), frontmatter);
  return {
    projectId,
    fileName,
    filePath: join(memoryPath, fileName),
    card: {
      id: `${projectId}/${fileName}`,
      projectId,
      fileName,
      ...(originSessionId ? { originSessionId } : {}),
    },
  };
}

async function addTranscript(root, projectId, sessionId, content, mtime) {
  const projectPath = join(root, projectId);
  await mkdir(projectPath, { recursive: true });
  const transcriptPath = join(projectPath, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, content);
  if (mtime) await utimes(transcriptPath, mtime, mtime);
  return transcriptPath;
}

async function findOrigin(root, target, options) {
  assert.equal(
    typeof serverModule.findMemoryOrigin,
    'function',
    'server.js must export findMemoryOrigin(root, target, options) for bounded origin lookup',
  );
  return serverModule.findMemoryOrigin(root, target, options);
}

async function resolveOriginTarget(root, id, options) {
  assert.equal(
    typeof serverModule.resolveOriginTarget,
    'function',
    'server.js must export the bounded opaque-id origin target resolver',
  );
  return serverModule.resolveOriginTarget(root, id, options);
}

function assertFound(result, message, date) {
  assert.equal(result.status, 'found');
  assert.equal(result.message, message);
  assert.equal(result.date, date);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'path'), false);
}

function assertNotFound(result, reason) {
  assert.equal(result.status, 'not-found');
  assert.equal(result.reason, reason);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'path'), false);
}

test('GET /api/origin/:id returns the planted fixture message and message date without changing the transcript', async (t) => {
  const transcriptPath = join(FIXTURE_ROOT, FIXTURE_PROJECT, 'session-demo-001.jsonl');
  const beforeBytes = await readFile(transcriptPath);
  const beforeStats = await stat(transcriptPath);
  const server = await startServer(t);

  const response = await request(server, originPath(FIXTURE_ID));

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^application\/json\b/);
  assertFound(
    JSON.parse(response.body),
    'Please remember the small demo setup and why we review feedback.',
    '2026-09-18T08:01:00.000Z',
  );
  assert.deepEqual(await readFile(transcriptPath), beforeBytes);
  const afterStats = await stat(transcriptPath);
  assert.equal(afterStats.mode, beforeStats.mode);
  assert.equal(afterStats.mtimeMs, beforeStats.mtimeMs);
});

test('the origin route keeps token, Host, and opaque card-id boundaries and returns path-free errors', async (t) => {
  const server = await startServer(t);
  const missingToken = await request(server, originPath(FIXTURE_ID), { token: undefined });
  const foreignHost = await request(server, originPath(FIXTURE_ID), {
    host: 'attacker.example',
  });
  const traversal = await request(server, originPath('../../outside/secret.md'));

  assert.equal(missingToken.status, 401);
  assert.equal(foreignHost.status, 403);
  assert.equal(traversal.status, 404);
  assert.match(traversal.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(traversal.body), {
    error: { code: 'unknown-id', message: 'Memory was not found.' },
  });
  assert.doesNotMatch(traversal.body, /outside|secret|\.jsonl|fixtures|projects/i);
});

test('the origin route does not read an unrelated transcript that would stall project discovery', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root, {
    projectId: 'a-target-project',
    originSessionId: 'session-target',
  });
  await addTranscript(root, target.projectId, 'session-target', lines(
    textUser('Only the target transcript should be opened.', '2026-09-20T09:00:00.000Z'),
    writeCall(`/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`),
  ));
  await addMemory(root, { projectId: 'z-unrelated-project', fileName: 'unrelated.md' });
  await addTranscript(
    root,
    'z-unrelated-project',
    'stalled-discovery',
    Buffer.alloc(32 * 1024 * 1024, 0x0a),
  );
  const server = await startServer(t, {
    serverArgs: ['--root', root, '--port', '0', '--no-open'],
  });

  const response = await request(server, originPath(target.card.id), { timeoutMs: 1_000 });

  assert.equal(response.status, 200);
  assertFound(
    JSON.parse(response.body),
    'Only the target transcript should be opened.',
    '2026-09-20T09:00:00.000Z',
  );
});

test('the no-follow fallback rejects a target swapped to an outside symlink before file validation', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root, { originSessionId: 'safe-session' });
  const outsidePath = join(root, '..', 'outside-before-open.md');
  await writeFile(outsidePath, lines(
    '---',
    'name: Outside',
    'description: Must not be trusted.',
    'originSessionId: outside-session',
    '---',
  ));
  const nativeFs = require('node:fs').promises;
  let swapped = false;
  const fsPromises = {
    ...nativeFs,
    async lstat(candidatePath, options) {
      if (candidatePath === target.filePath && !swapped) {
        swapped = true;
        await unlink(target.filePath);
        await symlink(outsidePath, target.filePath);
      }
      return nativeFs.lstat(candidatePath, options);
    },
  };

  const resolvedTarget = await resolveOriginTarget(root, target.card.id, {
    fsPromises,
    noFollowFlag: 0,
  });

  assert.equal(swapped, true);
  assert.equal(resolvedTarget, undefined);
});

test('the no-follow fallback rejects a target swapped to an outside symlink during open', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root, { originSessionId: 'safe-session' });
  const outsidePath = join(root, '..', 'outside-during-open.md');
  await writeFile(outsidePath, lines(
    '---',
    'name: Outside',
    'description: Must not be trusted.',
    'originSessionId: outside-session',
    '---',
  ));
  const nativeFs = require('node:fs').promises;
  let swapped = false;
  const fsPromises = {
    ...nativeFs,
    async open(candidatePath, flags, mode) {
      if (candidatePath === target.filePath && !swapped) {
        swapped = true;
        await unlink(target.filePath);
        await symlink(outsidePath, target.filePath);
      }
      return nativeFs.open(candidatePath, flags, mode);
    },
  };

  const resolvedTarget = await resolveOriginTarget(root, target.card.id, {
    fsPromises,
    noFollowFlag: 0,
  });

  assert.equal(swapped, true);
  assert.equal(resolvedTarget, undefined);
});

test('origin lookup exposes the 64 MiB, ten-second, and newest-twenty production bounds', () => {
  assert.deepEqual(serverModule.ORIGIN_LIMITS, {
    maxBytes: 64 * 1024 * 1024,
    timeoutMs: 10_000,
    maxTranscripts: 20,
  });
});

test('origin parsing skips malformed JSON and tool-result user records when choosing the nearest preceding text user message', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root, { originSessionId: 'session-mixed' });
  await addTranscript(root, target.projectId, 'session-mixed', lines(
    textUser('The human request to preserve.'),
    '{malformed json',
    toolResult(),
    writeCall(`/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`),
  ));

  const result = await findOrigin(root, target);

  assertFound(result, 'The human request to preserve.', '2026-09-18T08:01:00.000Z');
});

test('a write matches the complete project memory path rather than another project with the same file name', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root, { originSessionId: 'session-exact' });
  await addTranscript(root, target.projectId, 'session-exact', lines(
    textUser('Wrong project prompt.', '2026-09-18T08:00:00.000Z'),
    writeCall(`/home/me/.claude/projects/other-project/memory/${target.fileName}`),
    textUser('Exact target prompt.', '2026-09-18T08:02:00.000Z'),
    writeCall(`/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`),
  ));

  const result = await findOrigin(root, target);

  assertFound(result, 'Exact target prompt.', '2026-09-18T08:02:00.000Z');
});

test('origin ignores an Edit and attributes the memory to the later Write that created it', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root, { originSessionId: 'session-write-only' });
  const targetPath = `/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`;
  await addTranscript(root, target.projectId, 'session-write-only', lines(
    textUser('This message only caused an edit.', '2026-09-18T08:00:00.000Z'),
    editCall(targetPath),
    textUser('This message caused the original write.', '2026-09-18T08:02:00.000Z'),
    writeCall(targetPath),
  ));

  assertFound(
    await findOrigin(root, target),
    'This message caused the original write.',
    '2026-09-18T08:02:00.000Z',
  );
});

test('a recorded origin session falls back across project folders', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root, {
    projectId: 'original-project',
    originSessionId: 'session-resumed',
  });
  await addMemory(root, { projectId: 'resumed-project', fileName: 'other.md' });
  await addTranscript(root, 'resumed-project', 'session-resumed', lines(
    textUser('Resume this work from the other folder.', '2026-09-19T09:30:00.000Z'),
    writeCall(`/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`),
  ));

  const result = await findOrigin(root, target);

  assertFound(
    result,
    'Resume this work from the other folder.',
    '2026-09-19T09:30:00.000Z',
  );
});

test('a memory without a session id scans only the project newest twenty transcripts', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root);
  const base = Date.parse('2026-09-01T00:00:00.000Z');

  for (let index = 1; index <= 21; index += 1) {
    const content = index === 1
      ? lines(
          textUser('Outside the newest twenty.'),
          writeCall(`/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`),
        )
      : lines(textUser(`Session ${index}.`), noWriteAssistant());
    await addTranscript(
      root,
      target.projectId,
      `session-${String(index).padStart(2, '0')}`,
      content,
      new Date(base + index * 1_000),
    );
  }

  assertNotFound(await findOrigin(root, target), 'write-not-found');

  const twentiethNewest = join(root, target.projectId, 'session-02.jsonl');
  await writeFile(twentiethNewest, lines(
    textUser('Exactly inside the newest twenty.', '2026-09-20T12:00:00.000Z'),
    writeCall(`/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`),
  ));
  await utimes(twentiethNewest, new Date(base + 2_000), new Date(base + 2_000));

  assertFound(
    await findOrigin(root, target),
    'Exactly inside the newest twenty.',
    '2026-09-20T12:00:00.000Z',
  );
});

test('not-found results distinguish a missing recorded session from a session with no matching write', async (t) => {
  const root = await createRoot(t);
  const missing = await addMemory(root, {
    projectId: 'missing-session-project',
    originSessionId: 'does-not-exist',
  });
  const noWrite = await addMemory(root, {
    projectId: 'no-write-project',
    originSessionId: 'session-no-write',
  });
  await addTranscript(root, noWrite.projectId, 'session-no-write', lines(
    textUser('A request that did not save this memory.'),
    noWriteAssistant(),
  ));

  assertNotFound(await findOrigin(root, missing), 'session-not-found');
  assertNotFound(await findOrigin(root, noWrite), 'write-not-found');
});

test('the byte budget is cumulative across transcripts and reports transcript-too-large', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root);
  const older = lines(
    textUser('The match is in the older transcript.'),
    writeCall(`/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`),
  );
  const newer = lines(
    textUser('This newer transcript has enough padding to consume budget. '.repeat(3)),
    noWriteAssistant(),
  );
  const olderPath = await addTranscript(root, target.projectId, 'older', older);
  const newerPath = await addTranscript(root, target.projectId, 'newer', newer);
  await utimes(olderPath, new Date('2026-09-18T08:00:00.000Z'), new Date('2026-09-18T08:00:00.000Z'));
  await utimes(newerPath, new Date('2026-09-19T08:00:00.000Z'), new Date('2026-09-19T08:00:00.000Z'));
  const olderUserBytes = Buffer.byteLength(`${textUser('The match is in the older transcript.')}\n`);
  const maxBytes = Buffer.byteLength(newer) + olderUserBytes + 12;

  const result = await findOrigin(root, target, { maxBytes });

  assertNotFound(result, 'transcript-too-large');
});

test('the byte budget returns an early Write match before later transcript padding crosses the cap', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root, { originSessionId: 'session-early-write' });
  const prefix = lines(
    textUser('The write appears before the cap.', '2026-09-20T08:00:00.000Z'),
    writeCall(`/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`),
  );
  await addTranscript(
    root,
    target.projectId,
    'session-early-write',
    `${prefix}${'x'.repeat(4_096)}\n`,
  );

  assertFound(
    await findOrigin(root, target, { maxBytes: Buffer.byteLength(prefix) }),
    'The write appears before the cap.',
    '2026-09-20T08:00:00.000Z',
  );
});

test('the ten-second budget has an injected clock and reports lookup-timed-out deterministically', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root, { originSessionId: 'session-slow' });
  await addTranscript(root, target.projectId, 'session-slow', lines(
    textUser('This would match without the deadline.'),
    writeCall(`/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`),
  ));
  let clockReads = 0;
  const nowImpl = () => {
    clockReads += 1;
    return clockReads === 1 ? 1_000 : 11_001;
  };

  const result = await findOrigin(root, target, { timeoutMs: 10_000, nowImpl });

  assertNotFound(result, 'lookup-timed-out');
  assert.ok(clockReads >= 2, 'lookup must check the injected clock after it starts');
});

test('the hard deadline covers pre-stream filesystem work and observes its late rejection', async (t) => {
  const root = await createRoot(t);
  const target = await addMemory(root, { originSessionId: 'session-delayed-filesystem' });
  let rejectRealpath;
  const fsPromises = {
    ...require('node:fs').promises,
    realpath: () => new Promise((resolveRealpath, reject) => {
      rejectRealpath = reject;
    }),
  };
  let unhandled;
  const onUnhandled = (error) => { unhandled = error; };
  process.once('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));

  const result = await findOrigin(root, target, {
    fsPromises,
    timeoutMs: 10_000,
    setTimeoutImpl(callback) {
      queueMicrotask(callback);
      return Symbol('origin-timeout');
    },
    clearTimeoutImpl() {},
  });

  assertNotFound(result, 'lookup-timed-out');
  rejectRealpath(new Error('late realpath failure'));
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.equal(unhandled, undefined);
});

test('origin lookup succeeds against a read-only transcript and leaves the project tree unchanged', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX read-only mode verification is not available on Windows');
    return;
  }

  const root = await createRoot(t);
  const target = await addMemory(root, { originSessionId: 'session-read-only' });
  const transcriptPath = await addTranscript(root, target.projectId, 'session-read-only', lines(
    textUser('Read this, but never write it.', '2026-09-20T07:00:00.000Z'),
    writeCall(`/home/me/.claude/projects/${target.projectId}/memory/${target.fileName}`),
  ));
  await chmod(transcriptPath, 0o444);
  t.after(() => chmod(transcriptPath, 0o600).catch(() => {}));
  const beforeNames = (await readdir(join(root, target.projectId))).sort();
  const beforeBytes = await readFile(transcriptPath);
  const beforeStats = await stat(transcriptPath);

  const result = await findOrigin(root, target);

  assertFound(result, 'Read this, but never write it.', '2026-09-20T07:00:00.000Z');
  assert.deepEqual((await readdir(join(root, target.projectId))).sort(), beforeNames);
  assert.deepEqual(await readFile(transcriptPath), beforeBytes);
  const afterStats = await stat(transcriptPath);
  assert.equal(afterStats.mode & 0o777, 0o444);
  assert.equal(afterStats.mtimeMs, beforeStats.mtimeMs);
});
