const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createHash } = require('node:crypto');
const {
  access,
  appendFile,
  chmod,
  link,
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
const { basename, dirname, join, relative } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const {
  applyDelete,
  createTrashRun,
  moveFileNoReplace,
  readIndexForDelete,
  restoreIndexLines,
  rewriteIndexForDelete,
} = require('../server');
const { startServer } = require('./server-helper');

function request(server, pathname, { body, method = 'GET' } = {}) {
  const requestBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body));

  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = http.request(new URL(pathname, server.url), {
      method,
      headers: {
        'X-SCMD-Token': server.token,
        ...(requestBody ? {
          'Content-Type': 'application/json',
          'Content-Length': requestBody.length,
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    outgoing.once('error', rejectRequest);
    if (requestBody) outgoing.write(requestBody);
    outgoing.end();
  });
}

async function makeServer(t, contentsByName, indexBytes) {
  const root = await mkdtemp(join(tmpdir(), 'scmd-delete-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-delete-state-'));
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
  return request(server, '/api/apply', {
    method: 'POST',
    body: { decisions },
  });
}

async function onlyTrashRun(stateDir) {
  const runNames = await readdir(join(stateDir, 'trash'));
  assert.equal(runNames.length, 1);
  assert.match(runNames[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{16}$/);
  return { runName: runNames[0], runPath: join(stateDir, 'trash', runNames[0]) };
}

async function listTree(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      found.push(relative(root, target));
      if (entry.isDirectory()) await visit(target);
    }
  }
  await visit(root);
  return found.sort();
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

async function waitForPendingManifest(stateDir) {
  return waitFor('a durable pending trash manifest', async () => {
    let runNames;
    try {
      runNames = await readdir(join(stateDir, 'trash'));
    } catch {
      return undefined;
    }
    for (const runName of runNames) {
      const runPath = join(stateDir, 'trash', runName);
      try {
        const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
        if (manifest.items.some((item) => item.status === 'pending')) return runPath;
      } catch {
        // The run or manifest may still be in the middle of its atomic creation.
      }
    }
  });
}

test('delete moves exact bytes, records a restorable manifest, and removes only the live index line', async (t) => {
  const oneBytes = Buffer.from('---\nname: One\ndescription: First hook.\n---\n\nOne body.\n');
  const twoBytes = Buffer.from('---\nname: Two\ndescription: Second hook.\n---\n\nTwo body.\n');
  const indexBefore = Buffer.from([
    '# Memory index\r\n',
    '\r\n',
    '```md\r\n',
    '- [Example only](one.md) — do not remove this fenced line\r\n',
    '```\r\n',
    '- [One](one.md) — First hook.\r\n',
    '- [Two](two.md) — Second hook.\n',
    'Tail without a final newline',
  ].join(''));
  const appended = Buffer.from('\r\n- [Written during review](new.md) — Keep this exact line.\r\n');
  const matchingLine = '- [One](one.md) — First hook.\r\n';
  const expectedIndex = Buffer.from(
    `${indexBefore.toString('utf8').replace(matchingLine, '')}${appended.toString('utf8')}`,
  );
  const { memoryDir, projectId, server, stateDir } = await makeServer(t, {
    'one.md': oneBytes,
    'two.md': twoBytes,
  }, indexBefore);
  const currentCards = await cards(server);
  const one = currentCards.find((card) => card.fileName === 'one.md');
  const two = currentCards.find((card) => card.fileName === 'two.md');
  const sourcePath = join(memoryDir, 'one.md');
  const sourceMode = (await stat(sourcePath)).mode & 0o777;
  const indexPath = join(memoryDir, 'MEMORY.md');
  const indexMode = (await stat(indexPath)).mode & 0o777;
  await appendFile(indexPath, appended);

  const response = await apply(server, [
    { id: one.id, action: 'delete', expectedHash: one.hash },
    { id: two.id, action: 'keep', expectedHash: two.hash },
  ]);

  assert.equal(response.status, 200);
  assert.deepEqual(response.json.results, [
    { id: one.id, action: 'delete', status: 'applied' },
    { id: two.id, action: 'keep', status: 'applied' },
  ]);
  await assert.rejects(access(sourcePath), { code: 'ENOENT' });
  assert.deepEqual(await readFile(indexPath), expectedIndex);
  assert.equal((await stat(indexPath)).mode & 0o777, indexMode);
  assert.deepEqual(await readFile(join(memoryDir, 'two.md')), twoBytes);

  const { runPath } = await onlyTrashRun(stateDir);
  const trashPath = join(runPath, projectId, 'one.md');
  assert.deepEqual(await readFile(trashPath), oneBytes);
  assert.equal((await stat(trashPath)).mode & 0o777, sourceMode);
  const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].status, 'deleted');
  assert.equal(manifest.items[0].id, one.id);
  assert.equal(manifest.items[0].from, sourcePath);
  assert.equal(manifest.items[0].indexLine, matchingLine);
  assert.equal(manifest.items[0].indexOffset, indexBefore.indexOf(Buffer.from(matchingLine)));
  assert.equal(manifest.items[0].indexMode, indexMode);
  assert.equal(manifest.items[0].fileMode, sourceMode);
  assert.equal(manifest.items[0].projectId, projectId);
  assert.equal(manifest.items[0].fileName, 'one.md');
  assert.equal(manifest.items[0].name, 'One');
  assert.equal(manifest.items[0].summary, 'First hook.');
  assert.deepEqual(manifest.items[0].indexLines, [{
    line: matchingLine,
    offset: indexBefore.indexOf(Buffer.from(matchingLine)),
  }]);
  assert.equal(new Date(manifest.items[0].deletedAt).toISOString(), manifest.items[0].deletedAt);
  assert.deepEqual(await listTree(join(stateDir, 'trash')), [
    basename(runPath),
    join(basename(runPath), 'manifest.json'),
    join(basename(runPath), projectId),
    join(basename(runPath), projectId, 'one.md'),
  ]);
  assert.equal(
    (await listTree(stateDir)).some((name) => name.includes('.tmp') || name.endsWith('.lock')),
    false,
  );
});

