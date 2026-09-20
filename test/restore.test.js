const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const {
  access,
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const { startServer } = require('./server-helper');

function request(server, pathname, { body, headers = {}, method = 'GET' } = {}) {
  const requestBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = http.request(new URL(pathname, server.url), {
      method,
      headers: {
        'X-SCMD-Token': server.token,
        ...headers,
        ...(requestBody ? {
          'Content-Type': 'application/json',
          'Content-Length': requestBody.length,
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveRequest({
          status: response.statusCode,
          json: response.headers['content-type']?.includes('application/json')
            ? JSON.parse(text)
            : undefined,
          text,
        });
      });
    });
    outgoing.once('error', rejectRequest);
    if (requestBody) outgoing.write(requestBody);
    outgoing.end();
  });
}

async function makeServer(t, contentsByName, indexBytes) {
  const root = await mkdtemp(join(tmpdir(), 'scmd-restore-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-restore-state-'));
  const projectId = 'project';
  const memoryDir = join(root, projectId, 'memory');
  await mkdir(memoryDir, { recursive: true });
  await Promise.all(Object.entries(contentsByName).map(([fileName, contents]) => (
    writeFile(join(memoryDir, fileName), contents)
  )));
  if (indexBytes !== undefined) await writeFile(join(memoryDir, 'MEMORY.md'), indexBytes);
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
  return { memoryDir, projectId, root, server, stateDir };
}

async function cards(server) {
  const response = await request(server, '/api/projects?includeReviewed=1');
  assert.equal(response.status, 200);
  return response.json.projects.flatMap((project) => project.cards);
}

function apply(server, decisions) {
  return request(server, '/api/apply', { method: 'POST', body: { decisions } });
}

function restore(server, runId, id) {
  return request(server, '/api/restore', { method: 'POST', body: { runId, id } });
}

function purge(server, runId) {
  return request(server, '/api/purge', { method: 'POST', body: { runId } });
}

async function deleteCard(server, card) {
  const response = await apply(server, [{
    id: card.id,
    action: 'delete',
    expectedHash: card.hash,
  }]);
  assert.deepEqual(response.json.results, [{
    id: card.id,
    action: 'delete',
    status: 'applied',
  }]);
}

async function onlyRun(stateDir) {
  const names = await readdir(join(stateDir, 'trash'));
  assert.equal(names.length, 1);
  return { runId: names[0], runPath: join(stateDir, 'trash', names[0]) };
}

async function waitFor(description, check, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

test('trash listing and restore make a duplicate-line middle-index delete byte-identical', async (t) => {
  const memoryBytes = Buffer.from([
    '---\r\n',
    'name: One\r\n',
    'description: Exact bytes.\r\n',
    '---\r\n',
    '\r\n',
    'Body.\r\n',
  ].join(''));
  const indexBytes = Buffer.from([
    '# Before\r\n',
    '- [One](one.md) — Exact bytes.\r\n',
    '- [Other](other.md) — Keep.\n',
    '- [One duplicate](one.md) — Exact bytes again.\r',
    'Tail without newline',
  ].join(''));
  const { memoryDir, server, stateDir } = await makeServer(t, {
    'one.md': memoryBytes,
    'other.md': '# Other\n',
  }, indexBytes);
  const [memoryMode, indexMode] = await Promise.all([
    stat(join(memoryDir, 'one.md')).then((value) => value.mode & 0o777),
    stat(join(memoryDir, 'MEMORY.md')).then((value) => value.mode & 0o777),
  ]);
  const one = (await cards(server)).find((card) => card.fileName === 'one.md');
  await deleteCard(server, one);

  const listed = await request(server, '/api/trash');
  assert.equal(listed.status, 200);
  assert.equal(JSON.stringify(listed.json).includes(memoryDir), false);
  assert.equal(JSON.stringify(listed.json).includes(stateDir), false);
  assert.equal(listed.json.runs.length, 1);
  const [run] = listed.json.runs;
  assert.equal(run.status, 'ready');
  assert.equal(Number.isInteger(run.size), true);
  assert.deepEqual(run.items, [{
    id: one.id,
    projectId: 'project',
    fileName: 'one.md',
    name: 'One',
    summary: 'Exact bytes.',
    hash: one.hash,
    deletedAt: run.items[0].deletedAt,
    status: 'deleted',
    restorable: true,
  }]);

  const response = await restore(server, run.id, one.id);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.result, {
    runId: run.id,
    id: one.id,
    status: 'restored',
  });
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), memoryBytes);
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
  assert.equal((await stat(join(memoryDir, 'one.md'))).mode & 0o777, memoryMode);
  assert.equal((await stat(join(memoryDir, 'MEMORY.md'))).mode & 0o777, indexMode);
  await assert.rejects(access(join(stateDir, 'trash', run.id, 'project', 'one.md')), {
    code: 'ENOENT',
  });

  const manifest = JSON.parse(await readFile(
    join(stateDir, 'trash', run.id, 'manifest.json'),
    'utf8',
  ));
  assert.equal(manifest.items[0].status, 'restored');
  assert.equal(new Date(manifest.items[0].restoredAt).toISOString(), manifest.items[0].restoredAt);

  const repeated = await restore(server, run.id, one.id);
  assert.deepEqual(repeated.json.result, {
    runId: run.id,
    id: one.id,
    status: 'skipped',
    reason: 'already-restored',
  });
});

