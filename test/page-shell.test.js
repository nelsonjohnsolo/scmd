const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const { loadPageApi } = require('./page-vm-helper');
const { startServer } = require('./server-helper');

const PAGE_PATH = resolve(__dirname, '..', 'index.html');
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

  removeAttribute(name) {
    delete this[name];
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

  setPointerCapture() {}

  releasePointerCapture() {}

  closest(selector) {
    return String(selector).split(',').some((candidate) => (
      candidate.trim().toUpperCase() === this.tagName
    )) ? this : null;
  }
}

function fakeDocument() {
  const ids = [
    'app-status',
    'apply-review',
    'apply-panel',
    'apply-summary-counts',
    'apply-notices',
    'apply-delete-list',
    'apply-edit-list',
    'apply-cancel',
    'apply-confirm',
    'apply-results',
    'trash-open',
    'trash-panel',
    'apply-result-list',
    'result-back',
    'trash-open',
    'trash-panel',
    'trash-title',
    'trash-runs',
    'trash-notices',
    'trash-back',
    'action-delete',
    'action-keep',
    'action-skip',
    'action-undo',
    'card-age',
    'card-body',
    'card-details',
    'card-name',
    'card-origin',
    'card-origin-date',
    'card-origin-message',
    'card-origin-status',
    'card-origin-toggle',
    'card-path',
    'card-project',
    'card-reviewed',
    'card-summary',
    'card-type',
    'decision-counts',
    'deck-stage',
    'fatal-error',
    'instruction-results',
    'memory-card',
    'notices',
    'rewrite-accept',
    'rewrite-before',
    'rewrite-before-lines',
    'rewrite-button',
    'rewrite-error',
    'rewrite-hand',
    'rewrite-input',
    'rewrite-login',
    'rewrite-after',
    'rewrite-after-lines',
    'rewrite-panel',
    'rewrite-reject',
    'rewrite-unavailable',
    'hand-editor',
    'hand-editor-cancel',
    'hand-editor-save',
    'hand-editor-text',
    'progress-bar',
    'progress-fill',
    'progress-label',
    'project-chips',
    'scope-everything',
    'scope-unreviewed',
    'search-input',
    'type-chips',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  for (const id of [
    'apply-review', 'apply-cancel', 'apply-confirm', 'result-back',
    'trash-open', 'trash-back', 'action-delete', 'action-keep',
    'action-skip', 'action-undo', 'rewrite-accept', 'rewrite-button',
    'rewrite-hand', 'rewrite-reject', 'hand-editor-cancel',
    'hand-editor-save', 'scope-everything', 'scope-unreviewed',
    'card-origin-toggle',
  ]) elements[id].tagName = 'BUTTON';
  elements['search-input'].tagName = 'INPUT';
  elements['rewrite-input'].tagName = 'INPUT';
  elements['hand-editor-text'].tagName = 'TEXTAREA';
  elements['card-origin-date'].tagName = 'TIME';
  elements['card-origin'].hidden = true;
  const listeners = new Map();
  const document = {
    elements,
    activeElement: null,
    createElement(tagName) {
      const element = new FakeElement(tagName);
      element.focus = () => {
        if (!element.disabled && !element.hidden) document.activeElement = element;
      };
      return element;
    },
    getElementById: (id) => elements[id] || null,
    addEventListener(type, listener) {
      const registered = listeners.get(type) || [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    async dispatch(type, event = {}) {
      const dispatched = {
        ...event,
        preventDefault: event.preventDefault || (() => {}),
      };
      for (const listener of listeners.get(type) || []) await listener(dispatched);
    },
  };
  for (const id of ['action-delete', 'action-keep', 'action-skip', 'action-undo']) {
    const element = elements[id];
    let disabled = Boolean(element.disabled);
    Object.defineProperty(element, 'disabled', {
      configurable: true,
      get: () => disabled,
      set(value) {
        disabled = Boolean(value);
        if (disabled && document.activeElement === element) document.activeElement = null;
      },
    });
  }
  for (const element of Object.values(elements)) {
    element.focus = () => {
      if (!element.disabled && !element.hidden) document.activeElement = element;
    };
  }
  return document;
}

test('page source contains the approved offline D16 shell', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  for (const token of ['--paper:', '--ink:', '--soft:', '--red:', '--green:', '--marker:']) {
    assert.ok(page.includes(token), `missing ${token}`);
  }
  assert.match(page, /prefers-color-scheme:\s*dark/);
  assert.match(page, /prefers-reduced-motion:\s*reduce/);
  assert.match(page, /class="[^"]*sticker-card/);
  assert.match(page, /class="[^"]*pill/);
  assert.match(page, /id="project-chips"/);
  assert.match(page, /id="deck-stage"/);
  assert.match(page, /id="rewrite-box"/);
  for (const id of [
    'apply-review',
    'apply-panel',
    'apply-confirm',
    'apply-results',
    'action-delete',
    'action-skip',
    'action-keep',
    'action-undo',
  ]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(page, /role="alert"/);
  assert.doesNotMatch(page, /https?:\/\/(?!127\.0\.0\.1|localhost)/i);
  assert.doesNotMatch(page, /fonts\.googleapis|@import\s+url|\.innerHTML\s*=/i);
});

test('task 6.6 source puts progress by the deck and groups labelled header actions', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  const topbar = page.match(/<header class="topbar">[\s\S]*?<\/header>/)?.[0] || '';
  const stage = page.match(/<section class="stage"[^>]*>[\s\S]*?<section class="instruction-results"/)?.[0] || '';
  const trash = topbar.match(/<button[^>]*id="trash-open"[\s\S]*?<\/button>/)?.[0] || '';

  assert.doesNotMatch(topbar, /id="progress-(?:label|bar|fill)"/);
  assert.match(topbar, /class="topbar-actions"/);
  assert.ok(topbar.indexOf('id="trash-open"') < topbar.indexOf('id="apply-review"'));
  assert.match(trash, /<svg\b[^>]*aria-hidden="true"/);
  assert.match(trash, />\s*Trash\s*<\/span>/);
  assert.doesNotMatch(trash, /🗑|♻|🚮/u);
  assert.match(
    stage,
    /<div class="progress-row"[^>]*>[\s\S]*?id="progress-fill"[\s\S]*?<\/div>\s*<div class="deck">/,
  );
  assert.match(
    stage,
    /id="progress-label"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/,
  );
  assert.match(stage, /id="app-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(stage, /Nothing is written until you apply\./);
  assert.doesNotMatch(stage.match(/<div class="status-line"[^>]*>/)?.[0] || '', /aria-live/);
  assert.doesNotMatch(stage.match(/<div class="progress-row"[^>]*>/)?.[0] || '', /aria-live/);
});

test('task 6.6 source styles the synchronized fill, CTA, deck clearance, and hand editor control', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');

  assert.match(page, /\.topbar-actions\s*\{[^}]*gap:\s*(?:8|9|10)px/s);
  assert.match(page, /\.progress-row\s*\{[^}]*position:\s*static/s);
  assert.match(page, /\.progress-fill\s*\{[^}]*display:\s*block[^}]*background:\s*var\(--ink\)/s);
  assert.match(page, /\.review-cta:not\(:disabled\)\s*\{[^}]*background:\s*var\(--marker\)[^}]*color:\s*#121212/s);
  assert.match(page, /\.review-cta:disabled\s*\{[^}]*background:\s*var\(--soft\)/s);
  assert.match(page, /\.deck-actions\s*\{[^}]*margin-top:\s*(?!0\b)[^;}]+/s);
  assert.match(page, /\.rewrite-hand-row\s*\{[^}]*justify-content:\s*flex-end/s);
  assert.match(page, /\.rewrite-hand\s*\{[^}]*min-height:\s*44px[^}]*border:\s*var\(--border\)/s);
  assert.match(page, /class="pill small rewrite-hand"[^>]*id="rewrite-hand"/);
  assert.doesNotMatch(page, /\.progress-wrap\s*\{\s*order:\s*3/s);
  assert.match(page, /@media\s*\(max-width:\s*480px\)[\s\S]*?\.progress-row\s*\{[^}]*grid-template-columns:\s*1fr auto/s);
  assert.match(page, /@media\s*\(max-width:\s*480px\)[\s\S]*?#decision-counts\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*1/s);
  assert.match(page, /@media\s*\(max-width:\s*480px\)[\s\S]*?\.progress-track\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*grid-row:\s*2/s);
});

test('rewrite shell has the exact local-login line and hides proposal and editor initially', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  assert.match(page, />Uses your local Claude Code login</);
  assert.match(page, /id="rewrite-panel"[^>]*hidden/);
  assert.match(page, /id="hand-editor"[^>]*hidden/);
  assert.match(page, /Installing Claude Code enables rewrites/);
});

test('semantic action labels use the existing paper token at an accessible large-text size', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  assert.match(page, /\.pill\.danger\s*\{[^}]*color:\s*var\(--paper\)/s);
  assert.match(page, /\.pill\.keep\s*\{[^}]*color:\s*var\(--paper\)/s);
  assert.match(page, /\.pill\.danger,\s*\.pill\.keep\s*\{[^}]*font-size:\s*19px/s);
});

test('page source provides expandable card content and narrow-screen wrapping', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  assert.match(page, /<details\b[^>]*id="card-details"/);
  assert.match(page, /<summary>show full memory/);
  assert.match(page, /id="card-body"/);
  assert.match(page, /<time\b[^>]*id="card-age"/);
  assert.match(page, /\.card-name[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(page, /\.card-meta\s+\.chip[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(page, /\.badge\s*\{[^}]*max-width:\s*100%[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(page, /data-intent="delete"[^}]*\.stamp\.delete/s);
  assert.match(page, /data-intent="keep"[^}]*\.stamp\.keep/s);
});

test('every memory card has the exact accessible on-demand origin control', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  const card = page.match(/<article\b[^>]*id="memory-card"[\s\S]*?<\/article>/)?.[0] || '';
  const toggle = card.match(/<button\b[^>]*id="card-origin-toggle"[^>]*>[\s\S]*?<\/button>/)?.[0] || '';
  const panelTag = card.match(/<[^>]+\bid="card-origin"[^>]*>/)?.[0] || '';

  assert.match(toggle, />\s*why was this saved\?\s*<\/button>/);
  assert.match(toggle, /\btype="button"/);
  assert.match(toggle, /\baria-controls="card-origin"/);
  assert.match(toggle, /\baria-expanded="false"/);
  assert.match(panelTag, /\baria-live="polite"/);
  assert.match(panelTag, /\bhidden\b/);
});

test('keyboard focus keeps a high-contrast ink ring and the marker accent', async () => {
  const page = await readFile(PAGE_PATH, 'utf8');
  assert.match(page, /:focus-visible[^}]*outline:\s*3px solid var\(--ink\)[^}]*box-shadow:\s*0 0 0 6px var\(--marker\)/s);
});

test('age formatter uses stable elapsed units and handles invalid or future dates', async () => {
  const { window } = await loadPageApi();
  const now = Date.parse('2026-09-20T12:00:00.000Z');
  assert.equal(window.SCMD.formatAge('2026-09-20T12:00:00.000Z', now), 'today');
  assert.equal(window.SCMD.formatAge('2026-09-19T12:00:00.000Z', now), '1 day old');
  assert.equal(window.SCMD.formatAge('2026-09-13T12:00:00.000Z', now), '1 week old');
  assert.equal(window.SCMD.formatAge('2025-09-20T12:00:00.000Z', now), '1 year old');
  assert.equal(window.SCMD.formatAge('2026-09-21T12:00:00.000Z', now), 'today');
  assert.equal(window.SCMD.formatAge('not-a-date', now), 'date unknown');
});

test('every real fixture card renders all visible fields and an expandable body', async (t) => {
  const server = await startServer(t);
  const fetchImpl = (pathname, options = {}) => fetch(new URL(pathname, server.url), options);
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({ token: server.token, fetchImpl });
  const { projects } = await backend.listProjects();
  const fixtures = projects.flatMap((project) => (
    project.cards.map((card) => ({ card, projectName: project.name }))
  ));

  assert.equal(fixtures.length, 5);
  for (const fixture of fixtures) {
    const document = fakeDocument();
    window.SCMD.renderCard({
      document,
      card: fixture.card,
      project: projects.find((project) => project.id === fixture.card.projectId),
      now: Date.parse('2027-09-20T12:00:00.000Z'),
    });

    assert.equal(document.elements['memory-card'].hidden, false);
    assert.equal(document.elements['card-name'].textContent, fixture.card.name);
    assert.equal(document.elements['card-summary'].textContent, fixture.card.summary);
    assert.equal(document.elements['card-type'].textContent, fixture.card.type);
    assert.equal(document.elements['card-project'].textContent, fixture.projectName);
    assert.match(document.elements['card-age'].textContent, /^(today|\d+ (?:day|week|month|year)s? old)$/);
    assert.equal(document.elements['card-body'].textContent, fixture.card.body);
    assert.equal(document.elements['card-details'].open, false);
    const parentProject = projects.find((project) => project.id === fixture.card.projectId);
    assert.equal(
      document.elements['card-path'].textContent,
      parentProject.pathUnknown ? 'path unknown' : parentProject.path,
    );
    assert.equal(document.elements['card-project'].title, parentProject.path || 'Project path could not be resolved.');
  }
});

test('boot renders the first available memory without interpreting card text as markup', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend({
    projects: [{
      id: 'unsafe-project',
      name: '<img src=x onerror=alert(1)>',
      path: '/Users/example/<unsafe-project>',
      pathUnknown: false,
      memoryCount: 1,
      cards: [{
        id: 'unsafe-project/card.md',
        fileName: 'card.md',
        projectId: 'unsafe-project',
        name: '<b>literal name</b>',
        summary: '<script>literal summary</script>',
        type: 'feedback',
        date: '2026-09-13T12:00:00.000Z',
        body: '<button>literal body</button>',
        hash: 'fixture-hash',
      }],
    }],
  });

  await window.SCMD.boot({
    backend,
    document,
    window,
    now: Date.parse('2026-09-20T12:00:00.000Z'),
  });

  assert.equal(document.elements['card-name'].textContent, '<b>literal name</b>');
  assert.equal(document.elements['card-summary'].textContent, '<script>literal summary</script>');
  assert.equal(document.elements['card-project'].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(document.elements['card-path'].textContent, '/Users/example/<unsafe-project>');
  assert.equal(document.elements['card-body'].textContent, '<button>literal body</button>');
  assert.equal(document.elements['card-age'].textContent, '1 week old');
  assert.equal(document.elements['card-age'].dateTime, '2026-09-13T12:00:00.000Z');
});

test('real fixture project and type controls produce the expected card', async (t) => {
  const server = await startServer(t);
  const fetchImpl = (pathname, options = {}) => fetch(new URL(pathname, server.url), options);
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({ token: server.token, fetchImpl });
  backend.events = () => () => {};
  const document = fakeDocument();

  await window.SCMD.boot({ backend, document, window });
  const projectButtons = document.elements['project-chips'].children;
  await projectButtons[0].dispatch('click');
  await projectButtons.find((button) => button.textContent.startsWith('my-side-project ·')).dispatch('click');
  for (const button of document.elements['type-chips'].children) {
    if (button.textContent !== 'project') await button.dispatch('click');
  }

  assert.equal(document.elements['card-name'].textContent, 'Keep the demo setup predictable');
  assert.equal(document.elements['card-type'].textContent, 'project');
  assert.equal(document.elements['card-project'].textContent, 'my-side-project');
  assert.equal(document.elements['progress-label'].textContent, '0 of 1');
  assert.deepEqual(
    document.elements['type-chips'].children
      .filter((button) => button['aria-pressed'] === 'true')
      .map((button) => button.textContent),
    ['project'],
  );
});

test('deck ordering is oldest-first and everything reloads reviewed cards', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend({
    projects: [{
      id: 'demo',
      name: 'demo',
      path: '/example/demo',
      pathUnknown: false,
      memoryCount: 3,
      cards: [
        { id: 'demo/new.md', projectId: 'demo', name: 'Newest', summary: 'Newest', type: 'project', date: '2026-09-20T00:00:00.000Z', body: 'new', hash: 'new' },
        { id: 'demo/reviewed.md', projectId: 'demo', name: 'Reviewed oldest', summary: 'Reviewed oldest', type: 'unknown', date: '2026-07-01T00:00:00.000Z', body: 'reviewed', hash: 'reviewed', reviewed: true },
        { id: 'demo/old.md', projectId: 'demo', name: 'Oldest unreviewed', summary: 'Oldest unreviewed', type: 'feedback', date: '2026-08-01T00:00:00.000Z', body: 'old', hash: 'old' },
      ],
    }],
  });

  await window.SCMD.boot({ backend, document, window });
  assert.equal(document.elements['card-name'].textContent, 'Oldest unreviewed');
  assert.equal(document.elements['progress-label'].textContent, '0 of 2');

  await document.elements['scope-everything'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'Reviewed oldest');
  assert.equal(document.elements['progress-label'].textContent, '0 of 3');
  assert.equal(document.elements['card-reviewed'].hidden, false);
  assert.equal(document.elements['card-reviewed'].textContent, 'previously reviewed');
  assert.equal(document.elements['scope-everything']['aria-pressed'], 'true');

  for (const button of [...document.elements['type-chips'].children]) {
    if (button.textContent !== 'unknown') await button.dispatch('click');
  }
  await document.elements['scope-unreviewed'].dispatch('click');
  assert.equal(document.elements['progress-label'].textContent, '0 of 0');
  await document.elements['scope-everything'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'Reviewed oldest');
  assert.deepEqual(
    document.elements['type-chips'].children
      .filter((button) => button['aria-pressed'] === 'true')
      .map((button) => button.textContent),
    ['unknown'],
  );
  assert.deepEqual(
    Array.from(backend.calls, (call) => [call.method, call.options?.includeReviewed]),
    [
    ['events', undefined],
    ['listProjects', true],
    ['instructions', undefined],
    ['read', undefined],
    ['listProjects', true],
      ['listProjects', false],
      ['listProjects', true],
    ],
  );
});