test('delete succeeds without creating or changing an index when its line is absent', async (t) => {
  await t.test('MEMORY.md is missing', async (t) => {
    const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
    const [one] = await cards(server);
    const response = await apply(server, [{ id: one.id, action: 'delete', expectedHash: one.hash }]);

    assert.deepEqual(response.json.results, [{
      id: one.id,
      action: 'delete',
      status: 'applied',
    }]);
    await assert.rejects(access(join(memoryDir, 'MEMORY.md')), { code: 'ENOENT' });
    const { runPath } = await onlyTrashRun(stateDir);
    const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.items[0].indexLine, null);
    assert.equal(manifest.items[0].indexOffset, null);
    assert.equal(manifest.items[0].indexMode, null);
  });

  await t.test('MEMORY.md has no matching line', async (t) => {
    const indexBytes = Buffer.from('# Index\r\n- [Other](other.md) — untouched\r\n');
    const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' }, indexBytes);
    const [one] = await cards(server);
    const response = await apply(server, [{ id: one.id, action: 'delete', expectedHash: one.hash }]);

    assert.equal(response.json.results[0].status, 'applied');
    assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
    const { runPath } = await onlyTrashRun(stateDir);
    const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
    assert.equal(manifest.items[0].indexLine, null);
    assert.equal(manifest.items[0].indexOffset, null);
  });
});

test('changed and unknown delete targets are isolated without creating trash', async (t) => {
  const { memoryDir, root, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
  const [one] = await cards(server);
  const changedBytes = Buffer.from('# One changed outside SCMD\n');
  await writeFile(join(memoryDir, 'one.md'), changedBytes);
  const outsidePath = join(dirname(root), `${basename(root)}-outside.md`);
  const outsideBytes = Buffer.from('outside\n');
  await writeFile(outsidePath, outsideBytes);
  t.after(() => rm(outsidePath, { force: true }));

  const response = await apply(server, [
    { id: one.id, action: 'delete', expectedHash: one.hash },
    { id: `../../${basename(outsidePath)}`, action: 'delete', expectedHash: one.hash },
  ]);

  assert.deepEqual(response.json.results, [
    { id: one.id, action: 'delete', status: 'skipped', reason: 'changed-since-read' },
    {
      id: `../../${basename(outsidePath)}`,
      action: 'delete',
      status: 'error',
      reason: 'unknown-id',
    },
  ]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), changedBytes);
  assert.deepEqual(await readFile(outsidePath), outsideBytes);
  assert.deepEqual(await readdir(stateDir), []);
  assert.equal(JSON.stringify(response.json).includes(root), false);
  assert.equal(JSON.stringify(response.json).includes(stateDir), false);
});

test('the decisive hash check runs after acquiring the project apply lock', async (t) => {
  const originalBytes = Buffer.from('# One\n');
  const changedBytes = Buffer.from('# One changed while apply waited\n');
  const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': originalBytes });
  const [one] = await cards(server);
  const lockDirectory = join(stateDir, '.apply-locks');
  const lockName = `${createHash('sha256').update(await realpath(memoryDir)).digest('hex')}.lock`;
  const lockPath = join(lockDirectory, lockName);
  await mkdir(lockDirectory);
  await writeFile(lockPath, 'held by test\n');

  const applying = apply(server, [{ id: one.id, action: 'delete', expectedHash: one.hash }]);
  await delay(100);
  await writeFile(join(memoryDir, 'one.md'), changedBytes);
  await rm(lockPath);
  const response = await applying;

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'delete',
    status: 'skipped',
    reason: 'changed-since-read',
  }]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), changedBytes);
  assert.deepEqual(await readdir(stateDir), []);
});

test('delete rejects a memory directory swapped to an outside symlink while waiting for its lock', {
  skip: process.platform === 'win32' ? 'symlink creation may require elevated privileges' : false,
}, async (t) => {
  const memoryBytes = Buffer.from('# One\n');
  const indexBytes = Buffer.from('- [One](one.md) — original\n');
  const { memoryDir, server, stateDir } = await makeServer(
    t,
    { 'one.md': memoryBytes },
    indexBytes,
  );
  const outsideMemoryDir = await mkdtemp(join(tmpdir(), 'scmd-delete-outside-memory-'));
  const savedMemoryDir = `${memoryDir}-saved`;
  await writeFile(join(outsideMemoryDir, 'one.md'), memoryBytes);
  await writeFile(join(outsideMemoryDir, 'MEMORY.md'), indexBytes);
  t.after(() => rm(outsideMemoryDir, { recursive: true, force: true }));
  const [one] = await cards(server);
  const trustedRealPath = await realpath(memoryDir);
  const lockDirectory = join(stateDir, '.apply-locks');
  const lockName = `${createHash('sha256').update(trustedRealPath).digest('hex')}.lock`;
  const lockPath = join(lockDirectory, lockName);
  await mkdir(lockDirectory);
  await writeFile(lockPath, 'held by test\n');

  const applying = apply(server, [{ id: one.id, action: 'delete', expectedHash: one.hash }]);
  await delay(100);
  await rename(memoryDir, savedMemoryDir);
  await symlink(outsideMemoryDir, memoryDir);
  await rm(lockPath);
  const response = await applying;

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'delete',
    status: 'error',
    reason: 'delete-failed',
  }]);
  assert.deepEqual(await readFile(join(savedMemoryDir, 'one.md')), memoryBytes);
  assert.deepEqual(await readFile(join(savedMemoryDir, 'MEMORY.md')), indexBytes);
  assert.deepEqual(await readFile(join(outsideMemoryDir, 'one.md')), memoryBytes);
  assert.deepEqual(await readFile(join(outsideMemoryDir, 'MEMORY.md')), indexBytes);
  assert.deepEqual(await readdir(stateDir), []);
});

