const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const { startServer } = require('./server-helper');

const FIXTURE_ROOT = resolve(__dirname, '..', 'fixtures', 'projects');

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

async function startAtRoot(t, root, { env = process.env } = {}) {
  return startServer(t, {
    serverArgs: ['--root', root, '--port', '0', '--no-open'],
    env,
  });
}

async function makeProject(root, projectId, files) {
  const memoryPath = join(root, projectId, 'memory');
  await mkdir(memoryPath, { recursive: true });
  for (const [fileName, contents] of Object.entries(files)) {
    await writeFile(join(memoryPath, fileName), contents);
  }
  return memoryPath;
}

function projectHealth(project) {
  return {
    unindexed: project.unindexed,
    dangling: project.dangling,
    unreadable: project.unreadable,
  };
}

test('fixture projects report deterministic unindexed files and the planted dangling line', async (t) => {
  const server = await startAtRoot(t, FIXTURE_ROOT);
  const first = await requestProjects(server);
  const second = await requestProjects(server);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body, first.body);

  const projects = Object.fromEntries(JSON.parse(first.body).projects.map((project) => [
    project.id,
    projectHealth(project),
  ]));
  assert.deepEqual(projects, {
    '-Users-example-api-server': {
      unindexed: ['api_contract.md'],
      dangling: [],
      unreadable: [],
    },
    '-Users-example-docs': {
      unindexed: [],
      dangling: [],
      unreadable: [],
    },
    '-Users-example-my-side-project': {
      unindexed: [],
      dangling: [{
        fileName: 'missing_deployment.md',
        lineNumber: 5,
        line: '- [Old deployment reminder](missing_deployment.md) — This entry points to a removed memory.',
      }],
      unreadable: [],
    },
    '-Users-example-web-client': {
      unindexed: ['feedback_accessibility.md', 'ui_note.md'],
      dangling: [],
      unreadable: [],
    },
  });
});

test('only canonical index bullets count, with duplicate dangling lines preserved exactly', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-index-health-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeProject(root, 'project', {
    'a.md': '# A\n',
    'b.md': '# B\n',
    'MEMORY.md': [
      '# Index',
      '- [A](a.md) — first',
      '  - [A duplicate](a.md) — second',
      'Some prose with [B](b.md) in it.',
      '- [Missing](ghost.md) — first missing',
      '- [Missing again](ghost.md) — second missing',
      '- [Parent path](../a.md) — never follow this',
      '- [Nested path](sub/a.md) — never follow this either',
      '- [External](https://example.com/a.md)',
      '- [Query](a.md?raw=1)',
      '- [Fragment](a.md#details)',
      '- [Backslash](folder\\a.md)',
      '- [Not Markdown](note.txt)',
      '* [Wrong bullet](star.md)',
      '-  [Wrong spacing](b.md)',
      '-\t[Wrong tab](b.md)',
      '````markdown',
      '- [Fenced existing](b.md)',
      '```',
      '- [Still fenced](fenced-too-short.md)',
      '````',
      '~~~ text',
      '- [Tilde fenced](tilde.md)',
      '~~~',
      '',
    ].join('\n'),
  });

  const server = await startAtRoot(t, root);
  const response = await requestProjects(server);
  const project = JSON.parse(response.body).projects[0];

  assert.equal(response.status, 200);
  assert.deepEqual(project.unindexed, ['b.md']);
  assert.deepEqual(project.dangling, [
    {
      fileName: 'ghost.md',
      lineNumber: 5,
      line: '- [Missing](ghost.md) — first missing',
    },
    {
      fileName: 'ghost.md',
      lineNumber: 6,
      line: '- [Missing again](ghost.md) — second missing',
    },
  ]);
  assert.deepEqual(project.unreadable, []);
  assert.doesNotMatch(response.body, /https:\/\/example\.com/);
  assert.doesNotMatch(response.body, /fenced-too-short/);
  assert.doesNotMatch(response.body, /tilde\.md/);
});

test('literal percent targets resolve exactly before percent-decoded alternatives', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-index-health-percent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeProject(root, 'project', {
    'a%b.md': '# Literal percent\n',
    'a%25b.md': '# Percent 25\n',
    'a%2Fb.md': '# Percent 2F\n',
    'MEMORY.md': [
      '- [Literal percent](a%b.md) — exact raw target',
      '- [Percent 25](a%25b.md) — exact raw target before a%b.md',
      '- [Percent 2F](a%2Fb.md) — never decode into a path',
      '',
    ].join('\n'),
  });

  const server = await startAtRoot(t, root);
  const response = await requestProjects(server);
  const project = JSON.parse(response.body).projects[0];

  assert.equal(response.status, 200);
  assert.deepEqual(project.unindexed, []);
  assert.deepEqual(project.dangling, []);
  assert.deepEqual(project.unreadable, []);
});

