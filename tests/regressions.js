'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function loadStore(options = {}) {
  let nextId = 0;
  const localStorage = storage();
  const sessionStorage = storage();
  const sandbox = {
    console,
    localStorage,
    sessionStorage,
    crypto: { randomUUID: () => `generated-${++nextId}` },
    Date,
    Math,
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'parse.js'), 'utf8'), sandbox, { filename: 'parse.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'store.js'), 'utf8'), sandbox, { filename: 'store.js' });
  if (options.context) return { Store: sandbox.Store, localStorage, sessionStorage };
  return sandbox.Store;
}

function baseData(overrides = {}) {
  return {
    version: 4,
    theme: null,
    sort: 'manual',
    pomodoro: [
      { focus: 25, rest: 5 },
      { focus: 25, rest: 5 },
      { focus: 25, rest: 5 },
      { focus: 25, rest: 25 }
    ],
    categories: [
      { id: 'work', name: '업무', hue: 220 },
      { id: 'personal', name: '개인', hue: 140 }
    ],
    todos: [],
    ...overrides
  };
}

function todo(id, fields = {}) {
  return {
    id,
    parentId: null,
    title: id,
    category: 'work',
    priority: 1,
    tags: [],
    completed: false,
    createdAt: 100,
    completedAt: null,
    order: 0,
    ...fields
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('가져오기 카테고리 이름은 연속 공백을 압축한 뒤 중복 제거한다', () => {
  const Store = loadStore();
  const result = Store.importData(baseData({
    categories: [
      { id: 'a', name: 'Deep   Work', hue: 10 },
      { id: 'b', name: 'Deep Work', hue: 20 }
    ]
  }));
  assert.ok(result);
  assert.deepEqual(
    Array.from(Store.getCategories(), (category) => category.name),
    ['Deep Work']
  );
});

test('restore는 현재 부모 카테고리를 상속하고 충돌 order에서 원래 자리를 보존한다', () => {
  const Store = loadStore();
  assert.ok(Store.importData(baseData({ todos: [
    todo('parent'),
    todo('victim', { parentId: 'parent', order: 0 }),
    todo('other-root', { category: 'personal', order: 1 })
  ] })));

  const removed = Store.remove('victim');
  assert.ok(removed);
  assert.ok(Store.update('parent', { category: 'personal' }));
  const newcomer = Store.addChild('parent', { title: 'newcomer', priority: 1, tags: [] });
  assert.ok(newcomer);
  assert.equal(newcomer.order, 0);

  assert.ok(Store.restore(removed));
  const restored = Store.getItem('victim');
  assert.equal(restored.category, 'personal');
  assert.equal(restored.order, 0);
  assert.equal(Store.getItem(newcomer.id).order, 1);
  assert.equal(new Set(Store.getChildren('parent').map((item) => item.order)).size, 2);

  Store.load();
  assert.deepEqual(
    Array.from(Store.getChildren('parent'), (item) => item.id),
    ['victim', newcomer.id]
  );
});

test('restore는 삭제된 카테고리를 복원하지 않고 현재 카테고리와 유일한 order를 쓴다', () => {
  const Store = loadStore();
  assert.ok(Store.importData(baseData({ todos: [
    todo('kept', { order: 0 }),
    todo('victim', { order: 1 })
  ] })));

  const removed = Store.remove('victim');
  assert.ok(removed);
  assert.ok(Store.removeCategory('work', 'personal'));
  const newcomer = Store.add({ title: 'new root', priority: 1, tags: [] }, 'personal');
  assert.ok(newcomer);

  assert.ok(Store.restore(removed));
  assert.equal(Store.getItem('victim').category, 'personal');
  const roots = Store.getRoots({ type: 'all' });
  assert.equal(new Set(roots.map((item) => item.order)).size, roots.length);
});

test('검색 태그 바는 문맥 상위의 직접 불일치 태그를 집계하지 않는다', () => {
  const Store = loadStore();
  assert.ok(Store.importData(baseData({ todos: [
    todo('parent', { title: '묶음', tags: ['parent-only'] }),
    todo('child', { parentId: 'parent', title: 'needle task', tags: ['child-tag'] })
  ] })));

  assert.deepEqual(
    Array.from(Store.getAllTags({ type: 'all', query: 'needle' }), ({ tag }) => tag),
    ['child-tag']
  );
});

test('태그 필터의 태그 축은 제거하되 검색 scope는 직접 일치 항목에 유지한다', () => {
  const Store = loadStore();
  assert.ok(Store.importData(baseData({ todos: [
    todo('one', { title: 'needle', tags: ['foo', 'bar'] }),
    todo('two', { title: 'other', tags: ['baz'] })
  ] })));

  assert.deepEqual(
    Array.from(Store.getAllTags({ type: 'tag', value: 'foo', query: 'needle' }), ({ tag }) => tag),
    ['bar', 'foo']
  );
});

class ClassList {
  constructor(owner) { this.owner = owner; this.values = new Set(); }
  setFrom(text) { this.values = new Set(String(text || '').split(/\s+/).filter(Boolean)); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(name) : !!force;
    if (next) this.values.add(name); else this.values.delete(name);
    return next;
  }
  contains(name) { return this.values.has(name); }
  toString() { return [...this.values].join(' '); }
}

function selectorMatches(node, selector) {
  if (!node || !(node instanceof FakeElement)) return false;
  if (selector.includes(',')) return selector.split(',').some((part) => selectorMatches(node, part.trim()));
  const tag = /^([a-z][\w-]*)/i.exec(selector)?.[1];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const name of selector.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(name[1])) return false;
  for (const match of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const [, attr, expected] = match;
    const actual = attr.startsWith('data-')
      ? node.dataset[attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
      : node.getAttribute(attr);
    if (actual == null || (expected !== undefined && String(actual) !== expected)) return false;
  }
  if (selector.startsWith('#') && node.id !== selector.slice(1)) return false;
  return true;
}

class FakeElement {
  constructor(tag = 'div', ownerDocument = null) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this.style = { setProperty() {} };
    this.hidden = false;
    this.open = false;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.selectionStart = 0;
  }
  set className(value) { this.classList.setFrom(value); }
  get className() { return this.classList.toString(); }
  set textContent(value) { this._textWrites = (this._textWrites || 0) + 1; this._text = String(value); this.childNodes = []; }
  get textContent() { return (this._text || '') + this.childNodes.map((child) => child.textContent || '').join(''); }
  set innerHTML(value) { this._htmlWrites = (this._htmlWrites || 0) + 1; this._html = String(value); }
  get innerHTML() { return this._html || ''; }
  get children() { return this.childNodes; }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceWith(next) {
    if (!this.parentNode) return;
    const at = this.parentNode.childNodes.indexOf(this);
    if (at >= 0) { next.parentNode = this.parentNode; this.parentNode.childNodes[at] = next; this.parentNode = null; }
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, init = {}) {
    const event = {
      target: this,
      preventDefault() {},
      stopPropagation() {},
      ...init
    };
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
  contains(node) { for (let cur = node; cur; cur = cur.parentNode) if (cur === this) return true; return false; }
  closest(selector) { for (let cur = this; cur; cur = cur.parentNode) if (selectorMatches(cur, selector)) return cur; return null; }
  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (selectorMatches(child, selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  select() { this.selectionStart = this.value.length; }
  setSelectionRange(start) { this.selectionStart = start; }
  click() { this.dispatch('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, height: 100 }; }
}

function makeDocument() {
  const ids = new Map();
  const document = {
    hidden: false,
    title: 'My What Todo',
    activeElement: null,
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    listeners: new Map(),
    createElement(tag) { return new FakeElement(tag, document); },
    getElementById(id) {
      if (!ids.has(id)) { const node = new FakeElement('div', document); node.id = id; ids.set(id, node); }
      return ids.get(id);
    },
    querySelector(selector) {
      if (selector === '.pomo-lengths') return document.getElementById('pomo-lengths');
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
  };
  document.documentElement.ownerDocument = document;
  document.body.ownerDocument = document;
  return document;
}

function loadApp(options = {}) {
  const document = makeDocument();
  const restored = [];
  const fileSnapshots = [];
  let fileStatusHandler = null;
  let retryCalls = 0;
  let loadCount = 0;
  let importCount = 0;
  const categories = [{ id: 'work', name: '업무', hue: 220 }];
  const mockStore = {
    STORAGE_KEY: 'daily-todo:v1', PRIORITIES: [0, 1, 2, 3], SORTS: ['priority', 'manual'],
    MAX_TITLE: 100, MAX_CATEGORY_NAME: 12, MAX_CATEGORIES: 64,
    POMO_ROUNDS: 4, POMO_MIN_MINUTES: 1, POMO_MAX_MINUTES: 180,
    isPersistent: true, wasCorrupted: false, lastError: null,
    load() { loadCount += 1; return []; },
    loadRun() { return null; }, saveRun() {},
    getTheme() { return null; }, getSort() { return 'priority'; },
    getPomodoro() { return [{ focus: 25, rest: 5 }, { focus: 25, rest: 5 }, { focus: 25, rest: 5 }, { focus: 25, rest: 25 }]; },
    getCategories() { return categories.map((item) => ({ ...item })); }, countInCategory() { return 0; },
    getRoots(filter) {
      return filter?.type === 'tag' && !Object.prototype.hasOwnProperty.call(filter, 'query')
        ? [{ id: 'tag-present' }]
        : [];
    },
    getChildren() { return []; }, getAllTags() { return [{ tag: 'alpha', openCount: 1 }]; },
    getStats() { return { done: 0, total: 0, percent: 0 }; }, countCompleted() { return 1; },
    getItem() { return null; }, isContextRow() { return false; },
    exportData() { return { todos: [], categories }; },
    importData() { importCount += 1; return { todos: 1, categories: 1 }; },
    restore(items) { restored.push(items.map((item) => ({ ...item }))); return items; }
  };
  const Store = options.Store ?? mockStore;
  const timers = new Map();
  let nextTimer = 0;
  const globalListeners = new Map();
  const sandbox = {
    console, document, Store,
    FileSync: {
      isSupported() { return true; },
      async connect() { return 'connected'; },
      save(snapshot) { fileSnapshots.push(snapshot); return Promise.resolve(options.saveResult ?? true); },
      async retry() { retryCalls += 1; return options.retryResult ?? true; },
      setErrorHandler() {},
      setStatusHandler(handler) {
        fileStatusHandler = handler;
        handler({
          phase: 'disconnected', fileName: null, lastSavedAt: null,
          saveError: false, retrying: false
        });
      }
    },
    Parse: { parseInput: () => ({ title: '', priority: null, tags: [] }) },
    CSS: { escape: (value) => String(value) },
    Blob: class {}, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Date, Math,
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return 1; }, clearInterval() {},
    requestAnimationFrame(fn) { fn(); },
    matchMedia() { return { matches: false, addEventListener() {} }; },
    addEventListener(type, fn) {
      if (!globalListeners.has(type)) globalListeners.set(type, []);
      globalListeners.get(type).push(fn);
    },
    AudioContext: class {}, webkitAudioContext: class {}
  };
  sandbox.globalThis = sandbox;
  let source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const end = source.indexOf("  Store.load();\n", source.indexOf("addEventListener('storage'"));
  assert.notEqual(end, -1, 'app test hook insertion point');
  source = source.slice(0, end) + `
  globalThis.__appTest = {
    showUndo, showNotice, undo, adoptExternal, render, renderTabs, renderTagBar, setFilter, saved,
    renderFileStatus,
    setPendingImport(value) { pendingImport = value; },
    setChanging(categoryId, priorityId) { changingCategory = categoryId; changingPriority = priorityId; },
    state() { return { pendingUndo, changingCategory, changingPriority, queuedNotice }; }
  };
})();\n`;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'app.js' });
  return {
    sandbox, document, Store, restored, fileSnapshots, timers,
    emitFileStatus(state) { fileStatusHandler(state); },
    get retryCalls() { return retryCalls; },
    get loadCount() { return loadCount; }, get importCount() { return importCount; }
  };
}

test('연속 삭제는 id 중복 없이 하나의 실행 취소 묶음으로 복원한다', () => {
  const app = loadApp();
  app.sandbox.__appTest.showUndo([{ id: 'a' }, { id: 'shared' }]);
  app.sandbox.__appTest.showUndo([{ id: 'b' }, { id: 'shared' }]);
  assert.deepEqual(
    Array.from(app.sandbox.__appTest.state().pendingUndo, (item) => item.id),
    ['a', 'shared', 'b']
  );
  app.sandbox.__appTest.undo();
  assert.deepEqual(Array.from(app.restored[0], (item) => item.id), ['a', 'shared', 'b']);
});

test('외부 상태 채택은 완료 삭제 dialog와 인라인 선택 상태를 모두 닫고 렌더한다', () => {
  const app = loadApp();
  const clearDialog = app.document.getElementById('clear-dialog');
  clearDialog.open = true;
  app.sandbox.__appTest.setChanging('category-item', 'priority-item');
  app.sandbox.__appTest.adoptExternal();
  assert.equal(clearDialog.open, false);
  assert.deepEqual({
    changingCategory: app.sandbox.__appTest.state().changingCategory,
    changingPriority: app.sandbox.__appTest.state().changingPriority
  }, { changingCategory: null, changingPriority: null });
  assert.equal(app.loadCount, 1);
});

test('외부 상태 채택은 삭제와 무관한 대기 알림을 보존한다', () => {
  const app = loadApp();
  const hooks = app.sandbox.__appTest;
  hooks.showUndo([{ id: 'old' }]);
  hooks.showNotice('집중 시간이 끝났습니다.');

  hooks.adoptExternal();

  assert.equal(hooks.state().pendingUndo, null);
  assert.equal(hooks.state().queuedNotice, null);
  assert.equal(app.document.getElementById('toast').textContent, '집중 시간이 끝났습니다.');
});

test('카테고리와 태그 필터 버튼은 필터 변경 직후 aria-pressed를 갱신한다', () => {
  const app = loadApp();
  const hooks = app.sandbox.__appTest;
  hooks.setFilter({ type: 'category', value: 'work' });
  let tabs = app.document.getElementById('category-tabs').children;
  assert.equal(tabs[0].getAttribute('aria-pressed'), 'false');
  assert.equal(tabs[1].getAttribute('aria-pressed'), 'true');

  hooks.setFilter({ type: 'tag', value: 'alpha' });
  const chip = app.document.getElementById('tag-bar').children[0];
  assert.equal(chip.getAttribute('aria-pressed'), 'true');
  tabs = app.document.getElementById('category-tabs').children;
  assert.equal(tabs[0].getAttribute('aria-pressed'), 'false');
  assert.equal(tabs[1].getAttribute('aria-pressed'), 'false');
});

test('가져오기 성공은 과거 undo와 대기 알림을 버리고 가져오기 결과만 알린다', () => {
  const app = loadApp();
  const hooks = app.sandbox.__appTest;
  hooks.showUndo([{ id: 'old' }]);
  hooks.setPendingImport({ todos: [todo('imported')] });

  const button = new FakeElement('button', app.document);
  button.dataset.choice = 'plain';
  app.document.getElementById('import-dialog').dispatch('click', { target: button });

  assert.equal(app.importCount, 1);
  assert.equal(hooks.state().pendingUndo, null);
  assert.equal(hooks.state().queuedNotice, null);
  assert.equal(app.document.getElementById('toast').textContent, '1개를 가져왔습니다.');
  hooks.undo();
  assert.equal(app.restored.length, 0);
});

test('saved 성공 경계는 변경 직후의 Store 스냅샷을 파일 동기화에 넘긴다', () => {
  const app = loadApp();
  const result = { id: 'changed' };

  assert.equal(app.sandbox.__appTest.saved(result), result);
  assert.deepEqual(app.fileSnapshots, [{ todos: [], categories: [{ id: 'work', name: '업무', hue: 220 }] }]);

  app.sandbox.__appTest.saved(null);
  assert.equal(app.fileSnapshots.length, 1);
});

test('파일 mirror 실패여도 실제 LocalStorage 정본과 Store mutation 결과를 롤백하지 않는다', async () => {
  const { Store, localStorage } = loadStore({ context: true });
  const result = Store.add({
    title: '로컬 정본 유지', priority: 1, tags: ['local-first']
  }, 'work');
  assert.ok(result);

  const key = Store.STORAGE_KEY;
  const persistedBeforeSaved = localStorage.getItem(key);
  assert.ok(persistedBeforeSaved);
  assert.equal(JSON.parse(persistedBeforeSaved).todos.some((item) => item.id === result.id), true);
  assert.equal(Store.exportData().todos.some((item) => item.id === result.id), true);

  const app = loadApp({ Store, saveResult: false });
  app.sandbox.__appTest.render();
  const list = app.document.getElementById('todo-list');
  assert.equal(list.textContent.includes('로컬 정본 유지'), true);

  assert.equal(app.sandbox.__appTest.saved(result), result);
  assert.equal(app.fileSnapshots[0].todos.some((item) => item.id === result.id), true,
    'saved 경계가 실제 Store 정본을 mirror한다');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(Store.getItem(result.id).id, result.id);
  assert.equal(Store.exportData().todos.some((item) => item.id === result.id), true);
  assert.equal(localStorage.getItem(key), persistedBeforeSaved);
  assert.equal(JSON.parse(localStorage.getItem(key)).todos.some((item) => item.id === result.id), true);
  assert.equal(list.textContent.includes('로컬 정본 유지'), true);
  assert.equal(app.document.getElementById('toast').textContent, '');
});

test('파일 상태 UI는 변경된 문자열만 쓰고 연결 중 버튼을 잠근 뒤 연결 후 다시 연결로 바꾼다', () => {
  const app = loadApp();
  const status = app.document.getElementById('file-status');
  const button = app.document.getElementById('file-connect');

  assert.equal(status.textContent, '파일 연결 안 됨');
  const writes = status._textWrites;
  app.emitFileStatus({ phase: 'disconnected', fileName: null, lastSavedAt: null });
  assert.equal(status._textWrites, writes, '같은 표시 문자열은 textContent를 다시 쓰지 않는다');

  app.emitFileStatus({ phase: 'connecting', fileName: null, lastSavedAt: null });
  assert.equal(status.textContent, '파일 연결 중…');
  assert.equal(button.disabled, true);

  app.sandbox.__appTest.renderFileStatus(
    { phase: 'connected', fileName: 'todos.json', lastSavedAt: 123 },
    () => '10:23:45'
  );
  assert.equal(status.textContent, 'todos.json 연결됨 · 마지막 저장 10:23:45');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '파일 다시 연결');
});

test('악성 형태 파일명은 HTML로 해석하지 않고 파일 상태의 textContent로만 그린다', () => {
  const malicious = '<img src=x onerror=globalThis.pwned=true>.json';
  const app = loadApp();
  const status = app.document.getElementById('file-status');
  const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  app.sandbox.__appTest.renderFileStatus(
    { phase: 'connected', fileName: malicious, lastSavedAt: 123 },
    () => '고정 시각'
  );

  assert.equal(status.textContent, `${malicious} 연결됨 · 마지막 저장 고정 시각`);
  assert.ok(status._textWrites > 0);
  assert.equal(status._htmlWrites, undefined);
  assert.equal(status.children.length, 0);
  assert.doesNotMatch(appSource, /\.innerHTML\s*=/);
});

test('정적 파일 상태 영역은 중복 live 속성 없이 status 역할을 가진다', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /id="file-status"[^>]*role="status"/);
  assert.doesNotMatch(html, /id="file-status"[^>]*aria-live=/);
});

test('좁은 footer에서 파일 상태는 남은 폭으로 줄고 긴 파일명을 개행하며 버튼은 줄지 않는다', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const fileStatus = /\.file-status\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const footerButton = /\.footer-button\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  assert.match(fileStatus, /\bflex\s*:\s*1\s+1\s+0\s*;/);
  assert.match(fileStatus, /\bmin-width\s*:\s*0\s*;/);
  assert.match(fileStatus, /\boverflow-wrap\s*:\s*anywhere\s*;/);
  assert.match(footerButton, /\bflex\s*:\s*none\s*;/);
});