test('concurrent server processes serialize deletes in one project', async (t) => {
  const indexBytes = Buffer.from([
    '- [One](one.md) — first\n',
    '- [Two](two.md) — second\n',
    '- [Three](three.md) — untouched\n',
  ].join(''));
  const { memoryDir, root, server: firstServer, stateDir } = await makeServer(t, {
    'one.md': '# One\n',
    'two.md': '# Two\n',
    'three.md': '# Three\n',
  }, indexBytes);
  const secondServer = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  const currentCards = await cards(firstServer);
  const one = currentCards.find((card) => card.fileName === 'one.md');
  const two = currentCards.find((card) => card.fileName === 'two.md');

  const [firstResponse, secondResponse] = await Promise.all([
    apply(firstServer, [{ id: one.id, action: 'delete', expectedHash: one.hash }]),
    apply(secondServer, [{ id: two.id, action: 'delete', expectedHash: two.hash }]),
  ]);

  assert.equal(firstResponse.json.results[0].status, 'applied');
  assert.equal(secondResponse.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from('- [Three](three.md) — untouched\n'),
  );
  const runNames = await readdir(join(stateDir, 'trash'));
  assert.equal(runNames.length, 2);
  const manifests = await Promise.all(runNames.map(async (runName) => (
    JSON.parse(await readFile(join(stateDir, 'trash', runName, 'manifest.json'), 'utf8'))
  )));
  assert.deepEqual(
    manifests.flatMap((manifest) => manifest.items.map((item) => item.id)).sort(),
    [one.id, two.id].sort(),
  );
  assert.ok(manifests.every((manifest) => manifest.items[0].status === 'deleted'));
});

test('delete removes every canonical duplicate and records exact line bytes and offsets', async (t) => {
  const fileName = 'résumé.md';
  const firstLine = `- [Résumé](${fileName}) — first\r`;
  const secondLine = `- [Résumé](${fileName}) — second\r`;
  const finalLine = `- [Résumé](${fileName}) — final`;
  const indexBytes = Buffer.from(`${firstLine}keep\n${secondLine}middle\n${finalLine}`);
  const { memoryDir, server, stateDir } = await makeServer(
    t,
    { [fileName]: '# Résumé\n' },
    indexBytes,
  );
  const [card] = await cards(server);

  const response = await apply(server, [{
    id: card.id,
    action: 'delete',
    expectedHash: card.hash,
  }]);

  assert.equal(response.json.results[0].status, 'applied');
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), Buffer.from('keep\nmiddle\n'));
  const { runPath } = await onlyTrashRun(stateDir);
  const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.items[0].indexLine, firstLine);
  assert.deepEqual(manifest.items[0].indexLines, [
    { line: firstLine, offset: 0 },
    { line: secondLine, offset: Buffer.byteLength(`${firstLine}keep\n`) },
    { line: finalLine, offset: Buffer.byteLength(`${firstLine}keep\n${secondLine}middle\n`) },
  ]);
});

test('surgical index rollback preserves bytes appended after the delete rewrite', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-index-rollback-'));
  const indexPath = join(directory, 'MEMORY.md');
  const lineBytes = Buffer.from('- [One](one.md) — restored\r\n');
  const prefix = Buffer.from('# Index\n');
  const suffix = Buffer.from('- [Other](other.md) — unchanged\n');
  const appended = Buffer.from('- [New](new.md) — written concurrently\n');
  await writeFile(indexPath, Buffer.concat([prefix, suffix, appended]));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await restoreIndexLines({ indexPath, fileName: 'one.md' }, {
    bytes: Buffer.concat([prefix, lineBytes, suffix]),
    lines: [{ offset: prefix.length, bytes: lineBytes }],
  });

  assert.deepEqual(
    await readFile(indexPath),
    Buffer.concat([prefix, lineBytes, suffix, appended]),
  );
});

test('index removal revalidates a stale snapshot and preserves external bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-index-revalidate-'));
  const indexPath = join(directory, 'MEMORY.md');
  const targetLine = Buffer.from('- [One](one.md) — remove\n');
  const prefix = Buffer.from('# Index\n');
  const suffix = Buffer.from('- [Other](other.md) — unchanged\n');
  const external = Buffer.from('- [New](new.md) — external append\n');
  const initialBytes = Buffer.concat([prefix, targetLine, suffix]);
  await writeFile(indexPath, initialBytes);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = { indexPath, fileName: 'one.md' };
  const stale = await readIndexForDelete(indexPath, target.fileName);
  await appendFile(indexPath, external);
  const persistedSnapshots = [];

  const result = await rewriteIndexForDelete(target, stale, async (snapshot) => {
    persistedSnapshots.push(snapshot.bytes);
  });

  assert.equal(result.changed, true);
  assert.equal(persistedSnapshots.length, 2);
  assert.deepEqual(persistedSnapshots[0], initialBytes);
  assert.deepEqual(persistedSnapshots[1], Buffer.concat([initialBytes, external]));
  assert.deepEqual(await readFile(indexPath), Buffer.concat([prefix, suffix, external]));
});

test('index removal retries when external bytes arrive while its temp file is prepared', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-index-rewrite-race-'));
  const indexPath = join(directory, 'MEMORY.md');
  const targetLine = Buffer.from('- [One](one.md) — remove\n');
  const padding = Buffer.alloc(128 * 1024 * 1024, 0x20);
  const external = Buffer.from('\n- [New](new.md) — external during temp write\n');
  await writeFile(indexPath, Buffer.concat([targetLine, padding]));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = { indexPath, fileName: 'one.md' };
  const initial = await readIndexForDelete(indexPath, target.fileName);

  const rewriting = rewriteIndexForDelete(target, initial);
  await waitFor('the index rewrite temp file', async () => (
    (await readdir(directory)).some((name) => name.startsWith('.MEMORY.md.') && name.endsWith('.tmp'))
  ));
  await appendFile(indexPath, external);
  await rewriting;

  const finalBytes = await readFile(indexPath);
  assert.equal(finalBytes.length, padding.length + external.length);
  assert.deepEqual(finalBytes.subarray(0, padding.length), padding);
  assert.deepEqual(finalBytes.subarray(-external.length), external);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('conservative index rollback preserves arbitrary edits and never duplicates restored lines', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-index-conservative-rollback-'));
  const indexPath = join(directory, 'MEMORY.md');
  const targetLine = Buffer.from('- [One](one.md) — restored\r\n');
  const originalPrefix = Buffer.from('# Original\n');
  const originalSuffix = Buffer.from('- [Other](other.md) — old\n');
  const originalBytes = Buffer.concat([originalPrefix, targetLine, originalSuffix]);
  const externallyEdited = Buffer.from('# External prepend\n- [Other](other.md) — edited without newline');
  await writeFile(indexPath, externallyEdited);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = { indexPath, fileName: 'one.md' };
  const originalIndex = {
    bytes: originalBytes,
    lines: [{ offset: originalPrefix.length, bytes: targetLine }],
  };

  await restoreIndexLines(target, originalIndex);
  const once = await readFile(indexPath);
  assert.deepEqual(once, Buffer.concat([externallyEdited, Buffer.from('\n'), targetLine]));
  await restoreIndexLines(target, originalIndex);
  assert.deepEqual(await readFile(indexPath), once);
});

