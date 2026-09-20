const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, relative, resolve } = require('node:path');

const { loadPageApi } = require('./page-vm-helper');
const { startServer } = require('./server-helper');

const FIXTURE_ROOT = resolve(__dirname, '..', 'fixtures', 'projects');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.listeners = new Map();
    this.style = {};
    this.textContent = '';
    this.value = '';
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatch(type, event = {}) {
    if (this.disabled) return;
    for (const listener of this.listeners.get(type) || []) {
      await listener({
        ...event,
        currentTarget: this,
        preventDefault: event.preventDefault || (() => {}),
      });
    }
  }

  focus() {}

  setPointerCapture() {}

  releasePointerCapture() {}
}

function fakeDocument() {
  const elements = new Map();
  const listeners = new Map();
  return {
    createElement: (tagName) => new FakeElement(tagName),
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new FakeElement(id === 'search-input' ? 'input' : 'div');
        elements.set(id, element);
      }
      return elements.get(id);
    },
    addEventListener(type, listener) {
      const registered = listeners.get(type) || [];
      registered.push(listener);
      listeners.set(type, registered);
    },
  };
}

async function snapshotTree(root) {
  const snapshot = [];

  async function visit(pathname) {
    const stats = await lstat(pathname);
    const path = relative(root, pathname) || '.';
    if (stats.isDirectory()) {
      snapshot.push({ path, type: 'directory' });
      const names = await readdir(pathname);
      names.sort();
      for (const name of names) await visit(join(pathname, name));
      return;
    }
    if (stats.isFile()) {
      snapshot.push({
        path,
        type: 'file',
        bytes: (await readFile(pathname)).toString('base64'),
      });
      return;
    }
    if (stats.isSymbolicLink()) {
      snapshot.push({ path, type: 'symlink', target: await readlink(pathname) });
      return;
    }
    snapshot.push({ path, type: 'other' });
  }

  await visit(root);
  return snapshot;
}

test('closing the page discards staged decisions without changing fixtures or SCMD state', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'scmd-close-without-apply-'));
  const root = join(sandbox, 'projects');
  const stateDir = join(sandbox, 'state');
  await cp(FIXTURE_ROOT, root, { recursive: true, verbatimSymlinks: true });
  await mkdir(stateDir);
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  const rootBefore = await snapshotTree(root);
  const stateBefore = await snapshotTree(stateDir);
  assert.deepEqual(stateBefore, [{ path: '.', type: 'directory' }]);

  const server = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  const requests = [];
  const fetchImpl = (pathname, options = {}) => {
    requests.push({ pathname, method: options.method || 'GET' });
    return fetch(new URL(pathname, server.url), options);
  };
  const { window } = await loadPageApi({ fetchImpl, href: server.url });
  const backend = window.SCMD.createHttpBackend({ token: server.token, fetchImpl });
  let eventStreamStopped = false;
  backend.events = () => () => { eventStreamStopped = true; };

  let beforeUnload;
  window.addEventListener = (type, listener) => {
    if (type === 'beforeunload') beforeUnload = listener;
  };
  const document = fakeDocument();
  const page = await window.SCMD.boot({ backend, document, window });

  await document.getElementById('action-keep').dispatch('click');
  await document.getElementById('action-delete').dispatch('click');
  assert.deepEqual(
    Array.from(page.controller.decisions(), ({ action }) => action),
    ['keep', 'delete'],
  );
  assert.equal(typeof beforeUnload, 'function');
  assert.equal(requests.some(({ pathname }) => pathname === '/api/apply'), false);

  beforeUnload();
  assert.equal(eventStreamStopped, true);
  await server.cleanup();

  assert.deepEqual(
    await snapshotTree(root),
    rootBefore,
    'staging and closing must leave every fixture path and file byte unchanged',
  );
  assert.deepEqual(
    await snapshotTree(stateDir),
    stateBefore,
    'staging and closing must not create review history, trash, or other SCMD state',
  );
});