test('a missing index leaves every candidate memory unindexed without an unreadable report', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-index-health-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeProject(root, 'project', {
    'a.md': '# A\n',
    'b.md': '# B\n',
  });

  const server = await startAtRoot(t, root);
  const response = await requestProjects(server);
  const project = JSON.parse(response.body).projects[0];

  assert.equal(response.status, 200);
  assert.deepEqual(project.unindexed, ['a.md', 'b.md']);
  assert.deepEqual(project.dangling, []);
  assert.deepEqual(project.unreadable, []);
});

test('a MEMORY.md symlink is rejected without reading or leaking its outside target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-index-health-'));
  const outside = await mkdtemp(join(tmpdir(), 'scmd-outside-index-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const memoryPath = await makeProject(root, 'project', {
    'one.md': '# One\n',
  });
  const outsideIndex = join(outside, 'outside-memory-index.md');
  const sentinel = 'SCMD_OUTSIDE_INDEX_SENTINEL';
  await writeFile(outsideIndex, [
    '- [One](one.md)',
    `- [${sentinel}](outside-secret.md)`,
    '',
  ].join('\n'));
  await symlink(outsideIndex, join(memoryPath, 'MEMORY.md'));

  const server = await startAtRoot(t, root);
  const response = await requestProjects(server);
  const project = JSON.parse(response.body).projects[0];

  assert.equal(response.status, 200);
  assert.deepEqual(project.unindexed, ['one.md']);
  assert.deepEqual(project.dangling, []);
  assert.deepEqual(project.unreadable, [{ fileName: 'MEMORY.md', code: 'symlink' }]);
  assert.doesNotMatch(response.body, new RegExp(sentinel));
  assert.doesNotMatch(response.body, new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a project whose memory directory is an outside symlink is omitted without reading it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-index-health-'));
  const outside = await mkdtemp(join(tmpdir(), 'scmd-outside-memory-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  await makeProject(root, 'valid-project', {
    'valid.md': '# Valid\n',
  });
  const rogueProject = 'rogue-project-sentinel';
  const rogueProjectPath = join(root, rogueProject);
  const outsideMemory = join(outside, 'memory-target');
  const outsideFileName = 'outside_secret.md';
  const outsideBody = 'SCMD_OUTSIDE_MEMORY_BODY_SENTINEL\n';
  const outsideTarget = 'outside-target-sentinel.md';
  await mkdir(rogueProjectPath, { recursive: true });
  await mkdir(outsideMemory, { recursive: true });
  await writeFile(join(outsideMemory, outsideFileName), outsideBody);
  await writeFile(join(outsideMemory, 'MEMORY.md'), [
    `- [Outside](${outsideFileName})`,
    `- [Outside target](${outsideTarget})`,
    '',
  ].join('\n'));
  await symlink(outsideMemory, join(rogueProjectPath, 'memory'), process.platform === 'win32' ? 'junction' : 'dir');
  const outsideHash = crypto.createHash('sha256').update(outsideBody).digest('hex');

  const server = await startAtRoot(t, root);
  const response = await requestProjects(server);
  const { projects } = JSON.parse(response.body);

  assert.equal(response.status, 200);
  assert.deepEqual(projects.map((project) => project.id), ['valid-project']);
  assert.deepEqual(projects[0].cards.map((card) => card.fileName), ['valid.md']);
  for (const sentinel of [
    rogueProject,
    outsideFileName,
    outsideBody.trim(),
    outsideHash,
    outsideTarget,
    outside,
  ]) {
    assert.equal(response.body.includes(sentinel), false, sentinel);
  }
});

