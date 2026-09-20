const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const net = require('node:net');

const { startServer } = require('./server-helper');

function request(server, pathname, { method = 'GET', headers = {} } = {}) {
  const url = new URL(pathname, server.url);

  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = http.request(url, { method, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        resolveRequest({
          status: response.statusCode,
          headers: response.headers,
          body,
        });
      });
    });

    outgoing.once('error', rejectRequest);
    outgoing.end();
  });
}

function waitForClose(child, timeoutMs = 500) {
  return new Promise((resolveClose, rejectClose) => {
    const timeout = setTimeout(() => {
      child.removeListener('close', onClose);
      rejectClose(new Error(`server did not exit within ${timeoutMs} ms`));
    }, timeoutMs);

    function onClose(code, signal) {
      clearTimeout(timeout);
      resolveClose({ code, signal });
    }

    child.once('close', onClose);
  });
}

function openEventStream(server, token = server.token) {
  const url = new URL('/api/events', server.url);

  return new Promise((resolveStream, rejectStream) => {
    const outgoing = http.request(url, {
      headers: { 'X-SCMD-Token': token },
    });

    outgoing.once('response', (response) => {
      response.once('error', rejectStream);
      resolveStream({
        response,
        close() {
          response.destroy();
          outgoing.destroy();
        },
      });
    });
    outgoing.once('error', rejectStream);
    outgoing.end();
  });
}

async function quitServer(server) {
  const closed = once(server.child, 'close');
  const response = await request(server, '/api/quit', {
    method: 'POST',
    headers: { 'X-SCMD-Token': server.token },
  });
  const [code, signal] = await closed;
  return { response, code, signal };
}