test('rollback treats an existing changed-hook target as already restored', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-index-changed-hook-'));
  const indexPath = join(directory, 'MEMORY.md');
  const savedLine = Buffer.from('- [One](one.md) — old hook\n');
  const currentLine = Buffer.from('- [Renamed](one.md) — new hook\n');
  await writeFile(indexPath, currentLine);
  t.after(() => rm(directory, { recursive: true, force: true }));

  await restoreIndexLines({ indexPath, fileName: 'one.md' }, {
    bytes: savedLine,
    lines: [{ offset: 0, bytes: savedLine }],
  });

  assert.deepEqual(await readFile(indexPath), currentLine);
});

test('rollback retries when external bytes arrive while its temp file is prepared', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-index-rollback-race-'));
  const indexPath = join(directory, 'MEMORY.md');
  const targetLine = Buffer.from('- [One](one.md) — restore\n');
  const padding = Buffer.alloc(128 * 1024 * 1024, 0x20);
  const external = Buffer.from('\n- [New](new.md) — external during rollback\n');
  const originalBytes = Buffer.concat([targetLine, padding]);
  await writeFile(indexPath, padding);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = { indexPath, fileName: 'one.md' };

  const restoring = restoreIndexLines(target, {
    bytes: originalBytes,
    lines: [{ offset: 0, bytes: targetLine }],
  });
  await waitFor('the index rollback temp file', async () => (
    (await readdir(directory)).some((name) => name.startsWith('.MEMORY.md.') && name.endsWith('.tmp'))
  ));
  await appendFile(indexPath, external);
  await restoring;

  assert.deepEqual(await readFile(indexPath), Buffer.concat([originalBytes, external]));
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('multiple deletes in one apply share one consistent manifest', async (t) => {
  const oneBytes = Buffer.from('# One\n');
  const twoBytes = Buffer.from('# Two\n');
  const { server, stateDir } = await makeServer(t, {
    'one.md': oneBytes,
    'two.md': twoBytes,
  }, Buffer.from('- [One](one.md) — first\n- [Two](two.md) — second\n'));
  const currentCards = await cards(server);

  const response = await apply(server, currentCards.map((card) => ({
    id: card.id,
    action: 'delete',
    expectedHash: card.hash,
  })));

  assert.deepEqual(response.json.results, currentCards.map((card) => ({
    id: card.id,
    action: 'delete',
    status: 'applied',
  })));
  const { runPath } = await onlyTrashRun(stateDir);
  const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
  assert.deepEqual(
    manifest.items.map(({ id, status }) => ({ id, status })),
    currentCards.map((card) => ({ id: card.id, status: 'deleted' })),
  );
  assert.deepEqual(await readFile(join(runPath, 'project', 'one.md')), oneBytes);
  assert.deepEqual(await readFile(join(runPath, 'project', 'two.md')), twoBytes);
});

test('cross-device delete copies exclusively before unlinking the verified source', async (t) => {
  let stateDir;
  try {
    if ((await stat(tmpdir())).dev === (await stat('/dev/shm')).dev) {
      t.skip('No writable alternate filesystem is available.');
      return;
    }
    stateDir = await mkdtemp('/dev/shm/scmd-delete-state-');
  } catch {
    t.skip('No writable alternate filesystem is available.');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'scmd-delete-exdev-root-'));
  const memoryDir = join(root, 'project', 'memory');
  const memoryBytes = Buffer.from('# Cross device\n');
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, 'one.md'), memoryBytes);
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
  const [one] = await cards(server);

  const response = await apply(server, [{ id: one.id, action: 'delete', expectedHash: one.hash }]);

  assert.equal(response.json.results[0].status, 'applied');
  await assert.rejects(access(join(memoryDir, 'one.md')), { code: 'ENOENT' });
  const { runPath } = await onlyTrashRun(stateDir);
  assert.deepEqual(await readFile(join(runPath, 'project', 'one.md')), memoryBytes);
});

