const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http = require('node:http');
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

const { applyEdit, createMemoryCard } = require('../server');
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
  const root = await mkdtemp(join(tmpdir(), 'scmd-edit-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-edit-state-'));
  const memoryDir = join(root, 'project', 'memory');
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
  return { memoryDir, root, server, stateDir };
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

async function directTarget(root, memoryDir, fileName, bytes) {
  const [rootRealPath, memoryRealPath, memoryStats, fileStats] = await Promise.all([
    realpath(root),
    realpath(memoryDir),
    lstat(memoryDir, { bigint: true }),
    stat(join(memoryDir, fileName)),
  ]);
  return {
    projectId: 'project',
    fileName,
    memoryPath: memoryDir,
    memoryRealPath,
    rootRealPath,
    memoryDev: memoryStats.dev,
    memoryIno: memoryStats.ino,
    filePath: join(memoryDir, fileName),
    indexPath: join(memoryDir, 'MEMORY.md'),
    card: createMemoryCard({ projectId: 'project', fileName, bytes, mtime: fileStats.mtime }),
  };
}

test('edit writes exact content and changes only the matching index hook', async (t) => {
  const original = [
    '---',
    'name: One',
    'description: Old hook.',
    'type: project',
    '---',
    '',
    'Old body.',
    '',
  ].join('\n');
  const edited = original
    .replace('name: One', 'name: Renamed')
    .replace('description: Old hook.', 'description: New hook.')
    .replace('Old body.', 'New body.');
  const indexBefore = Buffer.from([
    '# Memory index\r\n',
    '- [Custom title](one.md) — Old hook.\r\n',
    '- [Two](two.md) — Leave this alone.\n',
    'Tail without newline',
  ].join(''));
  const appended = Buffer.from('\r\n- [Concurrent](new.md) — Written during review.\r\n');
  const { memoryDir, server } = await makeServer(t, {
    'one.md': original,
  }, indexBefore);
  const [one] = await cards(server);
  await appendFile(join(memoryDir, 'MEMORY.md'), appended);

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.equal(response.status, 200);
  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'edit',
    status: 'applied',
  }]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), Buffer.from(edited));
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.concat([
      Buffer.from(indexBefore.toString('utf8').replace(' — Old hook.', ' — New hook.')),
      appended,
    ]),
  );
});

test('an unchanged description still fails closed and rolls back when index safety is unknown', {
  skip: process.platform === 'win32' ? 'symlink creation may require elevated privileges' : false,
}, async (t) => {
  const original = '---\nname: One\ndescription: "Same hook."\n---\nOld body.\n';
  const edited = '---\nname: Renamed\ndescription: Same hook.\ntype: project\n---\nNew body.\n';
  const outsideIndex = join(tmpdir(), `scmd-edit-outside-${process.pid}-${Date.now()}.md`);
  const outsideBytes = Buffer.from('- [One](one.md) — Same hook.\n');
  await writeFile(outsideIndex, outsideBytes);
  t.after(() => rm(outsideIndex, { force: true }));
  const { memoryDir, server } = await makeServer(t, { 'one.md': original });
  await symlink(outsideIndex, join(memoryDir, 'MEMORY.md'));
  const [one] = await cards(server);

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'edit',
    status: 'error',
    reason: 'edit-failed',
  }]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), Buffer.from(original));
  assert.deepEqual(await readFile(outsideIndex), outsideBytes);
});

test('a body-only edit leaves a regular matching index byte-identical', async (t) => {
  const original = '---\nname: One\ndescription: Same hook.\n---\nOld body.\n';
  const edited = original.replace('Old body.', 'New body.');
  const indexBytes = Buffer.from('\t- [Odd title](one.md) — Same hook.  \r\nTail');
  const { memoryDir, server } = await makeServer(t, { 'one.md': original }, indexBytes);
  const [one] = await cards(server);

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.equal(response.json.results[0].status, 'applied');
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
});

test('a changed description appends a well-formed line without regenerating the index', async (t) => {
  const original = '---\nname: Old name\ndescription: Old hook.\n---\nBody.\n';
  const edited = '---\nname: New [name]\ndescription: New hook.\n---\nBody.\n';
  const indexBefore = Buffer.from('# Notes\r\nTail without newline');
  const { memoryDir, server } = await makeServer(t, { 'one.md': original }, indexBefore);
  const [one] = await cards(server);

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'edit',
    status: 'applied',
  }]);
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from('# Notes\r\nTail without newline\n- [New \\[name\\]](one.md) — New hook.\n'),
  );
  const projects = await request(server, '/api/projects?includeReviewed=1');
  assert.deepEqual(projects.json.projects[0].unindexed, []);
});

