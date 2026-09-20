const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

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

test('one unwritable target does not poison the other items in a three-delete apply', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-failure-isolation-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-failure-isolation-state-'));
  const projects = [
    { id: 'project-a', fileName: 'a.md', title: 'A' },
    { id: 'project-b', fileName: 'b.md', title: 'B' },
    { id: 'project-c', fileName: 'c.md', title: 'C' },
  ];

  for (const project of projects) {
    project.memoryDir = join(root, project.id, 'memory');
    project.fileBytes = Buffer.from(`# ${project.title}\n`);
    project.indexBytes = Buffer.from(
      `- [${project.title}](${project.fileName}) — ${project.id}\n`,
    );
    await mkdir(project.memoryDir, { recursive: true });
    await writeFile(join(project.memoryDir, project.fileName), project.fileBytes);
    await writeFile(join(project.memoryDir, 'MEMORY.md'), project.indexBytes);
  }

  const blocked = projects[1];
  const originalMode = (await stat(blocked.memoryDir)).mode & 0o7777;
  const probe = join(blocked.memoryDir, '.permission-probe');
  const movedProbe = join(root, '.permission-probe-moved');
  await writeFile(probe, 'probe\n');

  t.after(async () => {
    await chmod(blocked.memoryDir, originalMode).catch(() => {});
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const server = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  const listed = await request(server, '/api/projects?includeReviewed=1');
  assert.equal(listed.status, 200);
  const cards = listed.json.projects.flatMap((project) => project.cards);
  assert.equal(cards.length, 3);

  await chmod(blocked.memoryDir, 0o555);
  let permissionsEnforced = false;
  try {
    await rename(probe, movedProbe);
  } catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error && error.code)) throw error;
    permissionsEnforced = true;
  }

  if (!permissionsEnforced) {
    await rename(movedProbe, probe);
    await chmod(blocked.memoryDir, originalMode);
    t.skip('This filesystem does not enforce directory write permissions for the test process.');
    return;
  }

  const byFile = new Map(cards.map((card) => [card.fileName, card]));
  const response = await request(server, '/api/apply', {
    method: 'POST',
    body: {
      decisions: projects.map((project) => {
        const card = byFile.get(project.fileName);
        return { id: card.id, action: 'delete', expectedHash: card.hash };
      }),
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.json.results, [
    { id: byFile.get('a.md').id, action: 'delete', status: 'applied' },
    { id: byFile.get('b.md').id, action: 'delete', status: 'error', reason: 'delete-failed' },
    { id: byFile.get('c.md').id, action: 'delete', status: 'applied' },
  ]);
  await assert.rejects(access(join(projects[0].memoryDir, 'a.md')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(blocked.memoryDir, 'b.md')), blocked.fileBytes);
  await assert.rejects(access(join(projects[2].memoryDir, 'c.md')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(projects[0].memoryDir, 'MEMORY.md')), Buffer.alloc(0));
  assert.deepEqual(await readFile(join(blocked.memoryDir, 'MEMORY.md')), blocked.indexBytes);
  assert.deepEqual(await readFile(join(projects[2].memoryDir, 'MEMORY.md')), Buffer.alloc(0));

  const runNames = await readdir(join(stateDir, 'trash'));
  assert.equal(runNames.length, 1);
  const [runName] = runNames;
  const manifest = JSON.parse(
    await readFile(join(stateDir, 'trash', runName, 'manifest.json'), 'utf8'),
  );
  assert.deepEqual(manifest.items.map((item) => item.id), [
    byFile.get('a.md').id,
    byFile.get('c.md').id,
  ]);
});
