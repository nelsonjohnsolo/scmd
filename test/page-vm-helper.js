const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const vm = require('node:vm');

const PAGE_PATH = resolve(__dirname, '..', 'index.html');

async function loadPageApi({
  autoBoot = false,
  document,
  fetchImpl = async () => { throw new Error('unexpected request'); },
  href = 'http://127.0.0.1:43210/?token=token-from-launch-url',
} = {}) {
  const page = await readFile(PAGE_PATH, 'utf8');
  const scripts = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1, 'expected one inline page script');
  const window = {
    __SCMD_NO_AUTOBOOT__: !autoBoot,
    location: { href },
    addEventListener() {},
    setTimeout() {},
  };
  vm.runInNewContext(scripts[0][1], {
    AbortController,
    URL,
    URLSearchParams,
    TextDecoder,
    console,
    document,
    fetch: fetchImpl,
    window,
  });
  assert.ok(window.SCMD, 'expected testable page API');
  return { page, window };
}

module.exports = { loadPageApi, PAGE_PATH };