test('a changed description creates a missing index atomically with a private mode', {
  skip: process.platform === 'win32' ? 'POSIX mode assertion does not apply on Windows' : false,
}, async (t) => {
  const original = '---\nname: One\ndescription: Old hook.\n---\nBody.\n';
  const edited = original.replace('Old hook.', 'New hook.');
  const { memoryDir, server } = await makeServer(t, { 'one.md': original });
  const [one] = await cards(server);

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.equal(response.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from('- [One](one.md) — New hook.\n'),
  );
  assert.equal((await stat(join(memoryDir, 'MEMORY.md'))).mode & 0o777, 0o600);
  assert.equal((await readdir(memoryDir)).some((name) => name.includes('.tmp')), false);
});

test('an edit appends a missing index line even when the description is unchanged', async (t) => {
  const original = '---\nname: One\ndescription: Same hook.\n---\nOld body.\n';
  const edited = original.replace('Old body.', 'New body.');
  const { memoryDir, server } = await makeServer(t, { 'one.md': original });
  const [one] = await cards(server);

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.equal(response.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from('- [One](one.md) — Same hook.\n'),
  );
});

test('adding a hook to a matching line without a separator preserves its existing suffix', async (t) => {
  const original = '---\nname: One\ndescription: Old hook.\n---\nBody.\n';
  const edited = original.replace('Old hook.', 'New hook.');
  const indexBefore = Buffer.from('- [One](one.md)  # keep this note\r');
  const { memoryDir, server } = await makeServer(t, { 'one.md': original }, indexBefore);
  const [one] = await cards(server);

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.equal(response.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from('- [One](one.md)  # keep this note — New hook.\r'),
  );
});

test('edit updates duplicate live hooks, ignores fenced examples, and preserves every line ending', async (t) => {
  const original = '---\nname: One\ndescription: Old hook.\n---\nBody.\n';
  const edited = [
    '---',
    'name: One',
    'description: "New: café\\nnot another line"',
    '---',
    'Body.',
    '',
  ].join('\n');
  const indexBefore = Buffer.from([
    '```md\r\n',
    '- [Example](one.md) — fenced\r\n',
    '```\r',
    '- [First title](one.md) — old one\r',
    '- [Second title](one.md) — old two\n',
    'untouched tail',
  ].join(''));
  const expected = Buffer.from([
    '```md\r\n',
    '- [Example](one.md) — fenced\r\n',
    '```\r',
    '- [First title](one.md) — New: café not another line\r',
    '- [Second title](one.md) — New: café not another line\n',
    'untouched tail',
  ].join(''));
  const { memoryDir, server } = await makeServer(t, { 'one.md': original }, indexBefore);
  const [one] = await cards(server);

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.equal(response.json.results[0].status, 'applied');
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), expected);
});

test('edit validates newContent per item, accepts empty content, and does not block a keep', async (t) => {
  const original = '---\nname: One\ndescription: Old hook.\n---\nBody.\n';
  const { memoryDir, server, stateDir } = await makeServer(t, {
    'one.md': original,
    'two.md': '# Two\n',
  }, Buffer.from('- [One](one.md) — Old hook.\n'));
  const currentCards = await cards(server);
  const one = currentCards.find((card) => card.fileName === 'one.md');
  const two = currentCards.find((card) => card.fileName === 'two.md');

  const response = await apply(server, [
    { id: one.id, action: 'edit', expectedHash: one.hash },
    { id: one.id, action: 'edit', expectedHash: one.hash, newContent: null },
    { id: one.id, action: 'edit', expectedHash: one.hash, newContent: '' },
    { id: two.id, action: 'keep', expectedHash: two.hash },
  ]);

  assert.deepEqual(response.json.results, [
    { id: one.id, action: 'edit', status: 'error', reason: 'invalid-new-content' },
    { id: one.id, action: 'edit', status: 'error', reason: 'invalid-new-content' },
    { id: one.id, action: 'edit', status: 'applied' },
    { id: two.id, action: 'keep', status: 'applied' },
  ]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), Buffer.alloc(0));
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from('- [One](one.md) — one\n'),
  );
  const history = JSON.parse(await readFile(join(stateDir, 'reviewed.json'), 'utf8'));
  assert.equal(history.entries[two.hash].id, two.id);
});

