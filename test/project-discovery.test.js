const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const { startServer } = require('./server-helper');

const FIXTURE_ROOT = resolve(__dirname, '..', 'fixtures', 'projects');
const DESTROY_MARKER = 'SCMD_TEST_TRANSCRIPT_DESTROYED';
const OPEN_MARKER = 'SCMD_TEST_TRANSCRIPT_OPEN';

function request(server, pathname, { headers = {} } = {}) {
  const url = new URL(pathname, server.url);

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
    outgoing.end();
  });
}

async function requestProjects(server, headers = {}) {
  return request(server, '/api/projects', {
    headers: {
      'X-SCMD-Token': server.token,
      ...headers,
    },
  });
}

async function startAtRoot(t, root, { env = process.env } = {}) {
  return startServer(t, {
    serverArgs: ['--root', root, '--port', '0', '--no-open'],
    env,
  });
}

async function addMemoryProject(root, folder, files = []) {
  const memory = join(root, folder, 'memory');
  await mkdir(memory, { recursive: true });
  await Promise.all(files.map((file) => writeFile(join(memory, file), `# ${file}\n`)));
  return join(root, folder);
}

async function transcriptStreamPreload(t) {
  const directory = await mkdtemp(join(tmpdir(), 'scmd-transcript-stream-'));
  const preload = join(directory, 'transcript-stream.js');
  await writeFile(preload, `
const fs = require('node:fs');
const { Readable } = require('node:stream');

const originalCreateReadStream = fs.createReadStream.bind(fs);
let active = 0;

fs.createReadStream = (target, ...args) => {
  const targetPath = String(target);
  const exactTarget = process.env.SCMD_TEST_STREAM_TARGET;
  const targetRoot = process.env.SCMD_TEST_STREAM_ROOT;
  const matches = exactTarget === targetPath
    || (targetRoot && targetPath.startsWith(targetRoot) && targetPath.endsWith('.jsonl'));
  if (!matches) return originalCreateReadStream(target, ...args);

  active += 1;
  process.stdout.write(${JSON.stringify(`${OPEN_MARKER} `)} + active + '\\n');
  const mode = process.env.SCMD_TEST_STREAM_MODE;
  let sent = false;
  return new Readable({
    read() {
      if (sent) return;
      sent = true;
      const emitCwd = () => {
        this.push('{"cwd":"/instrumented/project"}\\n');
        if (mode === 'delayed-end') this.push(null);
      };
      if (mode === 'delayed-end') setTimeout(emitCwd, 50);
      else emitCwd();
    },
    destroy(error, callback) {
      active -= 1;
      process.stdout.write(${JSON.stringify(`${DESTROY_MARKER} `)} + active + '\\n');
      callback(error);
    },
  });
};
`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return preload;
}

async function waitForOutput(server, pattern, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const output = server.output().stdout;
    if (pattern.test(output)) return output;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`server output did not match ${pattern}`);
}

test('GET /api/projects lists fixture projects, including an empty memory folder', async (t) => {
  const server = await startAtRoot(t, FIXTURE_ROOT);
  const response = await requestProjects(server);

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^application\/json\b/);
  const payload = JSON.parse(response.body);
  assert.equal(payload.root, FIXTURE_ROOT);
  assert.deepEqual(payload.projects.map(({ cards, ...project }) => project), [
      {
        id: '-Users-example-api-server',
        name: '-Users-example-api-server',
        path: null,
        pathUnknown: true,
        memoryCount: 1,
        unreviewedCount: 1,
        reviewedCount: 0,
        unindexed: ['api_contract.md'],
        dangling: [],
        unreadable: [],
      },
      {
        id: '-Users-example-docs',
        name: '-Users-example-docs',
        path: null,
        pathUnknown: true,
        memoryCount: 0,
        unreviewedCount: 0,
        reviewedCount: 0,
        unindexed: [],
        dangling: [],
        unreadable: [],
      },
      {
        id: '-Users-example-my-side-project',
        name: 'my-side-project',
        path: '/Users/example/my-side-project',
        pathUnknown: false,
        memoryCount: 2,
        unreviewedCount: 2,
        reviewedCount: 0,
        unindexed: [],
        dangling: [{
          fileName: 'missing_deployment.md',
          lineNumber: 5,
          line: '- [Old deployment reminder](missing_deployment.md) — This entry points to a removed memory.',
        }],
        unreadable: [],
      },
      {
        id: '-Users-example-web-client',
        name: '-Users-example-web-client',
        path: null,
        pathUnknown: true,
        memoryCount: 2,
        unreviewedCount: 2,
        reviewedCount: 0,
        unindexed: ['feedback_accessibility.md', 'ui_note.md'],
        dangling: [],
        unreadable: [],
      },
    ]);
});