test('scope reload disables filter controls so in-flight choices cannot be overwritten', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend({
    projects: [
      { id: 'one', name: 'one', memoryCount: 0, cards: [] },
      { id: 'two', name: 'two', memoryCount: 0, cards: [] },
    ],
  });
  const listProjects = fake.listProjects;
  let releaseReload;
  let reviewedLoads = 0;
  const backend = {
    ...fake,
    listProjects(options = {}) {
      if (!options.includeReviewed) return listProjects(options);
      reviewedLoads += 1;
      if (reviewedLoads === 1) return listProjects(options);
      return new Promise((resolve) => {
        releaseReload = () => resolve(listProjects(options));
      });
    },
  };

  await window.SCMD.boot({ backend, document, window });
  const switching = document.elements['scope-everything'].dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(document.elements['project-chips'].children[1].disabled, true);
  assert.equal(document.elements['type-chips'].children[0].disabled, true);
  await document.elements['project-chips'].children[1].dispatch('click');

  releaseReload();
  await switching;
  assert.equal(document.elements['project-chips'].children[1]['aria-pressed'], 'true');
  assert.equal(document.elements['project-chips'].children[1].disabled, false);
});

test('search reports a fixture CLAUDE.md-only hit as read-only with no swipeable card', async (t) => {
  const server = await startServer(t);
  const fetchImpl = (pathname, options = {}) => fetch(new URL(pathname, server.url), options);
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({ token: server.token, fetchImpl });
  backend.events = () => () => {};
  const document = fakeDocument();

  await window.SCMD.boot({ backend, document, window });
  document.elements['search-input'].value = 'scmd_instruction_only_token';
  await document.elements['search-input'].dispatch('input');

  assert.equal(document.elements['memory-card'].hidden, true);
  assert.equal(document.elements['progress-label'].textContent, '0 of 0');
  assert.equal(document.elements['instruction-results'].hidden, false);
  assert.equal(document.elements['instruction-results'].children.length, 1);
  assert.match(
    document.elements['instruction-results'].children[0].children[0].textContent,
    /fixtures\/CLAUDE\.md:3$/,
  );
  assert.match(
    document.elements['instruction-results'].children[0].children[1].textContent,
    /SCMD_INSTRUCTION_ONLY_TOKEN/,
  );
  assert.equal(
    document.elements['instruction-results'].children[0].children[2].textContent,
    'Read-only. SCMD does not edit this file.',
  );
});

test('instruction search bounds rendered hits and reports omitted and truncated results', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const matchingLines = Array.from(
    { length: 105 },
    (_, index) => `bounded needle ${index + 1}`,
  ).join('\r');
  const backend = window.SCMD.createFakeBackend({
    projects: [{ id: 'demo', name: 'demo', memoryCount: 0, cards: [] }],
    instructions: [{
      path: '/example/CLAUDE.md',
      projectId: null,
      content: matchingLines,
      truncated: true,
    }],
  });

  await window.SCMD.boot({ backend, document, window });
  document.elements['search-input'].value = 'NEEDLE';
  await document.elements['search-input'].dispatch('input');

  const results = document.elements['instruction-results'];
  assert.equal(results.hidden, false);
  assert.equal(results.children.length, 101);
  assert.equal(results.children[99].children[0].textContent, '/example/CLAUDE.md:100');
  assert.match(results.children[100].textContent, /5 more matches omitted/i);
  assert.match(results.children[100].textContent, /truncated at 256 KiB/i);
  assert.match(document.elements['app-status'].textContent, /105 read-only instruction hits/);
});

test('search filters memory name, summary, and body across selected projects as the user types', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend({
    projects: [
      {
        id: 'api', name: 'api', path: '/example/api', pathUnknown: false, memoryCount: 2,
        cards: [
          { id: 'api/body.md', projectId: 'api', name: 'Body hit', summary: 'Other', type: 'project', date: '2026-08-01T00:00:00.000Z', body: 'contains lighthouse here', hash: 'body' },
          { id: 'api/miss.md', projectId: 'api', name: 'No match', summary: 'Other', type: 'project', date: '2026-07-01T00:00:00.000Z', body: 'nothing', hash: 'miss' },
        ],
      },
      {
        id: 'web', name: 'web', path: '/example/web', pathUnknown: false, memoryCount: 1,
        cards: [
          { id: 'web/summary.md', projectId: 'web', name: 'Summary hit', summary: 'Use Lighthouse before release', type: 'feedback', date: '2026-09-01T00:00:00.000Z', body: 'other', hash: 'summary' },
        ],
      },
    ],
  });

  const loaded = await window.SCMD.boot({ backend, document, window });
  document.elements['search-input'].value = 'LIGHTHOUSE';
  await document.elements['search-input'].dispatch('input');

  assert.deepEqual(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id),
    ['api/body.md', 'web/summary.md'],
  );
  assert.equal(document.elements['card-name'].textContent, 'Body hit');
  assert.equal(document.elements['progress-label'].textContent, '0 of 2');
  assert.equal(document.elements['instruction-results'].hidden, true);
});

test('empty state explains when every matching memory has already been reviewed', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend({
    root: '/example/.claude/projects',
    projects: [{
      id: 'demo',
      name: 'demo',
      path: '/example/demo',
      pathUnknown: false,
      memoryCount: 1,
      cards: [{
        id: 'demo/reviewed.md',
        projectId: 'demo',
        name: 'Reviewed',
        summary: 'Already handled',
        type: 'feedback',
        date: '2026-08-01T00:00:00.000Z',
        body: 'reviewed body',
        hash: 'reviewed',
        reviewed: true,
      }],
    }],
  });

  await window.SCMD.boot({ backend, document, window });

  assert.equal(document.elements['memory-card'].hidden, true);
  assert.equal(
    document.elements['app-status'].textContent,
    'Everything under these filters has been reviewed; switch to Everything to see it.',
  );
  assert.equal(document.elements['scope-everything'].disabled, false);
});

test('empty state names the scanned directory when no memories exist', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend({
    root: '/example/.claude/projects',
    projects: [{ id: 'empty', name: 'empty', memoryCount: 0, cards: [] }],
  });

  await window.SCMD.boot({ backend, document, window });

  assert.equal(
    document.elements['app-status'].textContent,
    'No Claude Code memories were found in /example/.claude/projects.',
  );
});

test('empty state explains when active filters yield no memories', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend({
    root: '/example/.claude/projects',
    projects: [{
      id: 'demo',
      name: 'demo',
      path: '/example/demo',
      pathUnknown: false,
      memoryCount: 1,
      cards: [{
        id: 'demo/card.md',
        projectId: 'demo',
        name: 'A memory',
        summary: 'A useful detail',
        type: 'project',
        date: '2026-08-01T00:00:00.000Z',
        body: 'fixture body',
        hash: 'fixture',
      }],
    }],
  });

  await window.SCMD.boot({ backend, document, window });
  document.elements['search-input'].value = 'no-such-memory';
  await document.elements['search-input'].dispatch('input');

  assert.equal(document.elements['memory-card'].hidden, true);
  assert.equal(document.elements['app-status'].textContent, 'No memories match these filters.');
});

function decisionFixture() {
  return {
    projects: [{
      id: 'demo',
      name: 'demo',
      path: '/example/demo',
      pathUnknown: false,
      memoryCount: 4,
      cards: [
        { id: 'demo/a.md', projectId: 'demo', name: 'A', summary: 'A', type: 'project', date: '2026-01-01T00:00:00.000Z', body: 'a', hash: 'hash-a' },
        { id: 'demo/b.md', projectId: 'demo', name: 'B', summary: 'B', type: 'project', date: '2026-02-01T00:00:00.000Z', body: 'b', hash: 'hash-b' },
        { id: 'demo/c.md', projectId: 'demo', name: 'C', summary: 'C', type: 'project', date: '2026-03-01T00:00:00.000Z', body: 'c', hash: 'hash-c' },
        { id: 'demo/d.md', projectId: 'demo', name: 'D', summary: 'D', type: 'project', date: '2026-04-01T00:00:00.000Z', body: 'd', hash: 'hash-d' },
      ],
    }],
  };
}

test('task 6.6 clears ordinary deck status but exposes instruction, empty, and error messages', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend({
    ...decisionFixture(),
    instructions: [{
      path: '/example/CLAUDE.md',
      projectId: null,
      content: 'instruction-only needle',
    }],
  });
  let failReload = false;
  const backend = {
    ...fake,
    listProjects(options) {
      if (failReload) throw new Error('reload failed');
      return fake.listProjects(options);
    },
  };

  await window.SCMD.boot({ backend, document, window });
  const status = document.elements['app-status'];
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, '');

  document.elements['search-input'].value = 'instruction-only needle';
  await document.elements['search-input'].dispatch('input');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /1 read-only instruction hit/);

  document.elements['search-input'].value = 'missing everywhere';
  await document.elements['search-input'].dispatch('input');
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'No memories match these filters.');

  document.elements['search-input'].value = '';
  await document.elements['search-input'].dispatch('input');
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, '');

  failReload = true;
  await document.elements['scope-everything'].dispatch('click');
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'SCMD could not load this review.');
});

test('task 6.6 progress keeps visual and ARIA ratios synchronized through edit, skip, decision, and undo', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const loaded = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
  });
  const progress = document.elements['progress-bar'];
  const fill = document.elements['progress-fill'];

  assert.equal(document.elements['progress-label'].textContent, '0 of 4');
  assert.equal(progress['aria-valuemin'], '0');
  assert.equal(progress['aria-valuenow'], '0');
  assert.equal(progress['aria-valuemax'], '4');
  assert.equal(fill.style.width, '0%');
  assert.equal(document.elements['apply-review'].disabled, true);
  assert.equal(document.elements['apply-review'].textContent, 'Review decisions →');

  loaded.controller.stageEdit('demo/a.md', 'edited by hand');
  assert.equal(document.elements['progress-label'].textContent, '0 of 4');
  assert.equal(progress['aria-valuenow'], '0');
  assert.equal(fill.style.width, '0%');
  assert.equal(document.elements['apply-review'].textContent, 'Review 1 decision →');
  await document.elements['action-undo'].dispatch('click');

  await document.elements['action-skip'].dispatch('click');
  assert.equal(document.elements['progress-label'].textContent, '0 of 4');
  assert.equal(progress['aria-valuenow'], '0');
  assert.equal(fill.style.width, '0%');

  await document.elements['action-keep'].dispatch('click');
  assert.equal(document.elements['progress-label'].textContent, '1 of 4');
  assert.equal(progress['aria-valuenow'], '1');
  assert.equal(progress['aria-valuemax'], '4');
  assert.equal(fill.style.width, '25%');
  assert.equal(document.elements['apply-review'].disabled, false);
  assert.equal(document.elements['apply-review'].textContent, 'Review 1 decision →');

  await document.elements['action-undo'].dispatch('click');
  assert.equal(document.elements['progress-label'].textContent, '0 of 4');
  assert.equal(progress['aria-valuenow'], '0');
  assert.equal(fill.style.width, '0%');
  assert.equal(document.elements['apply-review'].disabled, true);
  assert.equal(document.elements['apply-review'].textContent, 'Review decisions →');
});

test('task 6.6 progress recalculates every scope while counts and CTA stay session-wide', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend({
    projects: [
      {
        id: 'alpha', name: 'alpha', memoryCount: 3,
        cards: [
          { id: 'alpha/a.md', projectId: 'alpha', name: 'Alpha', summary: 'Alpha', type: 'project', date: '2026-01-01T00:00:00.000Z', body: 'alpha', hash: 'a' },
          { id: 'alpha/b.md', projectId: 'alpha', name: 'Bravo', summary: 'Bravo', type: 'feedback', date: '2026-02-01T00:00:00.000Z', body: 'bravo', hash: 'b' },
          { id: 'alpha/reviewed.md', projectId: 'alpha', name: 'Reviewed', summary: 'Reviewed', type: 'project', date: '2026-03-01T00:00:00.000Z', body: 'reviewed', hash: 'r', reviewed: true },
        ],
      },
      {
        id: 'beta', name: 'beta', memoryCount: 1,
        cards: [
          { id: 'beta/c.md', projectId: 'beta', name: 'Gamma', summary: 'Gamma', type: 'project', date: '2026-04-01T00:00:00.000Z', body: 'gamma', hash: 'c' },
        ],
      },
    ],
  });

  await window.SCMD.boot({ backend, document, window });
  await document.elements['action-keep'].dispatch('click');
  await document.elements['action-delete'].dispatch('click');

  assert.equal(document.elements['progress-label'].textContent, '2 of 3');
  assert.ok(Math.abs(Number.parseFloat(document.elements['progress-fill'].style.width) - (200 / 3)) < 0.001);
  assert.equal(document.elements['decision-counts'].textContent, 'kept 1 · deleted 1');
  assert.equal(document.elements['apply-review'].textContent, 'Review 2 decisions →');

  const projectChip = (id) => document.elements['project-chips'].children
    .find((button) => button.dataset.filterKey === `project:${id}`);
  const typeChip = (id) => document.elements['type-chips'].children
    .find((button) => button.dataset.filterKey === id);

  await projectChip('alpha').dispatch('click');
  assert.equal(document.elements['progress-label'].textContent, '0 of 1');

  document.elements['search-input'].value = 'no matching memory';
  await document.elements['search-input'].dispatch('input');
  assert.equal(document.elements['progress-label'].textContent, '0 of 0');
  assert.equal(document.elements['progress-bar']['aria-valuenow'], '0');
  assert.equal(document.elements['progress-bar']['aria-valuemax'], '0');
  assert.equal(document.elements['progress-fill'].style.width, '0%');

  document.elements['search-input'].value = '';
  await document.elements['search-input'].dispatch('input');
  await projectChip('alpha').dispatch('click');
  await typeChip('feedback').dispatch('click');
  assert.equal(document.elements['progress-label'].textContent, '1 of 2');

  document.elements['search-input'].value = 'Gamma';
  await document.elements['search-input'].dispatch('input');
  assert.equal(document.elements['progress-label'].textContent, '0 of 1');
  assert.equal(document.elements['decision-counts'].textContent, 'kept 1 · deleted 1');
  assert.equal(document.elements['apply-review'].textContent, 'Review 2 decisions →');

  document.elements['search-input'].value = '';
  await document.elements['search-input'].dispatch('input');
  await document.elements['scope-everything'].dispatch('click');
  assert.equal(document.elements['progress-label'].textContent, '1 of 3');
  assert.equal(document.elements['decision-counts'].textContent, 'kept 1 · deleted 1');
});

test('origin lookup is lazy, shows loading, and renders found text and date literally', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(decisionFixture());
  const originCalls = [];
  let finishOrigin;
  const backend = {
    ...fake,
    origin(id) {
      originCalls.push(id);
      return new Promise((resolve) => { finishOrigin = resolve; });
    },
  };

  await window.SCMD.boot({ backend, document, window });

  const toggle = document.elements['card-origin-toggle'];
  const panel = document.elements['card-origin'];
  assert.deepEqual(originCalls, []);
  assert.equal(toggle.textContent, 'why was this saved?');
  assert.equal(toggle['aria-expanded'], 'false');
  assert.equal(panel.hidden, true);

  const loading = toggle.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(originCalls, ['demo/a.md']);
  assert.equal(toggle.disabled, true);
  assert.equal(toggle['aria-expanded'], 'true');
  assert.equal(panel.hidden, false);
  assert.match(document.elements['card-origin-status'].textContent, /looking up|loading/i);

  finishOrigin({
    status: 'found',
    message: '<img src=x onerror=alert(1)> literal request',
    date: '2026-01-02T03:04:05.000Z',
  });
  await loading;

  assert.equal(
    document.elements['card-origin-message'].textContent,
    '<img src=x onerror=alert(1)> literal request',
  );
  assert.equal(document.elements['card-origin-date'].dateTime, '2026-01-02T03:04:05.000Z');
  assert.match(document.elements['card-origin-date'].textContent, /2026/);
  assert.equal(toggle.disabled, false);
});

test('a pending or cached origin lookup does not issue overlapping duplicate requests', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(decisionFixture());
  const originCalls = [];
  let finishOrigin;
  const backend = {
    ...fake,
    origin(id) {
      originCalls.push(id);
      return new Promise((resolve) => { finishOrigin = resolve; });
    },
  };
  await window.SCMD.boot({ backend, document, window });
  const toggle = document.elements['card-origin-toggle'];

  const first = toggle.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  await toggle.dispatch('click');
  assert.deepEqual(originCalls, ['demo/a.md']);
  finishOrigin({ status: 'found', message: 'Cached origin.', date: '2026-01-02T03:04:05.000Z' });
  await first;

  await toggle.dispatch('click');
  assert.equal(toggle['aria-expanded'], 'false');
  assert.equal(document.elements['card-origin'].hidden, true);
  await toggle.dispatch('click');
  assert.equal(toggle['aria-expanded'], 'true');
  assert.equal(document.elements['card-origin'].hidden, false);
  assert.equal(document.elements['card-origin-message'].textContent, 'Cached origin.');
  assert.deepEqual(originCalls, ['demo/a.md']);
});

