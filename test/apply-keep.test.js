const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http = require('node:http');
const {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');

const { startServer } = require('./server-helper');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function request(server, pathname, {
  body,
  headers = { 'X-SCMD-Token': server.token },
  method = 'GET',
} = {}) {
  const url = new URL(pathname, server.url);
  const requestBody = body === undefined
    ? undefined
    : (Buffer.isBuffer(body) ? body : Buffer.from(body));

  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = http.request(url, {
      method,
      headers: {
        ...headers,
        ...(requestBody ? { 'Content-Length': requestBody.length } : {}),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        body: responseBody,
      }));
    });
    outgoing.once('error', rejectRequest);
    if (requestBody) outgoing.write(requestBody);
    outgoing.end();
  });
}

function postDecisions(server, decisions, options = {}) {
  return request(server, '/api/apply', {
    method: 'POST',
    body: JSON.stringify({ decisions }),
    ...options,
  });
}

async function requestWithoutEnding(server, {
  bodyChunk,
  contentLength,
  token = server.token,
  timeoutMs = 2_000,
} = {}) {
  let outgoing;
  const response = await new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      rejectRequest(error);
    };
    const timeout = setTimeout(() => {
      finishReject(new Error('Timed out waiting for a response before the request body ended.'));
    }, timeoutMs);

    outgoing = http.request(new URL('/api/apply', server.url), {
      method: 'POST',
      headers: {
        'X-SCMD-Token': token,
        ...(contentLength === undefined ? {} : { 'Content-Length': contentLength }),
      },
    }, (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (chunk) => { body += chunk; });
      incoming.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolveRequest({ status: incoming.statusCode, body });
      });
    });
    outgoing.once('error', finishReject);
    outgoing.flushHeaders();
    if (bodyChunk) outgoing.write(bodyChunk);
  }).finally(() => {
    if (outgoing) outgoing.destroy();
  });

  return response;
}

async function makeServer(t, contentsByName = {
  'one.md': '# One\n',
  'two.md': '# Two\n',
}) {
  const root = await mkdtemp(join(tmpdir(), 'scmd-apply-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-apply-state-'));
  const memoryDir = join(root, 'project', 'memory');
  await mkdir(memoryDir, { recursive: true });
  await Promise.all(Object.entries(contentsByName).map(([fileName, contents]) => (
    writeFile(join(memoryDir, fileName), contents)
  )));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const server = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  return { server, root, stateDir, memoryDir };
}

async function cards(server) {
  const response = await request(server, '/api/projects?includeReviewed=1');
  assert.equal(response.status, 200);
  return JSON.parse(response.body).projects.flatMap((project) => project.cards);
}

test('apply keeps an unchanged item while skipping a changed item in input order', async (t) => {
  const { server, stateDir, memoryDir } = await makeServer(t);
  const [one, two] = await cards(server);
  const changedBytes = Buffer.from('# One changed outside SCMD\n');
  const untouchedTwo = await readFile(join(memoryDir, 'two.md'));
  await writeFile(join(memoryDir, 'one.md'), changedBytes);
  const beforeApply = Date.now();

  const response = await postDecisions(server, [
    { id: one.id, action: 'keep', expectedHash: one.hash },
    { id: two.id, action: 'keep', expectedHash: two.hash },
  ]);
  const afterApply = Date.now();

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    results: [
      {
        id: one.id,
        action: 'keep',
        status: 'skipped',
        reason: 'changed-since-read',
      },
      { id: two.id, action: 'keep', status: 'applied' },
    ],
  });

  const history = JSON.parse(await readFile(join(stateDir, 'reviewed.json'), 'utf8'));
  assert.deepEqual(Object.keys(history.entries), [two.hash]);
  assert.equal(history.entries[two.hash].id, two.id);
  const recordedAt = Date.parse(history.entries[two.hash].at);
  assert.ok(recordedAt >= beforeApply && recordedAt <= afterApply);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), changedBytes);
  assert.deepEqual(await readFile(join(memoryDir, 'two.md')), untouchedTwo);
});

test('one apply persists multiple successful keeps in one history document', async (t) => {
  const { server, stateDir, memoryDir } = await makeServer(t, {
    'one.md': Buffer.from('# One\n'),
    'two.md': Buffer.from('# Two\n'),
    'three.md': Buffer.from('# Three\n'),
  });
  const currentCards = await cards(server);
  const before = await Promise.all(currentCards.map((card) => readFile(join(memoryDir, card.fileName))));

  const response = await postDecisions(server, currentCards.map((card) => ({
    id: card.id,
    action: 'keep',
    expectedHash: card.hash,
  })));

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).results, currentCards.map((card) => ({
    id: card.id,
    action: 'keep',
    status: 'applied',
  })));
  const history = JSON.parse(await readFile(join(stateDir, 'reviewed.json'), 'utf8'));
  assert.equal(history.version, 1);
  assert.deepEqual(Object.keys(history.entries).sort(), currentCards.map((card) => card.hash).sort());
  assert.deepEqual(
    await Promise.all(currentCards.map((card) => readFile(join(memoryDir, card.fileName)))),
    before,
  );
  assert.deepEqual(await readdir(stateDir), ['reviewed.json']);
});

