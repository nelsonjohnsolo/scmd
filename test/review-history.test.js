const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} = require('node:fs/promises');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { dirname, join, relative, sep } = require('node:path');

const { recordReviewed } = require('../server');
const { startServer } = require('./server-helper');

function requestProjects(server, includeReviewed = false) {
  const pathname = includeReviewed ? '/api/projects?includeReviewed=1' : '/api/projects';
  const url = new URL(pathname, server.url);

  return new Promise((resolveRequest, rejectRequest) => {
    const request = http.request(url, {
      headers: { 'X-SCMD-Token': server.token },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolveRequest({
        status: response.statusCode,
        body,
      }));
    });
    request.once('error', rejectRequest);
    request.end();
  });
}

async function makeRoot(t, contents = '# One\n') {
  const root = await mkdtemp(join(tmpdir(), 'scmd-review-root-'));
  const memoryPath = join(root, 'project', 'memory');
  const memoryFile = join(memoryPath, 'one.md');
  await mkdir(memoryPath, { recursive: true });
  await writeFile(memoryFile, contents);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, memoryPath, memoryFile };
}

async function startAtRoot(t, root) {
  return startServer(t, {
    serverArgs: ['--root', root, '--port', '0', '--no-open'],
  });
}

async function oneProject(server, includeReviewed = false) {
  const response = await requestProjects(server, includeReviewed);
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.projects.length, 1);
  return payload.projects[0];
}

test('recordReviewed creates the exact versioned sidecar without touching memory bytes', async (t) => {
  const { root, memoryFile } = await makeRoot(t);
  const stateDir = join(dirname(root), `${root.split(sep).at(-1)}-state`);
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const hash = 'a'.repeat(64);
  const id = 'project/one.md';
  const at = '2026-09-20T12:34:56.789Z';
  const before = await readFile(memoryFile);

  await recordReviewed(stateDir, { hash, id, at });

  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'reviewed.json'), 'utf8')), {
    version: 1,
    entries: {
      [hash]: { at, id },
    },
  });
  assert.deepEqual(await readFile(memoryFile), before);
  assert.equal(relative(root, stateDir).startsWith(`..${sep}`), true);
  if (process.platform !== 'win32') {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(stateDir, 'reviewed.json'))).mode & 0o777, 0o600);
  }
});

test('GET /api/projects filters reviewed content fresh and marks the explicit all view', async (t) => {
  const original = Buffer.from('# One\n');
  const { root, memoryPath, memoryFile } = await makeRoot(t, original);
  const server = await startAtRoot(t, root);

  const first = await oneProject(server);
  assert.equal(first.memoryCount, 1);
  assert.equal(first.unreviewedCount, 1);
  assert.equal(first.reviewedCount, 0);
  assert.equal(first.cards.length, 1);
  assert.equal(Object.hasOwn(first.cards[0], 'reviewed'), false);
  const originalCard = first.cards[0];

  await recordReviewed(server.stateDir, {
    hash: originalCard.hash,
    id: originalCard.id,
    at: '2026-09-20T13:00:00.000Z',
  });
  assert.deepEqual(await readFile(memoryFile), original);

  const afterKeep = await oneProject(server);
  assert.equal(afterKeep.memoryCount, 1);
  assert.equal(afterKeep.unreviewedCount, 0);
  assert.equal(afterKeep.reviewedCount, 1);
  assert.deepEqual(afterKeep.cards, []);

  const everything = await oneProject(server, true);
  assert.equal(everything.memoryCount, 1);
  assert.equal(everything.unreviewedCount, 0);
  assert.equal(everything.reviewedCount, 1);
  assert.equal(everything.cards.length, 1);
  assert.equal(everything.cards[0].reviewed, true);
  assert.equal(everything.cards[0].hash, originalCard.hash);

  await writeFile(memoryFile, '# One changed\n');
  const afterChange = await oneProject(server);
  assert.equal(afterChange.unreviewedCount, 1);
  assert.equal(afterChange.reviewedCount, 0);
  assert.equal(afterChange.cards.length, 1);
  assert.notEqual(afterChange.cards[0].hash, originalCard.hash);

  await writeFile(memoryFile, original);
  await rename(memoryFile, join(memoryPath, 'renamed.md'));
  const afterRename = await oneProject(server);
  assert.equal(afterRename.memoryCount, 1);
  assert.equal(afterRename.unreviewedCount, 0);
  assert.equal(afterRename.reviewedCount, 1);
  assert.deepEqual(afterRename.cards, []);

  const renamedEverything = await oneProject(server, true);
  assert.equal(renamedEverything.cards[0].id, 'project/renamed.md');
  assert.equal(renamedEverything.cards[0].hash, originalCard.hash);
  assert.equal(renamedEverything.cards[0].reviewed, true);
  assert.deepEqual(await readdir(server.stateDir), ['reviewed.json']);
});

test('concurrent recordReviewed calls preserve every entry with no atomic-write debris', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-review-state-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const records = Array.from({ length: 32 }, (_, index) => ({
    hash: index.toString(16).padStart(64, '0'),
    id: `project/memory-${index}.md`,
    at: `2026-09-20T14:00:${String(index).padStart(2, '0')}.000Z`,
  }));
  await Promise.all(records.map((record) => recordReviewed(stateDir, record)));

  const history = JSON.parse(await readFile(join(stateDir, 'reviewed.json'), 'utf8'));
  assert.equal(history.version, 1);
  assert.equal(Object.keys(history.entries).length, records.length);
  for (const { hash, id, at } of records) {
    assert.deepEqual(history.entries[hash], { at, id });
  }
  assert.deepEqual(await readdir(stateDir), ['reviewed.json']);
});

test('a rejected queued record does not block the next valid record', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-review-state-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const good = {
    hash: 'c'.repeat(64),
    id: 'project/good.md',
    at: '2026-09-20T15:00:00.000Z',
  };

  const rejected = recordReviewed(stateDir, {
    hash: 'not-a-sha256',
    id: 'project/bad.md',
    at: '2026-09-20T15:00:00.000Z',
  });
  const successful = recordReviewed(stateDir, good);

  await assert.rejects(rejected, TypeError);
  await successful;

  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'reviewed.json'), 'utf8')), {
    version: 1,
    entries: {
      [good.hash]: { at: good.at, id: good.id },
    },
  });
  assert.deepEqual(await readdir(stateDir), ['reviewed.json']);
});