test('an authoritative same-id card revision clears the old origin and requests it again', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(decisionFixture());
  const originCalls = [];
  let projectLoads = 0;
  let finishOldOrigin;
  const backend = {
    ...fake,
    async listProjects(options) {
      const result = await fake.listProjects(options);
      projectLoads += 1;
      if (projectLoads > 1) result.projects[0].cards[0].hash = 'hash-a-revised';
      return result;
    },
    origin(id) {
      originCalls.push(id);
      if (originCalls.length === 1) {
        return new Promise((resolve) => { finishOldOrigin = resolve; });
      }
      return Promise.resolve({
        status: 'found',
        message: 'Origin for revised A.',
        date: '2026-01-02T03:04:05.000Z',
      });
    },
  };
  await window.SCMD.boot({ backend, document, window });
  const toggle = document.elements['card-origin-toggle'];

  const oldLookup = toggle.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  await document.elements['scope-everything'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'A');
  assert.equal(toggle['aria-expanded'], 'false');
  assert.equal(document.elements['card-origin'].hidden, true);
  assert.equal(document.elements['card-origin-message'].textContent, '');

  finishOldOrigin({
    status: 'found',
    message: 'Late origin for old A.',
    date: '2026-01-02T03:04:05.000Z',
  });
  await oldLookup;
  assert.equal(document.elements['card-origin'].hidden, true);
  assert.notEqual(document.elements['card-origin-message'].textContent, 'Late origin for old A.');

  await toggle.dispatch('click');
  assert.deepEqual(originCalls, ['demo/a.md', 'demo/a.md']);
  assert.equal(document.elements['card-origin-message'].textContent, 'Origin for revised A.');
});

test('late origin completions cannot repopulate cache entries cleared by live updates', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const versions = [
    liveCard('demo/a.md', {
      name: 'A revision two',
      hash: 'hash-a-two',
      date: '2026-01-01T00:00:00.000Z',
    }),
    liveCard('demo/a.md', {
      name: 'A revision three',
      hash: 'hash-a-three',
      date: '2026-01-01T00:00:00.000Z',
    }),
  ];
  const pendingOrigins = [];
  const live = makeLiveBackend(window, {
    seed: liveFixture(),
    eventCards: { 'demo/a.md': () => versions.shift() },
  });
  live.backend.origin = () => {
    const pending = deferredValue();
    pendingOrigins.push(pending);
    return pending.promise;
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  const toggle = document.elements['card-origin-toggle'];

  const firstLookup = toggle.dispatch('click');
  await settleEvents();
  await live.emit({ type: 'changed', id: 'demo/a.md' });
  pendingOrigins[0].resolve({
    status: 'found',
    message: 'Late success for revision one.',
    date: '2026-01-02T03:04:05.000Z',
  });
  await firstLookup;
  assert.equal(loaded.controller.liveStateSizes().originLookups, 0);

  const secondLookup = toggle.dispatch('click');
  await settleEvents();
  await live.emit({ type: 'changed', id: 'demo/a.md' });
  pendingOrigins[1].reject(new Error('Late failure for revision two.'));
  await secondLookup;
  assert.equal(loaded.controller.liveStateSizes().originLookups, 0);

  const thirdLookup = toggle.dispatch('click');
  await settleEvents();
  await live.emit({ type: 'removed', id: 'demo/a.md' });
  pendingOrigins[2].resolve({
    status: 'found',
    message: 'Late success after removal.',
    date: '2026-01-02T03:04:05.000Z',
  });
  await thirdLookup;
  assert.equal(loaded.controller.liveStateSizes().originLookups, 0);
});

test('origin not-found responses show the literal state and a human-readable reason', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(decisionFixture());
  const backend = {
    ...fake,
    async origin() {
      return { status: 'not-found', reason: 'transcript-too-large' };
    },
  };
  await window.SCMD.boot({ backend, document, window });

  await document.elements['card-origin-toggle'].dispatch('click');

  assert.equal(document.elements['card-origin-status'].textContent, 'not found');
  assert.match(document.elements['card-origin-message'].textContent, /transcript.*too large/i);
  assert.doesNotMatch(document.elements['card-origin-message'].textContent, /transcript-too-large/);
  assert.equal(document.elements['card-origin'].hidden, false);
});

test('a resolved transient origin miss is retried after the panel is reopened', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(decisionFixture());
  let attempts = 0;
  const backend = {
    ...fake,
    async origin() {
      attempts += 1;
      if (attempts === 1) return { status: 'not-found', reason: 'lookup-timed-out' };
      return {
        status: 'found',
        message: 'Origin found on retry.',
        date: '2026-01-02T03:04:05.000Z',
      };
    },
  };
  await window.SCMD.boot({ backend, document, window });
  const toggle = document.elements['card-origin-toggle'];

  await toggle.dispatch('click');
  assert.equal(document.elements['card-origin-status'].textContent, 'not found');
  assert.match(document.elements['card-origin-message'].textContent, /took too long/i);
  await toggle.dispatch('click');
  await toggle.dispatch('click');

  assert.equal(attempts, 2);
  assert.equal(document.elements['card-origin-message'].textContent, 'Origin found on retry.');
});

test('origin request failures are announced without disabling the deck or retry', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(decisionFixture());
  let attempts = 0;
  const backend = {
    ...fake,
    async origin() {
      attempts += 1;
      throw new Error('<b>temporary disconnect</b>');
    },
  };
  await window.SCMD.boot({ backend, document, window });

  const toggle = document.elements['card-origin-toggle'];
  await toggle.dispatch('click');

  assert.match(document.elements['card-origin-status'].textContent, /could not|failed/i);
  assert.match(document.elements['card-origin-message'].textContent, /<b>temporary disconnect<\/b>/);
  assert.equal(toggle.disabled, false);
  assert.equal(document.elements['action-skip'].disabled, false);
  await toggle.dispatch('click');
  await toggle.dispatch('click');
  assert.equal(attempts, 2);
});

test('origin results stay with their card and the control never starts a card drag', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(decisionFixture());
  const originCalls = [];
  let finishFirst;
  const backend = {
    ...fake,
    origin(id) {
      originCalls.push(id);
      if (id === 'demo/a.md') {
        return new Promise((resolve) => { finishFirst = resolve; });
      }
      return Promise.resolve({
        status: 'found',
        message: 'Origin for B.',
        date: '2026-02-02T00:00:00.000Z',
      });
    },
  };
  const loaded = await window.SCMD.boot({ backend, document, window });
  const toggle = document.elements['card-origin-toggle'];
  const card = document.elements['memory-card'];

  const firstLookup = toggle.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.elements['action-skip'].disabled, false);
  await document.elements['action-skip'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'B');
  assert.equal(toggle.textContent, 'why was this saved?');
  assert.equal(toggle['aria-expanded'], 'false');
  assert.equal(document.elements['card-origin'].hidden, true);

  finishFirst({ status: 'found', message: 'Stale origin for A.', date: '2026-01-01T00:00:00.000Z' });
  await firstLookup;
  assert.notEqual(document.elements['card-origin-message'].textContent, 'Stale origin for A.');

  await card.dispatch('pointerdown', {
    target: toggle,
    pointerId: 41,
    isPrimary: true,
    button: 0,
    clientX: 200,
  });
  await card.dispatch('pointerup', { target: toggle, pointerId: 41, clientX: 20 });
  assert.equal(document.elements['card-name'].textContent, 'B');
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);

  await toggle.dispatch('click');
  assert.deepEqual(originCalls, ['demo/a.md', 'demo/b.md']);
  assert.equal(document.elements['card-origin-message'].textContent, 'Origin for B.');
  assert.equal(document.elements['action-keep'].disabled, false);
  await document.elements['action-keep'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'C');
});

function rewriteFixture(overrides = {}) {
  const content = `---
name: A
description: Original summary.
type: project
---

Original body.
`;
  return {
    rewriteAvailable: true,
    rewriteResult: {
      text: `---
name: A
description: New summary.
type: project
---

Short body.
`,
      valid: true,
    },
    projects: [{
      id: 'demo',
      name: 'demo',
      path: '/example/demo',
      pathUnknown: false,
      memoryCount: 1,
      cards: [{
        id: 'demo/a.md',
        projectId: 'demo',
        name: 'A',
        summary: 'Original summary.',
        type: 'project',
        date: '2026-01-01T00:00:00.000Z',
        body: 'Original body.\n',
        content,
        hash: 'hash-a',
      }],
    }],
    ...overrides,
  };
}

test('accepting a rewrite stages exact content and keeps the card visible with its new summary', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fixture = rewriteFixture();
  const backend = window.SCMD.createFakeBackend(fixture);
  const loaded = await window.SCMD.boot({ backend, document, window });

  assert.equal(document.elements['rewrite-login'].textContent, 'Uses your local Claude Code login');
  assert.equal(document.elements['rewrite-panel'].hidden, true);
  document.elements['rewrite-input'].value = 'make this shorter';
  await document.elements['rewrite-button'].dispatch('click');

  assert.equal(document.elements['rewrite-panel'].hidden, false);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(document.elements['card-summary'].textContent, 'Original summary.');
  assert.match(
    document.elements['rewrite-before-lines'].children.map((line) => line.textContent).join('\n'),
    /Original summary/,
  );
  assert.match(
    document.elements['rewrite-after-lines'].children.map((line) => line.textContent).join('\n'),
    /New summary/,
  );
  assert.ok(document.elements['rewrite-before-lines'].children.length <= 401);
  assert.ok(document.elements['rewrite-after-lines'].children.length <= 401);
  assert.equal(document.activeElement, document.elements['rewrite-accept']);

  await document.elements['rewrite-accept'].dispatch('click');

  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [{
    id: 'demo/a.md',
    action: 'edit',
    expectedHash: 'hash-a',
    newContent: fixture.rewriteResult.text,
  }]);
  assert.equal(document.elements['card-summary'].textContent, 'New summary.');
  assert.equal(document.elements['card-name'].textContent, 'A');
  assert.equal(document.elements['memory-card'].hidden, false);
  assert.equal(document.elements['rewrite-panel'].hidden, true);
  assert.equal(document.activeElement, document.elements['rewrite-input']);
});

test('rejecting a rewrite leaves the visible card and staged decisions unchanged', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend(rewriteFixture());
  const loaded = await window.SCMD.boot({ backend, document, window });
  document.elements['rewrite-input'].value = 'make this shorter';
  await document.elements['rewrite-button'].dispatch('click');

  await document.elements['rewrite-reject'].dispatch('click');

  assert.equal(document.elements['rewrite-panel'].hidden, true);
  assert.equal(document.elements['card-summary'].textContent, 'Original summary.');
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(document.activeElement, document.elements['rewrite-input']);
});

test('manual editing stays available without Claude and stages the textarea bytes without AI', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fixture = rewriteFixture({ rewriteAvailable: false });
  const backend = window.SCMD.createFakeBackend(fixture);
  const loaded = await window.SCMD.boot({ backend, document, window });

  assert.equal(document.elements['rewrite-input'].disabled, true);
  assert.equal(document.elements['rewrite-button'].disabled, true);
  assert.equal(document.elements['rewrite-unavailable'].hidden, false);
  assert.equal(
    document.elements['rewrite-unavailable'].textContent,
    'Installing Claude Code enables rewrites.',
  );
  assert.equal(document.elements['rewrite-hand'].disabled, false);
  await document.elements['rewrite-hand'].dispatch('click');
  assert.equal(document.elements['hand-editor-text'].value, fixture.projects[0].cards[0].content);
  assert.equal(document.activeElement, document.elements['hand-editor-text']);

  const edited = fixture.projects[0].cards[0].content.replace(
    'Original summary.',
    'Hand-written summary.',
  );
  document.elements['hand-editor-text'].value = edited;
  await document.elements['hand-editor-save'].dispatch('click');

  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [{
    id: 'demo/a.md',
    action: 'edit',
    expectedHash: 'hash-a',
    newContent: edited,
  }]);
  assert.equal(document.elements['card-summary'].textContent, 'Hand-written summary.');
  assert.equal(backend.calls.some((call) => call.method === 'modifyWithAI'), false);
  assert.equal(document.activeElement, document.elements['rewrite-hand']);
});

test('proposal and editor states suspend every deck mutation until explicitly closed', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend(rewriteFixture());
  const loaded = await window.SCMD.boot({ backend, document, window });
  loaded.controller.stageEdit(
    'demo/a.md',
    rewriteFixture().projects[0].cards[0].content.replace('Original summary.', 'Staged summary.'),
  );
  document.elements['rewrite-input'].value = 'make this shorter';
  await document.elements['rewrite-button'].dispatch('click');

  for (const id of [
    'action-delete',
    'action-skip',
    'action-keep',
    'action-undo',
    'apply-review',
    'trash-open',
    'scope-everything',
    'scope-unreviewed',
    'search-input',
  ]) assert.equal(document.elements[id].disabled, true, id);
  assert.equal(document.elements['project-chips'].children[0].disabled, true);
  assert.equal(document.elements['type-chips'].children[0].disabled, true);

  await document.dispatch('keydown', {
    key: 'ArrowRight',
    target: document.elements['rewrite-accept'],
  });
  const card = document.elements['memory-card'];
  await card.dispatch('pointerdown', {
    pointerId: 20,
    isPrimary: true,
    button: 0,
    clientX: 200,
  });
  await card.dispatch('pointerup', { pointerId: 20, clientX: 50 });
  assert.equal(Array.from(loaded.controller.decisions()).length, 1);
  assert.equal(document.elements['card-summary'].textContent, 'Staged summary.');

  await document.elements['rewrite-reject'].dispatch('click');
  assert.equal(document.elements['action-keep'].disabled, false);
  assert.equal(document.elements['action-undo'].disabled, false);
  assert.equal(document.elements['apply-review'].disabled, false);
  assert.equal(document.activeElement, document.elements['rewrite-input']);

  await document.elements['rewrite-hand'].dispatch('click');
  assert.equal(document.elements['action-keep'].disabled, true);
  await document.dispatch('keydown', { key: 'z' });
  assert.equal(Array.from(loaded.controller.decisions()).length, 1);
  await document.elements['hand-editor-cancel'].dispatch('click');
  assert.equal(document.activeElement, document.elements['rewrite-hand']);
});

test('repeated hand and AI edits compose from staged bytes with the original hash', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const original = rewriteFixture().projects[0].cards[0].content;
  const first = original
    .replace('name: A', 'name: Hand-edited A')
    .replace('Original summary.', 'First staged summary.')
    .replace('type: project', 'type: feedback');
  const fixture = rewriteFixture({
    rewriteResult: {
      text: first.replace('First staged summary.', 'AI summary.'),
      valid: true,
    },
  });
  const backend = window.SCMD.createFakeBackend(fixture);
  const loaded = await window.SCMD.boot({ backend, document, window });

  await document.elements['rewrite-hand'].dispatch('click');
  document.elements['hand-editor-text'].value = first;
  await document.elements['hand-editor-save'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'Hand-edited A');
  assert.equal(document.elements['card-type'].textContent, 'feedback');
  const sourceReadsAfterFirst = backend.calls.filter(
    (call) => call.method === 'read' && call.id === 'demo/a.md',
  ).length;

  await document.elements['rewrite-hand'].dispatch('click');
  assert.equal(document.elements['hand-editor-text'].value, first);
  assert.equal(backend.calls.filter(
    (call) => call.method === 'read' && call.id === 'demo/a.md',
  ).length, sourceReadsAfterFirst);
  await document.elements['hand-editor-cancel'].dispatch('click');

  document.elements['rewrite-input'].value = 'shorter again';
  await document.elements['rewrite-button'].dispatch('click');
  const aiCall = backend.calls.find((call) => call.method === 'modifyWithAI');
  assert.equal(aiCall.options.content, first);
  assert.match(
    document.elements['rewrite-before-lines'].children.map((line) => line.textContent).join('\n'),
    /First staged summary/,
  );
  await document.elements['rewrite-accept'].dispatch('click');

  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [{
    id: 'demo/a.md',
    action: 'edit',
    expectedHash: 'hash-a',
    newContent: fixture.rewriteResult.text,
  }]);
  await document.elements['action-undo'].dispatch('click');
  assert.equal(document.elements['card-summary'].textContent, 'First staged summary.');
  assert.equal(document.elements['card-name'].textContent, 'Hand-edited A');
  assert.equal(document.elements['card-type'].textContent, 'feedback');
  assert.equal(Array.from(loaded.controller.decisions())[0].newContent, first);
});

test('staged previews survive scope reloads and later edits still undo consistently', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fixture = rewriteFixture();
  const backend = window.SCMD.createFakeBackend(fixture);
  const loaded = await window.SCMD.boot({ backend, document, window });
  const first = fixture.projects[0].cards[0].content
    .replace('Original summary.', 'First staged summary.')
    .replace('Original body.', 'First staged body.');
  loaded.controller.stageEdit('demo/a.md', first);

  await document.elements['scope-everything'].dispatch('click');
  assert.equal(document.elements['card-summary'].textContent, 'First staged summary.');
  assert.match(document.elements['card-body'].textContent, /First staged body/);

  const second = first.replace('First staged summary.', 'Second staged summary.');
  loaded.controller.stageEdit('demo/a.md', second);
  assert.equal(Array.from(loaded.controller.decisions())[0].expectedHash, 'hash-a');
  await document.elements['action-undo'].dispatch('click');
  assert.equal(document.elements['card-summary'].textContent, 'First staged summary.');
  assert.equal(Array.from(loaded.controller.decisions())[0].newContent, first);
});

