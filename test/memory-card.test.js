const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { readFile, stat } = require('node:fs/promises');
const { resolve } = require('node:path');

const PROJECT_ROOT = resolve(__dirname, '..');
const FIXTURE_ROOT = resolve(PROJECT_ROOT, 'fixtures', 'projects');

test('server.js can be imported for pure discovery tests without launching the CLI', () => {
  const result = spawnSync(process.execPath, [
    '-e',
    "const server = require('./server'); process.stdout.write(String(typeof server.createMemoryCard));",
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 500,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'function');
});

const { createMemoryCard } = require('../server');

function cardFrom(text, {
  projectId = '-Users-example-project',
  fileName = 'memory.md',
  mtime = new Date('2026-09-20T12:00:00.000Z'),
} = {}) {
  return createMemoryCard({
    projectId,
    fileName,
    bytes: Buffer.from(text, 'utf8'),
    mtime,
  });
}

test('top-level frontmatter yields the complete card contract and hashes exact bytes', () => {
  const text = [
    '---',
    'name: "Release: checklist"',
    "description: 'Keep: the small list'",
    'type: project',
    'originSessionId: session-top-level',
    'modified: 1999-01-01T00:00:00.000Z',
    '---',
    '',
    'First body line.',
    'Second body line.',
    '',
  ].join('\n');

  const card = cardFrom(text, {
    projectId: '-Users-example-release',
    fileName: 'project_release.md',
  });

  assert.deepEqual(card, {
    id: '-Users-example-release/project_release.md',
    fileName: 'project_release.md',
    projectId: '-Users-example-release',
    name: 'Release: checklist',
    summary: 'Keep: the small list',
    type: 'project',
    date: '2026-09-20T12:00:00.000Z',
    body: '\nFirst body line.\nSecond body line.\n',
    hash: crypto.createHash('sha256').update(Buffer.from(text)).digest('hex'),
    originSessionId: 'session-top-level',
  });
});

test('nested metadata wins over top-level values and supplies a valid modified date', () => {
  const card = cardFrom([
    '---',
    'name: Nested memory',
    'description: Nested shape',
    'type: feedback',
    'originSessionId: top-level-session',
    'metadata:',
    '  node_type: memory',
    '  type: reference',
    '  originSessionId: nested-session',
    '  modified: 2026-09-17T10:30:00.000Z',
    '---',
    'Body.',
  ].join('\n'));

  assert.equal(card.type, 'reference');
  assert.equal(card.originSessionId, 'nested-session');
  assert.equal(card.date, '2026-09-17T10:30:00.000Z');
});

test('type falls back through filename prefixes and then unknown', () => {
  for (const type of ['feedback', 'project', 'reference', 'user']) {
    const card = cardFrom('A useful first line.\n', { fileName: `${type}_note.md` });
    assert.equal(card.type, type);
  }

  assert.equal(cardFrom('A useful first line.\n', { fileName: 'misc_note.md' }).type, 'unknown');
});

test('no-frontmatter files use the filename stem and first non-empty body line', () => {
  const card = cardFrom('\n\n  A plain memory with leading space.  \nMore detail.\n', {
    fileName: 'ui_note.md',
  });

  assert.equal(card.name, 'ui_note');
  assert.equal(card.summary, 'A plain memory with leading space.');
  assert.equal(card.body, '\n\n  A plain memory with leading space.  \nMore detail.\n');
  assert.equal(card.originSessionId, undefined);
});

test('invalid nested modified values fall back to mtime and unrelated indentation is ignored', () => {
  const card = cardFrom([
    '---',
    'metadata:',
    '  modified: definitely-not-a-date',
    'other:',
    '  type: feedback',
    '---',
    '',
    'Fallback body.',
  ].join('\n'), { fileName: 'note.md' });

  assert.equal(card.date, '2026-09-20T12:00:00.000Z');
  assert.equal(card.type, 'unknown');
  assert.equal(card.summary, 'Fallback body.');
});

test('Date-parser-compatible but non-ISO modified values fall back to mtime', () => {
  for (const modified of [
    '09/17/2026',
    '2026-09-17 10:30:00',
    'September 17, 2026',
  ]) {
    const card = cardFrom([
      '---',
      'metadata:',
      `  modified: ${modified}`,
      '---',
      'Body.',
    ].join('\n'));

    assert.equal(card.date, '2026-09-20T12:00:00.000Z', modified);
  }
});

test('ISO-looking modified values with invalid calendar or time fields fall back to mtime', () => {
  for (const modified of [
    '2026-02-30T10:30:00Z',
    '2026-09-17T24:00:00Z',
    '2026-09-17T10:60:00Z',
    '2026-09-17T10:30:60Z',
    '2026-09-17T10:30:00+25:00',
    '2026-09-17T10:30:00+02:60',
  ]) {
    const card = cardFrom([
      '---',
      'metadata:',
      `  modified: ${modified}`,
      '---',
      'Body.',
    ].join('\n'));

    assert.equal(card.date, '2026-09-20T12:00:00.000Z', modified);
  }
});

test('ISO modified timestamps accept optional fractions and numeric timezone offsets', () => {
  const utc = cardFrom([
    '---',
    'metadata:',
    '  modified: 2026-09-17T10:30:00Z',
    '---',
    'Body.',
  ].join('\n'));
  const offset = cardFrom([
    '---',
    'metadata:',
    '  modified: 2026-09-17T10:30:00.125+02:30',
    '---',
    'Body.',
  ].join('\n'));

  assert.equal(utc.date, '2026-09-17T10:30:00.000Z');
  assert.equal(offset.date, '2026-09-17T08:00:00.125Z');
});

test('malformed or empty content still yields a card with a non-empty summary', () => {
  const malformed = cardFrom('---\nname without a colon\nmetadata:\n  type\n', {
    fileName: 'malformed.md',
  });
  const empty = cardFrom('', { fileName: 'empty.md' });

  assert.equal(malformed.name, 'malformed');
  assert.ok(malformed.summary);
  assert.equal(empty.name, 'empty');
  assert.equal(empty.summary, 'empty');
});

test('invalid UTF-8 is rejected with a stable code for later unreadable-file reporting', () => {
  assert.throws(
    () => createMemoryCard({
      projectId: 'project',
      fileName: 'invalid.md',
      bytes: Buffer.from([0xc3, 0x28]),
      mtime: new Date('2026-09-20T12:00:00.000Z'),
    }),
    (error) => error && error.code === 'invalid-utf8',
  );
});

test('the fixture variants all produce cards with their intended fallbacks', async () => {
  const fixtureCases = [
    ['-Users-example-my-side-project', 'project_context.md', 'project', 'Keep the demo setup predictable'],
    ['-Users-example-api-server', 'api_contract.md', 'project', 'Keep the API contract small'],
    ['-Users-example-web-client', 'feedback_accessibility.md', 'feedback', 'Check keyboard access'],
    ['-Users-example-web-client', 'ui_note.md', 'unknown', 'ui_note'],
  ];

  for (const [projectId, fileName, type, name] of fixtureCases) {
    const filePath = resolve(FIXTURE_ROOT, projectId, 'memory', fileName);
    const [bytes, stats] = await Promise.all([readFile(filePath), stat(filePath)]);
    const card = createMemoryCard({ projectId, fileName, bytes, mtime: stats.mtime });
    assert.equal(card.type, type, fileName);
    assert.equal(card.name, name, fileName);
    assert.ok(card.summary, fileName);
  }
});
