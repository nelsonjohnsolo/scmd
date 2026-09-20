const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const { startServer } = require('./server-helper');

const MAX_INSTRUCTION_BYTES = 256 * 1024;

async function getInstructions(server) {
  const response = await fetch(new URL('/api/instructions', server.url), {
    headers: { 'X-SCMD-Token': server.token },
  });
  return { response, payload: await response.json() };
}

test('GET /api/instructions returns the fixture global file without following imports', async (t) => {
  const server = await startServer(t);
  const { response, payload } = await getInstructions(server);

  assert.equal(response.status, 200);
  assert.deepEqual(payload.files, [{
    path: resolve(__dirname, '..', 'fixtures', 'CLAUDE.md'),
    projectId: null,
    content: '# Fixture instructions\n\nSCMD_INSTRUCTION_ONLY_TOKEN keeps this read-only fixture easy to find.\n\n@NOT_FOLLOWED.md\n',
    truncated: false,
  }]);
});

test('instruction discovery reads only named global and resolved-project files and caps each file', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'scmd-instructions-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, '.claude', 'projects');
  const encodedProject = join(root, '-fixture-demo');
  const encodedSymlinkProject = join(root, '-fixture-symlink');
  const realProject = join(sandbox, 'workspace', 'demo');
  const symlinkProject = join(sandbox, 'workspace', 'symlink-demo');
  await mkdir(join(encodedProject, 'memory'), { recursive: true });
  await mkdir(join(encodedSymlinkProject, 'memory'), { recursive: true });
  await mkdir(join(realProject, '.claude'), { recursive: true });
  await mkdir(symlinkProject, { recursive: true });
  await writeFile(
    join(encodedProject, 'session.jsonl'),
    `${JSON.stringify({ cwd: realProject })}\n`,
  );
  await writeFile(join(sandbox, '.claude', 'CLAUDE.md'), 'G'.repeat(MAX_INSTRUCTION_BYTES + 100));
  await writeFile(join(sandbox, '.claude', 'NOT_FOLLOWED.md'), 'must not be returned\n');
  await writeFile(join(realProject, 'CLAUDE.md'), 'root project instruction\n');
  await writeFile(join(realProject, '.claude', 'CLAUDE.md'), 'nested project instruction\n');
  await writeFile(join(realProject, 'CLAUDE.local.md'), 'local project instruction\n');
  await writeFile(join(realProject, 'AGENTS.md'), 'not a Claude instruction file\n');
  await writeFile(
    join(encodedSymlinkProject, 'session.jsonl'),
    `${JSON.stringify({ cwd: symlinkProject })}\n`,
  );
  const outsideInstruction = join(sandbox, 'outside-instruction.md');
  await writeFile(outsideInstruction, 'must not be followed through a symlink\n');
  await symlink(outsideInstruction, join(symlinkProject, 'CLAUDE.md'));

  const server = await startServer(t, {
    serverArgs: ['--root', root, '--port', '0', '--no-open'],
  });
  const { response, payload } = await getInstructions(server);

  assert.equal(response.status, 200);
  assert.deepEqual(
    payload.files.map((file) => [file.path, file.projectId, file.truncated]),
    [
      [join(sandbox, '.claude', 'CLAUDE.md'), null, true],
      [join(realProject, 'CLAUDE.md'), '-fixture-demo', false],
      [join(realProject, '.claude', 'CLAUDE.md'), '-fixture-demo', false],
      [join(realProject, 'CLAUDE.local.md'), '-fixture-demo', false],
    ],
  );
  assert.equal(Buffer.byteLength(payload.files[0].content), MAX_INSTRUCTION_BYTES);
  assert.deepEqual(
    payload.files.slice(1).map((file) => file.content),
    ['root project instruction\n', 'nested project instruction\n', 'local project instruction\n'],
  );
  assert.equal(payload.files.some((file) => file.path.endsWith('NOT_FOLLOWED.md')), false);
  assert.equal(payload.files.some((file) => file.path.endsWith('AGENTS.md')), false);
  assert.equal(payload.files.some((file) => file.path.includes('symlink-demo')), false);
});