test('line diff aligns a single insertion instead of marking every later line changed', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fixture = rewriteFixture({
    projects: [{
      ...rewriteFixture().projects[0],
      cards: [{
        ...rewriteFixture().projects[0].cards[0],
        content: 'one\ntwo\nthree',
      }],
    }],
    rewriteResult: { text: 'one\ninserted\ntwo\nthree', valid: true },
  });
  const backend = window.SCMD.createFakeBackend(fixture);
  await window.SCMD.boot({ backend, document, window });
  document.elements['rewrite-input'].value = 'insert a line';

  await document.elements['rewrite-button'].dispatch('click');

  assert.deepEqual(
    document.elements['rewrite-before-lines'].children.map((line) => [line.textContent, line.className]),
    [['one', ''], [' ', 'gap'], ['two', ''], ['three', '']],
  );
  assert.deepEqual(
    document.elements['rewrite-after-lines'].children.map((line) => [line.textContent, line.className]),
    [['one', ''], ['inserted', 'added'], ['two', ''], ['three', '']],
  );
});

test('an oversized diff cannot be accepted unseen and opens the full hand editor', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const before = Array.from({ length: 401 }, (_, index) => `before ${index}`).join('\n');
  const after = Array.from({ length: 401 }, (_, index) => `after ${index}`).join('\n');
  const fixture = rewriteFixture({
    projects: [{
      ...rewriteFixture().projects[0],
      cards: [{ ...rewriteFixture().projects[0].cards[0], content: before }],
    }],
    rewriteResult: { text: after, valid: true },
  });
  const backend = window.SCMD.createFakeBackend(fixture);
  const loaded = await window.SCMD.boot({ backend, document, window });
  document.elements['rewrite-input'].value = 'replace everything';

  await document.elements['rewrite-button'].dispatch('click');

  assert.equal(document.elements['rewrite-panel'].hidden, true);
  assert.equal(document.elements['hand-editor'].hidden, false);
  assert.equal(document.elements['hand-editor-text'].value, after);
  assert.match(document.elements['rewrite-error'].textContent, /too large.*hand editor/i);
  assert.equal(document.activeElement, document.elements['hand-editor-text']);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
});

test('rewrite failures show the reason, re-enable the field, and stage no edit', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(rewriteFixture());
  const backend = {
    ...fake,
    async modifyWithAI() {
      const error = new Error('Claude Code rewrite timed out after 60000 ms.');
      error.code = 'rewrite-timeout';
      throw error;
    },
  };
  const loaded = await window.SCMD.boot({ backend, document, window });
  document.elements['rewrite-input'].value = 'make this shorter';

  await document.elements['rewrite-button'].dispatch('click');

  assert.match(document.elements['rewrite-error'].textContent, /timed out/);
  assert.equal(document.elements['rewrite-input'].disabled, false);
  assert.equal(document.elements['rewrite-button'].disabled, false);
  assert.equal(document.elements['rewrite-panel'].hidden, true);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
});

test('a rewrite-unavailable response disables only AI and leaves hand editing available', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(rewriteFixture());
  const backend = {
    ...fake,
    async modifyWithAI() {
      const error = new Error('Claude Code is not installed or is not available on PATH.');
      error.code = 'rewrite-unavailable';
      throw error;
    },
  };
  const loaded = await window.SCMD.boot({ backend, document, window });
  document.elements['rewrite-input'].value = 'make this shorter';

  await document.elements['rewrite-button'].dispatch('click');

  assert.equal(document.elements['rewrite-input'].disabled, true);
  assert.equal(document.elements['rewrite-button'].disabled, true);
  assert.equal(document.elements['rewrite-unavailable'].hidden, false);
  assert.equal(document.elements['rewrite-hand'].disabled, false);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
});

test('an unknown availability check has distinct copy and still leaves hand editing available', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(rewriteFixture());
  const backend = {
    ...fake,
    read(request) {
      if (request?.status === true) throw new Error('status failed');
      return fake.read(request);
    },
  };

  await window.SCMD.boot({ backend, document, window });

  assert.equal(document.elements['rewrite-input'].disabled, true);
  assert.equal(document.elements['rewrite-button'].disabled, true);
  assert.equal(document.elements['rewrite-unavailable'].hidden, false);
  assert.equal(
    document.elements['rewrite-unavailable'].textContent,
    'Rewrite availability could not be checked. Edit by hand still works.',
  );
  assert.equal(document.elements['rewrite-hand'].disabled, false);
});

test('an invalid proposal reports it and opens the hand editor with exact raw text', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const raw = '<not frontmatter>\r\nraw response\r\n';
  const backend = window.SCMD.createFakeBackend(rewriteFixture({
    rewriteResult: {
      text: raw,
      valid: false,
      reason: 'proposal-could-not-be-used',
      message: 'The proposal could not be used.',
    },
  }));
  const loaded = await window.SCMD.boot({ backend, document, window });
  document.elements['rewrite-input'].value = 'change it';

  await document.elements['rewrite-button'].dispatch('click');

  assert.equal(document.elements['rewrite-error'].textContent, 'The proposal could not be used.');
  assert.equal(document.elements['hand-editor'].hidden, false);
  assert.equal(document.elements['hand-editor-text'].value, raw);
  assert.equal(document.activeElement, document.elements['hand-editor-text']);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
});

test('a busy rewrite suspends deck navigation and applies only to its original card', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(decisionFixture());
  let finishRewrite;
  const backend = {
    ...fake,
    read(request) {
      if (request?.status === true) return Promise.resolve({ rewriteAvailable: true });
      return Promise.resolve({ ...decisionFixture().projects[0].cards[0], content: 'a' });
    },
    modifyWithAI() {
      return new Promise((resolve) => { finishRewrite = resolve; });
    },
  };
  const loaded = await window.SCMD.boot({ backend, document, window });
  document.elements['rewrite-input'].value = 'change it';
  const rewriting = document.elements['rewrite-button'].dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.elements['action-skip'].disabled, true);
  await document.elements['action-skip'].dispatch('click');
  await document.dispatch('keydown', { key: 'ArrowRight' });
  finishRewrite({ before: 'a', text: 'changed', valid: true });
  await rewriting;

  assert.equal(document.elements['card-name'].textContent, 'A');
  assert.equal(document.elements['rewrite-panel'].hidden, false);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
});

test('keyboard and action buttons stage identical keep and delete decisions', async () => {
  const { window } = await loadPageApi();
  const keyboardDocument = fakeDocument();
  const keyboardBackend = window.SCMD.createFakeBackend(decisionFixture());
  const keyboard = await window.SCMD.boot({
    backend: keyboardBackend,
    document: keyboardDocument,
    window,
  });
  await keyboardDocument.dispatch('keydown', { key: 'ArrowRight' });
  await keyboardDocument.dispatch('keydown', { key: 'ArrowLeft' });

  const buttonDocument = fakeDocument();
  const buttonBackend = window.SCMD.createFakeBackend(decisionFixture());
  const buttons = await window.SCMD.boot({
    backend: buttonBackend,
    document: buttonDocument,
    window,
  });
  await buttonDocument.elements['action-keep'].dispatch('click');
  await buttonDocument.elements['action-delete'].dispatch('click');

  assert.deepEqual(
    JSON.parse(JSON.stringify(Array.from(keyboard.controller.decisions()))),
    JSON.parse(JSON.stringify(Array.from(buttons.controller.decisions()))),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(keyboard.controller.decisions()))), [
    { id: 'demo/a.md', action: 'keep', expectedHash: 'hash-a' },
    { id: 'demo/b.md', action: 'delete', expectedHash: 'hash-b' },
  ]);
  assert.equal(keyboardDocument.elements['card-name'].textContent, 'C');
  assert.equal(keyboardDocument.elements['decision-counts'].textContent, 'kept 1 · deleted 1');
  assert.equal(keyboardDocument.elements['apply-review'].disabled, false);
  assert.deepEqual(
    Array.from(keyboardBackend.calls, (call) => call.method),
    ['events', 'listProjects', 'instructions', 'read'],
  );
});

test('skip moves cards to the end and undo restores actions in reverse order', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend(decisionFixture());
  const loaded = await window.SCMD.boot({ backend, document, window });

  await document.elements['action-skip'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'B');
  await document.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(document.elements['card-name'].textContent, 'C');
  await document.elements['action-undo'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'B');

  await document.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(document.elements['card-name'].textContent, 'C');
  await document.elements['action-delete'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'D');
  await document.dispatch('keydown', { key: 'z' });
  assert.equal(document.elements['card-name'].textContent, 'C');
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [
    { id: 'demo/b.md', action: 'keep', expectedHash: 'hash-b' },
  ]);
  await document.dispatch('keydown', { key: 'z' });
  assert.equal(document.elements['card-name'].textContent, 'B');
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(document.elements['apply-review'].disabled, true);
});

test('decision shortcuts do not fire while the user is typing', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const loaded = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
  });

  await document.dispatch('keydown', {
    key: 'ArrowRight',
    target: document.elements['search-input'],
  });

  assert.equal(document.elements['card-name'].textContent, 'A');
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
});

test('horizontal pointer drag stages past the threshold and snaps back below it', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const loaded = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
  });
  const card = document.elements['memory-card'];

  await card.dispatch('pointerdown', {
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 200,
  });
  await card.dispatch('pointermove', { pointerId: 1, clientX: 120 });
  assert.match(card.style.transform, /translateX\(-80px\).*rotate\(-5deg\)/);
  assert.equal(card.dataset.intent, 'delete');
  await card.dispatch('pointerup', { pointerId: 1, clientX: 120 });

  assert.equal(card.style.transform, '');
  assert.equal(card.dataset.intent, undefined);
  assert.equal(document.elements['card-name'].textContent, 'A');
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);

  await card.dispatch('pointerdown', {
    pointerId: 2,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    clientX: 200,
  });
  await card.dispatch('pointermove', { pointerId: 2, clientX: 80 });
  assert.match(card.style.transform, /translateX\(-120px\).*rotate\(-6deg\)/);
  await card.dispatch('pointerup', { pointerId: 2, clientX: 80 });
  assert.equal(document.elements['card-name'].textContent, 'B');

  await card.dispatch('pointerdown', {
    pointerId: 3,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    clientX: 100,
  });
  await card.dispatch('pointerup', { pointerId: 3, clientX: 210 });
  assert.equal(document.elements['card-name'].textContent, 'C');
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [
    { id: 'demo/a.md', action: 'delete', expectedHash: 'hash-a' },
    { id: 'demo/b.md', action: 'keep', expectedHash: 'hash-b' },
  ]);
});

test('a pointer release cannot decide a different card after the deck advances', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const loaded = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
  });
  const card = document.elements['memory-card'];

  await card.dispatch('pointerdown', {
    pointerId: 11,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    clientX: 200,
  });
  await document.dispatch('keydown', { key: 'ArrowRight' });
  await card.dispatch('pointerup', { pointerId: 11, clientX: 20 });

  assert.equal(document.elements['card-name'].textContent, 'B');
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [
    { id: 'demo/a.md', action: 'keep', expectedHash: 'hash-a' },
  ]);
});

test('committed pointer motion continues from release before staging exactly once', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  const loaded = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    reducedMotion: false,
  });
  const card = document.elements['memory-card'];

  await card.dispatch('pointerdown', {
    pointerId: 21,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    clientX: 220,
  });
  await card.dispatch('pointermove', { pointerId: 21, clientX: 90 });
  assert.match(card.style.transform, /translateX\(-130px\).*rotate\(-6deg\)/);

  await card.dispatch('pointerup', { pointerId: 21, clientX: 90 });

  assert.equal(card.dataset.motion, 'pointer-exit-left');
  assert.equal(card.dataset.intent, 'delete');
  assert.match(card.style.transform, /-100vw/);
  assert.equal(document.elements['card-name'].textContent, 'A');
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.deepEqual(timers.delays(), [180]);

  await timers.runNext();

  assert.equal(document.elements['card-name'].textContent, 'B');
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [
    { id: 'demo/a.md', action: 'delete', expectedHash: 'hash-a' },
  ]);
  assert.equal(card.dataset.motion, undefined);
  assert.equal(timers.count(), 0);
});

test('keyboard and button decisions share motion and lock repeated input from the next card', async () => {
  const { window } = await loadPageApi();
  const keyboardDocument = fakeDocument();
  const keyboardTimers = fakeTimers();
  const keyboard = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document: keyboardDocument,
    window,
    schedule: keyboardTimers.schedule,
    cancelSchedule: keyboardTimers.cancel,
    reducedMotion: false,
  });

  await keyboardDocument.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(keyboardDocument.elements['memory-card'].dataset.motion, 'exit-right');
  assert.equal(keyboardDocument.elements['memory-card'].dataset.intent, 'keep');
  assert.equal(keyboardDocument.elements['card-name'].textContent, 'A');
  assert.deepEqual(Array.from(keyboard.controller.decisions()), []);
  assert.equal(keyboardDocument.elements['action-delete'].disabled, true);
  await keyboardDocument.dispatch('keydown', { key: 'ArrowLeft' });
  await keyboardDocument.elements['action-delete'].dispatch('click');
  await keyboardDocument.elements['memory-card'].dispatch('pointerdown', {
    pointerId: 22,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    clientX: 200,
  });
  assert.equal(keyboardTimers.count(), 1);
  await keyboardTimers.runNext();
  await keyboardDocument.elements['memory-card'].dispatch('pointerup', {
    pointerId: 22,
    clientX: 20,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(keyboard.controller.decisions()))), [
    { id: 'demo/a.md', action: 'keep', expectedHash: 'hash-a' },
  ]);
  assert.equal(keyboardDocument.elements['card-name'].textContent, 'B');
  await keyboardDocument.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(keyboardDocument.elements['memory-card'].dataset.motion, 'exit-left');
  assert.equal(keyboardDocument.elements['memory-card'].dataset.intent, 'delete');
  await keyboardTimers.runNext();
  assert.equal(keyboardDocument.elements['card-name'].textContent, 'C');

  const buttonDocument = fakeDocument();
  const buttonTimers = fakeTimers();
  const buttons = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document: buttonDocument,
    window,
    schedule: buttonTimers.schedule,
    cancelSchedule: buttonTimers.cancel,
    reducedMotion: false,
  });

  await buttonDocument.elements['action-keep'].dispatch('click');
  assert.equal(buttonDocument.elements['memory-card'].dataset.motion, 'exit-right');
  assert.equal(buttonDocument.elements['memory-card'].dataset.intent, 'keep');
  assert.deepEqual(buttonTimers.delays(), [220]);
  await buttonTimers.runNext();
  await buttonDocument.elements['action-delete'].dispatch('click');
  assert.equal(buttonDocument.elements['memory-card'].dataset.motion, 'exit-left');
  assert.equal(buttonDocument.elements['memory-card'].dataset.intent, 'delete');
  await buttonTimers.runNext();

  assert.deepEqual(
    JSON.parse(JSON.stringify(Array.from(buttons.controller.decisions()))),
    JSON.parse(JSON.stringify(Array.from(keyboard.controller.decisions()))),
  );
  assert.equal(buttonDocument.elements['card-name'].textContent, 'C');
});

test('button-triggered motion restores intentional focus with accessible fallbacks', async () => {
  const { window } = await loadPageApi();
  for (const controlId of ['action-delete', 'action-keep', 'action-skip']) {
    const document = fakeDocument();
    const timers = fakeTimers();
    await window.SCMD.boot({
      backend: window.SCMD.createFakeBackend(decisionFixture()),
      document,
      window,
      schedule: timers.schedule,
      cancelSchedule: timers.cancel,
      reducedMotion: false,
    });
    const control = document.elements[controlId];
    control.focus();

    await control.dispatch('click');
    assert.equal(document.activeElement, null);
    await timers.runNext();

    assert.equal(document.activeElement, control, controlId);
  }

  const lastDocument = fakeDocument();
  const lastTimers = fakeTimers();
  const oneCard = decisionFixture();
  oneCard.projects[0].cards = oneCard.projects[0].cards.slice(0, 1);
  oneCard.projects[0].memoryCount = 1;
  await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(oneCard),
    document: lastDocument,
    window,
    schedule: lastTimers.schedule,
    cancelSchedule: lastTimers.cancel,
    reducedMotion: false,
  });
  lastDocument.elements['action-keep'].focus();
  await lastDocument.elements['action-keep'].dispatch('click');
  await lastTimers.runNext();
  assert.equal(lastDocument.elements['action-undo'].disabled, false);
  assert.equal(lastDocument.activeElement, lastDocument.elements['action-undo']);

  const undoDocument = fakeDocument();
  const undoTimers = fakeTimers();
  await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document: undoDocument,
    window,
    schedule: undoTimers.schedule,
    cancelSchedule: undoTimers.cancel,
    reducedMotion: false,
  });
  await undoDocument.dispatch('keydown', { key: 'ArrowRight' });
  await undoTimers.runNext();
  undoDocument.elements['action-undo'].focus();
  await undoDocument.elements['action-undo'].dispatch('click');
  assert.equal(undoDocument.activeElement, null);
  await undoTimers.runNext();
  assert.equal(undoDocument.elements['action-undo'].disabled, true);
  assert.equal(undoDocument.activeElement, undoDocument.elements['deck-stage']);
});

test('keyboard and pointer motion do not steal focus from unrelated controls', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    reducedMotion: false,
  });
  document.elements['deck-stage'].focus();

  await document.dispatch('keydown', { key: 'ArrowRight' });
  await timers.runNext();
  assert.equal(document.activeElement, document.elements['deck-stage']);

  const card = document.elements['memory-card'];
  await card.dispatch('pointerdown', {
    pointerId: 23,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    clientX: 200,
  });
  await card.dispatch('pointerup', { pointerId: 23, clientX: 80 });
  await timers.runNext();
  assert.equal(document.activeElement, document.elements['deck-stage']);
});