test('simulated cross-device move supports a near-NAME_MAX destination basename', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-delete-long-exdev-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'source.md');
  const destinationPath = join(directory, `${'a'.repeat(230)}.md`);
  const bytes = Buffer.from('# Long cross-device memory\n');
  await writeFile(sourcePath, bytes);
  const stats = await stat(sourcePath, { bigint: true });
  const source = { stats, mode: Number(stats.mode & 0o7777n) };
  const expectedHash = createHash('sha256').update(bytes).digest('hex');
  let firstLink = true;

  const result = await moveFileNoReplace(sourcePath, destinationPath, source, expectedHash, {
    linkFile: async (from, to) => {
      if (firstLink) {
        firstLink = false;
        const error = new Error('simulated cross-device link');
        error.code = 'EXDEV';
        throw error;
      }
      return link(from, to);
    },
  });

  assert.equal(result.sourceRemoved, true);
  await assert.rejects(access(sourcePath), { code: 'ENOENT' });
  assert.deepEqual(await readFile(destinationPath), bytes);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('a source-unlink failure removes only its uncommitted trash link and does not poison the next delete', {
  skip: process.platform === 'win32' ? 'directory mode enforcement differs on Windows' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-delete-unlink-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-delete-unlink-state-'));
  const firstMemoryDir = join(root, 'first-project', 'memory');
  const secondMemoryDir = join(root, 'second-project', 'memory');
  const firstBytes = Buffer.from('# First\n');
  const secondBytes = Buffer.from('# Second\n');
  await mkdir(firstMemoryDir, { recursive: true });
  await mkdir(secondMemoryDir, { recursive: true });
  await writeFile(join(firstMemoryDir, 'first.md'), firstBytes);
  await writeFile(join(secondMemoryDir, 'second.md'), secondBytes);
  t.after(() => chmod(firstMemoryDir, 0o700).catch(() => {}));
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
  const currentCards = await cards(server);
  const first = currentCards.find((card) => card.fileName === 'first.md');
  const second = currentCards.find((card) => card.fileName === 'second.md');
  await chmod(firstMemoryDir, 0o500);
  try {
    await writeFile(join(firstMemoryDir, '.permission-probe'), 'probe', { flag: 'wx' });
    await rm(join(firstMemoryDir, '.permission-probe'), { force: true });
    await chmod(firstMemoryDir, 0o700);
    t.skip('Directory permissions are not enforceable for this process.');
    return;
  } catch (error) {
    assert.ok(error && ['EACCES', 'EPERM'].includes(error.code));
  }

  const response = await apply(server, [
    { id: first.id, action: 'delete', expectedHash: first.hash },
    { id: second.id, action: 'delete', expectedHash: second.hash },
  ]);
  await chmod(firstMemoryDir, 0o700);

  assert.deepEqual(response.json.results, [
    { id: first.id, action: 'delete', status: 'error', reason: 'delete-failed' },
    { id: second.id, action: 'delete', status: 'applied' },
  ]);
  assert.deepEqual(await readFile(join(firstMemoryDir, 'first.md')), firstBytes);
  await assert.rejects(access(join(secondMemoryDir, 'second.md')), { code: 'ENOENT' });
  const { runPath } = await onlyTrashRun(stateDir);
  await assert.rejects(access(join(runPath, 'first-project', 'first.md')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(runPath, 'second-project', 'second.md')), secondBytes);
  const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.items.map((item) => item.id), [second.id]);
  assert.equal(
    (await listTree(stateDir)).some((name) => name.includes('.tmp') || name.endsWith('.lock')),
    false,
  );
});

test('an unproven linked-destination cleanup retains a rollback-incomplete manifest', {
  skip: process.platform === 'win32' ? 'directory mode enforcement differs on Windows' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-delete-partial-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-delete-partial-state-'));
  const projectId = 'project';
  const fileName = 'one.md';
  const memoryDir = join(root, projectId, 'memory');
  const filePath = join(memoryDir, fileName);
  const memoryBytes = Buffer.from('# One\n');
  await mkdir(memoryDir, { recursive: true });
  await writeFile(filePath, memoryBytes);
  t.after(() => chmod(memoryDir, 0o700).catch(() => {}));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const memoryStats = await stat(memoryDir, { bigint: true });
  const hash = createHash('sha256').update(memoryBytes).digest('hex');
  const target = {
    projectId,
    fileName,
    memoryPath: memoryDir,
    memoryRealPath: await realpath(memoryDir),
    rootRealPath: await realpath(root),
    memoryDev: memoryStats.dev,
    memoryIno: memoryStats.ino,
    filePath,
    indexPath: join(memoryDir, 'MEMORY.md'),
    card: {
      id: `${projectId}/${fileName}`,
      hash,
      name: 'One',
      summary: 'One',
    },
  };
  const run = await createTrashRun(stateDir);
  await chmod(memoryDir, 0o500);
  try {
    await writeFile(join(memoryDir, '.permission-probe'), 'probe', { flag: 'wx' });
    await rm(join(memoryDir, '.permission-probe'), { force: true });
    await chmod(memoryDir, 0o700);
    t.skip('Directory permissions are not enforceable for this process.');
    return;
  } catch (error) {
    assert.ok(error && ['EACCES', 'EPERM'].includes(error.code));
  }
  const cleanupFile = async () => false;
  const moveFile = (...args) => moveFileNoReplace(
    ...args,
    { unlinkDestination: cleanupFile },
  );

  await assert.rejects(
    applyDelete(target, run, new Date().toISOString(), stateDir, hash, {
      cleanupFile,
      moveFile,
    }),
    (error) => error && error.code === 'move-cleanup-incomplete',
  );
  await chmod(memoryDir, 0o700);

  assert.deepEqual(await readFile(filePath), memoryBytes);
  assert.deepEqual(await readFile(join(run.runPath, projectId, fileName)), memoryBytes);
  const manifest = JSON.parse(await readFile(run.manifestPath, 'utf8'));
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].status, 'rollback-incomplete');
  assert.equal((await listTree(stateDir)).some((name) => name.includes('.tmp')), false);
});