test('concurrent applies from separate server processes preserve both keeps', async (t) => {
  const { server: firstServer, root, stateDir } = await makeServer(t);
  const secondServer = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  const [one, two] = await cards(firstServer);
  const entries = {};
  for (let index = 0; index < 5_000; index += 1) {
    entries[index.toString(16).padStart(64, '0')] = {
      at: '2026-09-20T12:00:00.000Z',
      id: `seed/memory-${index}.md`,
    };
  }
  await writeFile(join(stateDir, 'reviewed.json'), `${JSON.stringify({ version: 1, entries })}\n`);

  const [firstResponse, secondResponse] = await Promise.all([
    postDecisions(firstServer, [{ id: one.id, action: 'keep', expectedHash: one.hash }]),
    postDecisions(secondServer, [{ id: two.id, action: 'keep', expectedHash: two.hash }]),
  ]);

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(JSON.parse(firstResponse.body).results[0].status, 'applied');
  assert.equal(JSON.parse(secondResponse.body).results[0].status, 'applied');
  const history = JSON.parse(await readFile(join(stateDir, 'reviewed.json'), 'utf8'));
  assert.equal(Object.keys(history.entries).length, 5_002);
  assert.equal(history.entries[one.hash].id, one.id);
  assert.equal(history.entries[two.hash].id, two.id);
  assert.deepEqual(await readdir(stateDir), ['reviewed.json']);
});

test('opaque unknown ids and path traversal cannot read outside the scanned card set', async (t) => {
  const { server, root, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
  const outsidePath = join(dirname(root), `${basename(root)}-outside.md`);
  const outsideBytes = Buffer.from('private outside bytes\n');
  await writeFile(outsidePath, outsideBytes);
  t.after(() => rm(outsidePath, { force: true }));

  const response = await postDecisions(server, [{
    id: `../../${basename(outsidePath)}`,
    action: 'keep',
    expectedHash: sha256(outsideBytes),
  }]);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    results: [{
      id: `../../${basename(outsidePath)}`,
      action: 'keep',
      status: 'error',
      reason: 'unknown-id',
    }],
  });
  assert.deepEqual(await readFile(outsidePath), outsideBytes);
  assert.deepEqual(await readdir(stateDir), []);
  assert.equal(response.body.includes(outsidePath), false);
});