test('invalid UTF-8 in the index and a memory is isolated with stable, path-free results', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-index-health-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memoryPath = await makeProject(root, 'project', {
    'a.md': '# A\n',
  });
  await writeFile(join(memoryPath, 'bad.md'), Buffer.from([0xc3, 0x28]));
  await writeFile(join(memoryPath, 'MEMORY.md'), Buffer.from([0xc3, 0x28]));

  const server = await startAtRoot(t, root);
  const first = await requestProjects(server);
  const second = await requestProjects(server);
  const firstPayload = JSON.parse(first.body);
  const project = firstPayload.projects[0];

  assert.equal(first.status, 200);
  assert.equal(second.body, first.body);
  assert.equal(project.memoryCount, 2);
  assert.deepEqual(project.cards.map((card) => card.fileName), ['a.md']);
  assert.deepEqual(project.unindexed, ['a.md', 'bad.md']);
  assert.deepEqual(project.dangling, []);
  assert.deepEqual(project.unreadable, [
    { fileName: 'MEMORY.md', code: 'invalid-utf8' },
    { fileName: 'bad.md', code: 'invalid-utf8' },
  ]);
  assert.equal(firstPayload.root, root);
  const { root: declaredRoot, ...pathFreePayload } = firstPayload;
  assert.equal(declaredRoot, root);
  assert.doesNotMatch(
    JSON.stringify(pathFreePayload),
    new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('chmod 000 memory is reported without failing its project when permissions are enforceable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-index-health-'));
  const memoryPath = await makeProject(root, 'project', {
    'open.md': '# Open\n',
    'locked.md': '# Locked\n',
    'MEMORY.md': '- [Open](open.md)\n- [Locked](locked.md)\n',
  });
  const lockedPath = join(memoryPath, 'locked.md');
  t.after(async () => {
    await chmod(lockedPath, 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await chmod(lockedPath, 0o000);

  let permissionError;
  try {
    await readFile(lockedPath);
  } catch (error) {
    permissionError = error;
  }
  if (!permissionError) {
    t.skip('filesystem permissions cannot be enforced for this process');
    return;
  }

  const server = await startAtRoot(t, root);
  const response = await requestProjects(server);
  const payload = JSON.parse(response.body);
  const project = payload.projects[0];

  assert.equal(response.status, 200);
  assert.equal(project.memoryCount, 2);
  assert.deepEqual(project.cards.map((card) => card.fileName), ['open.md']);
  assert.deepEqual(project.unindexed, []);
  assert.deepEqual(project.dangling, []);
  assert.deepEqual(project.unreadable, [{
    fileName: 'locked.md',
    code: permissionError.code,
  }]);
  assert.deepEqual(Object.keys(project.unreadable[0]).sort(), ['code', 'fileName']);
  assert.equal(payload.root, root);
  const { root: declaredRoot, ...pathFreePayload } = payload;
  assert.equal(declaredRoot, root);
  assert.doesNotMatch(
    JSON.stringify(pathFreePayload),
    new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('a memory is read and statted through one file handle', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-index-health-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memoryPath = await makeProject(root, 'project', {
    'one.md': '# One\n',
    'MEMORY.md': '- [One](one.md)\n',
  });
  const memoryFile = join(memoryPath, 'one.md');
  const preload = join(root, 'single-handle-preload.js');
  await writeFile(preload, `
const fs = require('node:fs');
const target = process.env.SCMD_SINGLE_HANDLE_TARGET;
const originalOpen = fs.promises.open.bind(fs.promises);
const originalReadFile = fs.promises.readFile.bind(fs.promises);
const originalStat = fs.promises.stat.bind(fs.promises);

function legacyCallError() {
  const error = new Error('path-based read/stat used');
  error.code = 'SCMD_TEST_LEGACY_CALL';
  return error;
}

fs.promises.readFile = (file, ...args) => {
  if (String(file) === target) return Promise.reject(legacyCallError());
  return originalReadFile(file, ...args);
};
fs.promises.stat = (file, ...args) => {
  if (String(file) === target) return Promise.reject(legacyCallError());
  return originalStat(file, ...args);
};
fs.promises.open = async (file, ...args) => {
  const handle = await originalOpen(file, ...args);
  if (String(file) !== target) return handle;

  process.stdout.write('SCMD_TEST_MEMORY_OPEN\\n');
  const originalClose = handle.close.bind(handle);
  let closed = false;
  handle.close = async (...closeArgs) => {
    if (!closed) {
      closed = true;
      process.stdout.write('SCMD_TEST_MEMORY_CLOSE\\n');
    }
    return originalClose(...closeArgs);
  };
  return handle;
};
`);

  const server = await startAtRoot(t, root, {
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
      SCMD_SINGLE_HANDLE_TARGET: memoryFile,
    },
  });
  const response = await requestProjects(server);
  const project = JSON.parse(response.body).projects[0];

  assert.equal(response.status, 200);
  assert.deepEqual(project.cards.map((card) => card.fileName), ['one.md']);
  assert.deepEqual(project.unreadable, []);
  const output = server.output().stdout;
  assert.equal((output.match(/^SCMD_TEST_MEMORY_OPEN$/gm) || []).length, 1);
  assert.equal((output.match(/^SCMD_TEST_MEMORY_CLOSE$/gm) || []).length, 1);
});