test('delete does not remove the index when Claude recreates the source after the move', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-delete-recreated-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-delete-recreated-state-'));
  const projectId = 'project';
  const fileName = 'one.md';
  const memoryDir = join(root, projectId, 'memory');
  const filePath = join(memoryDir, fileName);
  const originalBytes = Buffer.from('# Original\n');
  const claudeBytes = Buffer.from('# Recreated by Claude\n');
  const indexBytes = Buffer.from('- [One](one.md) — original\n');
  await mkdir(memoryDir, { recursive: true });
  await writeFile(filePath, originalBytes);
  await writeFile(join(memoryDir, 'MEMORY.md'), indexBytes);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const memoryStats = await stat(memoryDir, { bigint: true });
  const hash = createHash('sha256').update(originalBytes).digest('hex');
  const target = {
    projectId,
    fileName,
    memoryPath: memoryDir,
    memoryRealPath: await realpath(memoryDir),
    rootRealPath: await realpath(root),
    memoryDev: memoryStats.dev,
    memoryIno: memoryStats.ino,
    filePath,
    indexPath: join(memoryDir, 'MEMORY.md'),
    card: {
      id: `${projectId}/${fileName}`,
      hash,
      name: 'One',
      summary: 'One',
    },
  };
  const run = await createTrashRun(stateDir);
  const moveFile = async (...args) => {
    const moved = await moveFileNoReplace(...args);
    await writeFile(filePath, claudeBytes);
    return moved;
  };

  await assert.rejects(
    applyDelete(target, run, new Date().toISOString(), stateDir, hash, { moveFile }),
    (error) => error && ['memory-recreated', 'EEXIST'].includes(error.code),
  );

  assert.deepEqual(await readFile(filePath), claudeBytes);
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
  assert.deepEqual(await readFile(join(run.runPath, projectId, fileName)), originalBytes);
  const manifest = JSON.parse(await readFile(run.manifestPath, 'utf8'));
  assert.equal(manifest.items[0].status, 'rollback-incomplete');
});

test('delete rolls back after Claude recreates the source during the final manifest commit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-delete-final-manifest-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-delete-final-manifest-state-'));
  const projectId = 'project';
  const fileName = 'one.md';
  const memoryDir = join(root, projectId, 'memory');
  const filePath = join(memoryDir, fileName);
  const originalBytes = Buffer.from('# Original\n');
  const claudeBytes = Buffer.from('# Recreated during manifest commit\n');
  const indexBytes = Buffer.from('- [One](one.md) — original\n');
  await mkdir(memoryDir, { recursive: true });
  await writeFile(filePath, originalBytes);
  await writeFile(join(memoryDir, 'MEMORY.md'), indexBytes);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const memoryStats = await stat(memoryDir, { bigint: true });
  const hash = createHash('sha256').update(originalBytes).digest('hex');
  const target = {
    projectId,
    fileName,
    memoryPath: memoryDir,
    memoryRealPath: await realpath(memoryDir),
    rootRealPath: await realpath(root),
    memoryDev: memoryStats.dev,
    memoryIno: memoryStats.ino,
    filePath,
    indexPath: join(memoryDir, 'MEMORY.md'),
    card: {
      id: `${projectId}/${fileName}`,
      hash,
      name: 'One',
      summary: 'One',
    },
  };
  const run = await createTrashRun(stateDir);

  await assert.rejects(
    applyDelete(target, run, new Date().toISOString(), stateDir, hash, {
      afterFinalManifestCommit: () => writeFile(filePath, claudeBytes),
    }),
    (error) => error && ['memory-recreated', 'EEXIST'].includes(error.code),
  );

  assert.deepEqual(await readFile(filePath), claudeBytes);
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
  assert.deepEqual(await readFile(join(run.runPath, projectId, fileName)), originalBytes);
  const manifest = JSON.parse(await readFile(run.manifestPath, 'utf8'));
  assert.equal(manifest.items[0].status, 'rollback-incomplete');
});

test('move preserves its destination when the source disappears before unlink', async (t) => {
  async function exercise(branch, subtest) {
    const directory = await mkdtemp(join(tmpdir(), `scmd-delete-move-order-${branch}-`));
    subtest.after(() => rm(directory, { recursive: true, force: true }));
    const sourcePath = join(directory, 'source.md');
    const renamedSourcePath = join(directory, 'source-renamed.md');
    const destinationPath = join(directory, 'destination.md');
    const bytes = Buffer.from(`# ${branch}\n`);
    await writeFile(sourcePath, bytes);
    const stats = await stat(sourcePath, { bigint: true });
    const source = { stats, mode: Number(stats.mode & 0o7777n) };
    const expectedHash = createHash('sha256').update(bytes).digest('hex');
    let cleanupCalls = 0;
    let firstLink = true;
    const options = {
      beforeSourceUnlink: async () => rename(sourcePath, renamedSourcePath),
      unlinkDestination: async () => {
        cleanupCalls += 1;
        return true;
      },
    };
    if (branch === 'exdev') {
      options.linkFile = async (from, to) => {
        if (firstLink) {
          firstLink = false;
          const error = new Error('simulated cross-device link');
          error.code = 'EXDEV';
          throw error;
        }
        return link(from, to);
      };
    }

    await assert.rejects(
      moveFileNoReplace(sourcePath, destinationPath, source, expectedHash, options),
      (error) => (
        error
        && error.code === 'move-cleanup-incomplete'
        && error.partialMove
        && error.partialMove.sourcePreserved === false
      ),
    );
    assert.equal(cleanupCalls, 0);
    await assert.rejects(access(sourcePath), { code: 'ENOENT' });
    assert.deepEqual(await readFile(renamedSourcePath), bytes);
    assert.deepEqual(await readFile(destinationPath), bytes);
  }

  await t.test('same filesystem hard link', (subtest) => exercise('samefs', subtest));
  await t.test('cross-device copy fallback', (subtest) => exercise('exdev', subtest));
});

test('delete refuses symlinked index and trash targets without mutating their targets', {
  skip: process.platform === 'win32' ? 'symlink creation may require elevated privileges' : false,
}, async (t) => {
  await t.test('symlinked MEMORY.md', async (t) => {
    const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
    const outsidePath = join(dirname(stateDir), `${basename(stateDir)}-outside-index.md`);
    const outsideBytes = Buffer.from('- [One](one.md) — outside\n');
    await writeFile(outsidePath, outsideBytes);
    await symlink(outsidePath, join(memoryDir, 'MEMORY.md'));
    t.after(() => rm(outsidePath, { force: true }));
    const [one] = await cards(server);

    const response = await apply(server, [{ id: one.id, action: 'delete', expectedHash: one.hash }]);

    assert.deepEqual(response.json.results, [{
      id: one.id,
      action: 'delete',
      status: 'error',
      reason: 'delete-failed',
    }]);
    assert.deepEqual(await readFile(join(memoryDir, 'one.md')), Buffer.from('# One\n'));
    assert.deepEqual(await readFile(outsidePath), outsideBytes);
    assert.deepEqual(await readdir(stateDir), []);
  });

  await t.test('symlinked trash directory', async (t) => {
    const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': '# One\n' });
    const outsideDir = await mkdtemp(join(tmpdir(), 'scmd-delete-outside-trash-'));
    t.after(() => rm(outsideDir, { recursive: true, force: true }));
    await symlink(outsideDir, join(stateDir, 'trash'));
    const [one] = await cards(server);

    const response = await apply(server, [{ id: one.id, action: 'delete', expectedHash: one.hash }]);

    assert.deepEqual(response.json.results, [{
      id: one.id,
      action: 'delete',
      status: 'error',
      reason: 'delete-failed',
    }]);
    assert.deepEqual(await readFile(join(memoryDir, 'one.md')), Buffer.from('# One\n'));
    assert.deepEqual(await readdir(outsideDir), []);
  });
});