test('apply rejects invalid JSON and top-level schemas with stable path-free errors', async (t) => {
  const { server, root, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
  const cases = [
    ['{not json', 400, 'invalid-json'],
    ['', 400, 'invalid-json'],
    ['{}', 400, 'invalid-request'],
    ['{"decisions":"keep"}', 400, 'invalid-request'],
  ];

  for (const [body, status, code] of cases) {
    const response = await request(server, '/api/apply', { method: 'POST', body });
    assert.equal(response.status, status);
    assert.equal(JSON.parse(response.body).error.code, code);
    assert.equal(response.body.includes(root), false);
    assert.equal(response.body.includes(stateDir), false);
  }

  const tooLarge = await request(server, '/api/apply', {
    method: 'POST',
    body: Buffer.alloc(1_048_577, 0x20),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(JSON.parse(tooLarge.body).error.code, 'request-too-large');
  assert.deepEqual(await readdir(stateDir), []);
});

test('oversized declared and chunked bodies get prompt 413 responses before EOF', async (t) => {
  const { server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });

  const declared = await requestWithoutEnding(server, { contentLength: 1_048_577 });
  assert.equal(declared.status, 413);
  assert.equal(JSON.parse(declared.body).error.code, 'request-too-large');

  const chunked = await requestWithoutEnding(server, {
    bodyChunk: Buffer.alloc(1_048_577, 0x20),
  });
  assert.equal(chunked.status, 413);
  assert.equal(JSON.parse(chunked.body).error.code, 'request-too-large');

  const stillRunning = await request(server, '/api/projects');
  assert.equal(stillRunning.status, 200);
  assert.deepEqual(await readdir(stateDir), []);
});

test('invalid decisions have ordered per-item errors while valid keeps still apply', async (t) => {
  const { server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
  const [one] = await cards(server);
  const submitted = [
    null,
    { id: one.id, action: 'edit', expectedHash: one.hash },
    { id: 'project/missing.md', action: 'keep', expectedHash: one.hash },
    { id: one.id, action: 'keep', expectedHash: 'not-a-hash' },
    {
      id: one.id,
      action: 'keep',
      expectedHash: one.hash,
      newContent: '# Must not be silently ignored\n',
    },
    { id: one.id, action: 'keep', expectedHash: one.hash },
  ];

  const response = await postDecisions(server, submitted);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    results: [
      { id: null, action: null, status: 'error', reason: 'invalid-decision' },
      { id: one.id, action: 'edit', status: 'error', reason: 'invalid-new-content' },
      {
        id: 'project/missing.md',
        action: 'keep',
        status: 'error',
        reason: 'unknown-id',
      },
      { id: one.id, action: 'keep', status: 'error', reason: 'invalid-expected-hash' },
      { id: one.id, action: 'keep', status: 'error', reason: 'new-content-not-allowed' },
      { id: one.id, action: 'keep', status: 'applied' },
    ],
  });
  const history = JSON.parse(await readFile(join(stateDir, 'reviewed.json'), 'utf8'));
  assert.deepEqual(Object.keys(history.entries), [one.hash]);
});

test('apply rejects a wrong token before a declared request body ends', async (t) => {
  const { server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });

  const response = await requestWithoutEnding(server, {
    contentLength: 512,
    token: 'wrong-token',
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await readdir(stateDir), []);
});

test('corrupt review history is not overwritten and valid keeps report a safe error', async (t) => {
  const { server, root, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
  const [one] = await cards(server);
  const corrupt = Buffer.from('{broken history');
  const historyPath = join(stateDir, 'reviewed.json');
  await writeFile(historyPath, corrupt);

  const response = await postDecisions(server, [{
    id: one.id,
    action: 'keep',
    expectedHash: one.hash,
  }]);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    results: [{
      id: one.id,
      action: 'keep',
      status: 'error',
      reason: 'review-history-unavailable',
    }],
  });
  assert.deepEqual(await readFile(historyPath), corrupt);
  assert.deepEqual(await readdir(stateDir), ['reviewed.json']);
  assert.equal(response.body.includes(root), false);
  assert.equal(response.body.includes(stateDir), false);
});

test('separate processes fail closed on a stale regular lock until it is explicitly removed', async (t) => {
  const { server: firstServer, root, stateDir } = await makeServer(t);
  const secondServer = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  const [one, two] = await cards(firstServer);
  const lockPath = join(stateDir, '.reviewed.lock');
  const lockBytes = Buffer.from('abandoned-lock\n');
  await writeFile(lockPath, lockBytes);
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const lockInode = (await stat(lockPath)).ino;

  const [firstResponse, secondResponse] = await Promise.all([
    postDecisions(firstServer, [{ id: one.id, action: 'keep', expectedHash: one.hash }]),
    postDecisions(secondServer, [{ id: two.id, action: 'keep', expectedHash: two.hash }]),
  ]);

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(JSON.parse(firstResponse.body).results[0].reason, 'review-history-write-failed');
  assert.equal(JSON.parse(secondResponse.body).results[0].reason, 'review-history-write-failed');
  assert.deepEqual(await readFile(lockPath), lockBytes);
  assert.equal((await stat(lockPath)).ino, lockInode);
  assert.deepEqual(await readdir(stateDir), ['.reviewed.lock']);

  await rm(lockPath);
  const recovered = await postDecisions(firstServer, [{
    id: one.id,
    action: 'keep',
    expectedHash: one.hash,
  }]);
  assert.equal(recovered.status, 200);
  assert.equal(JSON.parse(recovered.body).results[0].status, 'applied');
  assert.deepEqual(await readdir(stateDir), ['reviewed.json']);
});

test('a history-lock symlink is never followed or removed as stale', {
  skip: process.platform === 'win32' ? 'symlink creation may require elevated privileges' : false,
}, async (t) => {
  const { server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
  const [one] = await cards(server);
  const outsidePath = join(dirname(stateDir), `${basename(stateDir)}-outside-lock`);
  const outsideBytes = Buffer.from('outside lock target\n');
  await writeFile(outsidePath, outsideBytes);
  const old = new Date(Date.now() - 60_000);
  await utimes(outsidePath, old, old);
  await symlink(outsidePath, join(stateDir, '.reviewed.lock'));
  t.after(() => rm(outsidePath, { force: true }));

  const response = await postDecisions(server, [{
    id: one.id,
    action: 'keep',
    expectedHash: one.hash,
  }]);

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).results[0].reason, 'review-history-write-failed');
  assert.deepEqual(await readFile(outsidePath), outsideBytes);
  assert.deepEqual((await readdir(stateDir)).sort(), ['.reviewed.lock']);
});