test('파일 실패 상태는 안전한 마지막 성공 문구와 retry 표시를 렌더한다', () => {
  const app = loadApp();
  const retry = app.document.getElementById('file-retry');
  app.sandbox.__appTest.renderFileStatus({
    phase: 'connected', fileName: 'todos.json', lastSavedAt: null,
    saveError: true, retrying: false
  });
  assert.equal(app.document.getElementById('file-status').textContent,
    'todos.json 연결됨 · 저장 실패 · 아직 성공 기록 없음');
  assert.equal(retry.hidden, false);
  assert.equal(retry.disabled, false);
  assert.equal(retry.textContent, '재시도');

  app.sandbox.__appTest.renderFileStatus({
    phase: 'connected', fileName: 'todos.json', lastSavedAt: 123,
    saveError: true, retrying: true
  }, () => '10:23:45');
  assert.equal(app.document.getElementById('file-status').textContent,
    'todos.json 연결됨 · 저장 실패 · 마지막 성공 10:23:45');
  assert.equal(retry.disabled, true);
  assert.equal(retry.textContent, '재시도 중…');
});

test('retry 버튼은 성공/실패 결과를 알리고 상태 없을 때 숨는다', async () => {
  const success = loadApp({ retryResult: true });
  const successRetry = success.document.getElementById('file-retry');
  success.emitFileStatus({
    phase: 'connected', fileName: 'a.json', lastSavedAt: 1,
    saveError: true, retrying: false
  });
  successRetry.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(success.retryCalls, 1);
  assert.equal(success.document.getElementById('toast').textContent, '파일 저장을 다시 완료했습니다.');

  const failure = loadApp({ retryResult: false });
  const failureRetry = failure.document.getElementById('file-retry');
  failure.emitFileStatus({
    phase: 'connected', fileName: 'b.json', lastSavedAt: 1,
    saveError: true, retrying: false
  });
  failureRetry.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failure.document.getElementById('toast').textContent, '파일 저장 재시도에 실패했습니다.');

  failure.emitFileStatus({
    phase: 'connected', fileName: 'b.json', lastSavedAt: 2,
    saveError: false, retrying: false
  });
  assert.equal(failureRetry.hidden, true);
});

test('정적 retry 버튼은 status 밖에 있어 중복 낭독하지 않고 좁은 footer에서 줄지 않는다', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(html, /<span id="file-status"[^>]*role="status"[^>]*>[^<]*<\/span>\s*<button[^>]*id="file-retry"[^>]*hidden/);
  const retryButton = /\.file-retry\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(retryButton, /\bflex\s*:\s*none\s*;/);
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}: ${error.stack || error.message}`);
    }
  }
  if (failures) {
    console.error(`${failures} regression test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('all regression tests passed');
  }
})();