test('authenticated GET /api/projects includes deterministic cards for every fixture memory', async (t) => {
  const server = await startAtRoot(t, FIXTURE_ROOT);
  const first = await requestProjects(server);
  const second = await requestProjects(server);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body, first.body);

  const projects = JSON.parse(first.body).projects;
  const cardFiles = Object.fromEntries(projects.map((project) => [
    project.id,
    project.cards.map((card) => card.fileName),
  ]));
  assert.deepEqual(cardFiles, {
    '-Users-example-api-server': ['api_contract.md'],
    '-Users-example-docs': [],
    '-Users-example-my-side-project': ['feedback_review.md', 'project_context.md'],
    '-Users-example-web-client': ['feedback_accessibility.md', 'ui_note.md'],
  });

  const cards = projects.flatMap((project) => project.cards);
  assert.equal(cards.length, 5);
  assert.equal(cards.some((card) => card.fileName === 'MEMORY.md'), false);
  for (const card of cards) {
    assert.equal(card.id, `${card.projectId}/${card.fileName}`);
    assert.ok(card.name);
    assert.ok(card.summary);
    assert.match(card.hash, /^[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(card.date)), card.id);
    assert.equal(typeof card.body, 'string');
  }

  const nested = cards.find((card) => card.fileName === 'api_contract.md');
  assert.equal(nested.type, 'project');
  assert.equal(nested.originSessionId, 'session-api-001');
  assert.equal(nested.date, '2026-09-17T10:30:00.000Z');
});

test('project enumeration omits immediate folders without a memory directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await addMemoryProject(root, 'included');
  await mkdir(join(root, 'omitted'), { recursive: true });

  const server = await startAtRoot(t, root);
  const response = await requestProjects(server);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).projects.map((project) => project.id), ['included']);
});

test('newest direct transcript wins without decoding a collision-like folder name, then stays cached', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = '-Users-example-collision-path';
  const project = await addMemoryProject(root, folder, ['one.md']);
  const oldTranscript = join(project, 'old.jsonl');
  const newestTranscript = join(project, 'new.jsonl');
  await writeFile(oldTranscript, '{"cwd":"/Users/example/collision/path"}\n');
  await writeFile(newestTranscript, [
    '{"metadata":{"cwd":"/nested/must-not-win"}}',
    'not json',
    '{"cwd":"/Users/example-collision/path"}',
  ].join('\n'));
  await mkdir(join(project, 'nested'), { recursive: true });
  await writeFile(join(project, 'nested', 'ignored.jsonl'), '{"cwd":"/newest/but/not/direct"}\n');
  await utimes(oldTranscript, new Date('2026-01-01'), new Date('2026-01-01'));
  await utimes(newestTranscript, new Date('2026-01-02'), new Date('2026-01-02'));

  const server = await startAtRoot(t, root);
  const first = await requestProjects(server);
  assert.equal(first.status, 200);
  const firstProject = JSON.parse(first.body).projects[0];
  const { cards, ...projectSummary } = firstProject;
  assert.deepEqual(projectSummary, {
    id: folder,
    name: 'path',
    path: '/Users/example-collision/path',
    pathUnknown: false,
    memoryCount: 1,
    unreviewedCount: 1,
    reviewedCount: 0,
    unindexed: ['one.md'],
    dangling: [],
    unreadable: [],
  });
  assert.deepEqual(cards.map((card) => card.fileName), ['one.md']);

  await writeFile(newestTranscript, '{"cwd":"/changed/after/first/request"}\n');
  const second = await requestProjects(server);
  assert.equal(second.status, 200);
  assert.deepEqual(JSON.parse(second.body).projects[0], firstProject);
});

