const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer } = require('./server-helper');
const { loadPageApi } = require('./page-vm-helper');

test('HTTP backend exposes the D2 interface and authenticates every request', async () => {
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    requests.push({ url, options });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ projects: [], notices: [] }),
    });
  };
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({
    token: 'token-from-launch-url',
    fetchImpl,
  });

  assert.deepEqual(
    Object.keys(backend).sort(),
    ['events', 'instructions', 'listProjects', 'modifyWithAI', 'origin', 'read', 'remove', 'write'],
  );
  await backend.listProjects();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/projects');
  assert.equal(requests[0].options.headers['X-SCMD-Token'], 'token-from-launch-url');
});

test('HTTP origin helper uses the specified path route and launch token', async () => {
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    requests.push({ url, options });
    return Promise.resolve({
      ok: true,
      json: async () => ({ status: 'not-found' }),
    });
  };
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({
    token: 'token-from-launch-url',
    fetchImpl,
  });

  await backend.origin('my project/memory.md');

  assert.equal(requests[0].url, '/api/origin/my%20project%2Fmemory.md');
  assert.equal(requests[0].options.headers['X-SCMD-Token'], 'token-from-launch-url');
});

test('HTTP write batches staged decisions into one apply request', async () => {
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    requests.push({ url, options });
    return Promise.resolve({
      ok: true,
      json: async () => ({ results: [{ id: 'demo/a.md', action: 'keep', status: 'applied' }] }),
    });
  };
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({
    token: 'token-from-launch-url',
    fetchImpl,
  });
  const decisions = [{ id: 'demo/a.md', action: 'keep', expectedHash: 'a'.repeat(64) }];

  const result = await backend.write(decisions);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/apply');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), { decisions });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    results: [{ id: 'demo/a.md', action: 'keep', status: 'applied' }],
  });
});

test('HTTP AI modification can send staged content through the existing method', async () => {
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    requests.push({ url, options });
    return Promise.resolve({
      ok: true,
      json: async () => ({ before: 'staged bytes', text: 'proposal', valid: true }),
    });
  };
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({ token: 'token', fetchImpl });

  const result = await backend.modifyWithAI(
    'demo/a.md',
    'shorten',
    { content: 'staged bytes' },
  );

  assert.deepEqual(JSON.parse(requests[0].options.body), {
    id: 'demo/a.md',
    instruction: 'shorten',
    content: 'staged bytes',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    before: 'staged bytes',
    text: 'proposal',
    valid: true,
  });
  assert.deepEqual(
    Object.keys(backend).sort(),
    ['events', 'instructions', 'listProjects', 'modifyWithAI', 'origin', 'read', 'remove', 'write'],
  );
});

test('HTTP backend routes trash listing, restore, and purge through the five-method interface', async () => {
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    requests.push({ url, options });
    const payload = url === '/api/trash'
      ? { runs: [], notices: [] }
      : { result: { status: 'ok' } };
    return Promise.resolve({ ok: true, json: async () => payload });
  };
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({
    token: 'token-from-launch-url',
    fetchImpl,
  });

  await backend.read({ trash: true });
  await backend.write({ restore: { runId: 'run-1', id: 'demo/a.md' } });
  await backend.remove({ trashRunId: 'run-1' });

  assert.deepEqual(requests.map(({ url, options }) => [
    url,
    options.method,
    options.body ? JSON.parse(options.body) : undefined,
  ]), [
    ['/api/trash', 'GET', undefined],
    ['/api/restore', 'POST', { runId: 'run-1', id: 'demo/a.md' }],
    ['/api/purge', 'POST', { runId: 'run-1' }],
  ]);
});