test('pointerup followed by lost capture schedules and commits exactly one decision', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  const loaded = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    reducedMotion: false,
  });
  const card = document.elements['memory-card'];

  await card.dispatch('pointerdown', {
    pointerId: 24,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    clientX: 200,
  });
  await card.dispatch('pointerup', { pointerId: 24, clientX: 70 });
  await card.dispatch('lostpointercapture', { pointerId: 24, clientX: 70 });

  assert.equal(timers.count(), 1);
  await timers.runNext();
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [
    { id: 'demo/a.md', action: 'delete', expectedHash: 'hash-a' },
  ]);
  assert.equal(document.elements['card-name'].textContent, 'B');
  assert.equal(timers.count(), 0);
});

test('beforeunload during an exit cancels motion without committing its decision', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  let beforeUnload;
  window.addEventListener = (type, listener) => {
    if (type === 'beforeunload') beforeUnload = listener;
  };
  const loaded = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    reducedMotion: false,
  });

  await document.elements['action-keep'].dispatch('click');
  assert.equal(timers.count(), 1);
  assert.equal(document.elements['memory-card'].dataset.motion, 'exit-right');
  assert.equal(document.elements['memory-card']['aria-busy'], 'true');

  beforeUnload();

  assert.equal(timers.count(), 0);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(document.elements['memory-card'].dataset.motion, undefined);
  assert.equal(document.elements['memory-card']['aria-busy'], undefined);
  assert.equal(document.elements['card-name'].textContent, 'A');
});

test('short and cancelled drags return to rest without staging a decision', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  const loaded = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    reducedMotion: false,
  });
  const card = document.elements['memory-card'];

  await card.dispatch('pointerdown', {
    pointerId: 31,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    clientX: 200,
  });
  await card.dispatch('pointermove', { pointerId: 31, clientX: 140 });
  await card.dispatch('pointerup', { pointerId: 31, clientX: 140 });

  assert.equal(card.dataset.motion, 'snapback');
  assert.equal(card.dataset.intent, undefined);
  assert.equal(card.style.transform, '');
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.deepEqual(timers.delays(), [180]);
  await timers.runNext();

  await card.dispatch('pointerdown', {
    pointerId: 32,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 200,
  });
  await card.dispatch('pointermove', { pointerId: 32, clientX: 80 });
  await card.dispatch('pointercancel', { pointerId: 32, clientX: 80 });
  assert.equal(card.dataset.motion, 'snapback');
  assert.equal(card.dataset.intent, undefined);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  await timers.runNext();
  assert.equal(card.dataset.motion, undefined);
  assert.equal(document.elements['card-name'].textContent, 'A');
});

test('skip exits upward before moving once to the end of the deck', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  const loaded = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    reducedMotion: false,
  });

  await document.dispatch('keydown', { key: 'ArrowUp' });

  assert.equal(document.elements['memory-card'].dataset.motion, 'exit-up');
  assert.equal(document.elements['memory-card'].dataset.intent, undefined);
  assert.equal(document.elements['card-name'].textContent, 'A');
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.deepEqual(timers.delays(), [180]);
  await timers.runNext();

  assert.equal(document.elements['card-name'].textContent, 'B');
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  await document.elements['action-undo'].dispatch('click');
  assert.equal(document.elements['memory-card'].dataset.motion, 'reenter-up');
  assert.equal(document.elements['memory-card'].dataset.intent, undefined);
  assert.equal(document.elements['card-name'].textContent, 'A');
});

test('undo re-enters from the prior delete, keep, or skip direction without a stamp', async () => {
  const { window } = await loadPageApi();
  const cases = [
    { control: 'action-delete', exit: 'exit-left', reentry: 'reenter-left' },
    { control: 'action-keep', exit: 'exit-right', reentry: 'reenter-right' },
    { control: 'action-skip', exit: 'exit-up', reentry: 'reenter-up' },
  ];

  for (const motionCase of cases) {
    const document = fakeDocument();
    const timers = fakeTimers();
    const loaded = await window.SCMD.boot({
      backend: window.SCMD.createFakeBackend(decisionFixture()),
      document,
      window,
      schedule: timers.schedule,
      cancelSchedule: timers.cancel,
      reducedMotion: false,
    });

    await document.elements[motionCase.control].dispatch('click');
    assert.equal(document.elements['memory-card'].dataset.motion, motionCase.exit);
    await timers.runNext();
    assert.equal(document.elements['card-name'].textContent, 'B');

    await document.elements['action-undo'].dispatch('click');
    assert.equal(document.elements['card-name'].textContent, 'A');
    assert.equal(document.elements['memory-card'].dataset.motion, motionCase.reentry);
    assert.equal(document.elements['memory-card'].dataset.intent, undefined);
    assert.equal(document.elements['action-keep'].disabled, true);
    assert.deepEqual(Array.from(loaded.controller.decisions()), []);
    assert.deepEqual(timers.delays(), [180]);
    await document.dispatch('keydown', { key: 'ArrowRight' });
    await timers.runNext();
    assert.equal(document.elements['memory-card'].dataset.motion, undefined);
    assert.equal(document.elements['card-name'].textContent, 'A');
    assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  }
});

test('a live refresh cannot let an outgoing motion commit a stale card', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  const changed = liveCard('demo/a.md', {
    name: 'A refreshed during motion',
    hash: 'hash-a-refreshed',
  });
  const live = makeLiveBackend(window, {
    seed: decisionFixture(),
    eventCards: { [changed.id]: changed },
  });
  const loaded = await window.SCMD.boot({
    backend: live.backend,
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    reducedMotion: false,
  });

  document.elements['action-keep'].focus();
  await document.elements['action-keep'].dispatch('click');
  assert.equal(document.elements['memory-card'].dataset.motion, 'exit-right');
  assert.equal(document.activeElement, null);
  await live.emit({ type: 'changed', id: changed.id });
  await settleEvents();

  assert.equal(document.elements['card-name'].textContent, 'B');
  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card)
      .find((card) => card.id === changed.id).name,
    'A refreshed during motion',
  );
  assert.equal(document.elements['memory-card'].dataset.motion, undefined);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(timers.delays().includes(220), false);
  assert.equal(document.activeElement, document.elements['action-keep']);
});

test('promoting a live addition during outgoing motion cancels the stale action and unlocks scope controls', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  const added = liveCard('demo/promoted.md', {
    name: 'Promoted during motion',
    hash: 'hash-promoted-during-motion',
  });
  const live = makeLiveBackend(window, {
    seed: decisionFixture(),
    eventCards: { [added.id]: added },
  });
  const loaded = await window.SCMD.boot({
    backend: live.backend,
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    reducedMotion: false,
  });

  document.elements['action-keep'].focus();
  await document.elements['action-keep'].dispatch('click');
  assert.equal(document.elements['memory-card'].dataset.motion, 'exit-right');
  assert.equal(document.activeElement, null);
  await live.emit({ type: 'added', id: added.id });
  await settleEvents();
  await noticeButton(document, 'Add to deck').dispatch('click');

  assert.equal(document.elements['card-name'].textContent, 'Promoted during motion');
  assert.equal(document.elements['memory-card'].dataset.motion, undefined);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(timers.delays().includes(220), false);
  assert.equal(document.elements['search-input'].disabled, false);
  assert.equal(document.elements['scope-unreviewed'].disabled, false);
  assert.equal(document.elements['scope-everything'].disabled, false);
  assert.equal(document.activeElement, document.elements['action-keep']);
  assert.equal(
    document.elements['project-chips'].children.some((chip) => chip.disabled),
    false,
  );
  assert.equal(
    document.elements['type-chips'].children.some((chip) => chip.disabled),
    false,
  );
});

test('reduced motion updates decisions and undo immediately without timers or motion styles', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  const loaded = await window.SCMD.boot({
    backend: window.SCMD.createFakeBackend(decisionFixture()),
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
    reducedMotion: true,
  });

  await document.elements['action-keep'].dispatch('click');

  assert.equal(document.elements['card-name'].textContent, 'B');
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [
    { id: 'demo/a.md', action: 'keep', expectedHash: 'hash-a' },
  ]);
  assert.equal(document.elements['memory-card'].dataset.motion, undefined);
  assert.equal(document.elements['memory-card'].dataset.intent, undefined);
  assert.equal(document.elements['memory-card'].style.transform, '');
  assert.equal(timers.count(), 0);

  await document.elements['action-undo'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'A');
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(document.elements['memory-card'].dataset.motion, undefined);
  assert.equal(timers.count(), 0);
});

test('apply summary requires confirmation and reports every batched outcome', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend({
    ...decisionFixture(),
    applyResults: [
      { id: 'demo/a.md', action: 'keep', status: 'applied' },
      { id: 'demo/b.md', action: 'delete', status: 'skipped', reason: 'changed-since-read' },
      { id: 'demo/c.md', action: 'edit', status: 'applied' },
    ],
  });
  const loaded = await window.SCMD.boot({ backend, document, window });
  await document.elements['action-keep'].dispatch('click');
  await document.elements['action-delete'].dispatch('click');
  loaded.controller.stageEdit('demo/c.md', '# C edited\n');

  await document.elements['apply-review'].dispatch('click');

  assert.equal(document.elements['deck-stage'].hidden, true);
  assert.equal(document.elements['apply-panel'].hidden, false);
  assert.equal(
    document.elements['apply-summary-counts'].textContent,
    '1 kept · 1 deleted · 1 edited',
  );
  assert.deepEqual(
    document.elements['apply-delete-list'].children.map((item) => item.textContent),
    ['B · demo'],
  );
  assert.deepEqual(
    document.elements['apply-edit-list'].children.map((item) => item.textContent),
    ['C · demo'],
  );
  assert.equal(backend.calls.some((call) => call.method === 'write'), false);
  await document.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(Array.from(loaded.controller.decisions()).length, 3);
  assert.equal(document.elements['scope-everything'].disabled, true);

  await document.elements['apply-cancel'].dispatch('click');
  assert.equal(document.elements['deck-stage'].hidden, false);
  assert.equal(document.elements['apply-panel'].hidden, true);
  assert.equal(backend.calls.some((call) => call.method === 'write'), false);
  await document.elements['apply-review'].dispatch('click');
  await document.elements['apply-confirm'].dispatch('click');

  const writeCalls = backend.calls.filter((call) => call.method === 'write');
  assert.equal(writeCalls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writeCalls[0].decisions)), [
    { id: 'demo/a.md', action: 'keep', expectedHash: 'hash-a' },
    { id: 'demo/b.md', action: 'delete', expectedHash: 'hash-b' },
    {
      id: 'demo/c.md',
      action: 'edit',
      expectedHash: 'hash-c',
      newContent: '# C edited\n',
    },
  ]);
  assert.equal(document.elements['apply-panel'].hidden, true);
  assert.equal(document.elements['apply-results'].hidden, false);
  assert.deepEqual(
    document.elements['apply-result-list'].children.map((item) => item.textContent),
    [
      'A · demo · keep · applied',
      'B · demo · delete · changed since you saw it',
      'C · demo · edit · applied',
    ],
  );
  await document.dispatch('keydown', { key: 'ArrowLeft' });
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(document.activeElement, document.elements['result-back']);
  await document.elements['result-back'].dispatch('click');
  assert.equal(document.activeElement, document.elements['deck-stage']);
  assert.equal(document.elements['deck-stage'].hidden, false);
});

test('apply freezes the reviewed batch while confirmation is in flight', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(decisionFixture());
  const batchWrite = fake.write;
  let releaseWrite;
  const backend = {
    ...fake,
    write(decisions) {
      return new Promise((resolve) => {
        releaseWrite = () => resolve(batchWrite(decisions));
      });
    },
  };
  const loaded = await window.SCMD.boot({ backend, document, window });
  await document.elements['action-keep'].dispatch('click');
  await document.elements['apply-review'].dispatch('click');
  const applying = document.elements['apply-confirm'].dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  await document.dispatch('keydown', { key: 'ArrowLeft' });
  await document.elements['action-delete'].dispatch('click');
  assert.equal(Array.from(loaded.controller.decisions()).length, 1);
  assert.equal(document.elements['apply-confirm'].disabled, true);
  assert.equal(document.elements['scope-unreviewed'].disabled, true);

  releaseWrite();
  await applying;
  const batch = fake.calls.find((call) => call.method === 'write').decisions;
  assert.deepEqual(JSON.parse(JSON.stringify(batch)), [
    { id: 'demo/a.md', action: 'keep', expectedHash: 'hash-a' },
  ]);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(document.elements['apply-results'].hidden, false);
});

test('post-apply reload cannot resurrect a memory removed while its snapshot was pending', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  const baseWrite = live.backend.write.bind(live.backend);
  const staleSnapshot = liveFixture();
  const latestSnapshot = liveFixture();
  latestSnapshot.projects[0].cards = latestSnapshot.projects[0].cards.filter(
    (card) => card.id !== 'demo/a.md',
  );
  latestSnapshot.projects[0].memoryCount = 1;
  const pendingReload = deferredValue();
  let applying = false;
  let reloadReads = 0;
  live.backend.write = async (decisions) => {
    const result = await baseWrite(decisions);
    applying = true;
    return result;
  };
  live.backend.listProjects = async (options) => {
    if (!applying) return initialListProjects(options);
    reloadReads += 1;
    return reloadReads === 1
      ? pendingReload.promise
      : JSON.parse(JSON.stringify(latestSnapshot));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  await document.elements['action-keep'].dispatch('click');
  await document.elements['apply-review'].dispatch('click');

  const confirming = document.elements['apply-confirm'].dispatch('click');
  await settleEvents();
  await live.emit({ type: 'removed', id: 'demo/a.md' });
  pendingReload.resolve(JSON.parse(JSON.stringify(staleSnapshot)));
  await confirming;
  await settleEvents();

  assert.equal(reloadReads, 2);
  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id).includes('demo/a.md'),
    false,
  );
});

test('post-apply reload cannot overwrite a concurrent authoritative changed event', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const changed = liveCard('demo/a.md', {
    name: 'Changed during apply reload',
    hash: 'hash-after-apply-event',
    date: '2026-01-01T00:00:00.000Z',
  });
  const live = makeLiveBackend(window, { eventCards: { [changed.id]: changed } });
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  const baseWrite = live.backend.write.bind(live.backend);
  const staleSnapshot = liveFixture();
  const latestSnapshot = liveFixture();
  latestSnapshot.projects[0].cards[0] = changed;
  const pendingReload = deferredValue();
  let applying = false;
  let reloadReads = 0;
  live.backend.write = async (decisions) => {
    const result = await baseWrite(decisions);
    applying = true;
    return result;
  };
  live.backend.listProjects = async (options) => {
    if (!applying) return initialListProjects(options);
    reloadReads += 1;
    return reloadReads === 1
      ? pendingReload.promise
      : JSON.parse(JSON.stringify(latestSnapshot));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  await document.elements['action-keep'].dispatch('click');
  await document.elements['apply-review'].dispatch('click');

  const confirming = document.elements['apply-confirm'].dispatch('click');
  await settleEvents();
  await live.emit({ type: 'changed', id: changed.id });
  pendingReload.resolve(JSON.parse(JSON.stringify(staleSnapshot)));
  await confirming;
  await settleEvents();

  const card = Array.from(loaded.controller.visibleCards(), ({ card: entry }) => entry)
    .find((entry) => entry.id === changed.id);
  assert.equal(reloadReads, 2);
  assert.equal(card.name, 'Changed during apply reload');
  assert.equal(card.hash, 'hash-after-apply-event');
});

test('fixture apply reports changed-since-read and refreshes that card for review', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'scmd-page-apply-'));
  const root = join(sandbox, 'projects');
  await cp(FIXTURE_ROOT, root, { recursive: true });
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const server = await startServer(t, {
    serverArgs: ['--root', root, '--port', '0', '--no-open'],
  });
  const fetchImpl = (pathname, options = {}) => fetch(new URL(pathname, server.url), options);
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({ token: server.token, fetchImpl });
  backend.events = () => () => {};
  const document = fakeDocument();
  const loaded = await window.SCMD.boot({ backend, document, window });
  const [keptEntry, changedEntry] = Array.from(loaded.controller.visibleCards());
  const originalChangedHash = changedEntry.card.hash;

  await document.elements['action-keep'].dispatch('click');
  await document.elements['action-delete'].dispatch('click');
  await writeFile(
    join(root, changedEntry.card.projectId, 'memory', changedEntry.card.fileName),
    '# Changed outside SCMD\n',
  );
  await document.elements['apply-review'].dispatch('click');
  await document.elements['apply-confirm'].dispatch('click');

  assert.match(
    document.elements['apply-result-list'].children[0].textContent,
    new RegExp(`${keptEntry.card.name} .* keep .* applied`),
  );
  assert.match(
    document.elements['apply-result-list'].children[1].textContent,
    /delete · changed since you saw it$/,
  );
  await document.elements['result-back'].dispatch('click');
  const refreshed = Array.from(loaded.controller.visibleCards(), ({ card }) => card)
    .find((card) => card.id === changedEntry.card.id);
  assert.ok(refreshed);
  assert.notEqual(refreshed.hash, originalChangedHash);
});