test('restore preserves index bytes written after delete and restores the saved line once', async (t) => {
  const memoryBytes = Buffer.from('# One\n');
  const savedLine = Buffer.from('- [One](one.md) — Saved.\n');
  const indexBytes = Buffer.from(`# Header\n${savedLine.toString()}- [Other](other.md) — Keep.\n`);
  const concurrent = Buffer.from('- [Concurrent](new.md) — Written after delete.\r\n');
  const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': memoryBytes }, indexBytes);
  const [one] = await cards(server);
  await deleteCard(server, one);
  await appendFile(join(memoryDir, 'MEMORY.md'), concurrent);
  const { runId } = await onlyRun(stateDir);

  const response = await restore(server, runId, one.id);

  assert.equal(response.json.result.status, 'restored');
  const restoredIndex = await readFile(join(memoryDir, 'MEMORY.md'));
  assert.ok(restoredIndex.includes(concurrent));
  assert.equal(
    restoredIndex.toString('utf8').split(savedLine.toString('utf8')).length - 1,
    1,
  );
});

test('restore matches exact surviving duplicate lines before treating same-target lines as equivalent', async (t) => {
  const first = '- [One](one.md) — First saved hook.\n';
  const second = '- [One](one.md) — Second saved hook.\n';
  const { memoryDir, server, stateDir } = await makeServer(
    t,
    { 'one.md': '# One\n' },
    Buffer.from(`${first}${second}`),
  );
  const [one] = await cards(server);
  await deleteCard(server, one);
  await writeFile(join(memoryDir, 'MEMORY.md'), second);
  const { runId } = await onlyRun(stateDir);

  const response = await restore(server, runId, one.id);

  assert.equal(response.json.result.status, 'restored');
  const restored = (await readFile(join(memoryDir, 'MEMORY.md'), 'utf8'));
  assert.equal(restored.split(first).length - 1, 1);
  assert.equal(restored.split(second).length - 1, 1);
});

test('restore recreates a missing index from exact saved lines and its original mode', async (t) => {
  const memoryBytes = Buffer.from('# One\n');
  const first = '- [One](one.md) — First.\r\n';
  const second = '- [One again](one.md) — Second.\n';
  const { memoryDir, server, stateDir } = await makeServer(
    t,
    { 'one.md': memoryBytes },
    Buffer.from(`${first}${second}`),
  );
  await chmod(join(memoryDir, 'MEMORY.md'), 0o640);
  const [one] = await cards(server);
  await deleteCard(server, one);
  await rm(join(memoryDir, 'MEMORY.md'));
  const { runId } = await onlyRun(stateDir);

  const response = await restore(server, runId, one.id);

  assert.equal(response.json.result.status, 'restored');
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), Buffer.from(`${first}${second}`));
  assert.equal((await stat(join(memoryDir, 'MEMORY.md'))).mode & 0o777, 0o640);
});