test('the printed token URL serves the packaged SCMD page', async (t) => {
  const server = await startServer(t);

  const response = await request(server, server.url);

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/html\b/);
  assert.match(response.body, /\bSCMD\b/);
  assert.match(response.body, /searchParams\.get\(['"]token['"]\)/);
  assert.match(response.body, /['"]X-SCMD-Token['"]/);
  assert.match(response.body, /['"]\/api\/events['"]/);
});

test('API requests require the launch token in X-SCMD-Token', async (t) => {
  const server = await startServer(t);
  const queryOnly = await request(server, `/api/quit?token=${server.token}`, { method: 'POST' });
  const wrongHeader = await request(server, '/api/quit', {
    method: 'POST',
    headers: { 'X-SCMD-Token': 'wrong' },
  });

  assert.equal(queryOnly.status, 401);
  assert.equal(wrongHeader.status, 401);
  assert.equal(server.child.exitCode, null);
});

test('a foreign Host gets 403 before a valid API request can act', async (t) => {
  const server = await startServer(t);

  const withoutToken = await request(server, '/api/quit', {
    method: 'POST',
    headers: { Host: 'attacker.example' },
  });
  const withToken = await request(server, '/api/quit', {
    method: 'POST',
    headers: {
      Host: 'attacker.example',
      'X-SCMD-Token': server.token,
    },
  });

  assert.equal(withoutToken.status, 403);
  assert.equal(withToken.status, 403);
  assert.equal(server.child.exitCode, null);
});

test('POST /api/quit with the launch token responds and exits cleanly', async (t) => {
  const server = await startServer(t);
  const closed = once(server.child, 'close');

  const response = await request(server, '/api/quit', {
    method: 'POST',
    headers: { 'X-SCMD-Token': server.token },
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /closed/i);
  const [code, signal] = await closed;
  assert.equal(code, 0);
  assert.equal(signal, null);
});

test('quit exits cleanly while another HTTP connection is still active', async (t) => {
  const server = await startServer(t);
  const launchUrl = new URL(server.url);
  const heldSocket = net.createConnection({
    host: launchUrl.hostname,
    port: Number(launchUrl.port),
  });
  heldSocket.on('error', () => {});
  t.after(() => heldSocket.destroy());
  await once(heldSocket, 'connect');
  await new Promise((resolveWrite, rejectWrite) => {
    heldSocket.write(
      `GET / HTTP/1.1\r\nHost: ${launchUrl.host}\r\n`,
      (error) => (error ? rejectWrite(error) : resolveWrite()),
    );
  });

  const [response, closed] = await Promise.all([
    request(server, '/api/quit', {
      method: 'POST',
      headers: { 'X-SCMD-Token': server.token },
    }),
    waitForClose(server.child),
  ]);

  assert.equal(response.status, 200);
  assert.match(response.body, /closed/i);
  assert.equal(closed.code, 0);
  assert.equal(closed.signal, null);
});

test('GET /api/events requires the launch token', async (t) => {
  const server = await startServer(t);

  const response = await request(server, '/api/events', {
    headers: { 'X-SCMD-Token': 'wrong' },
  });

  assert.equal(response.status, 401);
});

test('GET /api/events opens an authenticated event stream', async (t) => {
  const server = await startServer(t);
  const stream = await openEventStream(server);
  t.after(() => stream.close());

  assert.equal(stream.response.statusCode, 200);
  assert.match(stream.response.headers['content-type'], /^text\/event-stream\b/);
  assert.equal(stream.response.headers['cache-control'], 'no-cache');
  assert.equal(server.child.exitCode, null);
});

test('quit exits immediately while an event stream is connected', async (t) => {
  const server = await startServer(t);
  const stream = await openEventStream(server);
  const closed = once(server.child, 'close');

  const response = await request(server, '/api/quit', {
    method: 'POST',
    headers: { 'X-SCMD-Token': server.token },
  });
  const [code, signal] = await closed;

  assert.equal(response.status, 200);
  assert.equal(code, 0);
  assert.equal(signal, null);
  stream.close();
});

test('heartbeat lifecycle across the ten-second deadline', { concurrency: 4 }, async (t) => {
  await Promise.all([
    t.test('a refreshed page stays connected past the original deadline', async (t) => {
      const server = await startServer(t);
      const first = await openEventStream(server);
      assert.equal(first.response.statusCode, 200);
      first.close();

      await new Promise((resolve) => setTimeout(resolve, 100));
      const refreshed = await openEventStream(server);
      t.after(() => refreshed.close());
      assert.equal(refreshed.response.statusCode, 200);

      await new Promise((resolve) => setTimeout(resolve, 10_150));
      assert.equal(server.child.exitCode, null);

      const result = await quitServer(server);
      assert.equal(result.response.status, 200);
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
    }),
    t.test('one of two connected pages can close without stopping the server', async (t) => {
      const server = await startServer(t);
      const first = await openEventStream(server);
      const second = await openEventStream(server);
      t.after(() => second.close());
      assert.equal(first.response.statusCode, 200);
      assert.equal(second.response.statusCode, 200);

      first.close();
      await new Promise((resolve) => setTimeout(resolve, 10_250));
      assert.equal(server.child.exitCode, null);

      const result = await quitServer(server);
      assert.equal(result.response.status, 200);
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
    }),
    t.test('when no page ever connects', async (t) => {
      const server = await startServer(t);
      const started = Date.now();

      const closed = await waitForClose(server.child, 12_000);
      const elapsed = Date.now() - started;

      assert.equal(closed.code, 0);
      assert.equal(closed.signal, null);
      assert.ok(elapsed >= 9_500, `expected at least 9.5 s, got ${elapsed} ms`);
      assert.ok(elapsed < 12_000, `expected less than 12 s, got ${elapsed} ms`);
    }),
    t.test('after the last event stream closes', async (t) => {
      const server = await startServer(t);
      const stream = await openEventStream(server);
      assert.equal(stream.response.statusCode, 200);
      const started = Date.now();
      stream.close();

      const closed = await waitForClose(server.child, 12_000);
      const elapsed = Date.now() - started;

      assert.equal(closed.code, 0);
      assert.equal(closed.signal, null);
      assert.ok(elapsed >= 9_500, `expected at least 9.5 s, got ${elapsed} ms`);
      assert.ok(elapsed < 12_000, `expected less than 12 s, got ${elapsed} ms`);
    }),
  ]);
});