test('trash view lists run sizes, restores items, and requires a second purge click', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend({
    ...decisionFixture(),
    trash: {
      notices: [],
      runs: [{
        id: 'run-1',
        deletedAt: '2026-09-20T12:00:00.000Z',
        size: 1536,
        status: 'ready',
        items: [{
          id: 'demo/a.md',
          projectId: 'demo',
          fileName: 'a.md',
          name: 'A',
          summary: 'A',
          deletedAt: '2026-09-20T12:00:00.000Z',
          status: 'deleted',
          restorable: true,
        }],
      }],
    },
  });
  await window.SCMD.boot({ backend, document, window });

  await document.elements['trash-open'].dispatch('click');

  assert.equal(document.elements['deck-stage'].hidden, true);
  assert.equal(document.elements['trash-panel'].hidden, false);
  assert.equal(document.elements['trash-runs'].children.length, 1);
  const run = document.elements['trash-runs'].children[0];
  assert.equal(run.children[1].textContent, '1.5 KB');
  const item = run.children[2].children[0];
  assert.match(item.children[0].textContent, /A · demo\/a\.md/);
  await item.children[1].dispatch('click');
  assert.deepEqual(
    JSON.parse(JSON.stringify(backend.calls.find((call) => call.restore)?.restore)),
    { runId: 'run-1', id: 'demo/a.md' },
  );

  const restoredRun = document.elements['trash-runs'].children[0];
  assert.equal(restoredRun.children[2].children[0].children[1].textContent, 'restored');
  const purgeButton = restoredRun.children[3].children[0];
  assert.equal(document.activeElement, purgeButton);
  await purgeButton.dispatch('click');
  assert.equal(purgeButton.textContent, 'Confirm purge');
  assert.equal(backend.calls.some((call) => call.trashRunId), false);
  await purgeButton.dispatch('click');
  assert.equal(backend.calls.some((call) => call.trashRunId === 'run-1'), true);
  assert.equal(document.elements['trash-runs'].children[0].textContent, 'Trash is empty.');
  assert.equal(document.activeElement, document.elements['trash-title']);
});

test('trash mutation disables every action and blocks Back and Escape until it settles', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend({
    ...decisionFixture(),
    trash: {
      runs: [{
        id: 'run-1',
        deletedAt: '2026-09-20T12:00:00.000Z',
        size: 2048,
        status: 'ready',
        items: [
          { id: 'demo/a.md', name: 'A', status: 'deleted', restorable: true },
          { id: 'demo/b.md', name: 'B', status: 'deleted', restorable: true },
        ],
      }],
    },
  });
  const restore = fake.write;
  let releaseRestore;
  const backend = {
    ...fake,
    write(request) {
      return new Promise((resolve) => {
        releaseRestore = () => resolve(restore(request));
      });
    },
  };
  await window.SCMD.boot({ backend, document, window });
  await document.elements['trash-open'].dispatch('click');

  const run = document.elements['trash-runs'].children[0];
  const restoring = run.children[2].children[0].children[1].dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  const busyRun = document.elements['trash-runs'].children[0];
  const siblingRestore = busyRun.children[2].children[1].children[1];
  const purge = busyRun.children[3].children[0];

  assert.equal(siblingRestore.disabled, true);
  assert.equal(purge.disabled, true);
  assert.equal(document.elements['trash-back'].disabled, true);
  await siblingRestore.dispatch('click');
  await purge.dispatch('click');
  await document.dispatch('keydown', { key: 'Escape' });
  assert.equal(document.elements['trash-panel'].hidden, false);
  assert.equal(fake.calls.filter((call) => call.restore).length, 0);

  releaseRestore();
  await restoring;
  assert.equal(document.elements['trash-back'].disabled, false);
});

test('trash restore reports request failures, unlocks controls, and restores focus', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend({
    ...decisionFixture(),
    trash: {
      runs: [{
        id: 'run-1',
        status: 'ready',
        items: [{ id: 'demo/a.md', name: 'A', status: 'deleted', restorable: true }],
      }],
    },
  });
  const backend = {
    ...fake,
    async write() {
      throw new Error('server offline');
    },
  };
  await window.SCMD.boot({ backend, document, window });
  await document.elements['trash-open'].dispatch('click');
  const restore = document.elements['trash-runs'].children[0].children[2].children[0].children[1];

  await assert.doesNotReject(() => restore.dispatch('click'));

  assert.match(document.elements['trash-notices'].children[0].textContent, /Restore failed: server offline/);
  const retry = document.elements['trash-runs'].children[0].children[2].children[0].children[1];
  assert.equal(retry.disabled, false);
  assert.equal(document.elements['trash-back'].disabled, false);
  assert.equal(document.activeElement, retry);
});

test('trash purge reports request failures and returns focus to the run', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend({
    ...decisionFixture(),
    trash: {
      runs: [{ id: 'run-1', status: 'ready', size: 10, items: [] }],
    },
  });
  const backend = {
    ...fake,
    async remove() {
      throw new Error('permission denied');
    },
  };
  await window.SCMD.boot({ backend, document, window });
  await document.elements['trash-open'].dispatch('click');
  const purge = document.elements['trash-runs'].children[0].children[3].children[0];
  await purge.dispatch('click');

  await assert.doesNotReject(() => purge.dispatch('click'));

  assert.match(document.elements['trash-notices'].children[0].textContent, /Purge failed: permission denied/);
  const retry = document.elements['trash-runs'].children[0].children[3].children[0];
  assert.equal(retry.disabled, false);
  assert.equal(retry.textContent, 'Purge run');
  assert.equal(document.activeElement, retry);
});

test('a stale trash load cannot replace a newer trash view', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const fake = window.SCMD.createFakeBackend(decisionFixture());
  const pendingReads = [];
  const backend = {
    ...fake,
    read(request) {
      if (request?.trash === true) {
        return new Promise((resolve) => pendingReads.push(resolve));
      }
      return fake.read(request);
    },
  };
  await window.SCMD.boot({ backend, document, window });

  const firstOpen = document.elements['trash-open'].dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  await document.dispatch('keydown', { key: 'Escape' });
  const secondOpen = document.elements['trash-open'].dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pendingReads.length, 2);

  pendingReads[1]({
    runs: [{ id: 'new-run', status: 'ready', size: 2, items: [] }],
  });
  await secondOpen;
  pendingReads[0]({
    runs: [{ id: 'old-run', status: 'ready', size: 1, items: [] }],
  });
  await firstOpen;

  assert.equal(document.elements['trash-panel'].hidden, false);
  assert.equal(document.elements['trash-runs'].children[0].children[1].textContent, '2 B');
});

test('restoring from the page round-trips fixture memory and index bytes', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'scmd-page-restore-'));
  const root = join(sandbox, 'projects');
  const stateDir = join(sandbox, 'state');
  await cp(FIXTURE_ROOT, root, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const server = await startServer(t, {
    serverArgs: [
      '--root', root,
      '--state-dir', stateDir,
      '--port', '0',
      '--no-open',
    ],
  });
  const fetchImpl = (pathname, options = {}) => fetch(new URL(pathname, server.url), options);
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({ token: server.token, fetchImpl });
  backend.events = () => () => {};
  const all = await backend.listProjects({ includeReviewed: true });
  const project = all.projects.find((candidate) => candidate.id === '-Users-example-my-side-project');
  const card = project.cards.find((candidate) => candidate.fileName === 'project_context.md');
  const memoryPath = join(root, project.id, 'memory', card.fileName);
  const indexPath = join(root, project.id, 'memory', 'MEMORY.md');
  const [memoryBefore, indexBefore] = await Promise.all([
    readFile(memoryPath),
    readFile(indexPath),
  ]);
  await backend.remove(card.id, { expectedHash: card.hash });
  const document = fakeDocument();
  await window.SCMD.boot({ backend, document, window });

  await document.elements['trash-open'].dispatch('click');
  const run = document.elements['trash-runs'].children[0];
  const restoreItem = run.children[2].children.find((entry) => (
    entry.children[0].textContent.includes('project_context.md')
  ));
  await restoreItem.children[1].dispatch('click');

  assert.deepEqual(await readFile(memoryPath), memoryBefore);
  assert.deepEqual(await readFile(indexPath), indexBefore);
});

test('booting with a fake backend renders project counts and notices without mutating', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const backend = window.SCMD.createFakeBackend({
    projects: [
      { id: 'api', name: 'api-server', memoryCount: 1, cards: [] },
      { id: 'docs', name: 'docs', memoryCount: 0, cards: [] },
      { id: 'side', name: 'my-side-project', memoryCount: 2, cards: [] },
      { id: 'web', name: 'web-client', memoryCount: 2, cards: [] },
    ],
    notices: ['One fixture notice.'],
  });

  await window.SCMD.boot({ backend, document, window });

  assert.deepEqual(
    document.elements['project-chips'].children.map((child) => child.textContent),
    ['all · 5', 'api-server · 1', 'docs · 0', 'my-side-project · 2', 'web-client · 2'],
  );
  assert.equal(document.elements['project-chips'].children[2].className, 'chip on');
  assert.equal(document.elements['progress-label'].textContent, '0 of 0');
  assert.equal(document.elements.notices.children[0].textContent, 'One fixture notice.');
  assert.deepEqual(
    Array.from(backend.calls, (call) => call.method),
    ['events', 'listProjects', 'instructions', 'read'],
  );
  assert.equal(backend.calls[1].options.includeReviewed, true);
  assert.equal(backend.calls[3].status, true);
  assert.equal(document.elements['fatal-error'].hidden, true);
});

test('missing launch token renders a safe error without making a request', async () => {
  const document = fakeDocument();
  let requests = 0;
  const { window } = await loadPageApi({
    autoBoot: true,
    document,
    href: 'http://127.0.0.1:43210/',
    fetchImpl() {
      requests += 1;
      throw new Error('must not run');
    },
  });

  await window.__scmdReady;
  assert.equal(requests, 0);
  assert.equal(document.elements['fatal-error'].hidden, false);
  assert.match(document.elements['fatal-error'].textContent, /missing its launch token/i);
});

test('real fixture data is rendered into project chips with authoritative counts', async (t) => {
  const server = await startServer(t);
  const fetchImpl = (pathname, options = {}) => fetch(new URL(pathname, server.url), options);
  const { window } = await loadPageApi({ fetchImpl });
  const backend = window.SCMD.createHttpBackend({ token: server.token, fetchImpl });
  backend.events = () => () => {};
  const document = fakeDocument();

  await window.SCMD.boot({ backend, document, window });

  assert.deepEqual(
    document.elements['project-chips'].children.map((child) => child.textContent),
    [
      'all · 5',
      '-Users-example-api-server · 1',
      '-Users-example-docs · 0',
      'my-side-project · 2',
      '-Users-example-web-client · 2',
    ],
  );
});

function liveCard(id, overrides = {}) {
  const fileName = id.slice(id.indexOf('/') + 1);
  return {
    id,
    projectId: id.slice(0, id.indexOf('/')),
    fileName,
    name: fileName.replace(/\.md$/i, ''),
    summary: 'Live memory summary.',
    type: 'project',
    date: '2026-09-20T12:00:00.000Z',
    body: 'Live memory body.\n',
    content: 'Live memory body.\n',
    hash: `hash-${fileName}`,
    ...overrides,
  };
}

function liveFixture() {
  return {
    projects: [
      {
        id: 'demo',
        name: 'demo',
        path: '/example/demo',
        pathUnknown: false,
        memoryCount: 2,
        cards: [
          liveCard('demo/a.md', {
            name: 'A',
            summary: 'baseline-only',
            body: 'Original A body.\n',
            content: 'Original A body.\n',
            hash: 'hash-a',
            date: '2026-01-01T00:00:00.000Z',
          }),
          liveCard('demo/b.md', {
            name: 'B',
            hash: 'hash-b',
            date: '2026-02-01T00:00:00.000Z',
          }),
        ],
      },
      {
        id: 'other',
        name: 'other',
        path: '/example/other',
        pathUnknown: false,
        memoryCount: 1,
        cards: [liveCard('other/existing.md', { name: 'Other existing' })],
      },
    ],
  };
}

function deferredValue() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flattenText(element) {
  return [
    element?.textContent || '',
    ...(element?.children || []).map(flattenText),
  ].join(' ');
}

function descendants(element) {
  const children = element?.children || [];
  return children.flatMap((child) => [child, ...descendants(child)]);
}

function noticeButton(document, label) {
  return descendants(document.elements.notices).find((element) => (
    element.tagName === 'BUTTON' && element.textContent === label
  ));
}

async function settleEvents() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    schedule(callback, delay) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, { callback, delay });
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
    count() {
      return callbacks.size;
    },
    delays() {
      return [...callbacks.values()].map(({ delay }) => delay);
    },
    async runNext() {
      const entry = callbacks.entries().next().value;
      assert.ok(entry, 'expected a scheduled timer');
      const [id, { callback }] = entry;
      callbacks.delete(id);
      await callback();
      await settleEvents();
    },
    async runAll() {
      while (callbacks.size > 0) await this.runNext();
    },
  };
}

function makeLiveBackend(window, {
  earlyEvents = [],
  eventCards = {},
  seed = liveFixture(),
} = {}) {
  const base = window.SCMD.createFakeBackend(seed);
  let listener;
  let stopCalls = 0;
  const backend = {
    ...base,
    events(onEvent) {
      base.calls.push({ method: 'events' });
      listener = onEvent;
      for (const event of earlyEvents) onEvent(event);
      return () => { stopCalls += 1; };
    },
    async read(request) {
      if (request && typeof request === 'object') return base.read(request);
      if (!Object.prototype.hasOwnProperty.call(eventCards, request)) return base.read(request);
      base.calls.push({ method: 'read', id: request });
      const configured = eventCards[request];
      const result = typeof configured === 'function' ? configured() : configured;
      return result && typeof result.then === 'function' ? result : { ...result };
    },
  };
  return {
    backend,
    emit(event) {
      assert.ok(listener, 'expected the page to subscribe to memory events');
      return listener(event);
    },
    stopCalls: () => stopCalls,
  };
}

test('boot buffers a memory event received before the deck controller exists', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const added = liveCard('demo/boot.md', { name: 'Arrived during boot' });
  const live = makeLiveBackend(window, {
    earlyEvents: [{ type: 'added', id: added.id }],
    eventCards: { [added.id]: added },
  });

  await window.SCMD.boot({ backend: live.backend, document, window });
  await settleEvents();

  assert.match(flattenText(document.elements.notices), /Arrived during boot/);
  assert.ok(noticeButton(document, 'Add to deck'));
  assert.ok(noticeButton(document, 'Later'));
});

test('an added memory in a selected project is named literally with the exact actions', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const literalName = '<img src=x onerror=alert(1)> literal memory';
  const added = liveCard('demo/literal.md', { name: literalName });
  const live = makeLiveBackend(window, { eventCards: { [added.id]: added } });
  await window.SCMD.boot({ backend: live.backend, document, window });

  live.emit({ type: 'added', id: added.id });
  await settleEvents();

  const notice = document.elements.notices.children[0];
  assert.ok(notice);
  assert.match(notice.className, /notice/);
  assert.ok(flattenText(notice).includes(literalName));
  assert.equal(descendants(notice).some((element) => element.tagName === 'IMG'), false);
  assert.deepEqual(
    descendants(notice)
      .filter((element) => element.tagName === 'BUTTON')
      .map((button) => button.textContent),
    ['Add to deck', 'Later'],
  );
});

test('Add to deck makes the new memory next even when active filters exclude it', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const added = liveCard('demo/new-feedback.md', {
    name: 'New filtered memory',
    summary: 'does not match the search',
    type: 'feedback',
  });
  const live = makeLiveBackend(window, { eventCards: { [added.id]: added } });
  await window.SCMD.boot({ backend: live.backend, document, window });
  document.elements['search-input'].value = 'baseline-only';
  await document.elements['search-input'].dispatch('input');
  assert.equal(document.elements['card-name'].textContent, 'A');

  live.emit({ type: 'added', id: added.id });
  await settleEvents();
  const addButton = noticeButton(document, 'Add to deck');
  assert.ok(addButton, 'expected an Add to deck action');
  await addButton.dispatch('click');

  assert.equal(document.elements['card-name'].textContent, 'New filtered memory');
  assert.equal(document.elements.notices.children.length, 0);
});

test('Later dismisses the notice for this session without writes or deck mutation', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const added = liveCard('demo/later.md', { name: 'Review another time' });
  const live = makeLiveBackend(window, { eventCards: { [added.id]: added } });
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  const before = Array.from(loaded.controller.visibleCards(), ({ card }) => card.id);

  live.emit({ type: 'added', id: added.id });
  await settleEvents();
  const laterButton = noticeButton(document, 'Later');
  assert.ok(laterButton, 'expected a Later action');
  await laterButton.dispatch('click');

  assert.equal(document.elements.notices.children.length, 0);
  assert.deepEqual(Array.from(loaded.controller.visibleCards(), ({ card }) => card.id), before);
  assert.equal(document.elements['card-name'].textContent, 'A');
  assert.equal(
    live.backend.calls.some((call) => ['write', 'remove'].includes(call.method)),
    false,
  );
});

test('a changed undecided top card reloads its content and hash with a just-updated notice', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const changed = liveCard('demo/a.md', {
    name: 'A reloaded',
    summary: 'New summary from disk.',
    body: 'New body from disk.\n',
    content: 'New body from disk.\n',
    hash: 'hash-a-new',
    date: '2026-01-01T00:00:00.000Z',
  });
  const live = makeLiveBackend(window, { eventCards: { [changed.id]: changed } });
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });

  live.emit({ type: 'changed', id: changed.id });
  await settleEvents();

  const card = Array.from(loaded.controller.visibleCards(), ({ card: entry }) => entry)
    .find((entry) => entry.id === changed.id);
  assert.equal(document.elements['card-name'].textContent, 'A reloaded');
  assert.equal(document.elements['card-summary'].textContent, 'New summary from disk.');
  assert.equal(document.elements['card-body'].textContent, 'New body from disk.\n');
  assert.equal(card.hash, 'hash-a-new');
  assert.match(flattenText(document.elements.notices), /just updated/i);
});

test('a changed event does not overwrite a card that already has a decision', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const changed = liveCard('demo/a.md', { name: 'Must not replace A', hash: 'hash-a-new' });
  const live = makeLiveBackend(window, { eventCards: { [changed.id]: changed } });
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  await document.elements['action-keep'].dispatch('click');

  live.emit({ type: 'changed', id: changed.id });
  await settleEvents();

  const original = Array.from(loaded.controller.visibleCards(), ({ card }) => card)
    .find((card) => card.id === changed.id);
  assert.equal(original.name, 'A');
  assert.equal(original.hash, 'hash-a');
  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [{
    id: 'demo/a.md',
    action: 'keep',
    expectedHash: 'hash-a',
  }]);
});