test('edit skips a file changed after review without touching its index', async (t) => {
  const original = '---\nname: One\ndescription: Old hook.\n---\nBody.\n';
  const edited = original.replace('Old hook.', 'New hook.');
  const changed = Buffer.from('# Changed outside SCMD\n');
  const indexBytes = Buffer.from('- [One](one.md) — Old hook.\n');
  const { memoryDir, server } = await makeServer(t, { 'one.md': original }, indexBytes);
  const [one] = await cards(server);
  await writeFile(join(memoryDir, 'one.md'), changed);

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'edit',
    status: 'skipped',
    reason: 'changed-since-read',
  }]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), changed);
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
});

test('edit preserves an index append made while it waits for the project lock', async (t) => {
  const original = '---\nname: One\ndescription: Old hook.\n---\nBody.\n';
  const edited = original.replace('Old hook.', 'New hook.');
  const indexBytes = Buffer.from('- [One](one.md) — Old hook.\n');
  const appended = Buffer.from('- [Concurrent](new.md) — Keep this.\n');
  const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': original }, indexBytes);
  const [one] = await cards(server);
  const lockDirectory = join(stateDir, '.apply-locks');
  const lockName = `${createHash('sha256').update(await realpath(memoryDir)).digest('hex')}.lock`;
  const lockPath = join(lockDirectory, lockName);
  await mkdir(lockDirectory);
  await writeFile(lockPath, 'held by test\n');

  const applying = apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);
  await delay(100);
  await appendFile(join(memoryDir, 'MEMORY.md'), appended);
  await rm(lockPath);
  const response = await applying;

  assert.equal(response.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.concat([Buffer.from('- [One](one.md) — New hook.\n'), appended]),
  );
});

test('edit rechecks the memory hash after acquiring the project lock', async (t) => {
  const original = '---\nname: One\ndescription: Old hook.\n---\nBody.\n';
  const edited = original.replace('Old hook.', 'New hook.');
  const changed = Buffer.from('# Changed while apply waited\n');
  const indexBytes = Buffer.from('- [One](one.md) — Old hook.\n');
  const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': original }, indexBytes);
  const [one] = await cards(server);
  const lockDirectory = join(stateDir, '.apply-locks');
  const lockName = `${createHash('sha256').update(await realpath(memoryDir)).digest('hex')}.lock`;
  const lockPath = join(lockDirectory, lockName);
  await mkdir(lockDirectory);
  await writeFile(lockPath, 'held by test\n');

  const applying = apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);
  await delay(100);
  await writeFile(join(memoryDir, 'one.md'), changed);
  await rm(lockPath);
  const response = await applying;

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'edit',
    status: 'skipped',
    reason: 'changed-since-read',
  }]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), changed);
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
});

test('edit rejects a parent directory swapped to an outside symlink while waiting', {
  skip: process.platform === 'win32' ? 'symlink creation may require elevated privileges' : false,
}, async (t) => {
  const original = Buffer.from('---\nname: One\ndescription: Old hook.\n---\nBody.\n');
  const edited = original.toString('utf8').replace('Old hook.', 'New hook.');
  const indexBytes = Buffer.from('- [One](one.md) — Old hook.\n');
  const { memoryDir, server, stateDir } = await makeServer(t, { 'one.md': original }, indexBytes);
  const outsideMemoryDir = await mkdtemp(join(tmpdir(), 'scmd-edit-outside-memory-'));
  const savedMemoryDir = `${memoryDir}-saved`;
  await writeFile(join(outsideMemoryDir, 'one.md'), original);
  await writeFile(join(outsideMemoryDir, 'MEMORY.md'), indexBytes);
  t.after(() => rm(outsideMemoryDir, { recursive: true, force: true }));
  const [one] = await cards(server);
  const lockDirectory = join(stateDir, '.apply-locks');
  const lockName = `${createHash('sha256').update(await realpath(memoryDir)).digest('hex')}.lock`;
  const lockPath = join(lockDirectory, lockName);
  await mkdir(lockDirectory);
  await writeFile(lockPath, 'held by test\n');

  const applying = apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);
  await delay(100);
  await rename(memoryDir, savedMemoryDir);
  await symlink(outsideMemoryDir, memoryDir);
  await rm(lockPath);
  const response = await applying;

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'edit',
    status: 'error',
    reason: 'edit-failed',
  }]);
  assert.deepEqual(await readFile(join(savedMemoryDir, 'one.md')), original);
  assert.deepEqual(await readFile(join(savedMemoryDir, 'MEMORY.md')), indexBytes);
  assert.deepEqual(await readFile(join(outsideMemoryDir, 'one.md')), original);
  assert.deepEqual(await readFile(join(outsideMemoryDir, 'MEMORY.md')), indexBytes);
  assert.deepEqual(await readdir(stateDir), []);
});