test('a late manifest transition failure rolls the memory and index back byte-for-byte', {
  skip: process.platform === 'win32' ? 'directory mode enforcement differs on Windows' : false,
}, async (t) => {
  const oneBytes = Buffer.from('# One\n');
  const padding = '- [Other](other.md) — unchanged\n'.repeat(300_000);
  const indexBytes = Buffer.from(`${padding}- [One](one.md) — remove then restore\r\n`);
  const { memoryDir, projectId, server, stateDir } = await makeServer(
    t,
    { 'one.md': oneBytes },
    indexBytes,
  );
  const [one] = await cards(server);

  const applying = apply(server, [{ id: one.id, action: 'delete', expectedHash: one.hash }]);
  const trappedRunPath = await waitForPendingManifest(stateDir);
  await chmod(trappedRunPath, 0o500);
  t.after(() => chmod(trappedRunPath, 0o700).catch(() => {}));
  await waitFor('the memory move into trash', async () => {
    try {
      await access(join(memoryDir, 'one.md'));
      return false;
    } catch (error) {
      return error && error.code === 'ENOENT';
    }
  });
  const response = await applying;
  await chmod(trappedRunPath, 0o700);

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'delete',
    status: 'error',
    reason: 'delete-failed',
  }]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), oneBytes);
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
  await assert.rejects(access(join(trappedRunPath, projectId, 'one.md')), { code: 'ENOENT' });
  const manifest = JSON.parse(await readFile(join(trappedRunPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.items[0].status, 'pending');
  assert.equal((await listTree(stateDir)).some((name) => name.includes('.tmp')), false);
});

test('a delete failure with a durable pending record uses a fresh run for the next decision', {
  skip: process.platform === 'win32' ? 'directory mode enforcement differs on Windows' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-delete-abandon-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-delete-abandon-state-'));
  const firstMemoryDir = join(root, 'first-project', 'memory');
  const secondMemoryDir = join(root, 'second-project', 'memory');
  const firstBytes = Buffer.from('# First\n');
  const secondBytes = Buffer.from('# Second\n');
  const firstIndex = Buffer.from(
    `${'- [Other](other.md) — unchanged\n'.repeat(300_000)}- [First](first.md) — restore\n`,
  );
  await mkdir(firstMemoryDir, { recursive: true });
  await mkdir(secondMemoryDir, { recursive: true });
  await writeFile(join(firstMemoryDir, 'first.md'), firstBytes);
  await writeFile(join(firstMemoryDir, 'MEMORY.md'), firstIndex);
  await writeFile(join(secondMemoryDir, 'second.md'), secondBytes);
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
  const currentCards = await cards(server);
  const first = currentCards.find((card) => card.fileName === 'first.md');
  const second = currentCards.find((card) => card.fileName === 'second.md');
  const applying = apply(server, [
    { id: first.id, action: 'delete', expectedHash: first.hash },
    { id: second.id, action: 'delete', expectedHash: second.hash },
  ]);
  const failedRunPath = await waitForPendingManifest(stateDir);
  await chmod(failedRunPath, 0o500);
  t.after(() => chmod(failedRunPath, 0o700).catch(() => {}));
  await waitFor('the first memory move into trash', async () => {
    try {
      await access(join(firstMemoryDir, 'first.md'));
      return false;
    } catch (error) {
      return error && error.code === 'ENOENT';
    }
  });
  const response = await applying;
  await chmod(failedRunPath, 0o700);

  assert.deepEqual(response.json.results, [
    { id: first.id, action: 'delete', status: 'error', reason: 'delete-failed' },
    { id: second.id, action: 'delete', status: 'applied' },
  ]);
  assert.deepEqual(await readFile(join(firstMemoryDir, 'first.md')), firstBytes);
  assert.deepEqual(await readFile(join(firstMemoryDir, 'MEMORY.md')), firstIndex);
  await assert.rejects(access(join(secondMemoryDir, 'second.md')), { code: 'ENOENT' });

  const runNames = await readdir(join(stateDir, 'trash'));
  assert.equal(runNames.length, 2);
  const runs = await Promise.all(runNames.map(async (runName) => {
    const runPath = join(stateDir, 'trash', runName);
    return {
      manifest: JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8')),
      runPath,
    };
  }));
  const failedRun = runs.find(({ manifest }) => manifest.items[0].id === first.id);
  const successfulRun = runs.find(({ manifest }) => manifest.items[0].id === second.id);
  assert.equal(failedRun.manifest.items[0].status, 'pending');
  await assert.rejects(
    access(join(failedRun.runPath, 'first-project', 'first.md')),
    { code: 'ENOENT' },
  );
  assert.equal(successfulRun.manifest.items[0].status, 'deleted');
  assert.deepEqual(
    await readFile(join(successfulRun.runPath, 'second-project', 'second.md')),
    secondBytes,
  );
});