test('a removed memory drops its card, staged decision, and undo entry with a notice', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  await document.elements['action-keep'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'B');

  live.emit({ type: 'removed', id: 'demo/a.md' });
  await settleEvents();

  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id).includes('demo/a.md'),
    false,
  );
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(document.elements['action-undo'].disabled, true);
  await document.elements['action-undo'].dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'B');
  assert.match(flattenText(document.elements.notices), /removed/i);
});

test('removing the only reviewed decision exits the apply summary and disables stale confirm', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  await document.elements['action-keep'].dispatch('click');
  await document.elements['apply-review'].dispatch('click');
  const writesBefore = live.backend.calls.filter((call) => call.method === 'write').length;

  await live.emit({ type: 'removed', id: 'demo/a.md' });
  await settleEvents();

  assert.equal(document.elements['apply-panel'].hidden, true);
  assert.equal(document.elements['deck-stage'].hidden, false);
  assert.equal(document.elements['apply-confirm'].disabled, true);
  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.match(flattenText(document.elements.notices), /removed/i);
  await document.elements['apply-confirm'].dispatch('click');
  assert.equal(
    live.backend.calls.filter((call) => call.method === 'write').length,
    writesBefore,
  );
});

test('removing one reviewed decision refreshes the open summary and shows its notice', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  await window.SCMD.boot({ backend: live.backend, document, window });
  await document.elements['action-keep'].dispatch('click');
  await document.elements['action-delete'].dispatch('click');
  await document.elements['apply-review'].dispatch('click');

  await live.emit({ type: 'removed', id: 'demo/b.md' });
  await settleEvents();

  assert.equal(document.elements['apply-panel'].hidden, false);
  assert.equal(document.elements['deck-stage'].hidden, true);
  assert.equal(document.elements['apply-confirm'].disabled, false);
  assert.equal(document.elements['apply-summary-counts'].textContent, '1 kept · 0 deleted · 0 edited');
  assert.deepEqual(
    document.elements['apply-delete-list'].children.map((item) => item.textContent),
    ['None'],
  );
  assert.match(flattenText(document.elements['apply-notices']), /removed/i);

  await document.elements['apply-confirm'].dispatch('click');
  const write = live.backend.calls.find((call) => call.method === 'write');
  assert.deepEqual(JSON.parse(JSON.stringify(write.decisions)), [
    { id: 'demo/a.md', action: 'keep', expectedHash: 'hash-a' },
  ]);
});

test('a slow changed read cannot resurrect a card after its removed event', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const pending = deferredValue();
  const live = makeLiveBackend(window, {
    eventCards: { 'demo/a.md': () => pending.promise },
  });
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });

  const changing = live.emit({ type: 'changed', id: 'demo/a.md' });
  await settleEvents();
  const removing = live.emit({ type: 'removed', id: 'demo/a.md' });
  await settleEvents();
  pending.resolve(liveCard('demo/a.md', { name: 'Stale read', hash: 'stale-hash' }));
  await Promise.all([changing, removing]);
  await settleEvents();

  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id).includes('demo/a.md'),
    false,
  );
  assert.notEqual(document.elements['card-name'].textContent, 'Stale read');
  assert.match(flattenText(document.elements.notices), /removed/i);
});

test('quiet reviews and events for an unselected project show no update notice', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const unrelated = liveCard('other/new.md', { name: 'Unselected memory' });
  const live = makeLiveBackend(window, { eventCards: { [unrelated.id]: unrelated } });
  await window.SCMD.boot({ backend: live.backend, document, window });
  assert.equal(document.elements.notices.children.length, 0);
  const otherChip = document.elements['project-chips'].children.find(
    (button) => button.textContent.startsWith('other ·'),
  );
  await otherChip.dispatch('click');

  live.emit({ type: 'added', id: unrelated.id });
  await settleEvents();

  assert.equal(document.elements.notices.children.length, 0);
});

test('duplicate live events for one memory produce one notice', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const pending = deferredValue();
  const added = liveCard('demo/once.md', { name: 'Only once' });
  const live = makeLiveBackend(window, {
    eventCards: { [added.id]: () => pending.promise },
  });
  await window.SCMD.boot({ backend: live.backend, document, window });

  const first = live.emit({ type: 'added', id: added.id });
  const duplicate = live.emit({ type: 'added', id: added.id });
  await settleEvents();
  pending.resolve(added);
  await Promise.all([first, duplicate]);
  await settleEvents();

  assert.equal(document.elements.notices.children.length, 1);
});

test('a changed event refreshes an already-resolved pending added-memory notice', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const id = 'demo/revised-before-add.md';
  const versions = [
    liveCard(id, { name: 'Pending old version', hash: 'hash-old' }),
    liveCard(id, { name: 'Pending latest version', hash: 'hash-latest' }),
  ];
  const live = makeLiveBackend(window, {
    eventCards: { [id]: () => versions.shift() },
  });
  await window.SCMD.boot({ backend: live.backend, document, window });

  await live.emit({ type: 'added', id });
  await live.emit({ type: 'changed', id });
  await settleEvents();

  assert.equal(document.elements.notices.children.length, 1);
  assert.match(flattenText(document.elements.notices), /Pending latest version/);
  await noticeButton(document, 'Add to deck').dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'Pending latest version');
});

test('a changed event supersedes an overlapping added read with one latest notice', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const id = 'demo/changed-while-adding.md';
  const firstRead = deferredValue();
  let reads = 0;
  const latest = liveCard(id, { name: 'Latest overlapping version', hash: 'hash-latest' });
  const live = makeLiveBackend(window, {
    eventCards: {
      [id]: () => {
        reads += 1;
        return reads === 1 ? firstRead.promise : latest;
      },
    },
  });
  await window.SCMD.boot({ backend: live.backend, document, window });

  const adding = live.emit({ type: 'added', id });
  await settleEvents();
  const changing = live.emit({ type: 'changed', id });
  await changing;
  firstRead.resolve(liveCard(id, { name: 'Stale overlapping version', hash: 'hash-old' }));
  await adding;
  await settleEvents();

  assert.equal(reads, 2);
  assert.equal(document.elements.notices.children.length, 1);
  assert.match(flattenText(document.elements.notices), /Latest overlapping version/);
  await noticeButton(document, 'Add to deck').dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'Latest overlapping version');
});

test('deselecting a project during a changed read keeps the result quiet and unapplied', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const pending = deferredValue();
  const changed = liveCard('demo/a.md', {
    name: 'Must stay deferred',
    hash: 'hash-after-deselect',
  });
  const live = makeLiveBackend(window, {
    eventCards: { [changed.id]: () => pending.promise },
  });
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });

  const changing = live.emit({ type: 'changed', id: changed.id });
  await settleEvents();
  const demoChip = document.elements['project-chips'].children.find(
    (button) => button.textContent.startsWith('demo ·'),
  );
  await demoChip.dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'Other existing');

  pending.resolve(changed);
  await changing;
  await settleEvents();

  assert.equal(document.elements.notices.children.length, 0);
  const refreshedDemoChip = document.elements['project-chips'].children.find(
    (button) => button.textContent.startsWith('demo ·'),
  );
  await refreshedDemoChip.dispatch('click');
  const original = Array.from(loaded.controller.visibleCards(), ({ card }) => card)
    .find((card) => card.id === changed.id);
  assert.equal(original.name, 'A');
  assert.equal(original.hash, 'hash-a');
});

test('resync makes a change missed during disconnect visible without a notice', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  const refreshed = liveFixture();
  refreshed.projects[0].cards[0] = liveCard('demo/a.md', {
    name: 'Changed while disconnected',
    summary: 'Authoritative reconnect content.',
    body: 'Reloaded after reconnect.\n',
    content: 'Reloaded after reconnect.\n',
    hash: 'hash-after-reconnect',
    date: '2026-01-01T00:00:00.000Z',
  });
  let disconnected = false;
  live.backend.listProjects = async (options) => {
    if (!disconnected) return initialListProjects(options);
    live.backend.calls.push({ method: 'listProjects', options: { ...options } });
    return JSON.parse(JSON.stringify(refreshed));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  disconnected = true;

  await live.emit({ type: 'resync' });
  await settleEvents();

  const card = Array.from(loaded.controller.visibleCards(), ({ card: entry }) => entry)
    .find((entry) => entry.id === 'demo/a.md');
  assert.equal(card.name, 'Changed while disconnected');
  assert.equal(card.hash, 'hash-after-reconnect');
  assert.equal(document.elements['card-name'].textContent, 'Changed while disconnected');
  assert.equal(document.elements.notices.children.length, 0);
});

test('resync preserves filters and valid staged edits while dropping missing decisions', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  let resyncing = false;
  live.backend.listProjects = async (options) => {
    if (!resyncing) return initialListProjects(options);
    live.backend.calls.push({ method: 'listProjects', options: { ...options } });
    const refreshed = liveFixture();
    refreshed.projects[0].cards = refreshed.projects[0].cards.filter(
      (card) => card.id !== 'demo/a.md',
    );
    refreshed.projects[0].memoryCount = 1;
    return JSON.parse(JSON.stringify(refreshed));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  await document.elements['scope-everything'].dispatch('click');
  await document.elements['action-keep'].dispatch('click');
  const stagedContent = [
    '---',
    'name: B staged',
    'description: Staged summary survives resync.',
    'type: project',
    '---',
    'Staged body survives resync.',
    '',
  ].join('\n');
  assert.equal(loaded.controller.stageEdit('demo/b.md', stagedContent), true);
  const otherChip = document.elements['project-chips'].children.find(
    (button) => button.textContent.startsWith('other ·'),
  );
  await otherChip.dispatch('click');
  for (const chip of [...document.elements['type-chips'].children]) {
    if (chip.textContent !== 'project') await chip.dispatch('click');
  }
  document.elements['search-input'].value = 'survives resync';
  await document.elements['search-input'].dispatch('input');
  resyncing = true;

  await live.emit({ type: 'resync' });
  await settleEvents();

  assert.deepEqual(JSON.parse(JSON.stringify(Array.from(loaded.controller.decisions()))), [{
    id: 'demo/b.md',
    action: 'edit',
    expectedHash: 'hash-b',
    newContent: stagedContent,
  }]);
  assert.equal(document.elements['card-name'].textContent, 'B staged');
  assert.equal(document.elements['card-summary'].textContent, 'Staged summary survives resync.');
  assert.equal(document.elements['search-input'].value, 'survives resync');
  assert.equal(document.elements['scope-everything']['aria-pressed'], 'true');
  assert.equal(
    document.elements['project-chips'].children.find(
      (button) => button.textContent.startsWith('other ·'),
    )['aria-pressed'],
    'false',
  );
  assert.deepEqual(
    document.elements['type-chips'].children
      .filter((button) => button['aria-pressed'] === 'true')
      .map((button) => button.textContent),
    ['project'],
  );
  assert.equal(document.elements.notices.children.length, 0);
});

test('resync exits an apply summary whose only staged memory disappeared', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  let resyncing = false;
  live.backend.listProjects = async (options) => {
    if (!resyncing) return initialListProjects(options);
    const snapshot = liveFixture();
    snapshot.projects[0].cards = snapshot.projects[0].cards.filter(
      (card) => card.id !== 'demo/a.md',
    );
    snapshot.projects[0].memoryCount = 1;
    return JSON.parse(JSON.stringify(snapshot));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  await document.elements['action-keep'].dispatch('click');
  await document.elements['apply-review'].dispatch('click');
  resyncing = true;

  await live.emit({ type: 'resync' });
  await settleEvents();

  assert.deepEqual(Array.from(loaded.controller.decisions()), []);
  assert.equal(document.elements['apply-panel'].hidden, true);
  assert.equal(document.elements['deck-stage'].hidden, false);
  assert.equal(document.elements['apply-confirm'].disabled, true);
  assert.match(flattenText(document.elements.notices), /removed/i);
});

test('resync refreshes a partial apply summary and visibly reports its missing memory', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  let resyncing = false;
  live.backend.listProjects = async (options) => {
    if (!resyncing) return initialListProjects(options);
    const snapshot = liveFixture();
    snapshot.projects[0].cards = snapshot.projects[0].cards.filter(
      (card) => card.id !== 'demo/b.md',
    );
    snapshot.projects[0].memoryCount = 1;
    return JSON.parse(JSON.stringify(snapshot));
  };
  await window.SCMD.boot({ backend: live.backend, document, window });
  await document.elements['action-keep'].dispatch('click');
  await document.elements['action-delete'].dispatch('click');
  await document.elements['apply-review'].dispatch('click');
  resyncing = true;

  await live.emit({ type: 'resync' });
  await settleEvents();

  assert.equal(document.elements['apply-panel'].hidden, false);
  assert.equal(document.elements['deck-stage'].hidden, true);
  assert.equal(document.elements['apply-confirm'].disabled, false);
  assert.equal(document.elements['apply-summary-counts'].textContent, '1 kept · 0 deleted · 0 edited');
  assert.deepEqual(
    document.elements['apply-delete-list'].children.map((item) => item.textContent),
    ['None'],
  );
  assert.match(flattenText(document.elements['apply-notices']), /removed/i);

  await document.elements['apply-confirm'].dispatch('click');
  const write = live.backend.calls.find((call) => call.method === 'write');
  assert.deepEqual(JSON.parse(JSON.stringify(write.decisions)), [
    { id: 'demo/a.md', action: 'keep', expectedHash: 'hash-a' },
  ]);
});

test('a memory event during resync prevents the stale snapshot from resurrecting it', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  const staleSnapshot = liveFixture();
  const latestSnapshot = liveFixture();
  latestSnapshot.projects[0].cards = latestSnapshot.projects[0].cards.filter(
    (card) => card.id !== 'demo/a.md',
  );
  latestSnapshot.projects[0].memoryCount = 1;
  const pending = deferredValue();
  let resyncReads = 0;
  let resyncing = false;
  live.backend.listProjects = async (options) => {
    if (!resyncing) return initialListProjects(options);
    resyncReads += 1;
    live.backend.calls.push({ method: 'listProjects', options: { ...options } });
    return resyncReads === 1
      ? pending.promise
      : JSON.parse(JSON.stringify(latestSnapshot));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  resyncing = true;

  const syncing = live.emit({ type: 'resync' });
  await settleEvents();
  await live.emit({ type: 'removed', id: 'demo/a.md' });
  pending.resolve(JSON.parse(JSON.stringify(staleSnapshot)));
  await syncing;
  await settleEvents();

  assert.equal(resyncReads, 2);
  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id).includes('demo/a.md'),
    false,
  );
  assert.match(flattenText(document.elements.notices), /removed/i);
});

test('resync invalidates an added-memory notice whose card no longer exists', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const added = liveCard('demo/deleted-while-disconnected.md', {
    name: 'Gone before reconnect',
  });
  const live = makeLiveBackend(window, { eventCards: { [added.id]: added } });
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });

  await live.emit({ type: 'added', id: added.id });
  await settleEvents();
  const staleAddButton = noticeButton(document, 'Add to deck');
  const staleLaterButton = noticeButton(document, 'Later');
  assert.ok(staleAddButton);
  assert.ok(staleLaterButton);

  await live.emit({ type: 'resync' });
  await settleEvents();
  assert.equal(document.elements.notices.children.length, 0);

  await staleLaterButton.dispatch('click');
  await staleAddButton.dispatch('click');
  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id).includes(added.id),
    false,
  );
  assert.notEqual(document.elements['card-name'].textContent, 'Gone before reconnect');
  assert.equal(
    document.elements['project-chips'].children.find(
      (button) => button.textContent.startsWith('demo ·'),
    ).textContent,
    'demo · 2',
  );

  await live.emit({ type: 'added', id: added.id });
  await settleEvents();
  assert.ok(noticeButton(document, 'Add to deck'));
});

test('changed events arriving during a read coalesce into one trailing authoritative refresh', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const firstRead = deferredValue();
  const changedB = liveCard('demo/a.md', {
    name: 'Version B',
    hash: 'hash-b-version',
    date: '2026-01-01T00:00:00.000Z',
  });
  const changedC = liveCard('demo/a.md', {
    name: 'Version C',
    hash: 'hash-c-version',
    date: '2026-01-01T00:00:00.000Z',
  });
  let reads = 0;
  const live = makeLiveBackend(window, {
    eventCards: {
      [changedB.id]: () => {
        reads += 1;
        return reads === 1 ? firstRead.promise : changedC;
      },
    },
  });
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });

  const first = live.emit({ type: 'changed', id: changedB.id });
  await settleEvents();
  const trailing = live.emit({ type: 'changed', id: changedB.id });
  firstRead.resolve(changedB);
  await Promise.all([first, trailing]);
  await settleEvents();

  const card = Array.from(loaded.controller.visibleCards(), ({ card: entry }) => entry)
    .find((entry) => entry.id === changedB.id);
  assert.equal(reads, 2);
  assert.equal(card.name, 'Version C');
  assert.equal(card.hash, 'hash-c-version');
  assert.equal(document.elements['card-name'].textContent, 'Version C');
  assert.equal(document.elements.notices.children.length, 1);
});