test('an unusable newest transcript falls back to the encoded folder and does not read an older cwd', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = '-encoded-fallback';
  const project = await addMemoryProject(root, folder);
  const oldTranscript = join(project, 'old.jsonl');
  const newestTranscript = join(project, 'new.jsonl');
  await writeFile(oldTranscript, '{"cwd":"/must/not/use/older"}\n');
  await writeFile(newestTranscript, 'not json\n{"nested":{"cwd":"/not/top-level"}}\n{"cwd":42}\n');
  await utimes(oldTranscript, new Date('2026-01-01'), new Date('2026-01-01'));
  await utimes(newestTranscript, new Date('2026-01-02'), new Date('2026-01-02'));

  const server = await startAtRoot(t, root);
  const response = await requestProjects(server);

  assert.equal(response.status, 200);
  const { cards, ...projectSummary } = JSON.parse(response.body).projects[0];
  assert.deepEqual(projectSummary, {
    id: folder,
    name: folder,
    path: null,
    pathUnknown: true,
    memoryCount: 0,
    unreviewedCount: 0,
    reviewedCount: 0,
    unindexed: [],
    dangling: [],
    unreadable: [],
  });
  assert.deepEqual(cards, []);
});

test('path resolution destroys the transcript stream after an early cwd match', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await addMemoryProject(root, 'early-match');
  const transcript = join(project, 'session.jsonl');
  await writeFile(transcript, '{"cwd":"/unused/by/preload"}\n');
  const preload = await transcriptStreamPreload(t);
  const server = await startAtRoot(t, root, {
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
      SCMD_TEST_STREAM_MODE: 'stay-open',
      SCMD_TEST_STREAM_TARGET: transcript,
    },
  });

  const response = await requestProjects(server);

  assert.equal(response.status, 200);
  await waitForOutput(server, new RegExp(`^${DESTROY_MARKER} 0$`, 'm'));
});

test('project resolution opens at most one transcript stream at a time', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 8; index += 1) {
    const project = await addMemoryProject(root, `project-${index}`);
    await writeFile(join(project, 'session.jsonl'), '{"cwd":"/unused/by/preload"}\n');
  }
  const preload = await transcriptStreamPreload(t);
  const server = await startAtRoot(t, root, {
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
      SCMD_TEST_STREAM_MODE: 'delayed-end',
      SCMD_TEST_STREAM_ROOT: root,
    },
  });

  const response = await requestProjects(server);
  const activeCounts = [...server.output().stdout.matchAll(new RegExp(`^${OPEN_MARKER} (\\d+)$`, 'gm'))]
    .map((match) => Number(match[1]));

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).projects.length, 8);
  assert.equal(activeCounts.length, 8);
  assert.equal(Math.max(...activeCounts), 1);
});

test('GET /api/projects preserves Host and token checks', async (t) => {
  const server = await startAtRoot(t, FIXTURE_ROOT);

  const missingToken = await request(server, '/api/projects');
  const wrongToken = await request(server, '/api/projects', {
    headers: { 'X-SCMD-Token': 'wrong' },
  });
  const foreignHost = await requestProjects(server, { Host: 'attacker.example' });

  assert.equal(missingToken.status, 401);
  assert.equal(wrongToken.status, 401);
  assert.equal(foreignHost.status, 403);
});

test('a discovery failure returns a stable JSON error without filesystem details', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-projects-'));
  const server = await startAtRoot(t, root);
  await rm(root, { recursive: true, force: true });

  const response = await requestProjects(server);

  assert.equal(response.status, 500);
  assert.match(response.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      code: 'project-scan-failed',
      message: 'Could not list projects.',
    },
  });
  assert.doesNotMatch(response.body, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
