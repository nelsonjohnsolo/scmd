const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
  createHeartbeat,
  createMemoryWatcher,
  diffMemorySnapshots,
  scanMemorySnapshot,
} = require('../server');
const { startServer } = require('./server-helper');

const EVENT_TIMEOUT_MS = 2_000;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function memory(name, description, body = 'Body.') {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'type: project',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitForPathToDisappear(filePath, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(filePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`path did not disappear before the deadline: ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeTimers() {
  const timeouts = [];
  const intervals = [];
  let nextId = 1;

  function add(collection, callback, delay) {
    const handle = { callback, cleared: false, delay, id: nextId };
    nextId += 1;
    collection.push(handle);
    return handle;
  }

  return {
    clearInterval(handle) {
      if (handle) handle.cleared = true;
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true;
    },
    intervals,
    runInterval(handle = intervals.find((candidate) => !candidate.cleared)) {
      assert.ok(handle, 'expected an active interval');
      assert.equal(handle.cleared, false);
      handle.callback();
    },
    runTimeout(handle = timeouts.find((candidate) => !candidate.cleared)) {
      assert.ok(handle, 'expected an active timeout');
      assert.equal(handle.cleared, false);
      handle.cleared = true;
      handle.callback();
    },
    setInterval(callback, delay) {
      return add(intervals, callback, delay);
    },
    setTimeout(callback, delay) {
      return add(timeouts, callback, delay);
    },
    timeouts,
  };
}

function fakeFsWatcher() {
  const watcher = new EventEmitter();
  watcher.closeCalls = 0;
  watcher.close = () => { watcher.closeCalls += 1; };
  return watcher;
}

function makeWatcher(options) {
  const timers = options.timers || fakeTimers();
  return {
    service: createMemoryWatcher({
      debounceMs: 300,
      emit: () => {},
      memoryPaths: ['/safe/project/memory'],
      pollIntervalMs: 5_000,
      root: '/safe',
      timers,
      watch: () => fakeFsWatcher(),
      ...options,
    }),
    timers,
  };
}

function request(server, pathname, {
  body,
  headers = { 'X-SCMD-Token': server.token },
  method = 'GET',
} = {}) {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = http.request(new URL(pathname, server.url), {
      method,
      headers: {
        ...headers,
        ...(bytes ? {
          'Content-Type': 'application/json',
          'Content-Length': bytes.length,
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolveRequest({
        body: Buffer.concat(chunks).toString('utf8'),
        status: response.statusCode,
      }));
    });
    outgoing.once('error', rejectRequest);
    if (bytes) outgoing.write(bytes);
    outgoing.end();
  });
}

function openEventStream(server, token = server.token) {
  return new Promise((resolveStream, rejectStream) => {
    const outgoing = http.request(new URL('/api/events', server.url), {
      headers: { 'X-SCMD-Token': token },
    });
    outgoing.once('error', rejectStream);
    outgoing.once('response', (response) => {
      const queue = [];
      const waiters = [];
      let pending = '';

      function deliver(event) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(event);
        else queue.push(event);
      }

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        pending += chunk.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (!block || block.startsWith(':')) continue;

          let eventName = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (data.length === 0) continue;
          try {
            deliver({ type: eventName, ...JSON.parse(data.join('\n')) });
          } catch (error) {
            deliver({ parseError: error.message, raw: data.join('\n'), type: eventName });
          }
        }
      });

      resolveStream({
        close() {
          response.destroy();
          outgoing.destroy();
          for (const waiter of waiters.splice(0)) {
            clearTimeout(waiter.timeout);
            waiter.reject(new Error('event stream closed'));
          }
        },
        next(timeoutMs = EVENT_TIMEOUT_MS) {
          if (queue.length > 0) return Promise.resolve(queue.shift());
          return new Promise((resolveEvent, rejectEvent) => {
            const waiter = {
              reject: rejectEvent,
              resolve: resolveEvent,
              timeout: setTimeout(() => {
                const index = waiters.indexOf(waiter);
                if (index !== -1) waiters.splice(index, 1);
                rejectEvent(new Error(`no memory event arrived within ${timeoutMs} ms`));
              }, timeoutMs),
            };
            const resolve = waiter.resolve;
            waiter.resolve = (event) => {
              clearTimeout(waiter.timeout);
              resolve(event);
            };
            waiters.push(waiter);
          });
        },
        response,
      });
    });
    outgoing.end();
  });
}

async function expectResync(stream) {
  assert.deepEqual(await stream.next(), { type: 'resync' });
}

async function makeServer(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'scmd-live-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'scmd-live-state-'));
  const projectId = 'project';
  const memoryDir = join(root, projectId, 'memory');
  await mkdir(memoryDir, { recursive: true });
  await Promise.all(Object.entries(files).map(([fileName, contents]) => (
    writeFile(join(memoryDir, fileName), contents)
  )));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const server = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  return { memoryDir, projectId, root, server, stateDir };
}

async function cards(server) {
  const response = await request(server, '/api/projects?includeReviewed=1');
  assert.equal(response.status, 200);
  return JSON.parse(response.body).projects.flatMap((project) => project.cards);
}

function apply(server, decisions) {
  return request(server, '/api/apply', {
    body: { decisions },
    method: 'POST',
  });
}

function assertPathFree(event, ...paths) {
  assert.deepEqual(Object.keys(event).sort(), ['id', 'type']);
  const serialized = JSON.stringify(event);
  for (const value of paths) assert.equal(serialized.includes(value), false);
}

test('snapshot diff is pure, deterministic, and reports each id once', () => {
  const before = new Map([
    ['project/zeta.md', 'old-zeta'],
    ['project/gone.md', 'old-gone'],
    ['project/same.md', 'same'],
  ]);
  const after = new Map([
    ['project/same.md', 'same'],
    ['project/zeta.md', 'new-zeta'],
    ['project/alpha.md', 'new-alpha'],
  ]);
  const beforeEntries = [...before];
  const afterEntries = [...after];

  assert.deepEqual(diffMemorySnapshots(before, after), [
    { type: 'added', id: 'project/alpha.md' },
    { type: 'changed', id: 'project/zeta.md' },
    { type: 'removed', id: 'project/gone.md' },
  ]);
  assert.deepEqual([...before], beforeEntries);
  assert.deepEqual([...after], afterEntries);
});

test('snapshot scan excludes MEMORY.md, temporary files, non-markdown files, and symlinks', {
  skip: process.platform === 'win32' ? 'symlink creation may require elevated privileges' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-live-snapshot-'));
  const memoryDir = join(root, 'project', 'memory');
  const outside = join(root, 'outside.md');
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, 'good.md'), 'real memory\n');
  await writeFile(join(memoryDir, 'MEMORY.md'), '- [Good](good.md)\n');
  await writeFile(join(memoryDir, '.scmd-edit.123.deadbeef.tmp'), 'temporary\n');
  await writeFile(join(memoryDir, 'notes.txt'), 'not a memory\n');
  await writeFile(outside, 'outside\n');
  await symlink(outside, join(memoryDir, 'linked.md'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const snapshot = await scanMemorySnapshot(root);

  assert.deepEqual([...snapshot], [['project/good.md', sha256('real memory\n')]]);
});

test('snapshot scan preserves a prior file entry when that file alone is unreadable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'scmd-live-isolation-'));
  const memoryDir = join(root, 'project', 'memory');
  const unreadablePath = join(memoryDir, 'unreadable.md');
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, 'good.md'), 'new good\n');
  await writeFile(unreadablePath, 'cannot read now\n');
  t.after(() => rm(root, { recursive: true, force: true }));

  const fsPromises = Object.create(fs.promises);
  fsPromises.open = async (filePath, ...args) => {
    if (String(filePath) === unreadablePath) {
      const error = new Error('temporarily unreadable');
      error.code = 'EACCES';
      throw error;
    }
    return fs.promises.open(filePath, ...args);
  };
  const snapshot = await scanMemorySnapshot(root, {
    fsPromises,
    previousSnapshot: new Map([
      ['project/good.md', 'old-good'],
      ['project/unreadable.md', 'old-unreadable'],
    ]),
  });

  assert.deepEqual([...snapshot], [
    ['project/good.md', sha256('new good\n')],
    ['project/unreadable.md', 'old-unreadable'],
  ]);
});

test('watch bursts use one 300 ms debounce and emit one diff', async () => {
  const baseline = new Map([['project/one.md', 'old']]);
  const changed = new Map([['project/one.md', 'new']]);
  const scans = [baseline, changed];
  const emitted = [];
  const watcher = fakeFsWatcher();
  let notify;
  const { service, timers } = makeWatcher({
    emit: (events) => emitted.push(events),
    scan: async () => scans.shift(),
    watch: (memoryPath, callback) => {
      assert.equal(memoryPath, '/safe/project/memory');
      notify = callback;
      return watcher;
    },
  });
  await service.start();

  notify('rename', 'one.md');
  notify('change', 'one.md');
  notify('change', 'one.md');

  assert.deepEqual(timers.timeouts.filter((timer) => !timer.cleared).map((timer) => timer.delay), [300]);
  timers.runTimeout();
  await flushAsyncWork();
  assert.deepEqual(emitted, [[{ type: 'changed', id: 'project/one.md' }]]);
  service.stop();
});

test('own-transition baselines expose exact external edit reverts and delete recreations', async () => {
  const baseline = new Map([
    ['project/edit.md', 'old-edit'],
    ['project/delete.md', 'old-delete'],
  ]);
  const scans = [baseline, new Map(baseline)];
  const emitted = [];
  let notify;
  const { service, timers } = makeWatcher({
    emit: (events) => emitted.push(events),
    scan: async () => scans.shift(),
    watch: (memoryPath, callback) => {
      notify = callback;
      return fakeFsWatcher();
    },
  });
  await service.start();

  service.suppress([
    { type: 'changed', id: 'project/edit.md', hash: 'own-edit' },
    { type: 'removed', id: 'project/delete.md' },
  ]);
  notify('change', 'ignored.md');
  timers.runTimeout();
  await flushAsyncWork();

  assert.deepEqual(emitted, [[
    { type: 'added', id: 'project/delete.md' },
    { type: 'changed', id: 'project/edit.md' },
  ]]);
  service.stop();
});

test('a watch event during a scan schedules one serialized dirty rescan', async () => {
  const firstScan = deferred();
  let notify;
  let scanCalls = 0;
  let activeScans = 0;
  let maxActiveScans = 0;
  const { service, timers } = makeWatcher({
    scan: async () => {
      scanCalls += 1;
      if (scanCalls === 1) return new Map([['project/one.md', 'old']]);
      activeScans += 1;
      maxActiveScans = Math.max(maxActiveScans, activeScans);
      if (scanCalls === 2) await firstScan.promise;
      activeScans -= 1;
      return new Map([['project/one.md', `version-${scanCalls}`]]);
    },
    watch: (memoryPath, callback) => {
      notify = callback;
      return fakeFsWatcher();
    },
  });
  await service.start();

  notify('change', 'one.md');
  timers.runTimeout();
  await flushAsyncWork();
  assert.equal(scanCalls, 2);

  notify('change', 'one.md');
  notify('rename', 'one.md');
  firstScan.resolve();
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(scanCalls, 3);
  assert.equal(maxActiveScans, 1);
  service.stop();
});

test('watch setup failure falls back to a 5 s poll with an injectable interval', async () => {
  const timers = fakeTimers();
  let scanCalls = 0;
  const { service } = makeWatcher({
    memoryPaths: ['/safe/one/memory', '/safe/two/memory'],
    pollIntervalMs: undefined,
    scan: async () => {
      scanCalls += 1;
      return new Map();
    },
    timers,
    watch: () => {
      const error = new Error('watch unavailable');
      error.code = 'ENOSYS';
      throw error;
    },
  });
  await service.start();

  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.intervals[0].delay, 5_000);
  timers.runInterval();
  await flushAsyncWork();
  assert.equal(scanCalls, 2);
  service.stop();

  const shortTimers = fakeTimers();
  const short = makeWatcher({
    pollIntervalMs: 17,
    scan: async () => new Map(),
    timers: shortTimers,
    watch: () => { throw new Error('watch unavailable'); },
  }).service;
  await short.start();
  assert.equal(shortTimers.intervals[0].delay, 17);
  short.stop();
});

test('an initial EIO retries into a silent baseline instead of poisoning watcher startup', async () => {
  const baseline = new Map([['project/one.md', 'old']]);
  const changed = new Map([['project/one.md', 'new']]);
  const scans = [
    async () => {
      const error = new Error('temporary scan failure');
      error.code = 'EIO';
      throw error;
    },
    async () => baseline,
    async () => changed,
  ];
  const emitted = [];
  const { service, timers } = makeWatcher({
    emit: (events) => emitted.push(events),
    scan: async () => scans.shift()(),
  });

  await service.start();
  assert.deepEqual(emitted, []);
  assert.deepEqual(timers.intervals.map((timer) => timer.delay), [5_000]);
  timers.runInterval();
  await flushAsyncWork();
  assert.deepEqual(emitted, [[{ type: 'changed', id: 'project/one.md' }]]);
  service.stop();
});

test('a runtime fs.watch error closes watchers and switches to polling', async () => {
  const timers = fakeTimers();
  const watchers = [fakeFsWatcher(), fakeFsWatcher()];
  let watchIndex = 0;
  const { service } = makeWatcher({
    memoryPaths: ['/safe/one/memory', '/safe/two/memory'],
    scan: async () => new Map(),
    timers,
    watch: () => watchers[watchIndex++],
  });
  await service.start();

  watchers[0].emit('error', Object.assign(new Error('overflow'), { code: 'ENOSPC' }));

  assert.deepEqual(watchers.map((watcher) => watcher.closeCalls), [1, 1]);
  assert.deepEqual(timers.intervals.map((timer) => timer.delay), [5_000]);
  service.stop();
});

test('heartbeat stop disposes watchers, debounce timers, and polling timers once', async () => {
  const timers = fakeTimers();
  const watcher = fakeFsWatcher();
  let notify;
  const { service } = makeWatcher({
    scan: async () => new Map(),
    timers,
    watch: (memoryPath, callback) => {
      notify = callback;
      return watcher;
    },
  });
  await service.start();
  notify('change', 'one.md');
  watcher.emit('error', new Error('watch failed'));

  const heartbeat = createHeartbeat({ close() {} }, new Set(), () => service.stop());
  heartbeat.stop();
  heartbeat.stop();

  assert.equal(watcher.closeCalls, 1);
  assert.ok(timers.timeouts.every((timer) => timer.cleared));
  assert.ok(timers.intervals.every((timer) => timer.cleared));
});

test('a backpressured SSE client has one bounded resync pending until drain', () => {
  const response = new EventEmitter();
  const writes = [];
  let writable = false;
  response.destroyed = false;
  response.writableEnded = false;
  response.write = (block) => {
    writes.push(block);
    return writable;
  };
  response.destroy = () => { response.destroyed = true; };
  const heartbeat = createHeartbeat({ close() {} }, new Set());

  heartbeat.connect(response);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /data: \{"type":"resync"\}/);
  for (let index = 0; index < 100; index += 1) {
    heartbeat.broadcast([{ type: 'changed', id: `project/${index}.md` }]);
  }
  assert.equal(writes.length, 1);

  writable = true;
  response.emit('drain');
  assert.equal(writes.length, 2);
  assert.match(writes[1], /data: \{"type":"resync"\}/);
  heartbeat.stop();
});

test('authenticated SSE emits added, changed, and removed exactly once with path-free payloads', async (t) => {
  const { memoryDir, projectId, root, server, stateDir } = await makeServer(t, {});
  const stream = await openEventStream(server);
  t.after(() => stream.close());
  assert.equal(stream.response.statusCode, 200);
  await expectResync(stream);

  const filePath = join(memoryDir, 'live.md');
  await writeFile(filePath, memory('Live', 'Added.'));
  const added = await stream.next();
  assert.deepEqual(added, { type: 'added', id: `${projectId}/live.md` });
  assertPathFree(added, root, stateDir, memoryDir, filePath);

  await writeFile(filePath, memory('Live', 'Changed.'));
  const changed = await stream.next();
  assert.deepEqual(changed, { type: 'changed', id: `${projectId}/live.md` });
  assertPathFree(changed, root, stateDir, memoryDir, filePath);

  await unlink(filePath);
  const removed = await stream.next();
  assert.deepEqual(removed, { type: 'removed', id: `${projectId}/live.md` });
  assertPathFree(removed, root, stateDir, memoryDir, filePath);

  await writeFile(join(memoryDir, 'sentinel.md'), memory('Sentinel', 'Last.'));
  assert.deepEqual(await stream.next(), { type: 'added', id: `${projectId}/sentinel.md` });
});

test('successful apply writes are suppressed while external and hash-mismatched changes still emit', async (t) => {
  const original = memory('Original', 'Before.');
  const { memoryDir, projectId, server } = await makeServer(t, {
    'own-edit.md': original,
    'own-delete.md': original,
    'raced-edit.md': original,
    'external.md': original,
    'stale.md': original,
  });
  const current = await cards(server);
  const byName = new Map(current.map((card) => [card.fileName, card]));
  const stream = await openEventStream(server);
  t.after(() => stream.close());
  await expectResync(stream);

  const edited = memory('Original', 'Applied edit.');
  const applyResponse = await apply(server, [
    {
      id: byName.get('own-edit.md').id,
      action: 'edit',
      expectedHash: byName.get('own-edit.md').hash,
      newContent: edited,
    },
    {
      id: byName.get('own-delete.md').id,
      action: 'delete',
      expectedHash: byName.get('own-delete.md').hash,
    },
    {
      id: byName.get('raced-edit.md').id,
      action: 'edit',
      expectedHash: byName.get('raced-edit.md').hash,
      newContent: edited,
    },
  ]);
  assert.equal(applyResponse.status, 200);
  assert.deepEqual(
    JSON.parse(applyResponse.body).results.map(({ status }) => status),
    ['applied', 'applied', 'applied'],
  );

  await writeFile(join(memoryDir, 'raced-edit.md'), memory('Original', 'External won.'));
  await writeFile(join(memoryDir, 'external.md'), memory('Original', 'External.'));
  await writeFile(join(memoryDir, 'stale.md'), memory('Original', 'Changed before apply.'));
  const staleResponse = await apply(server, [{
    id: byName.get('stale.md').id,
    action: 'edit',
    expectedHash: byName.get('stale.md').hash,
    newContent: edited,
  }]);
  assert.deepEqual(JSON.parse(staleResponse.body).results, [{
    id: `${projectId}/stale.md`,
    action: 'edit',
    status: 'skipped',
    reason: 'changed-since-read',
  }]);

  const events = [await stream.next(), await stream.next(), await stream.next()];
  assert.deepEqual(events.sort((left, right) => left.id.localeCompare(right.id)), [
    { type: 'changed', id: `${projectId}/external.md` },
    { type: 'changed', id: `${projectId}/raced-edit.md` },
    { type: 'changed', id: `${projectId}/stale.md` },
  ]);

  await writeFile(join(memoryDir, 'sentinel.md'), memory('Sentinel', 'Last.'));
  assert.deepEqual(await stream.next(), { type: 'added', id: `${projectId}/sentinel.md` });
  assert.equal(await readFile(join(memoryDir, 'own-edit.md'), 'utf8'), edited);
});

test('external exact reverts inside the apply debounce window remain visible', async (t) => {
  const original = memory('Original', 'Before.');
  const { memoryDir, projectId, server } = await makeServer(t, {
    'reverted-edit.md': original,
    'recreated-delete.md': original,
  });
  const current = await cards(server);
  const byName = new Map(current.map((card) => [card.fileName, card]));
  const stream = await openEventStream(server);
  t.after(() => stream.close());
  await expectResync(stream);

  const response = await apply(server, [
    {
      id: byName.get('reverted-edit.md').id,
      action: 'edit',
      expectedHash: byName.get('reverted-edit.md').hash,
      newContent: memory('Original', 'SCMD edit.'),
    },
    {
      id: byName.get('recreated-delete.md').id,
      action: 'delete',
      expectedHash: byName.get('recreated-delete.md').hash,
    },
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(
    JSON.parse(response.body).results.map(({ status }) => status),
    ['applied', 'applied'],
  );

  await Promise.all([
    writeFile(join(memoryDir, 'reverted-edit.md'), original),
    writeFile(join(memoryDir, 'recreated-delete.md'), original),
  ]);

  const events = [await stream.next(), await stream.next()];
  assert.deepEqual(events.sort((left, right) => left.id.localeCompare(right.id)), [
    { type: 'added', id: `${projectId}/recreated-delete.md` },
    { type: 'changed', id: `${projectId}/reverted-edit.md` },
  ]);

  await writeFile(join(memoryDir, 'sentinel.md'), memory('Sentinel', 'Last.'));
  assert.deepEqual(await stream.next(), { type: 'added', id: `${projectId}/sentinel.md` });
});

test('overlapping applies reconcile own transitions in commit order, not response order', async (t) => {
  const original = memory('Shared', 'A.');
  const versionB = memory('Shared', 'B.');
  const versionC = memory('Shared', 'C.');
  const versionD = memory('Shared', 'D.');
  const { memoryDir, projectId, server, stateDir } = await makeServer(t, {
    'shared.md': original,
    'busy.md': memory('Busy', 'Keep.'),
  });
  const current = await cards(server);
  const byName = new Map(current.map((card) => [card.fileName, card]));
  const stream = await openEventStream(server);
  const reviewLock = join(stateDir, '.reviewed.lock');
  t.after(() => unlink(reviewLock).catch(() => {}));
  t.after(() => stream.close());
  await expectResync(stream);
  await writeFile(reviewLock, 'held by test\n');

  const firstApply = apply(server, [
    {
      id: byName.get('shared.md').id,
      action: 'edit',
      expectedHash: byName.get('shared.md').hash,
      newContent: versionB,
    },
    {
      id: byName.get('busy.md').id,
      action: 'keep',
      expectedHash: byName.get('busy.md').hash,
    },
  ]);

  const sharedPath = join(memoryDir, 'shared.md');
  const sharedApplyLock = join(
    stateDir,
    '.apply-locks',
    `${sha256(await realpath(memoryDir))}.lock`,
  );
  const committedDeadline = Date.now() + 1_000;
  while (await readFile(sharedPath, 'utf8') !== versionB) {
    if (Date.now() >= committedDeadline) throw new Error('first apply did not commit version B');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await waitForPathToDisappear(sharedApplyLock);

  const secondResponse = await apply(server, [{
    id: `${projectId}/shared.md`,
    action: 'edit',
    expectedHash: sha256(versionB),
    newContent: versionC,
  }]);
  assert.deepEqual(JSON.parse(secondResponse.body).results, [{
    id: `${projectId}/shared.md`,
    action: 'edit',
    status: 'applied',
  }]);

  await unlink(reviewLock);
  const firstResponse = await firstApply;
  assert.deepEqual(
    JSON.parse(firstResponse.body).results.map(({ status }) => status),
    ['applied', 'applied'],
  );
  await assert.rejects(stream.next(700), /no memory event arrived/);

  await writeFile(sharedPath, versionD);
  assert.deepEqual(await stream.next(), {
    type: 'changed',
    id: `${projectId}/shared.md`,
  });
  await writeFile(join(memoryDir, 'sentinel.md'), memory('Sentinel', 'Last.'));
  assert.deepEqual(await stream.next(), { type: 'added', id: `${projectId}/sentinel.md` });
});

test('every reconnect emits resync after changes observed with no SSE client', async (t) => {
  const original = memory('One', 'Before.');
  const { memoryDir, projectId, server } = await makeServer(t, { 'one.md': original });
  const firstStream = await openEventStream(server);
  await expectResync(firstStream);
  firstStream.close();

  await writeFile(join(memoryDir, 'one.md'), memory('One', 'Changed in the gap.'));
  await new Promise((resolve) => setTimeout(resolve, 500));

  const secondStream = await openEventStream(server);
  t.after(() => secondStream.close());
  await expectResync(secondStream);
  await writeFile(join(memoryDir, 'sentinel.md'), memory('Sentinel', 'Last.'));
  assert.deepEqual(await secondStream.next(), {
    type: 'added',
    id: `${projectId}/sentinel.md`,
  });
});

test('topology reconciliation watches a project and memory directory created after startup', async (t) => {
  const { root, server } = await makeServer(t, {});
  const stream = await openEventStream(server);
  t.after(() => stream.close());
  await expectResync(stream);

  const lateMemoryDir = join(root, 'late-project', 'memory');
  await mkdir(lateMemoryDir, { recursive: true });
  await writeFile(join(lateMemoryDir, 'late.md'), memory('Late', 'Arrived.'));

  assert.deepEqual(await stream.next(), {
    type: 'added',
    id: 'late-project/late.md',
  });
});

test('POST /api/quit closes the watcher-backed process while SSE is connected', async (t) => {
  const { server } = await makeServer(t, { 'one.md': memory('One', 'One.') });
  const stream = await openEventStream(server);
  await expectResync(stream);
  const closed = once(server.child, 'close');

  const response = await request(server, '/api/quit', { method: 'POST' });
  const [code, signal] = await Promise.race([
    closed,
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('watcher kept the process alive after quit')), 1_000);
      timeout.unref?.();
    }),
  ]);

  assert.equal(response.status, 200);
  assert.equal(code, 0);
  assert.equal(signal, null);
  stream.close();
});