test('a stale scope reload cannot resurrect a card removed while it was pending', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  const staleSnapshot = liveFixture();
  const latestSnapshot = liveFixture();
  latestSnapshot.projects[0].cards = latestSnapshot.projects[0].cards.filter(
    (card) => card.id !== 'demo/a.md',
  );
  latestSnapshot.projects[0].memoryCount = 1;
  const pending = deferredValue();
  let scopeReads = 0;
  let reloadingScope = false;
  live.backend.listProjects = async (options) => {
    if (!reloadingScope) return initialListProjects(options);
    scopeReads += 1;
    return scopeReads === 1
      ? pending.promise
      : JSON.parse(JSON.stringify(latestSnapshot));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  reloadingScope = true;

  const reloading = document.elements['scope-everything'].dispatch('click');
  await settleEvents();
  await live.emit({ type: 'removed', id: 'demo/a.md' });
  pending.resolve(JSON.parse(JSON.stringify(staleSnapshot)));
  await reloading;
  await settleEvents();

  assert.equal(scopeReads, 2);
  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id).includes('demo/a.md'),
    false,
  );
});

test('a resync supersedes a stale scope reload that started before it', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  const staleScopeSnapshot = liveFixture();
  staleScopeSnapshot.projects[0].cards[0] = liveCard('demo/a.md', {
    name: 'Stale scope version B',
    hash: 'hash-scope-b',
    date: '2026-01-01T00:00:00.000Z',
  });
  const resyncSnapshot = liveFixture();
  resyncSnapshot.projects[0].cards[0] = liveCard('demo/a.md', {
    name: 'Authoritative resync version C',
    hash: 'hash-resync-c',
    date: '2026-01-01T00:00:00.000Z',
  });
  const pendingScope = deferredValue();
  let reloading = false;
  let reloadReads = 0;
  live.backend.listProjects = async (options) => {
    if (!reloading) return initialListProjects(options);
    reloadReads += 1;
    return reloadReads === 1
      ? pendingScope.promise
      : JSON.parse(JSON.stringify(resyncSnapshot));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  reloading = true;

  const changingScope = document.elements['scope-everything'].dispatch('click');
  await settleEvents();
  await live.emit({ type: 'resync' });
  pendingScope.resolve(JSON.parse(JSON.stringify(staleScopeSnapshot)));
  await changingScope;
  await settleEvents();

  const card = Array.from(loaded.controller.visibleCards(), ({ card: entry }) => entry)
    .find((entry) => entry.id === 'demo/a.md');
  assert.equal(reloadReads, 2);
  assert.equal(card.name, 'Authoritative resync version C');
  assert.equal(card.hash, 'hash-resync-c');
});

test('a rejected scope reload stays quiet after a successful resync supersedes it', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  const pendingScope = deferredValue();
  const resyncSnapshot = liveFixture();
  resyncSnapshot.projects[0].cards[0] = liveCard('demo/a.md', {
    name: 'Resync survived rejected scope',
    hash: 'hash-resync-after-rejection',
    date: '2026-01-01T00:00:00.000Z',
  });
  let reloading = false;
  let reloadReads = 0;
  live.backend.listProjects = async (options) => {
    if (!reloading) return initialListProjects(options);
    reloadReads += 1;
    return reloadReads === 1
      ? pendingScope.promise
      : JSON.parse(JSON.stringify(resyncSnapshot));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  reloading = true;

  const changingScope = document.elements['scope-everything'].dispatch('click');
  await settleEvents();
  await live.emit({ type: 'resync' });
  pendingScope.reject(new Error('obsolete scope failure'));
  await changingScope;
  await settleEvents();

  const card = Array.from(loaded.controller.visibleCards(), ({ card: entry }) => entry)
    .find((entry) => entry.id === 'demo/a.md');
  assert.equal(card.name, 'Resync survived rejected scope');
  assert.equal(document.elements['fatal-error'].hidden, true);
  assert.equal(document.elements['fatal-error'].textContent, '');
});

test('resync refreshes a pending added notice before its Add action can insert the card', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const oldCard = liveCard('demo/pending.md', {
    name: 'Pending version B',
    body: 'Version B body.\n',
    content: 'Version B body.\n',
    hash: 'hash-pending-b',
  });
  const latestCard = liveCard(oldCard.id, {
    name: 'Pending version C',
    body: 'Version C body.\n',
    content: 'Version C body.\n',
    hash: 'hash-pending-c',
  });
  const live = makeLiveBackend(window, { eventCards: { [oldCard.id]: oldCard } });
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  let resyncing = false;
  live.backend.listProjects = async (options) => {
    if (!resyncing) return initialListProjects(options);
    const snapshot = liveFixture();
    snapshot.projects[0].cards.push(latestCard);
    snapshot.projects[0].memoryCount += 1;
    return JSON.parse(JSON.stringify(snapshot));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });

  await live.emit({ type: 'added', id: oldCard.id });
  await settleEvents();
  const staleAdd = noticeButton(document, 'Add to deck');
  resyncing = true;
  await live.emit({ type: 'resync' });
  await settleEvents();

  assert.match(flattenText(document.elements.notices), /Pending version C/);
  await staleAdd.dispatch('click');
  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id).includes(oldCard.id),
    false,
  );
  await noticeButton(document, 'Add to deck').dispatch('click');
  const inserted = Array.from(loaded.controller.visibleCards(), ({ card }) => card)
    .find((card) => card.id === oldCard.id);
  assert.equal(inserted.name, 'Pending version C');
  assert.equal(inserted.hash, 'hash-pending-c');
  assert.equal(document.elements['card-name'].textContent, 'Pending version C');
});

test('resync turns an in-flight added read into one authoritative actionable notice', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const id = 'demo/pending-during-resync.md';
  const pendingRead = deferredValue();
  const staleCard = liveCard(id, {
    name: 'Stale event read',
    hash: 'hash-stale-event-read',
  });
  const authoritativeCard = liveCard(id, {
    name: 'Authoritative reconnect addition',
    hash: 'hash-authoritative-addition',
  });
  const live = makeLiveBackend(window, {
    eventCards: { [id]: () => pendingRead.promise },
  });
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  let resyncing = false;
  live.backend.listProjects = async (options) => {
    if (!resyncing) return initialListProjects(options);
    const snapshot = liveFixture();
    snapshot.projects[0].cards.push(authoritativeCard);
    snapshot.projects[0].memoryCount += 1;
    return JSON.parse(JSON.stringify(snapshot));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });

  const adding = live.emit({ type: 'added', id });
  await settleEvents();
  resyncing = true;
  await live.emit({ type: 'resync' });
  await settleEvents();

  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id).includes(id),
    false,
  );
  assert.equal(document.elements.notices.children.length, 1);
  assert.match(flattenText(document.elements.notices), /Authoritative reconnect addition/);

  pendingRead.resolve(staleCard);
  await adding;
  await settleEvents();
  assert.equal(document.elements.notices.children.length, 1);
  assert.doesNotMatch(flattenText(document.elements.notices), /Stale event read/);

  await noticeButton(document, 'Add to deck').dispatch('click');
  const inserted = Array.from(loaded.controller.visibleCards(), ({ card }) => card)
    .find((card) => card.id === id);
  assert.equal(inserted.name, 'Authoritative reconnect addition');
  assert.equal(inserted.hash, 'hash-authoritative-addition');
  assert.equal(document.elements['card-name'].textContent, 'Authoritative reconnect addition');
});

test('resync offers newly discovered selected-project cards without announcing unselected ones', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const selectedAddition = liveCard('demo/reconnect-only.md', {
    name: 'Found after reconnect',
    hash: 'hash-reconnect-only',
  });
  const unselectedAddition = liveCard('other/quiet-reconnect.md', {
    name: 'Quiet unselected reconnect addition',
    hash: 'hash-quiet-reconnect',
  });
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  let resyncing = false;
  live.backend.listProjects = async (options) => {
    if (!resyncing) return initialListProjects(options);
    const snapshot = liveFixture();
    snapshot.projects[0].cards.push(selectedAddition);
    snapshot.projects[0].memoryCount += 1;
    snapshot.projects[1].cards.push(unselectedAddition);
    snapshot.projects[1].memoryCount += 1;
    return JSON.parse(JSON.stringify(snapshot));
  };
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });
  const otherChip = document.elements['project-chips'].children.find(
    (button) => button.textContent.startsWith('other ·'),
  );
  await otherChip.dispatch('click');
  resyncing = true;

  await live.emit({ type: 'resync' });
  await settleEvents();

  assert.equal(document.elements.notices.children.length, 1);
  assert.match(flattenText(document.elements.notices), /Found after reconnect/);
  assert.doesNotMatch(flattenText(document.elements.notices), /Quiet unselected/);
  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id)
      .includes(selectedAddition.id),
    false,
  );

  await noticeButton(document, 'Add to deck').dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'Found after reconnect');
  assert.equal(document.elements.notices.children.length, 0);
});

test('passive live notices expire and reclaim their per-memory bookkeeping', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  const changed = liveCard('demo/a.md', {
    name: 'Brief update',
    hash: 'hash-brief-update',
  });
  const live = makeLiveBackend(window, { eventCards: { [changed.id]: changed } });
  const loaded = await window.SCMD.boot({
    backend: live.backend,
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
  });

  await live.emit({ type: 'changed', id: changed.id });
  await live.emit({ type: 'removed', id: 'demo/b.md' });
  await settleEvents();
  assert.equal(document.elements.notices.children.length, 2);
  assert.equal(timers.count(), 2);

  await timers.runAll();

  assert.equal(document.elements.notices.children.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.controller.liveStateSizes())), {
    notices: 0,
    noticeGenerations: 0,
    eventGenerations: 0,
    pendingEvents: 0,
    passiveTimers: 0,
    originLookups: 0,
  });
});

test('a failed resync retries without another event and cancels the retry after success', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  const refreshed = liveFixture();
  refreshed.projects[0].cards[0] = liveCard('demo/a.md', {
    name: 'Loaded by retry',
    hash: 'hash-retry',
  });
  let resyncReads = 0;
  let resyncing = false;
  live.backend.listProjects = async (options) => {
    if (!resyncing) return initialListProjects(options);
    resyncReads += 1;
    if (resyncReads === 1) throw new Error('temporary resync failure');
    return JSON.parse(JSON.stringify(refreshed));
  };
  const loaded = await window.SCMD.boot({
    backend: live.backend,
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
  });
  resyncing = true;

  assert.equal(await live.emit({ type: 'resync' }), false);
  assert.equal(timers.count(), 1);
  assert.deepEqual(timers.delays(), [1000]);

  await timers.runNext();

  assert.equal(resyncReads, 2);
  assert.equal(timers.count(), 0);
  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card)
      .find((card) => card.id === 'demo/a.md').name,
    'Loaded by retry',
  );
  assert.equal(document.elements.notices.children.length, 0);
  assert.equal(loaded.controller.liveStateSizes().pendingEvents, 0);
});

test('notice rerenders restore action focus and detach the obsolete action handlers', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const added = liveCard('demo/focused.md', { name: 'Focused addition' });
  const live = makeLiveBackend(window, { eventCards: { [added.id]: added } });
  const loaded = await window.SCMD.boot({ backend: live.backend, document, window });

  await live.emit({ type: 'added', id: added.id });
  await settleEvents();
  const oldAdd = noticeButton(document, 'Add to deck');
  oldAdd.focus();

  document.elements['search-input'].value = 'unrelated rerender';
  await document.elements['search-input'].dispatch('input');
  const currentAdd = noticeButton(document, 'Add to deck');

  assert.notEqual(currentAdd, oldAdd);
  assert.equal(document.activeElement, currentAdd);
  await oldAdd.dispatch('click');
  assert.equal(
    Array.from(loaded.controller.visibleCards(), ({ card }) => card.id).includes(added.id),
    false,
  );
  document.elements['search-input'].value = '';
  await document.elements['search-input'].dispatch('input');
  await noticeButton(document, 'Add to deck').dispatch('click');
  assert.equal(document.elements['card-name'].textContent, 'Focused addition');
});

test('live rerenders preserve filter focus and invalidate detached project and type chips', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const changedDemo = liveCard('demo/a.md', {
    name: 'Demo live rerender',
    hash: 'hash-demo-live-rerender',
  });
  const changedOther = liveCard('other/existing.md', {
    name: 'Other live rerender',
    hash: 'hash-other-live-rerender',
  });
  const live = makeLiveBackend(window, {
    eventCards: {
      [changedDemo.id]: changedDemo,
      [changedOther.id]: changedOther,
    },
  });
  await window.SCMD.boot({ backend: live.backend, document, window });

  const oldProject = document.elements['project-chips'].children.find(
    (button) => button.textContent.startsWith('demo ·'),
  );
  oldProject.focus();
  await live.emit({ type: 'changed', id: changedDemo.id });
  await settleEvents();
  const focusedProject = document.elements['project-chips'].children.find(
    (button) => button.textContent.startsWith('demo ·'),
  );
  assert.notEqual(focusedProject, oldProject);
  assert.equal(document.activeElement, focusedProject);

  await oldProject.dispatch('click');
  assert.equal(
    document.elements['project-chips'].children.find(
      (button) => button.textContent.startsWith('demo ·'),
    )['aria-pressed'],
    'true',
  );
  await document.activeElement.dispatch('click');
  assert.equal(
    document.elements['project-chips'].children.find(
      (button) => button.textContent.startsWith('demo ·'),
    )['aria-pressed'],
    'false',
  );

  const oldType = document.elements['type-chips'].children.find(
    (button) => button.textContent === 'project',
  );
  oldType.focus();
  await live.emit({ type: 'changed', id: changedOther.id });
  await settleEvents();
  const focusedType = document.elements['type-chips'].children.find(
    (button) => button.textContent === 'project',
  );
  assert.notEqual(focusedType, oldType);
  assert.equal(document.activeElement, focusedType);

  await oldType.dispatch('click');
  assert.equal(
    document.elements['type-chips'].children.find(
      (button) => button.textContent === 'project',
    )['aria-pressed'],
    'true',
  );
  await document.activeElement.dispatch('click');
  assert.equal(
    document.elements['type-chips'].children.find(
      (button) => button.textContent === 'project',
    )['aria-pressed'],
    'false',
  );
});

test('beforeunload destroys the controller and cancels a scheduled resync retry', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const timers = fakeTimers();
  const live = makeLiveBackend(window);
  const initialListProjects = live.backend.listProjects.bind(live.backend);
  let resyncing = false;
  live.backend.listProjects = async (options) => {
    if (!resyncing) return initialListProjects(options);
    throw new Error('still disconnected');
  };
  let beforeUnload;
  window.addEventListener = (type, listener) => {
    if (type === 'beforeunload') beforeUnload = listener;
  };
  await window.SCMD.boot({
    backend: live.backend,
    document,
    window,
    schedule: timers.schedule,
    cancelSchedule: timers.cancel,
  });
  resyncing = true;
  await live.emit({ type: 'resync' });
  assert.equal(timers.count(), 1);

  beforeUnload();

  assert.equal(timers.count(), 0);
  assert.equal(live.stopCalls(), 1);
  assert.equal(await live.emit({ type: 'removed', id: 'demo/a.md' }), false);
  assert.equal(timers.count(), 0);
});

test('beforeunload during each boot read prevents late controller work', async (t) => {
  for (const pendingStage of ['projects', 'instructions', 'status']) {
    await t.test(pendingStage, async () => {
      const { window } = await loadPageApi();
      const document = fakeDocument();
      const timers = fakeTimers();
      const pending = deferredValue();
      const seed = liveFixture();
      const base = window.SCMD.createFakeBackend(seed);
      let listener;
      let stopCalls = 0;
      const backend = {
        ...base,
        events(onEvent) {
          listener = onEvent;
          base.calls.push({ method: 'events' });
          return () => { stopCalls += 1; };
        },
        async listProjects(options) {
          if (pendingStage === 'projects') {
            base.calls.push({ method: 'listProjects', options: { ...options } });
            return pending.promise;
          }
          return base.listProjects(options);
        },
        async instructions() {
          if (pendingStage === 'instructions') {
            base.calls.push({ method: 'instructions' });
            return pending.promise;
          }
          return base.instructions();
        },
        async read(request) {
          if (pendingStage === 'status' && request?.status === true) {
            base.calls.push({ method: 'read', status: true });
            return pending.promise;
          }
          return base.read(request);
        },
      };
      let beforeUnload;
      window.addEventListener = (type, callback) => {
        if (type === 'beforeunload') beforeUnload = callback;
      };

      const booting = window.SCMD.boot({
        backend,
        document,
        window,
        schedule: timers.schedule,
        cancelSchedule: timers.cancel,
      });
      await settleEvents();
      listener({ type: 'resync' });
      beforeUnload();
      if (pendingStage === 'projects') pending.resolve(JSON.parse(JSON.stringify(seed)));
      else if (pendingStage === 'instructions') pending.resolve({ files: [] });
      else pending.resolve({ rewriteAvailable: false });
      const loaded = await booting;

      assert.equal(stopCalls, 1);
      assert.equal(loaded.controller, undefined);
      assert.equal(timers.count(), 0);
      assert.equal(await listener({ type: 'resync' }), false);
      assert.equal(timers.count(), 0);
      const methods = Array.from(base.calls, (call) => call.method);
      if (pendingStage === 'projects') assert.deepEqual(methods, ['events', 'listProjects']);
      if (pendingStage === 'instructions') assert.equal(methods.includes('read'), false);
    });
  }
});

test('boot keeps the event-stream cleanup attached to beforeunload', async () => {
  const { window } = await loadPageApi();
  const document = fakeDocument();
  const live = makeLiveBackend(window);
  let beforeUnload;
  let beforeUnloadOptions;
  window.addEventListener = (type, listener, options) => {
    if (type === 'beforeunload') {
      beforeUnload = listener;
      beforeUnloadOptions = options;
    }
  };

  await window.SCMD.boot({ backend: live.backend, document, window });
  assert.equal(live.stopCalls(), 0);
  assert.equal(beforeUnloadOptions?.once, true);

  beforeUnload();
  assert.equal(live.stopCalls(), 1);
});