test('an unsafe index failure rolls the memory edit back without following the symlink', {
  skip: process.platform === 'win32' ? 'symlink creation may require elevated privileges' : false,
}, async (t) => {
  const original = Buffer.from('---\nname: One\ndescription: Old hook.\n---\nBody.\n');
  const edited = original.toString('utf8').replace('Old hook.', 'New hook.');
  const indexPathBytes = Buffer.from('- [One](one.md) — Old hook.\n');
  const { memoryDir, server, stateDir } = await makeServer(
    t,
    { 'one.md': original },
    indexPathBytes,
  );
  const [one] = await cards(server);
  const outsideIndex = join(tmpdir(), `scmd-edit-outside-index-${process.pid}-${Date.now()}.md`);
  const outsideBytes = Buffer.from('- [Outside](outside.md) — untouched\n');
  await writeFile(outsideIndex, outsideBytes);
  t.after(() => rm(outsideIndex, { force: true }));
  await rm(join(memoryDir, 'MEMORY.md'));
  await symlink(outsideIndex, join(memoryDir, 'MEMORY.md'));

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'edit',
    status: 'error',
    reason: 'edit-failed',
  }]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), original);
  assert.deepEqual(await readFile(outsideIndex), outsideBytes);
  assert.equal((await readdir(memoryDir)).some((name) => name.includes('.tmp')), false);
  assert.deepEqual(await readdir(stateDir), []);
});

test('edit preserves the memory and index file modes', {
  skip: process.platform === 'win32' ? 'POSIX mode assertion does not apply on Windows' : false,
}, async (t) => {
  const original = '---\nname: One\ndescription: Old hook.\n---\nBody.\n';
  const edited = original.replace('Old hook.', 'New hook.');
  const { memoryDir, server } = await makeServer(
    t,
    { 'one.md': original },
    Buffer.from('- [One](one.md) — Old hook.\n'),
  );
  const memoryPath = join(memoryDir, 'one.md');
  const indexPath = join(memoryDir, 'MEMORY.md');
  await chmod(memoryPath, 0o640);
  await chmod(indexPath, 0o644);
  const [one] = await cards(server);

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);

  assert.equal(response.json.results[0].status, 'applied');
  assert.equal((await stat(memoryPath)).mode & 0o777, 0o640);
  assert.equal((await stat(indexPath)).mode & 0o777, 0o644);
});

test('a memory write failure leaves the memory and index untouched with no temp file', {
  skip: process.platform === 'win32' ? 'directory mode enforcement differs on Windows' : false,
}, async (t) => {
  const original = Buffer.from('---\nname: One\ndescription: Old hook.\n---\nBody.\n');
  const edited = original.toString('utf8').replace('Old hook.', 'New hook.');
  const indexBytes = Buffer.from('- [One](one.md) — Old hook.\n');
  const { memoryDir, server } = await makeServer(t, { 'one.md': original }, indexBytes);
  const [one] = await cards(server);
  await chmod(memoryDir, 0o500);
  t.after(() => chmod(memoryDir, 0o700).catch(() => {}));

  const response = await apply(server, [{
    id: one.id,
    action: 'edit',
    expectedHash: one.hash,
    newContent: edited,
  }]);
  await chmod(memoryDir, 0o700);

  assert.deepEqual(response.json.results, [{
    id: one.id,
    action: 'edit',
    status: 'error',
    reason: 'edit-failed',
  }]);
  assert.deepEqual(await readFile(join(memoryDir, 'one.md')), original);
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), indexBytes);
  assert.equal((await readdir(memoryDir)).some((name) => name.includes('.tmp')), false);
});