test('rollback never overwrites a memory recreated after it moved to trash', {
  skip: process.platform === 'win32' ? 'directory mode enforcement differs on Windows' : false,
}, async (t) => {
  const originalBytes = Buffer.from('# Original\n');
  const replacementBytes = Buffer.from('# Recreated by Claude\n');
  const padding = '- [Other](other.md) — unchanged\n'.repeat(300_000);
  const indexBytes = Buffer.from(`${padding}- [One](one.md) — original\n`);
  const { memoryDir, projectId, server, stateDir } = await makeServer(
    t,
    { 'one.md': originalBytes },
    indexBytes,
  );
  const [one] = await cards(server);

  const applying = apply(server, [{ id: one.id, action: 'delete', expectedHash: one.hash }]);
  const runPath = await waitForPendingManifest(stateDir);
  await chmod(runPath, 0o500);
  t.after(() => chmod(runPath, 0o700).catch(() => {}));
  await waitFor('the original memory to move into trash', async () => {
    try {
      await access(join(memoryDir, 'one.md'));
      return false;
    } catch (error) {
      return error && error.code === 'ENOENT';
    }
  });
  await writeFile(join(memoryDir, 'one.md'), replacementBytes);
  const response = await applying;
  await chmod(runPath, 0o700);

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'delete',
    status: 'error',
    reason: 'delete-failed',
  }]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), replacementBytes);
  assert.deepEqual(await readFile(join(runPath, projectId, 'one.md')), originalBytes);
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
  const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.items[0].status, 'pending');
  assert.equal((await listTree(stateDir)).some((name) => name.includes('.tmp')), false);
});

test('a failed first delete discards its empty run before a later delete succeeds', {
  skip: process.platform === 'win32' ? 'symlink creation may require elevated privileges' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-delete-isolation-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-delete-isolation-state-'));
  const firstMemoryDir = join(root, 'first-project', 'memory');
  const secondMemoryDir = join(root, 'second-project', 'memory');
  await mkdir(firstMemoryDir, { recursive: true });
  await mkdir(secondMemoryDir, { recursive: true });
  await writeFile(join(firstMemoryDir, 'first.md'), '# First\n');
  await writeFile(join(secondMemoryDir, 'second.md'), '# Second\n');
  const secondIndex = Buffer.from('- [Second](second.md) — valid\n');
  await writeFile(join(secondMemoryDir, 'MEMORY.md'), secondIndex);
  const outsideIndex = join(dirname(stateDir), `${basename(stateDir)}-outside-index.md`);
  const outsideBytes = Buffer.from('- [First](first.md) — outside\n');
  await writeFile(outsideIndex, outsideBytes);
  await symlink(outsideIndex, join(firstMemoryDir, 'MEMORY.md'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  t.after(() => rm(outsideIndex, { force: true }));

  const server = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  const currentCards = await cards(server);
  const first = currentCards.find((card) => card.fileName === 'first.md');
  const second = currentCards.find((card) => card.fileName === 'second.md');

  const response = await apply(server, [
    { id: first.id, action: 'delete', expectedHash: first.hash },
    { id: second.id, action: 'delete', expectedHash: second.hash },
  ]);

  assert.deepEqual(response.json.results, [
    { id: first.id, action: 'delete', status: 'error', reason: 'delete-failed' },
    { id: second.id, action: 'delete', status: 'applied' },
  ]);
  assert.deepEqual(await readFile(join(firstMemoryDir, 'first.md')), Buffer.from('# First\n'));
  assert.deepEqual(await readFile(outsideIndex), outsideBytes);
  await assert.rejects(access(join(secondMemoryDir, 'second.md')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(secondMemoryDir, 'MEMORY.md')), Buffer.alloc(0));

  const { runPath } = await onlyTrashRun(stateDir);
  assert.deepEqual(
    await readFile(join(runPath, 'second-project', 'second.md')),
    Buffer.from('# Second\n'),
  );
  const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.items.map((item) => item.id), [second.id]);
  assert.equal((await listTree(stateDir)).some((name) => name.includes('.tmp')), false);
});

test('a harmless middle failure keeps successful deletes in one run', {
  skip: process.platform === 'win32' ? 'symlink creation may require elevated privileges' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-delete-grouping-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-delete-grouping-state-'));
  const outsideIndex = join(dirname(stateDir), `${basename(stateDir)}-outside-index.md`);
  const outsideBytes = Buffer.from('- [B](b.md) — outside\n');
  await writeFile(outsideIndex, outsideBytes);
  for (const [projectId, fileName] of [
    ['project-a', 'a.md'],
    ['project-b', 'b.md'],
    ['project-c', 'c.md'],
  ]) {
    const memoryDir = join(root, projectId, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(join(memoryDir, fileName), `# ${projectId}\n`);
  }
  await symlink(outsideIndex, join(root, 'project-b', 'memory', 'MEMORY.md'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  t.after(() => rm(outsideIndex, { force: true }));
  const server = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  const currentCards = await cards(server);
  const a = currentCards.find((card) => card.fileName === 'a.md');
  const b = currentCards.find((card) => card.fileName === 'b.md');
  const c = currentCards.find((card) => card.fileName === 'c.md');

  const response = await apply(server, [a, b, c].map((card) => ({
    id: card.id,
    action: 'delete',
    expectedHash: card.hash,
  })));

  assert.deepEqual(response.json.results, [
    { id: a.id, action: 'delete', status: 'applied' },
    { id: b.id, action: 'delete', status: 'error', reason: 'delete-failed' },
    { id: c.id, action: 'delete', status: 'applied' },
  ]);
  assert.deepEqual(await readFile(outsideIndex), outsideBytes);
  assert.deepEqual(await readFile(join(root, 'project-b', 'memory', 'b.md')), Buffer.from('# project-b\n'));
  const { runPath } = await onlyTrashRun(stateDir);
  const manifest = JSON.parse(await readFile(join(runPath, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.items.map((item) => item.id), [a.id, c.id]);
  assert.deepEqual(
    await readFile(join(runPath, 'project-a', 'a.md')),
    Buffer.from('# project-a\n'),
  );
  assert.deepEqual(
    await readFile(join(runPath, 'project-c', 'c.md')),
    Buffer.from('# project-c\n'),
  );
});
