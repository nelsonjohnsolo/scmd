const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { chmod, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { join, relative, resolve } = require('node:path');
const { promisify } = require('node:util');

const ROOT = resolve(__dirname, '..');
const MARKETPLACE_PATH = join(ROOT, '.claude-plugin', 'marketplace.json');
const PLUGIN_ROOT = join(ROOT, 'plugin');
const PLUGIN_MANIFEST_PATH = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
const RUN_COMMAND_PATH = join(PLUGIN_ROOT, 'commands', 'run.md');
const LAUNCH_COMMAND = 'npx -y --prefix="${CLAUDE_PLUGIN_ROOT}" --prefer-online @nelsonjohnsolo/scmd@latest';
const execFileAsync = promisify(execFile);

function readRequired(path) {
  assert.ok(existsSync(path), `expected ${relative(ROOT, path)} to exist`);
  return readFileSync(path, 'utf8');
}

function parseJson(path) {
  return JSON.parse(readRequired(path));
}

function listFiles(root) {
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(root, path));
    }
  }

  visit(root);
  return files.sort();
}

function parseCommand(path) {
  const source = readRequired(path);
  const match = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, 'run.md must contain YAML frontmatter followed by command instructions');

  const frontmatter = Object.fromEntries(match[1].split('\n').map((line) => {
    const separator = line.indexOf(':');
    assert.notEqual(separator, -1, `invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    const value = rawValue === 'true' ? true : rawValue;
    return [key, value];
  }));

  return { frontmatter, body: match[2] };
}

async function writePackage(directory, marker) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: '@nelsonjohnsolo/scmd',
    version: '9.9.9',
    bin: { scmd: 'launcher.js' },
  }));
  await writeFile(join(directory, 'launcher.js'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(marker)});\n`);
  await chmod(join(directory, 'launcher.js'), 0o755);
}

async function startRegistry(t, tarball) {
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const shasum = createHash('sha1').update(tarball).digest('hex');
  const server = createServer((request, response) => {
    if (request.url === '/scmd-9.9.9.tgz') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(tarball);
      return;
    }

    const origin = `http://127.0.0.1:${server.address().port}`;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      name: '@nelsonjohnsolo/scmd',
      'dist-tags': { latest: '9.9.9' },
      versions: {
        '9.9.9': {
          name: '@nelsonjohnsolo/scmd',
          version: '9.9.9',
          bin: { scmd: 'launcher.js' },
          dist: {
            tarball: `${origin}/scmd-9.9.9.tgz`,
            integrity,
            shasum,
          },
        },
      },
    }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('plugin and marketplace contain only the supported manifest and flat run command files', () => {
  assert.ok(existsSync(MARKETPLACE_PATH), 'expected .claude-plugin/marketplace.json to exist');
  assert.ok(existsSync(PLUGIN_ROOT), 'expected plugin/ to exist');
  assert.deepEqual(listFiles(join(ROOT, '.claude-plugin')), ['marketplace.json']);
  assert.deepEqual(listFiles(PLUGIN_ROOT), [
    '.claude-plugin/plugin.json',
    'commands/run.md',
  ]);
});

test('marketplace points the scmd namespace at the repository-local plugin', () => {
  const marketplace = parseJson(MARKETPLACE_PATH);

  assert.equal(marketplace.name, 'scmd');
  assert.deepEqual(marketplace.owner, {
    name: 'Nelson John',
    email: 'nelson@solobits.dev',
  });
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, 'scmd');
  assert.equal(marketplace.plugins[0].source, './plugin');
  assert.equal(marketplace.plugins[0].version, '0.1.0');
});

test('plugin manifest defines the scmd namespace and current repository identity', () => {
  const manifest = parseJson(PLUGIN_MANIFEST_PATH);

  assert.equal(manifest.name, 'scmd');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.repository, 'https://github.com/nelsonjohnsolo/scmd');
  assert.deepEqual(manifest.author, {
    name: 'Nelson John',
    email: 'nelson@solobits.dev',
    url: 'https://github.com/nelsonjohnsolo/scmd',
  });
});

test('run is user-only and narrowly permits the exact launcher command', () => {
  const { frontmatter } = parseCommand(RUN_COMMAND_PATH);

  assert.equal(frontmatter['disable-model-invocation'], true);
  assert.equal(frontmatter['allowed-tools'], `Bash(${LAUNCH_COMMAND})`);
  assert.match(frontmatter.description, /launch|start/i);
  assert.ok(frontmatter.description.length <= 100, 'description should stay concise');
});

test('run launches through Bash background execution and reports readiness safely', () => {
  const { body } = parseCommand(RUN_COMMAND_PATH);

  assert.equal(body.split(LAUNCH_COMMAND).length - 1, 1, 'instructions must invoke one exact launcher');
  assert.match(body, /Bash/);
  assert.match(body, /run_in_background:\s*true/);
  assert.match(body, /do not.*(?:`&`.*`nohup`|`nohup`.*`&`)/is);
  const launcherLine = body.split('\n').find((line) => line.includes(LAUNCH_COMMAND));
  assert.equal(launcherLine.trim(), `- command: \`${LAUNCH_COMMAND}\``);
  assert.match(body, /SCMD running at /);
  assert.match(body, /stdout/i);
  assert.match(body, /complete.*(?:loopback|127\.0\.0\.1).*token|token.*complete.*(?:loopback|127\.0\.0\.1)/is);
  assert.match(body, /(?:exit|fail|error).*before.*SCMD running at /is);
  assert.match(body, /stderr/i);
  assert.match(body, /(?:already|duplicate|second).*run|do not.*(?:duplicate|another)/is);
});

test('the launcher ignores a matching project-local package and runs the fresh registry package', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'scmd-plugin-npx-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const project = join(sandbox, 'hostile-project');
  const remotePackage = join(sandbox, 'registry-package');
  const packDestination = join(sandbox, 'packed');
  const pluginRoot = join(sandbox, 'installed plugin');
  const cache = join(sandbox, 'npm-cache');

  await mkdir(packDestination, { recursive: true });
  await mkdir(pluginRoot, { recursive: true });
  await writePackage(remotePackage, 'REGISTRY_PACKAGE');
  await writePackage(join(project, 'node_modules', '@nelsonjohnsolo', 'scmd'), 'MALICIOUS_LOCAL_PACKAGE');
  await mkdir(join(project, 'node_modules', '.bin'), { recursive: true });
  await writeFile(
    join(project, 'node_modules', '.bin', 'scmd'),
    '#!/usr/bin/env node\nconsole.log("MALICIOUS_LOCAL_PACKAGE");\n',
  );
  await chmod(join(project, 'node_modules', '.bin', 'scmd'), 0o755);
  await writeFile(join(project, 'package.json'), JSON.stringify({
    private: true,
    dependencies: { '@nelsonjohnsolo/scmd': '9.9.9' },
  }));
  const { stdout: packOutput } = await execFileAsync('npm', [
    'pack', '--json', '--pack-destination', packDestination,
  ], {
    cwd: remotePackage,
    env: { ...process.env, NPM_CONFIG_CACHE: cache },
  });
  const [{ filename }] = JSON.parse(packOutput);
  const registry = await startRegistry(t, await readFile(join(packDestination, filename)));
  const command = LAUNCH_COMMAND.replace('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
  const env = {
    ...process.env,
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_REGISTRY: registry,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  const { stdout: vulnerableStdout } = await execFileAsync(
    'bash', ['-lc', 'npx -y @nelsonjohnsolo/scmd'], { cwd: project, env, timeout: 20_000 },
  );
  const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], {
    cwd: project,
    env,
    timeout: 20_000,
  });

  assert.match(vulnerableStdout, /MALICIOUS_LOCAL_PACKAGE/);
  assert.match(stdout, /REGISTRY_PACKAGE/);
  assert.doesNotMatch(`${stdout}\n${stderr}`, /MALICIOUS_LOCAL_PACKAGE/);
});
