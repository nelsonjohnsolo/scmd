const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer } = require('./server-helper');

const FETCH_TIMEOUT_MS = 5_000;

test('serves the SCMD review page', async (t) => {
  const server = await startServer(t);

  const response = await fetch(server.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  assert.equal(response.ok, true, `expected a successful response, got ${response.status}`);
  assert.match(await response.text(), /\bSCMD\b/);
});