test('HTTP read overload routes rewrite status and exact memory source without adding a method', async () => {
  const requests = [];
  const exact = '---\r\nname: Exact\r\ndescription: Exact bytes.\r\ntype: project\r\n---\r\n\r\nBody.\r\n';
  const fetchImpl = (url, options = {}) => {
    requests.push({ url, options });
    return Promise.resolve({
      ok: true,
      json: async () => (url === '/api/status'
        ? { rewriteAvailable: false }
        : { id: 'my project/memory.md', content: exact }),
    });
  };
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({
    token: 'token-from-launch-url',
    fetchImpl,
  });

  const status = await backend.read({ status: true });
  const memory = await backend.read('my project/memory.md');

  assert.deepEqual(JSON.parse(JSON.stringify(status)), { rewriteAvailable: false });
  assert.equal(memory.content, exact);
  assert.deepEqual(requests.map(({ url, options }) => [
    url,
    options.headers['X-SCMD-Token'],
  ]), [
    ['/api/status', 'token-from-launch-url'],
    ['/api/memory/my%20project%2Fmemory.md', 'token-from-launch-url'],
  ]);
  assert.deepEqual(
    Object.keys(backend).sort(),
    ['events', 'instructions', 'listProjects', 'modifyWithAI', 'origin', 'read', 'remove', 'write'],
  );
});

test('HTTP event stream carries the launch token and can be stopped', async () => {
  const requests = [];
  const fetchImpl = (url, options = {}) => {
    requests.push({ url, options });
    return new Promise(() => {});
  };
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({
    token: 'token-from-launch-url',
    fetchImpl,
  });

  const stop = backend.events();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/events');
  assert.equal(requests[0].options.headers['X-SCMD-Token'], 'token-from-launch-url');
  assert.ok(requests[0].options.signal);
  stop();
});

test('stopping the event stream cancels a queued reconnect', async () => {
  const requests = [];
  const scheduled = [];
  const fetchImpl = (url, options = {}) => {
    requests.push({ url, options });
    return Promise.reject(new Error('fixture disconnect'));
  };
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({
    token: 'token-from-launch-url',
    fetchImpl,
    schedule(callback) {
      scheduled.push(callback);
    },
  });

  const stop = backend.events();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(scheduled.length, 1);

  stop();
  await scheduled[0]();
  assert.equal(requests.length, 1);
});

test('event callbacks keep working after the HTTP stream reconnects', async () => {
  const scheduled = [];
  const payloads = [
    { type: 'added', id: 'demo/one.md' },
    { type: 'removed', id: 'demo/two.md' },
  ];
  const fetchImpl = async () => {
    const payload = payloads.shift();
    let sent = false;
    return {
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              if (sent) return { done: true };
              sent = true;
              return {
                done: false,
                value: Buffer.from(`data: ${JSON.stringify(payload)}\n\n`),
              };
            },
          };
        },
      },
    };
  };
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({
    token: 'token-from-launch-url',
    fetchImpl,
    schedule(callback) {
      scheduled.push(callback);
    },
  });
  const received = [];

  const stop = backend.events((event) => received.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(received)), [
    { type: 'added', id: 'demo/one.md' },
  ]);
  assert.equal(scheduled.length, 1);

  await scheduled.shift()();
  assert.deepEqual(JSON.parse(JSON.stringify(received)), [
    { type: 'added', id: 'demo/one.md' },
    { type: 'removed', id: 'demo/two.md' },
  ]);
  stop();
});

test('fake backend has the same callable surface and records no mutation during listing', async () => {
  const { window } = await loadPageApi();
  const fake = window.SCMD.createFakeBackend({
    projects: [{ id: 'docs', name: 'docs', memoryCount: 0, cards: [] }],
    notices: ['Fixture notice.'],
  });
  assert.deepEqual(
    Object.keys(fake).filter((key) => typeof fake[key] === 'function').sort(),
    ['events', 'instructions', 'listProjects', 'modifyWithAI', 'origin', 'read', 'remove', 'write'],
  );
  const result = await fake.listProjects();
  assert.equal(result.projects[0].memoryCount, 0);
  assert.deepEqual(Array.from(fake.calls, (call) => call.method), ['listProjects']);
});

