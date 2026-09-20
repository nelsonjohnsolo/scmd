const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { startServer } = require('./server-helper');

const REVIEW_HISTORY_NOTICE = 'Review history could not be read. All memories are shown as unreviewed.';
const MEMORY_CONTENTS = {
  'one.md': '# One\n',
  'two.md': '# Two\n',
};

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function requestProjects(server) {
  const url = new URL('/api/projects', server.url);

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

async function makeServer(t) {
  const root = await mkdtemp(join(tmpdir(), 'scmd-corrupt-history-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-corrupt-history-state-'));
  const memoryDir = join(root, 'project', 'memory');
  await mkdir(memoryDir, { recursive: true });
  await Promise.all(Object.entries(MEMORY_CONTENTS).map(([fileName, contents]) => (
    writeFile(join(memoryDir, fileName), contents)
  )));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  return startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
}

async function assertUnreadableHistoryResponse(server) {
  const response = await requestProjects(server);
  assert.equal(response.status, 200);
  assert.equal(response.body.includes(server.stateDir), false);

  const payload = JSON.parse(response.body);
  assert.deepEqual(payload.notices, [REVIEW_HISTORY_NOTICE]);
  assert.equal(payload.notices.length, 1);
  assert.equal(payload.projects.length, 1);

  const project = payload.projects[0];
  assert.equal(project.memoryCount, 2);
  assert.equal(project.unreviewedCount, 2);
  assert.equal(project.reviewedCount, 0);
  assert.deepEqual(project.cards.map((card) => card.fileName), ['one.md', 'two.md']);
}

test('invalid review history formats show every card as unreviewed with one path-free notice', async (t) => {
  const server = await makeServer(t);
  const historyPath = join(server.stateDir, 'reviewed.json');
  const invalidHistories = [
    Buffer.from('{garbage'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from(JSON.stringify({ version: 2, entries: {} })),
    Buffer.from(JSON.stringify({ version: 1, entries: [] })),
    Buffer.from(JSON.stringify({
      version: 1,
      entries: {
        invalid: { at: 'not-a-date', id: '' },
      },
    })),
  ];

  for (const invalidHistory of invalidHistories) {
    await writeFile(historyPath, invalidHistory);
    await assertUnreadableHistoryResponse(server);
  }
});

test('a genuine review history read failure is non-fatal', async (t) => {
  const server = await makeServer(t);
  const historyPath = join(server.stateDir, 'reviewed.json');
  await mkdir(historyPath);

  await assertUnreadableHistoryResponse(server);
});

test('review history is read fresh and missing or repaired state has no notice', async (t) => {
  const server = await makeServer(t);
  const historyPath = join(server.stateDir, 'reviewed.json');
  await writeFile(historyPath, '{garbage');
  await assertUnreadableHistoryResponse(server);

  const reviewedHash = sha256(MEMORY_CONTENTS['one.md']);
  await writeFile(historyPath, `${JSON.stringify({
    version: 1,
    entries: {
      [reviewedHash]: {
        at: '2026-09-20T12:00:00.000Z',
        id: 'project/one.md',
      },
    },
  })}\n`);

  const repaired = await requestProjects(server);
  assert.equal(repaired.status, 200);
  assert.equal(repaired.body.includes(server.stateDir), false);
  const repairedPayload = JSON.parse(repaired.body);
  assert.deepEqual(repairedPayload.notices, []);
  assert.equal(repairedPayload.projects[0].unreviewedCount, 1);
  assert.equal(repairedPayload.projects[0].reviewedCount, 1);
  assert.deepEqual(repairedPayload.projects[0].cards.map((card) => card.fileName), ['two.md']);

  await rm(historyPath);
  const missing = await requestProjects(server);
  assert.equal(missing.status, 200);
  const missingPayload = JSON.parse(missing.body);
  assert.deepEqual(missingPayload.notices, []);
  assert.equal(missingPayload.projects[0].unreviewedCount, 2);
  assert.equal(missingPayload.projects[0].reviewedCount, 0);
  assert.deepEqual(missingPayload.projects[0].cards.map((card) => card.fileName), ['one.md', 'two.md']);
});