test('concurrent server processes serialize edits and preserve both index updates', async (t) => {
  const oneBytes = '---\nname: One\ndescription: First old.\n---\nBody.\n';
  const twoBytes = '---\nname: Two\ndescription: Second old.\n---\nBody.\n';
  const { memoryDir, root, server: firstServer, stateDir } = await makeServer(t, {
    'one.md': oneBytes,
    'two.md': twoBytes,
  }, Buffer.from('- [One](one.md) — First old.\n- [Two](two.md) — Second old.\n'));
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
    apply(firstServer, [{
      id: one.id,
      action: 'edit',
      expectedHash: one.hash,
      newContent: oneBytes.replace('First old.', 'First new.'),
    }]),
    apply(secondServer, [{
      id: two.id,
      action: 'edit',
      expectedHash: two.hash,
      newContent: twoBytes.replace('Second old.', 'Second new.'),
    }]),
  ]);

  assert.equal(firstResponse.json.results[0].status, 'applied');
  assert.equal(secondResponse.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from('- [One](one.md) — First new.\n- [Two](two.md) — Second new.\n'),
  );
});

test('reserved filename characters round-trip through repeated edit and delete index maintenance', {
  skip: process.platform === 'win32' ? 'colon is not a valid Windows filename character' : false,
}, async (t) => {
  const fileName = 'a#b?:c.md';
  const original = '---\nname: Reserved\ndescription: Old hook.\n---\nBody.\n';
  const firstEdit = original.replace('Old hook.', 'First hook.');
  const secondEdit = original.replace('Old hook.', 'Second hook.');
  const { memoryDir, server } = await makeServer(t, { [fileName]: original });
  const [firstCard] = await cards(server);

  const firstResponse = await apply(server, [{
    id: firstCard.id,
    action: 'edit',
    expectedHash: firstCard.hash,
    newContent: firstEdit,
  }]);
  assert.equal(firstResponse.json.results[0].status, 'applied');

  const [secondCard] = await cards(server);
  const secondResponse = await apply(server, [{
    id: secondCard.id,
    action: 'edit',
    expectedHash: secondCard.hash,
    newContent: secondEdit,
  }]);
  assert.equal(secondResponse.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from('- [Reserved](a%23b%3F%3Ac.md) — Second hook.\n'),
  );

  const [deleteCard] = await cards(server);
  const deleteResponse = await apply(server, [{
    id: deleteCard.id,
    action: 'delete',
    expectedHash: deleteCard.hash,
  }]);
  assert.equal(deleteResponse.json.results[0].status, 'applied');
  await assert.rejects(access(join(memoryDir, fileName)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), Buffer.alloc(0));
});

test('literal percent index targets survive repeated edit and delete without duplication', async (t) => {
  for (const fileName of ['a%b.md', 'a%25b.md', 'a%2Fb.md']) {
    await t.test(fileName, async (st) => {
      const original = '---\nname: Percent\ndescription: Old hook.\n---\nBody.\n';
      const firstEdit = original.replace('Old hook.', 'First hook.');
      const secondEdit = original.replace('Old hook.', 'Second hook.');
      const rawLine = `- [Percent](${fileName}) — Old hook.\n`;
      const { memoryDir, server } = await makeServer(st, { [fileName]: original }, Buffer.from(rawLine));
      const [firstCard] = await cards(server);

      const firstResponse = await apply(server, [{
        id: firstCard.id,
        action: 'edit',
        expectedHash: firstCard.hash,
        newContent: firstEdit,
      }]);
      assert.equal(firstResponse.json.results[0].status, 'applied');

      const [secondCard] = await cards(server);
      const secondResponse = await apply(server, [{
        id: secondCard.id,
        action: 'edit',
        expectedHash: secondCard.hash,
        newContent: secondEdit,
      }]);
      assert.equal(secondResponse.json.results[0].status, 'applied');
      assert.deepEqual(
        await readFile(join(memoryDir, 'MEMORY.md')),
        Buffer.from(`- [Percent](${fileName}) — Second hook.\n`),
      );

      const [deleteCard] = await cards(server);
      const deleteResponse = await apply(server, [{
        id: deleteCard.id,
        action: 'delete',
        expectedHash: deleteCard.hash,
      }]);
      assert.equal(deleteResponse.json.results[0].status, 'applied');
      await assert.rejects(access(join(memoryDir, fileName)), { code: 'ENOENT' });
      assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), Buffer.alloc(0));
    });
  }
});

