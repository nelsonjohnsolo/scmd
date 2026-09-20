const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  unlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join, relative, resolve, sep } = require('node:path');

const { startServer } = require('./server-helper');

const FIXTURE_ROOT = resolve(__dirname, '..', 'fixtures', 'projects');
const FETCH_TIMEOUT_MS = 5_000;

function modeOf(stats) {
  return (stats.mode & 0o7777).toString(8).padStart(4, '0');
}

function pathDepth(pathname) {
  return pathname === '.' ? 0 : pathname.split(sep).length;
}

async function treeManifest(root) {
  const manifest = [];

  async function visit(absolutePath, relativePath) {
    const stats = await lstat(absolutePath);
    const common = {
      path: relativePath,
      mode: modeOf(stats),
      mtimeMs: stats.mtimeMs,
    };

    if (stats.isDirectory()) {
      manifest.push({ ...common, type: 'directory' });
      const entries = await readdir(absolutePath);
      entries.sort();
      for (const entry of entries) {
        await visit(join(absolutePath, entry), relativePath === '.' ? entry : join(relativePath, entry));
      }
      return;
    }

    if (stats.isFile()) {
      const bytes = await readFile(absolutePath);
      manifest.push({
        ...common,
        type: 'file',
        size: stats.size,
        bytes: bytes.toString('base64'),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
      return;
    }

    if (stats.isSymbolicLink()) {
      manifest.push({
        ...common,
        type: 'symlink',
        target: await readlink(absolutePath),
      });
      return;
    }

    manifest.push({ ...common, type: 'other' });
  }

  await visit(root, '.');
  return manifest.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
}

async function makeTreeReadOnly(root, original) {
  for (const entry of [...original].sort((left, right) => right.path.length - left.path.length)) {
    if (entry.type === 'file') await chmod(join(root, entry.path), 0o444);
  }
  for (const entry of [...original]
    .filter(({ type }) => type === 'directory')
    .sort((left, right) => pathDepth(right.path) - pathDepth(left.path))) {
    await chmod(join(root, entry.path), 0o555);
  }
}

async function restoreTreePermissions(root, original) {
  const directories = original.filter(({ type }) => type === 'directory');

  for (const entry of [...directories].sort((left, right) => pathDepth(left.path) - pathDepth(right.path))) {
    await chmod(join(root, entry.path), 0o700).catch(() => {});
  }
  for (const entry of original.filter(({ type }) => type === 'file')) {
    await chmod(join(root, entry.path), Number.parseInt(entry.mode, 8)).catch(() => {});
  }
  for (const entry of [...directories].sort((left, right) => pathDepth(right.path) - pathDepth(left.path))) {
    await chmod(join(root, entry.path), Number.parseInt(entry.mode, 8)).catch(() => {});
  }
}

test('discovery loads from a read-only fixture copy without mutating its tree', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX read-only mode verification is not available on Windows');
    return;
  }

  const sandbox = await mkdtemp(join(tmpdir(), 'scmd-read-only-discovery-'));
  const root = join(sandbox, 'projects');
  const stateDir = join(sandbox, 'state');
  let originalModes;
  let server;
  t.after(async () => {
    let cleanupError;
    try {
      if (server) await server.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (originalModes) await restoreTreePermissions(root, originalModes);
    } catch (error) {
      cleanupError ||= error;
    }
    try {
      await rm(sandbox, { recursive: true, force: true });
    } catch (error) {
      cleanupError ||= error;
    }
    if (cleanupError) throw cleanupError;
  });

  await cp(FIXTURE_ROOT, root, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  await mkdir(stateDir);
  originalModes = await treeManifest(root);
  await makeTreeReadOnly(root, originalModes);

  const probe = join(root, '.scmd-write-probe');
  let writeError;
  try {
    await writeFile(probe, 'discovery must not write here', { flag: 'wx' });
  } catch (error) {
    writeError = error;
  }
  if (!writeError) {
    try {
      await chmod(root, 0o755);
      await unlink(probe);
    } finally {
      await chmod(root, 0o555);
    }
    t.diagnostic('filesystem permissions cannot be enforced for this process; continuing mutation checks');
  } else {
    assert.match(writeError.code, /^(?:EACCES|EPERM|EROFS)$/);
  }

  const before = await treeManifest(root);
  for (const entry of before) {
    if (entry.type === 'directory') assert.equal(entry.mode, '0555', entry.path);
    if (entry.type === 'file') assert.equal(entry.mode, '0444', entry.path);
  }
  server = await startServer(undefined, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });

  const pageResponse = await fetch(server.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /\bSCMD\b/);

  const projectsUrl = new URL('/api/projects', server.url);
  const projectsResponse = await fetch(projectsUrl, {
    headers: { 'X-SCMD-Token': server.token },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  assert.equal(projectsResponse.status, 200);
  const projects = JSON.parse(await projectsResponse.text()).projects;
  assert.deepEqual(
    projects.map(({ id, memoryCount }) => ({ id, memoryCount })),
    [
      { id: '-Users-example-api-server', memoryCount: 1 },
      { id: '-Users-example-docs', memoryCount: 0 },
      { id: '-Users-example-my-side-project', memoryCount: 2 },
      { id: '-Users-example-web-client', memoryCount: 2 },
    ],
  );
  assert.deepEqual(
    projects.flatMap(({ cards }) => cards.map(({ id, fileName }) => ({ id, fileName }))),
    [
      {
        id: '-Users-example-api-server/api_contract.md',
        fileName: 'api_contract.md',
      },
      {
        id: '-Users-example-my-side-project/feedback_review.md',
        fileName: 'feedback_review.md',
      },
      {
        id: '-Users-example-my-side-project/project_context.md',
        fileName: 'project_context.md',
      },
      {
        id: '-Users-example-web-client/feedback_accessibility.md',
        fileName: 'feedback_accessibility.md',
      },
      {
        id: '-Users-example-web-client/ui_note.md',
        fileName: 'ui_note.md',
      },
    ],
  );
  for (const project of projects) assert.deepEqual(project.unreadable, [], project.id);
  const transcriptBackedProject = projects.find(({ id }) => id === '-Users-example-my-side-project');
  assert.equal(transcriptBackedProject.path, '/Users/example/my-side-project');
  assert.equal(transcriptBackedProject.pathUnknown, false);

  await server.cleanup();
  const after = await treeManifest(root);
  assert.deepEqual(after, before, 'discovery must not create, remove, or modify anything under --root');
  assert.equal(relative(root, stateDir).startsWith(`..${sep}`), true);
  assert.equal(dirname(stateDir), sandbox);
});