test('fake read overload exposes seeded rewrite availability and exact memory content', async () => {
  const { window } = await loadPageApi();
  const content = '---\nname: A\ndescription: B\ntype: project\n---\n\nC\n';
  const fake = window.SCMD.createFakeBackend({
    rewriteAvailable: false,
    projects: [{
      id: 'demo',
      name: 'demo',
      memoryCount: 1,
      cards: [{ id: 'demo/a.md', name: 'A', body: 'C\n', content }],
    }],
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(await fake.read({ status: true }))),
    { rewriteAvailable: false },
  );
  assert.equal((await fake.read('demo/a.md')).content, content);
  assert.deepEqual(JSON.parse(JSON.stringify(fake.calls)), [
    { method: 'read', status: true },
    { method: 'read', id: 'demo/a.md' },
  ]);
});

test('fake batch edits update the complete card preview and unconfigured AI fails explicitly', async () => {
  const { window } = await loadPageApi();
  const original = '---\nname: A\ndescription: Before.\ntype: project\n---\n\nOld body.\n';
  const edited = '---\nname: Renamed\ndescription: After.\ntype: feedback\n---\n\nNew body.\n';
  const fake = window.SCMD.createFakeBackend({
    projects: [{
      id: 'demo',
      name: 'demo',
      memoryCount: 1,
      cards: [{
        id: 'demo/a.md',
        name: 'A',
        summary: 'Before.',
        type: 'project',
        body: 'Old body.\n',
        content: original,
        hash: 'hash-before',
      }],
    }],
  });

  await fake.write([{
    id: 'demo/a.md',
    action: 'edit',
    expectedHash: 'hash-a',
    newContent: edited,
  }]);
  const card = await fake.read('demo/a.md');

  assert.equal(card.name, 'Renamed');
  assert.equal(card.summary, 'After.');
  assert.equal(card.type, 'feedback');
  assert.equal(card.body, '\nNew body.\n');
  assert.equal(card.content, edited);
  assert.notEqual(card.hash, 'hash-before');
  const editedHash = card.hash;
  await fake.write([{
    id: 'demo/a.md',
    action: 'edit',
    expectedHash: editedHash,
    newContent: edited,
  }]);
  assert.equal((await fake.read('demo/a.md')).hash, editedHash);
  await assert.rejects(
    fake.modifyWithAI('demo/a.md', 'shorten'),
    /No fake rewrite result configured/,
  );
});

test('configured fake AI reports the exact staged input as before', async () => {
  const { window } = await loadPageApi();
  const fake = window.SCMD.createFakeBackend({
    rewriteResult: { text: 'proposal', valid: true },
    projects: [{
      id: 'demo',
      name: 'demo',
      memoryCount: 1,
      cards: [{ id: 'demo/a.md', body: 'disk bytes', content: 'disk bytes' }],
    }],
  });

  const result = await fake.modifyWithAI('demo/a.md', 'shorten', { content: 'staged bytes' });

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    before: 'staged bytes',
    text: 'proposal',
    valid: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(fake.calls[0])), {
    method: 'modifyWithAI',
    id: 'demo/a.md',
    instruction: 'shorten',
    options: { content: 'staged bytes' },
  });
});

test('HTTP backend loads authoritative project counts from the real fixture server', async (t) => {
  const server = await startServer(t);
  const requests = [];
  const fetchImpl = (pathname, options = {}) => {
    requests.push({ pathname, options });
    return fetch(new URL(pathname, server.url), options);
  };
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({ token: server.token, fetchImpl });
  const result = await backend.listProjects();
  const counts = Object.fromEntries(result.projects.map((project) => [project.name, project.memoryCount]));

  assert.deepEqual(counts, {
    '-Users-example-api-server': 1,
    '-Users-example-docs': 0,
    'my-side-project': 2,
    '-Users-example-web-client': 2,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers['X-SCMD-Token'], server.token);
});