test('raw percent targets win over decoded sibling collisions for edit and delete', async (t) => {
  const literalName = 'a%23b.md';
  const decodedName = 'a#b.md';
  const literal = '---\nname: Literal\ndescription: Literal old.\n---\nBody.\n';
  const decoded = '---\nname: Decoded\ndescription: Decoded old.\n---\nBody.\n';
  const { memoryDir, server } = await makeServer(t, {
    [literalName]: literal,
    [decodedName]: decoded,
  }, Buffer.from([
    `- [Literal](${literalName}) — Literal old.`,
    `- [Decoded](${decodedName}) — Decoded old.`,
    '',
  ].join('\n')));

  const health = await request(server, '/api/projects?includeReviewed=1');
  assert.deepEqual(health.json.projects[0].unindexed, []);
  assert.deepEqual(health.json.projects[0].dangling, []);

  const initialCards = await cards(server);
  const decodedCard = initialCards.find((card) => card.fileName === decodedName);
  const decodedResponse = await apply(server, [{
    id: decodedCard.id,
    action: 'edit',
    expectedHash: decodedCard.hash,
    newContent: decoded.replace('Decoded old.', 'Decoded new.'),
  }]);
  assert.equal(decodedResponse.json.results[0].status, 'applied');
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), Buffer.from([
    `- [Literal](${literalName}) — Literal old.`,
    `- [Decoded](${decodedName}) — Decoded new.`,
    '',
  ].join('\n')));

  const editedCards = await cards(server);
  const literalCard = editedCards.find((card) => card.fileName === literalName);
  const literalResponse = await apply(server, [{
    id: literalCard.id,
    action: 'delete',
    expectedHash: literalCard.hash,
  }]);
  assert.equal(literalResponse.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from(`- [Decoded](${decodedName}) — Decoded new.\n`),
  );
  assert.deepEqual(await readFile(join(memoryDir, decodedName)), Buffer.from(
    decoded.replace('Decoded old.', 'Decoded new.'),
  ));
});

test('an appended encoded target stays distinct from a literal percent sibling', async (t) => {
  const literalName = 'a%23b.md';
  const decodedName = 'a#b.md';
  const literal = '---\nname: Literal\ndescription: Literal old.\n---\nBody.\n';
  const decoded = '---\nname: Decoded\ndescription: Decoded old.\n---\nBody.\n';
  const literalLine = `- [Literal](${literalName}) — Literal old.\n`;
  const { memoryDir, server } = await makeServer(t, {
    [literalName]: literal,
    [decodedName]: decoded,
  }, Buffer.from(literalLine));

  const initialHealth = await request(server, '/api/projects?includeReviewed=1');
  assert.deepEqual(initialHealth.json.projects[0].unindexed, [decodedName]);

  const decodedCard = (await cards(server)).find((card) => card.fileName === decodedName);
  const firstEdit = decoded.replace('Decoded old.', 'Decoded first.');
  const firstResponse = await apply(server, [{
    id: decodedCard.id,
    action: 'edit',
    expectedHash: decodedCard.hash,
    newContent: firstEdit,
  }]);
  assert.equal(firstResponse.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from(`${literalLine}- [Decoded](a\\%23b.md) — Decoded first.\n`),
  );
  const indexedHealth = await request(server, '/api/projects?includeReviewed=1');
  assert.deepEqual(indexedHealth.json.projects[0].unindexed, []);

  const firstEditedCard = (await cards(server)).find((card) => card.fileName === decodedName);
  const secondEdit = decoded.replace('Decoded old.', 'Decoded second.');
  const secondResponse = await apply(server, [{
    id: firstEditedCard.id,
    action: 'edit',
    expectedHash: firstEditedCard.hash,
    newContent: secondEdit,
  }]);
  assert.equal(secondResponse.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from(`${literalLine}- [Decoded](a\\%23b.md) — Decoded second.\n`),
  );

  const secondEditedCard = (await cards(server)).find((card) => card.fileName === decodedName);
  const deleteResponse = await apply(server, [{
    id: secondEditedCard.id,
    action: 'delete',
    expectedHash: secondEditedCard.hash,
  }]);
  assert.equal(deleteResponse.json.results[0].status, 'applied');
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), Buffer.from(literalLine));
  assert.deepEqual(await readFile(join(memoryDir, literalName)), Buffer.from(literal));
});