test('restore hash and no-overwrite guards leave trash, destination, and index untouched', async (t) => {
  await t.test('trash bytes changed', async (t) => {
    const indexBytes = Buffer.from('- [One](one.md) — Saved.\n');
    const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' }, indexBytes);
    const [one] = await cards(server);
    await deleteCard(server, one);
    const { runId, runPath } = await onlyRun(stateDir);
    await writeFile(join(runPath, 'project', 'one.md'), '# Tampered\n');

    const response = await restore(server, runId, one.id);

    assert.deepEqual(response.json.result, {
      runId,
      id: one.id,
      status: 'skipped',
      reason: 'changed-in-trash',
    });
    await assert.rejects(access(join(memoryDir, 'one.md')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), Buffer.alloc(0));
    assert.deepEqual(await readFile(join(runPath, 'project', 'one.md')), Buffer.from('# Tampered\n'));
  });

  await t.test('destination recreated', async (t) => {
    const replacement = Buffer.from('# Recreated elsewhere\n');
    const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
    const [one] = await cards(server);
    await deleteCard(server, one);
    const { runId, runPath } = await onlyRun(stateDir);
    await writeFile(join(memoryDir, 'one.md'), replacement);

    const response = await restore(server, runId, one.id);

    assert.deepEqual(response.json.result, {
      runId,
      id: one.id,
      status: 'error',
      reason: 'destination-exists',
    });
    assert.deepEqual(await readFile(join(memoryDir, 'one.md')), replacement);
    assert.deepEqual(await readFile(join(runPath, 'project', 'one.md')), Buffer.from('# One\n'));
  });
});

test('restore reports restore-incomplete when a recreated destination prevents rollback', async (t) => {
  const padding = '- [Other](other.md) — unchanged\n'.repeat(250_000);
  const indexBytes = Buffer.from(`${padding}- [One](one.md) — restore\n`);
  const replacement = Buffer.from('# Recreated during restore\n');
  const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' }, indexBytes);
  const [one] = await cards(server);
  await deleteCard(server, one);
  const postDeleteIndex = await readFile(join(memoryDir, 'MEMORY.md'));
  const { runId, runPath } = await onlyRun(stateDir);
  const restoring = restore(server, runId, one.id);
  await waitFor('the restored file before index work completes', async () => {
    try {
      await access(join(memoryDir, 'one.md'));
      return true;
    } catch {
      return false;
    }
  });
  await writeFile(join(memoryDir, 'one.md'), replacement);

  const response = await restoring;

  assert.deepEqual(response.json.result,
    { runId, id: one.id, status: 'error', reason: 'restore-incomplete' });
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), replacement);
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), postDeleteIndex);
  const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.items[0].status, 'restore-incomplete');
});