test('a percent-escape-looking sibling line is not edited or deleted as its decoded filename', async (t) => {
  const literalName = 'a%25b.md';
  const decodedName = 'a%b.md';
  const literal = '---\nname: Literal\ndescription: Literal old.\n---\nBody.\n';
  const decoded = '---\nname: Decoded\ndescription: Decoded old.\n---\nBody.\n';
  const literalLine = `- [Literal](${literalName}) — Literal old.\n`;
  const { memoryDir, server } = await makeServer(t, {
    [literalName]: literal,
    [decodedName]: decoded,
  }, Buffer.from(`${literalLine}- [Decoded](${decodedName}) — Decoded old.\n`));

  const health = await request(server, '/api/projects?includeReviewed=1');
  assert.deepEqual(health.json.projects[0].unindexed, []);

  const decodedCard = (await cards(server)).find((card) => card.fileName === decodedName);
  const editResponse = await apply(server, [{
    id: decodedCard.id,
    action: 'edit',
    expectedHash: decodedCard.hash,
    newContent: decoded.replace('Decoded old.', 'Decoded new.'),
  }]);
  assert.equal(editResponse.json.results[0].status, 'applied');
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from(`${literalLine}- [Decoded](${decodedName}) — Decoded new.\n`),
  );

  const editedCard = (await cards(server)).find((card) => card.fileName === decodedName);
  const deleteResponse = await apply(server, [{
    id: editedCard.id,
    action: 'delete',
    expectedHash: editedCard.hash,
  }]);
  assert.equal(deleteResponse.json.results[0].status, 'applied');
  assert.deepEqual(await readFile(join(memoryDir, 'MEMORY.md')), Buffer.from(literalLine));
  assert.deepEqual(await readFile(join(memoryDir, literalName)), Buffer.from(literal));
});

test('a valid near-NAME_MAX filename edits atomically without an oversized temp basename', async (t) => {
  const fileName = `${'a'.repeat(230)}.md`;
  const original = Buffer.from('---\nname: Long\ndescription: Old hook.\n---\nBody.\n');
  const edited = original.toString('utf8').replace('Old hook.', 'New hook.');
  const indexBytes = Buffer.from(`- [Long](${fileName}) — Old hook.\n`);
  const { memoryDir, server } = await makeServer(t, { [fileName]: original }, indexBytes);
  const [card] = await cards(server);

  const response = await apply(server, [{
    id: card.id,
    action: 'edit',
    expectedHash: card.hash,
    newContent: edited,
  }]);

  assert.deepEqual(response.json.results, [{
    id: card.id,
    action: 'edit',
    status: 'applied',
  }]);
  assert.deepEqual(await readFile(join(memoryDir, fileName)), Buffer.from(edited));
  assert.deepEqual(
    await readFile(join(memoryDir, 'MEMORY.md')),
    Buffer.from(`- [Long](${fileName}) — New hook.\n`),
  );
  assert.equal((await readdir(memoryDir)).some((name) => name.endsWith('.tmp')), false);
});

test('control characters in a filename fail closed without index injection', {
  skip: process.platform === 'win32' ? 'control-character filename support differs on Windows' : false,
}, async (t) => {
  const fileName = 'bad\nname.md';
  const original = Buffer.from('---\nname: Bad\ndescription: Old hook.\n---\nBody.\n');
  const edited = original.toString('utf8').replace('Old hook.', 'New hook.');
  const { memoryDir, server, stateDir } = await makeServer(t, { [fileName]: original });
  const [card] = await cards(server);

  const response = await apply(server, [
    { id: card.id, action: 'edit', expectedHash: card.hash, newContent: edited },
    { id: card.id, action: 'delete', expectedHash: card.hash },
  ]);

  assert.deepEqual(response.json.results, [
    { id: card.id, action: 'edit', status: 'error', reason: 'edit-failed' },
    { id: card.id, action: 'delete', status: 'error', reason: 'delete-failed' },
  ]);
  assert.deepEqual(await readFile(join(memoryDir, fileName)), original);
  await assert.rejects(access(join(memoryDir, 'MEMORY.md')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(stateDir), []);
});

for (const [label, hookName] of [
  ['immediately after memory rename', 'afterMemoryRename'],
  ['after committed memory validation before index access', 'afterMemoryCommitValidated'],
]) {
  test(`edit recovers safely when the memory directory is swapped ${label}`, {
    skip: process.platform === 'win32' ? 'symlink creation may require elevated privileges' : false,
  }, async (t) => {
    const original = Buffer.from('---\nname: One\ndescription: Old hook.\n---\nBody.\n');
    const edited = original.toString('utf8').replace('Old hook.', 'New hook.');
    const indexBytes = Buffer.from('- [One](one.md) — Old hook.\n');
    const { memoryDir, root, stateDir } = await makeServer(t, { 'one.md': original }, indexBytes);
    const outsideMemoryDir = await mkdtemp(join(tmpdir(), 'scmd-edit-hook-outside-'));
    const savedMemoryDir = `${memoryDir}-saved`;
    await writeFile(join(outsideMemoryDir, 'one.md'), original);
    await writeFile(join(outsideMemoryDir, 'MEMORY.md'), indexBytes);
    t.after(() => rm(outsideMemoryDir, { recursive: true, force: true }));
    const target = await directTarget(root, memoryDir, 'one.md', original);
    const swap = async () => {
      await rename(memoryDir, savedMemoryDir);
      await symlink(outsideMemoryDir, memoryDir);
    };

    await assert.rejects(
      applyEdit(target, stateDir, target.card.hash, edited, { [hookName]: swap }),
      (error) => error && error.code === 'unsafe-memory-directory',
    );

    assert.deepEqual(await readFile(join(savedMemoryDir, 'one.md')), original);
    assert.deepEqual(await readFile(join(savedMemoryDir, 'MEMORY.md')), indexBytes);
    assert.deepEqual(await readFile(join(outsideMemoryDir, 'one.md')), original);
    assert.deepEqual(await readFile(join(outsideMemoryDir, 'MEMORY.md')), indexBytes);
  });
}

test('a Claude rewrite after memory commit survives and no stale SCMD hook is committed', async (t) => {
  const original = Buffer.from('---\nname: One\ndescription: Old hook.\n---\nBody.\n');
  const edited = original.toString('utf8').replace('Old hook.', 'SCMD hook.');
  const claude = Buffer.from('---\nname: One\ndescription: Claude hook.\n---\nClaude body.\n');
  const indexBytes = Buffer.from('- [One](one.md) — Old hook.\n');
  const { memoryDir, root, stateDir } = await makeServer(t, { 'one.md': original }, indexBytes);
  const target = await directTarget(root, memoryDir, 'one.md', original);

  await assert.rejects(
    applyEdit(target, stateDir, target.card.hash, edited, {
      afterMemoryCommitValidated: () => writeFile(target.filePath, claude),
    }),
    (error) => error && error.code === 'changed-since-read',
  );

  assert.deepEqual(await readFile(target.filePath), claude);
  assert.deepEqual(await readFile(target.indexPath), indexBytes);
});

test('a Claude rewrite immediately after index commit survives and rolls the stale hook back', async (t) => {
  const original = Buffer.from('---\nname: One\ndescription: Old hook.\n---\nBody.\n');
  const edited = original.toString('utf8').replace('Old hook.', 'SCMD hook.');
  const claude = Buffer.from('---\nname: One\ndescription: Claude hook.\n---\nClaude body.\n');
  const indexBytes = Buffer.from('- [One](one.md) — Old hook.\n');
  const { memoryDir, root, stateDir } = await makeServer(t, { 'one.md': original }, indexBytes);
  const target = await directTarget(root, memoryDir, 'one.md', original);

  await assert.rejects(
    applyEdit(target, stateDir, target.card.hash, edited, {
      afterIndexCommit: () => writeFile(target.filePath, claude),
    }),
    (error) => error && error.code === 'changed-since-read',
  );

  assert.deepEqual(await readFile(target.filePath), claude);
  assert.deepEqual(await readFile(target.indexPath), indexBytes);
});

test('a Claude rewrite during the final unchanged-index read prevents a false applied result', async (t) => {
  const original = Buffer.from('---\nname: One\ndescription: Same hook.\n---\nOld body.\n');
  const edited = original.toString('utf8').replace('Old body.', 'SCMD body.');
  const claude = Buffer.from('---\nname: One\ndescription: Same hook.\n---\nClaude body.\n');
  const indexBytes = Buffer.from('- [One](one.md) — Same hook.\n');
  const { memoryDir, root, stateDir } = await makeServer(t, { 'one.md': original }, indexBytes);
  const target = await directTarget(root, memoryDir, 'one.md', original);

  await assert.rejects(
    applyEdit(target, stateDir, target.card.hash, edited, {
      afterVerifiedIndexRead: () => writeFile(target.filePath, claude),
    }),
    (error) => error && error.code === 'changed-since-read',
  );

  assert.deepEqual(await readFile(target.filePath), claude);
  assert.deepEqual(await readFile(target.indexPath), indexBytes);
});