test('trash listing isolates corrupt runs and restore rejects unsafe manifest paths and statuses', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'scmd-restore-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
  const [one] = await cards(server);
  await deleteCard(server, one);
  const { runId, runPath } = await onlyRun(stateDir);
  const manifestPath = join(runPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.items[0].from = join(outside, 'stolen.md');
  manifest.items[0].to = join(outside, 'payload.md');
  const pendingPath = join(memoryDir, 'pending.md');
  const pendingTrashPath = join(runPath, 'project', 'pending.md');
  manifest.items.push({
    ...manifest.items[0],
    id: 'project/pending.md',
    fileName: 'pending.md',
    from: pendingPath,
    to: pendingTrashPath,
    status: 'pending',
    indexLine: null,
    indexLines: [],
    indexOffset: null,
  });
  manifest.items.push({
    ...manifest.items[0],
    id: 'project/incomplete.md',
    fileName: 'incomplete.md',
    from: join(memoryDir, 'incomplete.md'),
    to: join(runPath, 'project', 'incomplete.md'),
    status: 'rollback-incomplete',
    indexLine: null,
    indexLines: [],
    indexOffset: null,
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const corruptRun = join(stateDir, 'trash', 'corrupt-run');
  await mkdir(corruptRun);
  await writeFile(join(corruptRun, 'manifest.json'), '{not json');

  const listed = await request(server, '/api/trash');

  assert.equal(listed.status, 200);
  assert.equal(listed.json.runs.length, 2);
  assert.equal(listed.json.runs.find((run) => run.id === 'corrupt-run').status, 'invalid');
  assert.equal(listed.json.runs.find((run) => run.id === runId).status, 'ready');
  const invalidPublicItem = listed.json.runs
    .find((run) => run.id === runId).items.find((item) => item.status === 'invalid');
  assert.deepEqual(invalidPublicItem, {
    id: null,
    projectId: null,
    fileName: null,
    name: null,
    summary: null,
    hash: null,
    deletedAt: null,
    status: 'invalid',
    restorable: false,
  });
  assert.equal(JSON.stringify(listed.json).includes(outside), false);

  const unsafe = await restore(server, runId, one.id);
  const pending = await restore(server, runId, 'project/pending.md');
  const incomplete = await restore(server, runId, 'project/incomplete.md');
  const corrupt = await restore(server, 'corrupt-run', one.id);
  assert.deepEqual(unsafe.json.result,
    { runId, id: one.id, status: 'error', reason: 'invalid-manifest-item' });
  assert.deepEqual(pending.json.result,
    { runId, id: 'project/pending.md', status: 'error', reason: 'not-restorable' });
  assert.deepEqual(incomplete.json.result,
    { runId, id: 'project/incomplete.md', status: 'error', reason: 'not-restorable' });
  assert.deepEqual(corrupt.json.result,
    { runId: 'corrupt-run', id: one.id, status: 'error', reason: 'invalid-manifest' });
  await assert.rejects(access(join(outside, 'stolen.md')), { code: 'ENOENT' });
  await assert.rejects(access(join(outside, 'payload.md')), { code: 'ENOENT' });
  await assert.rejects(access(join(memoryDir, 'one.md')), { code: 'ENOENT' });
});

test('restore rejects internally inconsistent index snapshots in a manifest', async (t) => {
  const { server, stateDir } = await makeServer(
    t,
    { 'one.md': '# One\n' },
    Buffer.from('- [One](one.md) — One.\n'),
  );
  const [one] = await cards(server);
  await deleteCard(server, one);
  const { runId, runPath } = await onlyRun(stateDir);
  const manifestPath = join(runPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.items[0].indexAfterDeleteExists = false;
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  const listed = await request(server, '/api/trash');
  const restored = await restore(server, runId, one.id);

  assert.equal(listed.json.runs[0].items[0].status, 'invalid');
  assert.equal(listed.json.runs[0].items[0].restorable, false);
  assert.deepEqual(restored.json.result,
    { runId, id: one.id, status: 'error', reason: 'invalid-manifest-item' });
});

test('restore rejects a trash run directory replaced while it waits for the run lock', async (t) => {
  const indexBytes = Buffer.from('- [One](one.md) — One.\n');
  const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' }, indexBytes);
  const [one] = await cards(server);
  await deleteCard(server, one);
  const { runId, runPath } = await onlyRun(stateDir);
  const manifestBytes = await readFile(join(runPath, 'manifest.json'));
  const trashBytes = await readFile(join(runPath, 'project', 'one.md'));
  const runLockPath = join(
    stateDir,
    '.apply-locks',
    `${createHash('sha256').update(`trash:${await realpath(runPath)}`).digest('hex')}.lock`,
  );
  await mkdir(join(stateDir, '.apply-locks'), { recursive: true });
  await writeFile(runLockPath, 'held by test\n');
  const restoring = restore(server, runId, one.id);
  await delay(100);

  const movedRunPath = `${runPath}-moved`;
  await rename(runPath, movedRunPath);
  await mkdir(join(runPath, 'project'), { recursive: true });
  await writeFile(join(runPath, 'manifest.json'), manifestBytes);
  await writeFile(join(runPath, 'project', 'one.md'), trashBytes);
  await rm(runLockPath, { force: true });

  const response = await restoring;

  assert.deepEqual(response.json.result,
    { runId, id: one.id, status: 'error', reason: 'invalid-manifest' });
  await assert.rejects(access(join(memoryDir, 'one.md')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), Buffer.alloc(0));
  assert.deepEqual(await readFile(join(movedRunPath, 'project', 'one.md')), trashBytes);
  assert.deepEqual(await readFile(join(runPath, 'project', 'one.md')), trashBytes);
});

test('restore isolates failures and refuses symlink destinations and indexes', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'scmd-restore-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideMemory = join(outside, 'outside.md');
  const outsideIndex = join(outside, 'MEMORY.md');
  await writeFile(outsideMemory, '# Outside\n');
  await writeFile(outsideIndex, '# Outside index\n');
  const { memoryDir, server, stateDir } = await makeServer(t, {
    'one.md': '# One\n',
    'two.md': '# Two\n',
  }, Buffer.from('- [One](one.md) — One.\n- [Two](two.md) — Two.\n'));
  const currentCards = await cards(server);
  const one = currentCards.find((card) => card.fileName === 'one.md');
  const two = currentCards.find((card) => card.fileName === 'two.md');
  await apply(server, [
    { id: one.id, action: 'delete', expectedHash: one.hash },
    { id: two.id, action: 'delete', expectedHash: two.hash },
  ]);
  const { runId, runPath } = await onlyRun(stateDir);
  await symlink(outsideMemory, join(memoryDir, 'one.md'));
  await rm(join(memoryDir, 'MEMORY.md'));
  await symlink(outsideIndex, join(memoryDir, 'MEMORY.md'));

  const firstResponse = await restore(server, runId, one.id);
  const secondResponse = await restore(server, runId, two.id);

  assert.deepEqual(firstResponse.json.result,
    { runId, id: one.id, status: 'error', reason: 'destination-exists' });
  assert.deepEqual(secondResponse.json.result,
    { runId, id: two.id, status: 'error', reason: 'unsafe-index' });
  assert.deepEqual(await readFile(outsideMemory), Buffer.from('# Outside\n'));
  assert.deepEqual(await readFile(outsideIndex), Buffer.from('# Outside index\n'));
  assert.deepEqual(await readFile(join(runPath, 'project', 'one.md')), Buffer.from('# One\n'));
  assert.deepEqual(await readFile(join(runPath, 'project', 'two.md')), Buffer.from('# Two\n'));
});

test('two server processes serialize same-run restores without lost manifest or index updates', async (t) => {
  const indexBytes = Buffer.from('- [One](one.md) — One.\r\n- [Two](two.md) — Two.\n');
  const { memoryDir, root, server, stateDir } = await makeServer(t, {
    'one.md': '# One\n',
    'two.md': '# Two\n',
  }, indexBytes);
  const currentCards = await cards(server);
  const one = currentCards.find((card) => card.fileName === 'one.md');
  const two = currentCards.find((card) => card.fileName === 'two.md');
  const deleted = await apply(server, [
    { id: one.id, action: 'delete', expectedHash: one.hash },
    { id: two.id, action: 'delete', expectedHash: two.hash },
  ]);
  assert.deepEqual(deleted.json.results.map((result) => result.status), ['applied', 'applied']);
  const { runId, runPath } = await onlyRun(stateDir);
  const otherServer = await startServer(t, {
    serverArgs: ['--root', root, '--state-dir', stateDir, '--port', '0', '--no-open'],
  });

  const [first, second] = await Promise.all([
    restore(server, runId, one.id),
    restore(otherServer, runId, two.id),
  ]);

  assert.equal(first.json.result.status, 'restored');
  assert.equal(second.json.result.status, 'restored');
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
  const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.items.map((item) => item.status), ['restored', 'restored']);

  const sameItem = await Promise.all([
    restore(server, runId, one.id),
    restore(otherServer, runId, one.id),
  ]);
  assert.deepEqual(sameItem.map((response) => response.json.result.reason), [
    'already-restored',
    'already-restored',
  ]);
});

test('a multi-delete run restores byte-identically in either item order', async (t) => {
  for (const order of [['one.md', 'two.md'], ['two.md', 'one.md']]) {
    await t.test(order.join(' then '), async (t) => {
      const indexBytes = Buffer.from([
        '- [One](one.md) — One.\r\n',
        '- [Two](two.md) — Two.\n',
        '- [Survivor](survivor.md) — Never deleted.\r\n',
      ].join(''));
      const oneBytes = Buffer.from('# One\r\n');
      const twoBytes = Buffer.from('# Two\n');
      const { memoryDir, server, stateDir } = await makeServer(t, {
        'one.md': oneBytes,
        'two.md': twoBytes,
        'survivor.md': '# Survivor\n',
      }, indexBytes);
      const currentCards = (await cards(server))
        .filter((card) => card.fileName === 'one.md' || card.fileName === 'two.md');
      const byName = new Map(currentCards.map((card) => [card.fileName, card]));
      const deleted = await apply(server, currentCards.map((card) => ({
        id: card.id,
        action: 'delete',
        expectedHash: card.hash,
      })));
      assert.deepEqual(deleted.json.results.map((result) => result.status), ['applied', 'applied']);
      const { runId } = await onlyRun(stateDir);

      for (const fileName of order) {
        const response = await restore(server, runId, byName.get(fileName).id);
        assert.equal(response.json.result.status, 'restored');
      }

      assert.deepEqual(await readFile(join(memoryDir, 'one.md')), oneBytes);
      assert.deepEqual(await readFile(join(memoryDir, 'two.md')), twoBytes);
      assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
    });
  }
});

test('three same-project deletes restore exactly across every restore order', async (t) => {
  const restoreOrders = [
    ['one.md', 'two.md', 'three.md'],
    ['one.md', 'three.md', 'two.md'],
    ['two.md', 'one.md', 'three.md'],
    ['two.md', 'three.md', 'one.md'],
    ['three.md', 'one.md', 'two.md'],
    ['three.md', 'two.md', 'one.md'],
  ];
  for (const restoreOrder of restoreOrders) {
    await t.test(restoreOrder.join(' then '), async (t) => {
      const indexBytes = Buffer.from([
        '- [One](one.md) — One.\r\n',
        '- [Survivor](survivor.md) — Never deleted.\n',
        '- [Two](two.md) — Two.\r',
        '- [Three](three.md) — Three.\n',
      ].join(''));
      const { memoryDir, server, stateDir } = await makeServer(t, {
        'one.md': '# One\n',
        'two.md': '# Two\n',
        'three.md': '# Three\n',
        'survivor.md': '# Survivor\n',
      }, indexBytes);
      const byName = new Map((await cards(server)).map((card) => [card.fileName, card]));
      const deleteOrder = ['two.md', 'one.md', 'three.md'];
      const deleted = await apply(server, deleteOrder.map((fileName) => ({
        id: byName.get(fileName).id,
        action: 'delete',
        expectedHash: byName.get(fileName).hash,
      })));
      assert.deepEqual(deleted.json.results.map((result) => result.status), [
        'applied',
        'applied',
        'applied',
      ]);
      const { runId } = await onlyRun(stateDir);

      for (const fileName of restoreOrder) {
        const response = await restore(server, runId, byName.get(fileName).id);
        assert.equal(response.json.result.status, 'restored');
      }

      assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
    });
  }
});

test('restore waits for an active multi-delete run before reading or changing its manifest', async (t) => {
  const { root, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
  const secondMemoryDir = join(root, 'second', 'memory');
  await mkdir(secondMemoryDir, { recursive: true });
  await writeFile(join(secondMemoryDir, 'two.md'), '# Two\n');
  const currentCards = await cards(server);
  const one = currentCards.find((card) => card.fileName === 'one.md');
  const two = currentCards.find((card) => card.fileName === 'two.md');
  const lockDirectory = join(stateDir, '.apply-locks');
  await mkdir(lockDirectory, { recursive: true });
  const secondRealPath = await realpath(secondMemoryDir);
  const secondLockPath = join(
    lockDirectory,
    `${createHash('sha256').update(secondRealPath).digest('hex')}.lock`,
  );
  await writeFile(secondLockPath, 'held by test\n');

  const applying = apply(server, [
    { id: one.id, action: 'delete', expectedHash: one.hash },
    { id: two.id, action: 'delete', expectedHash: two.hash },
  ]);
  const runPath = await waitFor('the first completed delete in an active run', async () => {
    try {
      const { runPath: candidate } = await onlyRun(stateDir);
      const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'));
      return manifest.items.some((item) => item.id === one.id && item.status === 'deleted')
        ? candidate
        : undefined;
    } catch {
      return undefined;
    }
  });
  const runId = runPath.split('/').at(-1);
  const restoring = restore(server, runId, one.id);

  try {
    assert.equal(await Promise.race([
      restoring.then(() => 'settled'),
      delay(100, 'waiting'),
    ]), 'waiting');
  } finally {
    await rm(secondLockPath, { force: true });
  }

  const [applyResponse, restoreResponse] = await Promise.all([applying, restoring]);
  assert.deepEqual(applyResponse.json.results.map((result) => result.status), ['applied', 'applied']);
  assert.equal(restoreResponse.json.result.status, 'restored');
  const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.items.map((item) => item.status), ['restored', 'deleted']);
});

test('restoring a memory deleted without an index does not create one', async (t) => {
  const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
  const [one] = await cards(server);
  await deleteCard(server, one);
  const { runId } = await onlyRun(stateDir);

  const response = await restore(server, runId, one.id);

  assert.equal(response.json.result.status, 'restored');
  await assert.rejects(access(join(memoryDir, 'MEMORY.md')), { code: 'ENOENT' });
});

test('purge permanently removes one validated trash run without restoring its memory', async (t) => {
  const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
  const [one] = await cards(server);
  await deleteCard(server, one);
  const { runId, runPath } = await onlyRun(stateDir);

  const response = await purge(server, runId);

  assert.equal(response.status, 200);
  assert.deepEqual(response.json.result, { runId, status: 'purged' });
  await assert.rejects(access(runPath), { code: 'ENOENT' });
  await assert.rejects(access(join(memoryDir, 'one.md')), { code: 'ENOENT' });
  const listed = await request(server, '/api/trash');
  assert.deepEqual(listed.json, { runs: [], notices: [] });
});

test('trash listing accepts a valid manifest larger than the request-body limit', async (t) => {
  const description = 'x'.repeat((1024 * 1024) + 64);
  const memory = `---\nname: Large\ndescription: ${description}\n---\n\nBody.\n`;
  const { server, stateDir } = await makeServer(t, { 'large.md': memory });
  const [large] = await cards(server);
  await deleteCard(server, large);
  const { runPath } = await onlyRun(stateDir);
  assert.ok((await stat(join(runPath, 'manifest.json'))).size > 1024 * 1024);

  const response = await request(server, '/api/trash');

  assert.equal(response.status, 200);
  assert.equal(response.json.runs[0].status, 'ready');
  assert.equal(response.json.runs[0].items[0].restorable, true);
});

test('trash and restore preserve Host, token, JSON, and body-size checks', async (t) => {
  const { server } = await makeServer(t, { 'one.md': '# One\n' });

  const noToken = await request(server, '/api/trash', {
    headers: { 'X-SCMD-Token': '' },
  });
  assert.equal(noToken.status, 401);
  const foreignHost = await request(server, '/api/trash', {
    headers: { Host: 'attacker.example' },
  });
  assert.equal(foreignHost.status, 403);
  const invalid = await request(server, '/api/restore', { method: 'POST', body: {} });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'invalid-request');
  const invalidPurge = await request(server, '/api/purge', { method: 'POST', body: {} });
  assert.equal(invalidPurge.status, 400);
  assert.equal(invalidPurge.json.error.code, 'invalid-request');

  const hugeId = 'x'.repeat((1024 * 1024) + 1);
  const tooLarge = await request(server, '/api/restore', {
    method: 'POST',
    body: { runId: createHash('sha256').update('x').digest('hex'), id: hugeId },
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.json.error.code, 'request-too-large');
});
