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
    version: 6,
    theme: null,
    sort: 'manual',
    pomodoro: [
      { focus: 25, rest: 5 },
      { focus: 25, rest: 5 },
      { focus: 25, rest: 5 },
      { focus: 25, rest: 25 }
    ],
    miniOpacity: 82,
    pipDial: true,
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

const plain = (value) => JSON.parse(JSON.stringify(value));

function assertCanonicalGroups(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.parentId)) groups.set(item.parentId, []);
    groups.get(item.parentId).push(item.order);
  }
  for (const orders of groups.values()) {
    assert.deepEqual(orders.slice().sort((a, b) => a - b), orders.map((_, i) => i));
  }
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

test('remove는 중간 root 삭제 직후 getter·export·저장본·재로드의 order를 정본화한다', () => {
  const { Store, localStorage } = loadStore({ context: true });
  assert.ok(Store.importData(baseData({ todos: [
    todo('root-a', { order: 0, createdAt: 10 }),
    todo('root-b', { order: 1, createdAt: 20 }),
    todo('root-c', { order: 2, createdAt: 30 })
  ] })));

  const removed = Store.remove('root-b');
  assert.deepEqual(plain(removed).map(({ id, order }) => ({ id, order })), [{ id: 'root-b', order: 1 }]);
  assert.deepEqual(Array.from(Store.getRoots(), ({ id, order }) => [id, order]), [
    ['root-a', 0], ['root-c', 1]
  ]);

  const exported = plain(Store.exportData());
  assert.deepEqual(exported.todos.map(({ id, order }) => [id, order]), [
    ['root-a', 0], ['root-c', 1]
  ]);
  const persisted = JSON.parse(localStorage.getItem(Store.STORAGE_KEY));
  assert.deepEqual(persisted.todos, exported.todos);

  Store.load();
  assert.deepEqual(plain(Store.exportData()), exported);
  assert.deepEqual(Array.from(Store.getRoots(), ({ id, order }) => [id, order]), [
    ['root-a', 0], ['root-c', 1]
  ]);
});

test('remove는 중간 child 삭제 후 모든 sibling 그룹의 상대 순서와 부모 완료 조정을 보존한다', () => {
  const Store = loadStore();
  assert.ok(Store.importData(baseData({ todos: [
    todo('root-a', { order: 0, createdAt: 10 }),
    todo('parent', { order: 1, createdAt: 20 }),
    todo('root-c', { order: 2, createdAt: 30, category: 'personal' }),
    todo('child-a', { parentId: 'parent', order: 0, createdAt: 40 }),
    todo('child-b', { parentId: 'parent', order: 1, createdAt: 50, completed: true, completedAt: 50 }),
    todo('child-c', { parentId: 'parent', order: 2, createdAt: 60 }),
    todo('other-parent', { order: 3, createdAt: 70, category: 'personal' }),
    todo('other-a', { parentId: 'other-parent', order: 0, createdAt: 80 }),
    todo('other-b', { parentId: 'other-parent', order: 1, createdAt: 90 })
  ] })));
  const parentCompleted = Store.getItem('parent').completed;

  const removed = Store.remove('child-b');
  assert.equal(removed[0].order, 1);
  assert.deepEqual(Array.from(Store.getChildren('parent'), ({ id, order }) => [id, order]), [
    ['child-a', 0], ['child-c', 1]
  ]);
  assert.deepEqual(Array.from(Store.getRoots(), ({ id, order }) => [id, order]), [
    ['root-a', 0], ['parent', 1], ['root-c', 2], ['other-parent', 3]
  ]);
  assert.deepEqual(Array.from(Store.getChildren('other-parent'), ({ id, order }) => [id, order]), [
    ['other-a', 0], ['other-b', 1]
  ]);
  assert.equal(Store.getItem('parent').completed, parentCompleted);
  assertCanonicalGroups(plain(Store.exportData()).todos);
});

test('removeCompleted는 root cascade와 여러 parent 그룹 삭제 후 고아 없이 정본·수동 상대 순서를 유지한다', () => {
  const Store = loadStore();
  assert.ok(Store.importData(baseData({ todos: [
    todo('root-a', { title: 'A', order: 0, createdAt: 10 }),
    todo('root-doomed', { title: 'B', order: 1, createdAt: 20, completed: true, completedAt: 20 }),
    todo('root-c', { title: 'C', order: 2, createdAt: 30, category: 'personal' }),
    todo('parent-p', { title: 'P', order: 3, createdAt: 40 }),
    todo('parent-q', { title: 'Q', order: 4, createdAt: 50, category: 'personal' }),
    todo('cascade-child', { parentId: 'root-doomed', order: 0, createdAt: 60, completed: true, completedAt: 60 }),
    todo('p-a', { parentId: 'parent-p', title: 'PA', order: 0, createdAt: 70 }),
    todo('p-doomed', { parentId: 'parent-p', title: 'PB', order: 1, createdAt: 80, completed: true, completedAt: 80 }),
    todo('p-c', { parentId: 'parent-p', title: 'PC', order: 2, createdAt: 90 }),
    todo('q-doomed', { parentId: 'parent-q', title: 'QA', order: 0, createdAt: 100, completed: true, completedAt: 100 }),
    todo('q-b', { parentId: 'parent-q', title: 'QB', order: 1, createdAt: 110 })
  ] })));
  const before = plain(Store.exportData()).todos;
  const doomedIds = new Set(['root-doomed', 'cascade-child', 'p-doomed', 'q-doomed']);
  const expectedByParent = new Map();
  for (const item of before.filter((item) => !doomedIds.has(item.id))) {
    if (!expectedByParent.has(item.parentId)) expectedByParent.set(item.parentId, []);
    expectedByParent.get(item.parentId).push([item.id, item.title, item.category]);
  }

  assert.ok(Store.removeCompleted());
  const after = plain(Store.exportData()).todos;
  assertCanonicalGroups(after);
  const ids = new Set(after.map((item) => item.id));
  assert.ok(after.every((item) => item.parentId === null || ids.has(item.parentId)));
  for (const [parentId, expected] of expectedByParent) {
    assert.deepEqual(
      after.filter((item) => item.parentId === parentId)
        .sort((a, b) => a.order - b.order)
        .map(({ id, title, category }) => [id, title, category]),
      expected
    );
  }
});

test('remove와 removeCompleted 스냅샷은 삭제 전 order를 보존하고 restore는 원래 상대 위치를 복원한다', () => {
  const first = loadStore();
  assert.ok(first.importData(baseData({ todos: [
    todo('root-a', { order: 0, createdAt: 10 }),
    todo('root-b', { order: 1, createdAt: 20 }),
    todo('root-c', { order: 2, createdAt: 30 }),
    todo('child-b', { parentId: 'root-b', order: 0, createdAt: 40 })
  ] })));
  const removed = first.remove('root-b');
  assert.deepEqual(plain(removed).map(({ id, order }) => [id, order]), [['root-b', 1], ['child-b', 0]]);
  assert.ok(first.restore(removed));
  assert.deepEqual(Array.from(first.getRoots(), ({ id, order }) => [id, order]), [
    ['root-a', 0], ['root-b', 1], ['root-c', 2]
  ]);
  assert.deepEqual(Array.from(first.getChildren('root-b'), ({ id, order }) => [id, order]), [['child-b', 0]]);

  const second = loadStore();
  assert.ok(second.importData(baseData({ todos: [
    todo('root-a', { order: 0, createdAt: 10 }),
    todo('root-b', { order: 1, createdAt: 20, completed: true, completedAt: 20 }),
    todo('root-c', { order: 2, createdAt: 30 }),
    todo('parent', { order: 3, createdAt: 40 }),
    todo('child-a', { parentId: 'parent', order: 0, createdAt: 50 }),
    todo('child-b', { parentId: 'parent', order: 1, createdAt: 60, completed: true, completedAt: 60 }),
    todo('child-c', { parentId: 'parent', order: 2, createdAt: 70 })
  ] })));
  const completed = second.removeCompleted();
  assert.deepEqual(plain(completed).map(({ id, order }) => [id, order]), [['root-b', 1], ['child-b', 1]]);
  assert.ok(second.restore(completed));
  assert.deepEqual(Array.from(second.getRoots(), ({ id, order }) => [id, order]), [
    ['root-a', 0], ['root-b', 1], ['root-c', 2], ['parent', 3]
  ]);
  assert.deepEqual(Array.from(second.getChildren('parent'), ({ id, order }) => [id, order]), [
    ['child-a', 0], ['child-b', 1], ['child-c', 2]
  ]);
});

test('삭제 저장 실패는 remove와 removeCompleted의 필터·renumber·객체 상태를 모두 롤백한다', () => {
  for (const operation of ['remove', 'removeCompleted']) {
    const { Store, localStorage } = loadStore({ context: true });
    assert.ok(Store.importData(baseData({ todos: [
      todo('root-a', { order: 0, createdAt: 10 }),
      todo('root-b', { order: 1, createdAt: 20, completed: operation === 'removeCompleted', completedAt: 20 }),
      todo('root-c', { order: 2, createdAt: 30 }),
      todo('parent', { order: 3, createdAt: 40 }),
      todo('child-a', { parentId: 'parent', order: 0, createdAt: 50 }),
      todo('child-b', { parentId: 'parent', order: 1, createdAt: 60, completed: operation === 'removeCompleted', completedAt: 60 }),
      todo('child-c', { parentId: 'parent', order: 2, createdAt: 70 })
    ] })));
    const before = plain(Store.exportData());
    const references = new Map(before.todos.map((item) => [item.id, Store.getItem(item.id)]));
    const rawBefore = localStorage.getItem(Store.STORAGE_KEY);
    localStorage.setItem = () => { throw new Error('quota'); };

    const result = operation === 'remove' ? Store.remove('root-b') : Store.removeCompleted();
    assert.equal(result, null);
    assert.equal(Store.lastError, 'save');
    assert.deepEqual(plain(Store.exportData()), before);
    assert.equal(localStorage.getItem(Store.STORAGE_KEY), rawBefore);
    for (const [id, reference] of references) assert.equal(Store.getItem(id), reference);
  }
});

test('유효하지 않은 remove와 완료 항목 없는 removeCompleted는 rev·저장·객체를 건드리지 않는다', () => {
  const { Store, localStorage } = loadStore({ context: true });
  assert.ok(Store.importData(baseData({ todos: [
    todo('root-a', { order: 0, createdAt: 10 }),
    todo('root-b', { order: 1, createdAt: 20 })
  ] })));
  const before = plain(Store.exportData());
  const rawBefore = localStorage.getItem(Store.STORAGE_KEY);
  const revBefore = JSON.parse(rawBefore).rev;
  const references = before.todos.map((item) => Store.getItem(item.id));
  let writes = 0;
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = (...args) => { writes += 1; return originalSetItem.call(localStorage, ...args); };

  assert.equal(Store.remove('missing'), null);
  assert.equal(Store.removeCompleted(), null);
  assert.equal(writes, 0);
  assert.equal(localStorage.getItem(Store.STORAGE_KEY), rawBefore);
  assert.equal(JSON.parse(localStorage.getItem(Store.STORAGE_KEY)).rev, revBefore);
  assert.deepEqual(plain(Store.exportData()), before);
  assert.deepEqual(before.todos.map((item) => Store.getItem(item.id)), references);
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

test('화면 설정은 가져오기와 로드에서 같은 자리에서 정규화된다', () => {
  // 저장본을 열 때와 파일을 가져올 때가 같은 검증(adopt)을 탄다. 두 값이 늘어난 뒤로도
  // 그 약속이 지켜지는지 본다 — 여기가 헐거우면 남이 만든 파일 하나로 화면이 깨진다.
  // 무엇이 들어오든 **나오는 것의 모양이 정해져 있다.** 어떤 값이 어떻게 강제 변환되는지를
  // 하나하나 적어두면 그 표가 곧 명세가 되어버리는데, 정작 지켜야 하는 것은 이쪽이다.
  const hostile = [
    ['범위 밖(위)', 101], ['범위 밖(아래)', -1], ['NaN', Number.NaN],
    ['없음', undefined], ['널', null], ['객체', { v: 50 }], ['배열', [50]],
    ['무한대', Number.POSITIVE_INFINITY], ['문자열', '50'], ['참', true],
    ['빈 문자열', ''], ['음수 0', -0]
  ];

  for (const [label, value] of hostile) {
    const { Store } = loadStore({ context: true });
    assert.ok(Store.importData(baseData({ miniOpacity: value, pipDial: value })), label);

    const opacity = Store.getMiniOpacity();
    assert.ok(Number.isInteger(opacity) && opacity >= 0 && opacity <= 100,
      `${label} → 0~100 정수여야 하는데 ${opacity}`);
    assert.equal(typeof Store.getPipDial(), 'boolean', `${label} → 참/거짓`);
  }

  // 읽을 수가 없는 값은 기본값으로 떨어진다
  for (const value of [Number.NaN, undefined, { v: 50 }, 'nope']) {
    const { Store } = loadStore({ context: true });
    assert.ok(Store.importData(baseData({ miniOpacity: value, pipDial: value })));
    assert.equal(Store.getMiniOpacity(), 82);
    assert.equal(Store.getPipDial(), true);
  }

  // 숫자로 읽히는 값은 받아들인다 — 회차 시간(clampMinutes)과 같은 관례다.
  // 보기 방식은 참/거짓뿐이라 그런 여지를 두지 않는다. 억지로 읽을 값이 없다.
  const lenient = loadStore({ context: true });
  assert.ok(lenient.Store.importData(baseData({ miniOpacity: '50', pipDial: 'false' })));
  assert.equal(lenient.Store.getMiniOpacity(), 50);
  assert.equal(lenient.Store.getPipDial(), true, "'false'는 참도 거짓도 아니다");

  // 멀쩡한 값은 그대로 살아남고, 저장·재로드를 건너도 같다
  const { Store, localStorage } = loadStore({ context: true });
  assert.ok(Store.importData(baseData({ miniOpacity: 37, pipDial: false })));
  assert.equal(Store.getMiniOpacity(), 37);
  assert.equal(Store.getPipDial(), false);

  const reopened = loadStore({ context: true });
  reopened.localStorage.setItem('daily-todo:v1', localStorage.getItem('daily-todo:v1'));
  reopened.Store.load();
  assert.equal(reopened.Store.getMiniOpacity(), 37, '다시 열어도 지켜진다');
  assert.equal(reopened.Store.getPipDial(), false);

  // 소수점은 반올림해 들인다. 손잡이가 정수만 내지만 파일은 아무 값이나 담을 수 있다.
  const rounded = loadStore({ context: true });
  assert.ok(rounded.Store.importData(baseData({ miniOpacity: 36.6 })));
  assert.equal(rounded.Store.getMiniOpacity(), 37);
});

test('화면 설정도 저장 실패에는 통째로 되돌아간다', () => {
  const { Store, localStorage } = loadStore({ context: true });
  assert.ok(Store.importData(baseData({ miniOpacity: 40, pipDial: true })));

  // 다음 쓰기를 막는다. 변경 API는 실패하면 값을 되돌리고 null을 준다 (PRD §8).
  localStorage.setItem = () => { throw new Error('quota'); };

  assert.equal(Store.setMiniOpacity(10), null);
  assert.equal(Store.getMiniOpacity(), 40, '되돌리지 않으면 화면과 저장본이 갈라진다');
  assert.equal(Store.setPipDial(false), null);
  assert.equal(Store.getPipDial(), true);
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
    // 사용자 정의 속성(--mini-veil 등)은 실제로 기억한다. 삼키면 CSSOM으로만
    // 건드리는 값들을 검사할 방법이 없어진다. 카멜케이스 직접 대입은 그대로 객체에 앉는다.
    const custom = new Map();
    this.style = {
      setProperty(name, value) { custom.set(name, String(value)); },
      getPropertyValue(name) { return custom.has(name) ? custom.get(name) : ''; },
      removeProperty(name) { custom.delete(name); }
    };
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
  setAttribute(name, value) {
    // 진짜 DOM에서 `class` 속성과 classList는 같은 것이다. 여기서 갈라 두면
    // SVG처럼 setAttribute로만 클래스를 붙이는 코드가 검사에서 사라진다.
    if (name === 'class') { this.classList.setFrom(value); return; }
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    if (name === 'class') return this.classList.toString();
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
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

/**
 * `index.html`에서 접힌 채로 시작하는 자리들.
 *
 * 가짜 요소는 전부 보이는 채로 태어난다. 그대로 두면 **접힌 자리를 건너뛰는 코드가
 * 검사에서 통째로 사라진다** — 실제로는 안 그리는데 테스트에서는 그리고 있었다.
 * 마크업에서 읽어 와 같은 상태로 세운다.
 */
const HIDDEN_AT_START = (() => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const out = new Set();
  for (const [tag] of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const id = /\bid="([\w-]+)"/.exec(tag);
    if (id && /\shidden(?=[\s>/])/.test(tag)) out.add(id[1]);
  }
  return out;
})();

function makeDocument() {
  const ids = new Map();
  const document = {
    hidden: false,
    title: 'My What Todo',
    activeElement: null,
    documentElement: new FakeElement('html'),
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    listeners: new Map(),
    createElement(tag) { return new FakeElement(tag, document); },
    // SVG는 이름공간으로 만든다. 가짜 문서에서는 같은 요소로 충분하다 —
    // 검사하는 것은 붙은 속성과 클래스이지 그리기가 아니다.
    createElementNS(ns, tag) { return new FakeElement(tag, document); },
    getElementById(id) {
      if (!ids.has(id)) {
        const node = new FakeElement('div', document);
        node.id = id;
        node.hidden = HIDDEN_AT_START.has(id);
        ids.set(id, node);
      }
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
    },
    dispatch(type, init = {}) {
      const event = { type, target: document, ...init };
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
  };
  document.documentElement.ownerDocument = document;
  document.head.ownerDocument = document;
  document.body.ownerDocument = document;
  return document;
}

function loadApp(options = {}) {
  const document = makeDocument();
  const restored = [];
  const fileSnapshots = [];
  const markdownSnapshots = [];
  let fileStatusHandler = null;
  let fileErrorHandler = null;
  let currentFileState = null;
  let markdownStatusHandler = null;
  let markdownErrorHandler = null;
  let retryCalls = 0;
  let forceCalls = 0;
  let keepExternalCalls = 0;
  let checkExternalCalls = 0;
  let markdownConnectCalls = 0;
  let markdownForceCalls = 0;
  let markdownKeepExternalCalls = 0;
  let markdownCheckExternalCalls = 0;
  let markdownReadConflictCalls = 0;
  let markdownImportConflictCalls = 0;
  let loadCount = 0;
  let importCount = 0;
  const savedRuns = [];
  const categories = [{ id: 'work', name: '업무', hue: 220 }];
  let pomodoro = [
    { focus: 25, rest: 5 }, { focus: 25, rest: 5 }, { focus: 25, rest: 5 }, { focus: 25, rest: 25 }
  ];
  let miniOpacity = options.miniOpacity ?? 82;
  let pipDial = options.pipDial ?? true;
  let theme = options.theme ?? null;
  const mockStore = {
    STORAGE_KEY: 'daily-todo:v1', PRIORITIES: [0, 1, 2, 3], SORTS: ['priority', 'manual'],
    MAX_TITLE: 100, MAX_CATEGORY_NAME: 12, MAX_CATEGORIES: 64,
    POMO_ROUNDS: 4, POMO_MIN_MINUTES: 1, POMO_MAX_MINUTES: 180,
    isPersistent: true, wasCorrupted: false, lastError: null,
    load() { loadCount += 1; return []; },
    loadRun() { return options.run === undefined ? null : options.run; },
    saveRun(run) { savedRuns.push(JSON.parse(JSON.stringify(run))); },
    getTheme() { return theme; },
    setTheme(value) { theme = value; return value; },
    getSort() { return 'priority'; },
    MINI_OPACITY_DEFAULT: 82,
    getMiniOpacity() { return miniOpacity; },
    getPipDial() { return pipDial; },
    setPipDial(value) {
      if (options.pipDialResult === null) return null;
      pipDial = value === true;
      return pipDial;
    },
    setMiniOpacity(value) {
      if (options.miniOpacityResult === null) return null;
      miniOpacity = Math.min(100, Math.max(0, Math.round(Number(value))));
      return miniOpacity;
    },
    getPomodoro() { return pomodoro.map((round) => ({ ...round })); },
    setPomodoro(value) {
      pomodoro = value === null
        ? [{ focus: 25, rest: 5 }, { focus: 25, rest: 5 }, { focus: 25, rest: 5 }, { focus: 25, rest: 25 }]
        : value.map((round) => ({ ...round }));
      return true;
    },
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
    importData(data) {
      importCount += 1;
      if (options.onStoreImport) return options.onStoreImport(data);
      return options.storeImportResult === undefined ? { todos: 1, categories: 1 } : options.storeImportResult;
    },
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
      save(snapshot) {
        fileSnapshots.push(snapshot);
        if (options.fileSaveThrows) throw new Error('file sync throw');
        if (options.fileSaveRejects) return Promise.reject(new Error('file sync reject'));
        return Promise.resolve(options.saveResult ?? true);
      },
      async retry() { retryCalls += 1; return options.retryResult ?? true; },
      forceOverwrite(getSnapshot) {
        forceCalls += 1;
        if (options.captureForceSnapshot) fileSnapshots.push(getSnapshot());
        return Promise.resolve(options.forceResult ?? true);
      },
      keepExternal() {
        keepExternalCalls += 1;
        return Promise.resolve(options.keepExternalResult ?? 'disconnected');
      },
      checkExternal() {
        checkExternalCalls += 1;
        if (options.fileCheckThrows) throw new Error('file check throw');
        if (options.fileCheckRejects) return Promise.reject(new Error('file check reject'));
        return Promise.resolve(options.checkExternalResult ?? 'unchanged');
      },
      getState() { return currentFileState; },
      setErrorHandler(handler) { fileErrorHandler = handler; },
      setStatusHandler(handler) {
        fileStatusHandler = handler;
        currentFileState = {
          phase: 'disconnected', fileName: null, lastSavedAt: null,
          saveError: false, checkError: false, retryAvailable: false,
          retrying: false, conflict: false, forcing: false
        };
        handler(currentFileState);
      }
    },
    MarkdownSync: {
      isSupported() { return options.markdownSupported ?? true; },
      async connect(getSnapshot) {
        markdownConnectCalls += 1;
        if (options.captureMarkdownConnectSnapshot) markdownSnapshots.push(getSnapshot());
        return options.markdownConnectResult ?? 'connected';
      },
      save(snapshot) {
        markdownSnapshots.push(snapshot);
        if (options.markdownSaveThrows) throw new Error('markdown sync throw');
        if (options.markdownSaveRejects) return Promise.reject(new Error('markdown sync reject'));
        return Promise.resolve(options.markdownSaveResult ?? true);
      },
      forceOverwrite(getSnapshot) {
        markdownForceCalls += 1;
        if (options.captureMarkdownForceSnapshot) markdownSnapshots.push(getSnapshot());
        if (options.markdownForceRejects) return Promise.reject(new Error('markdown force reject'));
        return Promise.resolve(options.markdownForceResult ?? true);
      },
      keepExternal() {
        markdownKeepExternalCalls += 1;
        if (options.markdownKeepExternalRejects) return Promise.reject(new Error('markdown keep reject'));
        return Promise.resolve(options.markdownKeepExternalResult ?? 'disconnected');
      },
      checkExternal() {
        markdownCheckExternalCalls += 1;
        if (options.markdownCheckThrows) throw new Error('markdown check throw');
        if (options.markdownCheckRejects) return Promise.reject(new Error('markdown check reject'));
        return Promise.resolve(options.markdownCheckExternalResult ?? 'unchanged');
      },
      readConflict() {
        markdownReadConflictCalls += 1;
        if (options.markdownReadThrows) throw new Error('raw read secret');
        if (options.markdownReadRejects) return Promise.reject(new Error('raw read rejection'));
        return Promise.resolve(options.markdownReadResult ?? {
          status: 'ready', text: 'verified markdown', token: 'token-1'
        });
      },
      importConflict(token, apply) {
        markdownImportConflictCalls += 1;
        if (options.markdownImportThrows) throw new Error('raw import secret');
        if (options.markdownImportRejects) return Promise.reject(new Error('raw import rejection'));
        if (options.onMarkdownImport) return options.onMarkdownImport(token, apply);
        const applied = apply(options.verifiedText ?? 'verified markdown');
        return Promise.resolve(options.markdownImportResult ?? {
          status: applied === null ? 'apply-failed' : 'imported'
        });
      },
      getState() { return options.markdownState ?? null; },
      setErrorHandler(handler) { markdownErrorHandler = handler; },
      setStatusHandler(handler) {
        markdownStatusHandler = handler;
        handler({ phase: 'disconnected', fileName: null, lastSavedAt: null, saveError: false });
      }
    },
    MarkdownImport: {
      parse(text, current) {
        if (options.markdownParse) return options.markdownParse(text, current);
        return {
          data: current,
          summary: { total: current.todos.length, changed: 1, completedChanged: 1,
            priorityChanged: 0, titleChanged: 0, tagsChanged: 0, categoryChanged: 0,
            reparented: 0, reordered: 0 }
        };
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

  /**
   * 가짜 별도 창 (Document Picture-in-Picture).
   *
   * 진짜 창은 사용자가 눌러야만 열리고 자동화로는 좀처럼 열리지 않는다. 그런데 그
   * 안에서 도는 것은 대부분 순수한 판단이다 — 어떤 아이콘을 고르는지, 어떤 이름을
   * 붙이는지, 어느 클래스를 켜는지, 닫을 때 무엇을 놓는지. 그 부분만이라도 여기서 잡는다.
   */
  let pipWin = null;
  let pipTimers = 0;
  if (!options.pipUnsupported) {
    sandbox.documentPictureInPicture = {
      get window() { return pipWin; },
      requestWindow(size) {
        if (options.pipRejects) return Promise.reject(new Error('denied'));
        const pipDocument = makeDocument();
        pipWin = {
          document: pipDocument,
          innerWidth: size?.width ?? 240,
          innerHeight: size?.height ?? 210,
          requested: { ...size },
          listeners: new Map(),
          setInterval() { pipTimers += 1; return 77; },
          clearInterval() { pipTimers -= 1; },
          addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(fn);
          },
          close() {
            const gone = pipWin;
            pipWin = null;
            for (const fn of gone.listeners.get('pagehide') ?? []) fn({ type: 'pagehide' });
          }
        };
        return Promise.resolve(pipWin);
      }
    };
  }
  sandbox.globalThis = sandbox;
  let source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const end = source.indexOf("  Store.load();\n", source.indexOf("addEventListener('storage'"));
  assert.notEqual(end, -1, 'app test hook insertion point');
  source = source.slice(0, end) + `
  globalThis.__appTest = {
    showUndo, showNotice, undo, adoptExternal, render, renderTabs, renderTagBar, setFilter, saved,
    renderFileStatus, renderMarkdownStatus, syncMirrors, queueAdopt,
    prepareMarkdownImport, confirmMarkdownImport, formatMarkdownImportSummary,
    setPendingImport(value) { pendingImport = value; },
    setChanging(categoryId, priorityId) { changingCategory = categoryId; changingPriority = priorityId; },
    state() { return { pendingUndo, changingCategory, changingPriority, queuedNotice, pendingMarkdownImport }; },

    syncPomoSettings, paintMiniVeil, openPip, PIP_ICONS,
    restorePomoRun, renderPomo, pomoRefresh, pomoFinish, pomoAdvance, pomoAct,
    cycleEnter, pomoSet, togglePomo, togglePomoView, reflectLengthChange,
    pomoState() {
      return { pomoLength, pomoLeft, pomoEndsAt, cycleRound, cyclePhase, pendingNext, miniDismissed };
    },
    /** 구간이 끝나는 순간을 만든다. setInterval이 도는 대신 여기서 한 걸음 민다. */
    expirePomo() { pomoEndsAt = Date.now() - 1000; pomoRefresh(); }
  };
})();\n`;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'app.js' });
  return {
    sandbox, document, Store, restored, fileSnapshots, markdownSnapshots, timers, savedRuns,
    get pipWindow() { return pipWin; },
    get pipTimers() { return pipTimers; },
    emitFileStatus(state) { currentFileState = state; fileStatusHandler(state); },
    emitFileError(error = new Error('file error')) { fileErrorHandler(error); },
    emitMarkdownStatus(state) { markdownStatusHandler(state); },
    emitMarkdownError(error = new Error('markdown error')) { markdownErrorHandler(error); },
    dispatchGlobal(type, init = {}) {
      for (const fn of globalListeners.get(type) ?? []) fn({ type, ...init });
    },
    get retryCalls() { return retryCalls; },
    get forceCalls() { return forceCalls; },
    get keepExternalCalls() { return keepExternalCalls; },
    get checkExternalCalls() { return checkExternalCalls; },
    get markdownConnectCalls() { return markdownConnectCalls; },
    get markdownForceCalls() { return markdownForceCalls; },
    get markdownKeepExternalCalls() { return markdownKeepExternalCalls; },
    get markdownCheckExternalCalls() { return markdownCheckExternalCalls; },
    get markdownReadConflictCalls() { return markdownReadConflictCalls; },
    get markdownImportConflictCalls() { return markdownImportConflictCalls; },
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
  assert.equal(app.fileSnapshots.length, 1);
  assert.equal(app.markdownSnapshots.length, 1);
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
  assert.equal(app.fileSnapshots.length, 1);
  assert.equal(app.markdownSnapshots.length, 1);
});

test('숨은 탭에서 mirror한 외부 상태는 visible 전환 때 다시 load하거나 저장하지 않고 화면에만 반영한다', () => {
  const app = loadApp();
  const hooks = app.sandbox.__appTest;
  const clearDialog = app.document.getElementById('clear-dialog');
  clearDialog.open = true;
  hooks.setChanging('category-item', 'priority-item');

  app.document.hidden = true;
  hooks.queueAdopt();
  assert.equal(app.loadCount, 1);
  assert.equal(app.fileSnapshots.length, 1);
  assert.equal(app.markdownSnapshots.length, 1);
  assert.equal(clearDialog.open, true, '숨은 동안에는 UI cleanup을 미룬다');

  app.document.hidden = false;
  app.document.dispatch('visibilitychange');
  assert.equal(app.loadCount, 1, '이미 읽은 외부 상태를 다시 load하지 않는다');
  assert.equal(app.fileSnapshots.length, 1, 'JSON mirror를 중복 저장하지 않는다');
  assert.equal(app.markdownSnapshots.length, 1, 'Markdown mirror를 중복 저장하지 않는다');
  assert.equal(clearDialog.open, false);
  assert.deepEqual({
    changingCategory: hooks.state().changingCategory,
    changingPriority: hooks.state().changingPriority
  }, { changingCategory: null, changingPriority: null });
  assert.equal(app.document.getElementById('category-tabs').children.length, 2, 'visible 때 render한다');
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
  assert.equal(app.fileSnapshots.length, 1);
  assert.equal(app.markdownSnapshots.length, 1);
  assert.equal(hooks.state().pendingUndo, null);
  assert.equal(hooks.state().queuedNotice, null);
  assert.equal(app.document.getElementById('toast').textContent, '1개를 가져왔습니다.');
  hooks.undo();
  assert.equal(app.restored.length, 0);
});

test('saved 성공 경계는 변경 직후 하나의 Store 스냅샷을 JSON과 Markdown mirror에 fanout한다', () => {
  const app = loadApp();
  const result = { id: 'changed' };

  assert.equal(app.sandbox.__appTest.saved(result), result);
  assert.deepEqual(app.fileSnapshots, [{ todos: [], categories: [{ id: 'work', name: '업무', hue: 220 }] }]);
  assert.deepEqual(app.markdownSnapshots, app.fileSnapshots);
  assert.equal(app.markdownSnapshots[0], app.fileSnapshots[0], '두 mirror는 같은 호출 시점 snapshot을 받는다');

  app.sandbox.__appTest.saved(null);
  assert.equal(app.fileSnapshots.length, 1);
  assert.equal(app.markdownSnapshots.length, 1);
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
    saveError: true, checkError: false, retryAvailable: true, retrying: false
  });
  assert.equal(app.document.getElementById('file-status').textContent,
    'todos.json 연결됨 · 저장 실패 · 아직 성공 기록 없음');
  assert.equal(retry.hidden, false);
  assert.equal(retry.disabled, false);
  assert.equal(retry.textContent, '재시도');

  app.sandbox.__appTest.renderFileStatus({
    phase: 'connected', fileName: 'todos.json', lastSavedAt: 123,
    saveError: true, checkError: false, retryAvailable: true, retrying: true
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
    saveError: true, checkError: false, retryAvailable: true, retrying: false
  });
  successRetry.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(success.retryCalls, 1);
  assert.equal(success.document.getElementById('toast').textContent, '파일 저장을 다시 완료했습니다.');

  const failure = loadApp({ retryResult: false });
  const failureRetry = failure.document.getElementById('file-retry');
  failure.emitFileStatus({
    phase: 'connected', fileName: 'b.json', lastSavedAt: 1,
    saveError: true, checkError: false, retryAvailable: true, retrying: false
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

test('한 mirror의 동기 throw/rejection은 다른 mirror fanout과 mutation 결과를 막지 않는다', async () => {
  const thrown = loadApp({ markdownSaveThrows: true });
  const result = { id: 'kept' };
  assert.equal(thrown.sandbox.__appTest.saved(result), result);
  assert.equal(thrown.fileSnapshots.length, 1);
  assert.equal(thrown.markdownSnapshots.length, 1);

  const rejected = loadApp({ markdownSaveRejects: true });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    assert.equal(rejected.sandbox.__appTest.saved(result), result);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejected.fileSnapshots.length, 1);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  const fileThrown = loadApp({ fileSaveThrows: true });
  assert.equal(fileThrown.sandbox.__appTest.saved(result), result);
  assert.equal(fileThrown.fileSnapshots.length, 1);
  assert.equal(fileThrown.markdownSnapshots.length, 1);

  const fileRejected = loadApp({ fileSaveRejects: true });
  const fileUnhandled = [];
  const onFileUnhandled = (error) => fileUnhandled.push(error);
  process.on('unhandledRejection', onFileUnhandled);
  try {
    assert.equal(fileRejected.sandbox.__appTest.saved(result), result);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fileRejected.markdownSnapshots.length, 1);
    assert.equal(fileUnhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onFileUnhandled);
  }
});

test('모든 direct file save 경로는 syncMirrors 하나로 모여 Markdown 누락을 막는다', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(source, /function syncMirrors\(snapshot\)/);
  assert.equal((source.match(/FileSync\.save\(/g) || []).length, 1);
  assert.equal((source.match(/MarkdownSync\.save\(/g) || []).length, 1);
  assert.doesNotMatch(source, /Store\.restore\([\s\S]{0,160}FileSync\.save/);
});

test('Markdown 상태 UI는 연결·성공·실패 문구와 다시 연결 버튼을 안전하게 렌더한다', () => {
  const app = loadApp();
  const status = app.document.getElementById('markdown-status');
  const button = app.document.getElementById('markdown-connect');
  assert.equal(status.textContent, 'Markdown 연결 안 됨');

  app.emitMarkdownStatus({ phase: 'connecting', fileName: null, lastSavedAt: null, saveError: false });
  assert.equal(status.textContent, 'Markdown 연결 중…');
  assert.equal(button.disabled, true);

  app.sandbox.__appTest.renderMarkdownStatus({
    phase: 'connected', fileName: 'vault/<x>.md', lastSavedAt: 123, saveError: false
  }, () => '10:23:45');
  assert.equal(status.textContent, 'vault/<x>.md Markdown 연결됨 · 마지막 저장 10:23:45');
  assert.equal(status._htmlWrites, undefined);
  assert.equal(button.textContent, 'Markdown 다시 연결');
  assert.equal(button.disabled, false);

  app.sandbox.__appTest.renderMarkdownStatus({
    phase: 'connected', fileName: 'vault.md', lastSavedAt: 123, saveError: true
  }, () => '10:23:45');
  assert.equal(status.textContent, 'Markdown 저장 실패 · 마지막 성공 10:23:45');
});

test('Markdown 연결 버튼은 지원 여부를 안내하고 picker에 현재 Store snapshot getter를 준다', async () => {
  const unsupported = loadApp({ markdownSupported: false });
  unsupported.document.getElementById('markdown-connect').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unsupported.markdownConnectCalls, 0);
  assert.equal(unsupported.document.getElementById('toast').textContent,
    '이 브라우저는 Markdown 연결을 지원하지 않습니다. JSON 내보내기를 이용해 주세요.');

  const supported = loadApp({ captureMarkdownConnectSnapshot: true });
  supported.document.getElementById('markdown-connect').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supported.markdownConnectCalls, 1);
  assert.equal(supported.markdownSnapshots[0].categories[0].id, 'work');
});

test('정적 Markdown script·status·도움말은 CSP와 제한 편집 가져오기 계약을 지킨다', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const exportAt = html.indexOf('<script src="markdown-export.js"></script>');
  const syncAt = html.indexOf('<script src="markdown-sync.js"></script>');
  const appAt = html.indexOf('<script src="app.js"></script>');
  assert.ok(exportAt > 0 && exportAt < syncAt && syncAt < appAt);
  assert.match(html, /id="markdown-status"[^>]*role="status"/);
  assert.doesNotMatch(html, /id="markdown-status"[^>]*aria-live=/);
  assert.match(html, /Markdown[^<]*지원되는 기존 할 일 편집/);
  assert.match(html, /체크박스·P0~P3·제목·태그·형제 순서·기존 카테고리 이동·최대 2단계 재배치/);
  assert.doesNotMatch(html, /현재 Markdown 편집은 앱에 반영되지 않습니다/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);
});

test('footer의 두 상태 row는 모바일에서 긴 이름을 줄바꿈하고 버튼 폭을 보존한다', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const wrapper = /\.mirror-statuses\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const row = /\.mirror-status-row\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(wrapper, /\bmin-width\s*:\s*0\s*;/);
  assert.match(wrapper, /\bgrid\b|display\s*:\s*grid/);
  assert.match(row, /\bmin-width\s*:\s*0\s*;/);
  assert.match(row, /\bdisplay\s*:\s*flex\s*;/);
});

test('JSON read-check 오류는 자동 저장 보류 문구를 보이고 retry를 숨기며 정확히 안내한다', () => {
  const app = loadApp();
  app.emitFileStatus({
    phase: 'connected', fileName: 'todos.json', lastSavedAt: 123,
    saveError: false, checkError: true, retryAvailable: false,
    retrying: false, conflict: false, forcing: false
  });
  assert.equal(app.document.getElementById('file-status').textContent,
    'todos.json 연결됨 · 외부 변경 확인 실패 · 자동 저장 보류');
  assert.equal(app.document.getElementById('file-retry').hidden, true);
  assert.equal(app.document.getElementById('file-connect').disabled, false, '다시 연결은 계속 가능하다');
  app.emitFileError();
  assert.equal(app.document.getElementById('toast').textContent,
    '연결한 파일의 외부 변경 여부를 확인하지 못했습니다. 브라우저 저장 내용은 그대로 유지됩니다.');
});

test('JSON write 오류는 retryAvailable일 때만 retry를 보이고 기존 저장 실패 안내를 유지한다', () => {
  const app = loadApp();
  app.emitFileStatus({
    phase: 'connected', fileName: 'todos.json', lastSavedAt: 123,
    saveError: true, checkError: false, retryAvailable: true,
    retrying: false, conflict: false, forcing: false
  });
  assert.equal(app.document.getElementById('file-retry').hidden, false);
  app.emitFileError();
  assert.equal(app.document.getElementById('toast').textContent,
    '연결한 파일에 저장하지 못했습니다. 브라우저 저장 내용은 그대로 유지됩니다.');
});

test('JSON conflict 상태는 retry를 숨기고 정확한 중지 문구와 해결 버튼만 노출한다', () => {
  const app = loadApp();
  app.emitFileStatus({
    phase: 'connected', fileName: 'todos.json', lastSavedAt: 123,
    saveError: true, checkError: false, retryAvailable: true, retrying: false, conflict: true, forcing: false
  });
  assert.equal(app.document.getElementById('file-status').textContent,
    'todos.json 연결됨 · 외부 변경 감지 · 자동 저장 중지');
  assert.equal(app.document.getElementById('file-retry').hidden, true);
  const resolve = app.document.getElementById('file-conflict-resolve');
  assert.equal(resolve.hidden, false);
  assert.equal(resolve.disabled, false);
  assert.equal(resolve.textContent, '충돌 해결');

  app.emitFileStatus({
    phase: 'connected', fileName: 'todos.json', lastSavedAt: 123,
    saveError: false, retrying: false, conflict: false, forcing: false
  });
  assert.equal(resolve.hidden, true);
});

test('충돌 해결 dialog는 세 선택을 정확한 FileSync 메서드와 안전한 notice로 연결한다', async () => {
  const force = loadApp({ captureForceSnapshot: true, forceResult: true });
  force.document.getElementById('file-conflict-resolve').click();
  const forceDialog = force.document.getElementById('file-conflict-dialog');
  assert.equal(forceDialog.open, true);
  const forceButton = new FakeElement('button', force.document);
  forceButton.dataset.choice = 'force';
  forceDialog.dispatch('click', { target: forceButton });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(force.forceCalls, 1);
  assert.equal(force.fileSnapshots[0].categories[0].id, 'work');
  assert.equal(force.keepExternalCalls, 0);
  assert.equal(force.document.getElementById('toast').textContent,
    '앱의 최신 내용으로 파일을 덮어썼습니다.');

  const keep = loadApp({ keepExternalResult: 'disconnected' });
  const keepDialog = keep.document.getElementById('file-conflict-dialog');
  keepDialog.showModal();
  const keepButton = new FakeElement('button', keep.document);
  keepButton.dataset.choice = 'keep';
  keepDialog.dispatch('click', { target: keepButton });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(keep.keepExternalCalls, 1);
  assert.equal(keep.forceCalls, 0);
  assert.equal(keep.fileSnapshots.length, 0, 'Local JSON mirror save를 새로 만들지 않는다');
  assert.equal(keep.markdownSnapshots.length, 0, 'Markdown mirror를 건드리지 않는다');
  assert.equal(keep.document.getElementById('toast').textContent,
    '외부 파일을 유지하고 JSON 연결을 해제했습니다.');

  const cancelled = loadApp();
  const cancelDialog = cancelled.document.getElementById('file-conflict-dialog');
  cancelDialog.showModal();
  const cancelButton = new FakeElement('button', cancelled.document);
  cancelButton.dataset.choice = 'cancel';
  cancelDialog.dispatch('click', { target: cancelButton });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelDialog.open, false);
  assert.equal(cancelled.forceCalls, 0);
  assert.equal(cancelled.keepExternalCalls, 0);
});

test('충돌 해결 실패와 busy는 rejection 없이 conflict 유지 안내를 한다', async () => {
  const forceFail = loadApp({ forceResult: false });
  const dialog = forceFail.document.getElementById('file-conflict-dialog');
  dialog.showModal();
  const button = new FakeElement('button', forceFail.document);
  button.dataset.choice = 'force';
  dialog.dispatch('click', { target: button });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forceFail.document.getElementById('toast').textContent,
    '덮어쓰지 못했습니다. 외부 변경 충돌은 그대로 유지됩니다.');

  const busy = loadApp({ keepExternalResult: 'busy' });
  const busyDialog = busy.document.getElementById('file-conflict-dialog');
  busyDialog.showModal();
  const keepButton = new FakeElement('button', busy.document);
  keepButton.dataset.choice = 'keep';
  busyDialog.dispatch('click', { target: keepButton });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(busy.document.getElementById('toast').textContent,
    '파일 작업이 진행 중입니다. 끝난 뒤 다시 선택해 주세요.');
});

test('window focus와 hidden→visible은 checkExternal을 이벤트당 한 번 호출하고 rejection을 흡수한다', async () => {
  const app = loadApp();
  app.dispatchGlobal('focus');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.checkExternalCalls, 1);

  app.document.hidden = true;
  app.document.dispatch('visibilitychange');
  assert.equal(app.checkExternalCalls, 1);
  app.document.hidden = false;
  app.document.dispatch('visibilitychange');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.checkExternalCalls, 2);
});

test('정적 충돌 dialog와 버튼은 정확한 세 선택·접근성·모바일 줄바꿈 계약을 가진다', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(html, /id="file-conflict-resolve"[^>]*hidden[^>]*>충돌 해결<\/button>/);
  assert.match(html, /<dialog id="file-conflict-dialog"[^>]*aria-labelledby="file-conflict-dialog-title"/);
  assert.match(html, /data-choice="force"[^>]*>앱 내용으로 덮어쓰기<\/button>/);
  assert.match(html, /data-choice="keep"[^>]*>외부 파일 유지<\/button>/);
  assert.match(html, /data-choice="cancel"[^>]*>취소<\/button>/);
  assert.match(css, /\.file-conflict-resolve\s*,\s*\.markdown-conflict-resolve\s*\{[^}]*flex\s*:\s*none/s);
  assert.match(css, /@media[^{}]*\(max-width:[^)]*\)[\s\S]*?\.conflict-actions\s*\{[^}]*flex-direction\s*:\s*column/s);
});

test('도움말과 PRD는 JSON 외부 변경 보호와 read→write TOCTOU 잔여 한계를 명시한다', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const prd = fs.readFileSync(path.join(ROOT, 'docs/todo-app-prd.md'), 'utf8');
  assert.match(html, /외부 변경[^<]*(감지|충돌)/);
  assert.match(`${readme}\n${prd}`, /TOCTOU|read.?→.?write|읽기.?→.?쓰기/i);
  assert.match(`${readme}\n${prd}`, /best-effort|최선 노력/i);
});

test('Markdown conflict/checkError 상태와 해결 버튼은 JSON과 독립된 정확한 문구를 렌더한다', () => {
  const app = loadApp();
  const resolve = app.document.getElementById('markdown-conflict-resolve');
  const connect = app.document.getElementById('markdown-connect');
  app.emitMarkdownStatus({
    phase: 'connected', fileName: 'vault.md', lastSavedAt: 123,
    saveError: false, checkError: false, conflict: true, forcing: false
  });
  assert.equal(app.document.getElementById('markdown-status').textContent,
    'vault.md Markdown 연결됨 · 외부 변경 감지 · 자동 저장 중지');
  assert.equal(resolve.hidden, false);
  assert.equal(resolve.textContent, 'Markdown 충돌 해결');
  assert.equal(connect.disabled, false);

  app.emitMarkdownStatus({
    phase: 'connected', fileName: 'vault.md', lastSavedAt: 123,
    saveError: false, checkError: true, conflict: false, forcing: false
  });
  assert.equal(app.document.getElementById('markdown-status').textContent,
    'vault.md Markdown 연결됨 · 외부 변경 확인 실패 · 자동 저장 보류');
  assert.equal(resolve.hidden, true);

  app.emitMarkdownStatus({
    phase: 'connected', fileName: 'vault.md', lastSavedAt: 123,
    saveError: false, checkError: false, conflict: true, forcing: true
  });
  assert.equal(resolve.disabled, true);
  assert.equal(resolve.textContent, '해결 중…');
  assert.equal(connect.disabled, true);
});

test('Markdown 전용 충돌 dialog는 current Store force와 Markdown-only keep/cancel을 호출한다', async () => {
  const force = loadApp({ captureMarkdownForceSnapshot: true });
  force.document.getElementById('markdown-conflict-resolve').click();
  const dialog = force.document.getElementById('markdown-conflict-dialog');
  assert.equal(dialog.open, true);
  const forceButton = new FakeElement('button', force.document);
  forceButton.dataset.choice = 'force';
  dialog.dispatch('click', { target: forceButton });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(force.markdownForceCalls, 1);
  assert.equal(force.markdownSnapshots[0].categories[0].id, 'work');
  assert.equal(force.forceCalls, 0, 'JSON force는 독립이다');
  assert.equal(force.document.getElementById('toast').textContent,
    '앱의 최신 내용으로 Markdown 파일을 덮어썼습니다.');

  const keep = loadApp();
  const keepDialog = keep.document.getElementById('markdown-conflict-dialog');
  keepDialog.showModal();
  const keepButton = new FakeElement('button', keep.document);
  keepButton.dataset.choice = 'keep';
  keepDialog.dispatch('click', { target: keepButton });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(keep.markdownKeepExternalCalls, 1);
  assert.equal(keep.keepExternalCalls, 0);
  assert.equal(keep.fileSnapshots.length, 0);
  assert.equal(keep.markdownSnapshots.length, 0);
  assert.equal(keep.document.getElementById('toast').textContent,
    '외부 파일을 유지하고 Markdown 연결을 해제했습니다.');
});

test('Markdown 충돌 해결 실패/busy/rejection은 정확한 notice로 흡수하고 cancel은 무변경이다', async () => {
  const choose = async (app, choice) => {
    const dialog = app.document.getElementById('markdown-conflict-dialog');
    dialog.showModal();
    const button = new FakeElement('button', app.document);
    button.dataset.choice = choice;
    dialog.dispatch('click', { target: button });
    await new Promise((resolve) => setImmediate(resolve));
  };

  const forceFail = loadApp({ markdownForceResult: false });
  await choose(forceFail, 'force');
  assert.equal(forceFail.document.getElementById('toast').textContent,
    '덮어쓰지 못했습니다. Markdown 외부 변경 충돌은 그대로 유지됩니다.');

  const forceReject = loadApp({ markdownForceRejects: true });
  await choose(forceReject, 'force');
  assert.equal(forceReject.document.getElementById('toast').textContent,
    '덮어쓰지 못했습니다. Markdown 외부 변경 충돌은 그대로 유지됩니다.');

  const busy = loadApp({ markdownKeepExternalResult: 'busy' });
  await choose(busy, 'keep');
  assert.equal(busy.document.getElementById('toast').textContent,
    'Markdown 파일 작업이 진행 중입니다. 끝난 뒤 다시 선택해 주세요.');

  const keepFail = loadApp({ markdownKeepExternalRejects: true });
  await choose(keepFail, 'keep');
  assert.equal(keepFail.document.getElementById('toast').textContent,
    '외부 Markdown 파일 유지에 실패했습니다. 충돌은 그대로 유지됩니다.');

  const cancel = loadApp();
  await choose(cancel, 'cancel');
  assert.equal(cancel.markdownForceCalls, 0);
  assert.equal(cancel.markdownKeepExternalCalls, 0);
  assert.equal(cancel.document.getElementById('toast').textContent, '');
});

test('Markdown read-check 오류와 write 오류는 상태에 맞는 독립 notice를 보인다', () => {
  const check = loadApp({ markdownState: { checkError: true } });
  check.emitMarkdownError();
  assert.equal(check.document.getElementById('toast').textContent,
    '연결한 Markdown 파일의 외부 변경 여부를 확인하지 못했습니다. 브라우저와 JSON 저장 내용은 그대로 유지됩니다.');

  const write = loadApp({ markdownState: { checkError: false } });
  write.emitMarkdownError();
  assert.equal(write.document.getElementById('toast').textContent,
    'Markdown 파일에 저장하지 못했습니다. 브라우저와 JSON 저장 내용은 그대로 유지됩니다.');
});

test('focus/visible checker는 JSON과 Markdown을 각각 1회 all-settled하고 독립 throw/rejection을 흡수한다', async () => {
  const markdownThrows = loadApp({ markdownCheckThrows: true });
  markdownThrows.dispatchGlobal('focus');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(markdownThrows.checkExternalCalls, 1);
  assert.equal(markdownThrows.markdownCheckExternalCalls, 1);

  const fileRejects = loadApp({ fileCheckRejects: true });
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    fileRejects.document.hidden = false;
    fileRejects.document.dispatch('visibilitychange');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fileRejects.checkExternalCalls, 1);
    assert.equal(fileRejects.markdownCheckExternalCalls, 1);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('정적 Markdown 충돌 UI는 별도 accessible dialog와 모바일 button 계약을 가진다', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(html, /id="markdown-conflict-resolve"[^>]*hidden[^>]*>Markdown 충돌 해결<\/button>/);
  assert.match(html, /<dialog id="markdown-conflict-dialog"[^>]*aria-labelledby="markdown-conflict-dialog-title"/);
  assert.match(html, /id="markdown-conflict-dialog-title"[^>]*>Markdown 파일 충돌 해결<\/h2>/);
  assert.match(html, /id="markdown-conflict-dialog"[\s\S]*data-choice="force"[^>]*>앱 내용으로 덮어쓰기<\/button>/);
  assert.match(html, /id="markdown-conflict-dialog"[\s\S]*data-choice="keep"[^>]*>외부 파일 유지<\/button>/);
  assert.match(html, /id="markdown-conflict-dialog"[\s\S]*data-choice="cancel"[^>]*>취소<\/button>/);
  assert.match(css, /\.markdown-conflict-resolve\s*\{[^}]*flex\s*:\s*none/s);
});

test('README/PRD/help는 Markdown best-effort TOCTOU 보호와 6B2 가져오기 범위를 명시한다', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const prd = fs.readFileSync(path.join(ROOT, 'docs/todo-app-prd.md'), 'utf8');
  assert.match(html, /Markdown[^<]*외부 변경[^<]*(감지|충돌)/);
  assert.match(`${readme}\n${prd}`, /Markdown[\s\S]{0,400}(TOCTOU|read.?→.?write)/i);
  assert.match(`${readme}\n${prd}`, /Markdown[\s\S]{0,400}(best-effort|최선 노력)/i);
  assert.match(`${readme}\n${prd}`, /6B2[\s\S]{0,180}(미리|가져오기)/i);
});

test('Markdown 충돌 가져오기 정적 UI는 별도 preview와 CSP·모바일 계약을 가진다', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  assert.match(html, /id="markdown-conflict-dialog"[\s\S]*data-choice="import"[^>]*>Markdown 편집 가져오기<\/button>/);
  assert.match(html, /<dialog id="markdown-import-dialog"[^>]*aria-labelledby="markdown-import-dialog-title"/);
  assert.match(html, /id="markdown-import-dialog-text"/);
  assert.match(html, /id="markdown-import-dialog"[\s\S]*data-choice="confirm"[^>]*>가져오기<\/button>/);
  assert.ok(html.indexOf('markdown-import.js') < html.indexOf('markdown-sync.js'));
  assert.doesNotMatch(html, /<script(?![^>]*src=)[^>]*>/);
  assert.match(css, /@media[^{}]*\(max-width:[^)]*\)[\s\S]*?\.markdown-import-actions\s*\{[^}]*flex-wrap\s*:\s*wrap/s);
});

test('Markdown preview는 count summary만 textContent로 표시하고 원문·제목·태그·ID를 보존하지 않는다', async () => {
  const raw = '- [ ] <img src=x> #secret <!-- my-what-todo:id=private -->';
  const summary = { total: 3, changed: 2, completedChanged: 1, priorityChanged: 1,
    titleChanged: 1, tagsChanged: 1, categoryChanged: 0, reparented: 0, reordered: 1 };
  const app = loadApp({ markdownReadResult: { status: 'ready', text: raw, token: 'secret-token' },
    markdownParse: () => ({ data: { malicious: raw }, summary }) });
  await app.sandbox.__appTest.prepareMarkdownImport();
  const preview = app.document.getElementById('markdown-import-dialog');
  const text = app.document.getElementById('markdown-import-dialog-text');
  assert.equal(preview.open, true);
  assert.match(text.textContent, /전체 3개.*변경 2개.*완료 1.*우선순위 1.*제목 1.*태그 1.*순서 1/s);
  assert.equal(text._htmlWrites, undefined);
  assert.doesNotMatch(text.textContent + app.document.getElementById('toast').textContent, /img|secret|private|secret-token/);
  assert.deepEqual(Object.keys(app.sandbox.__appTest.state().pendingMarkdownImport).sort(),
    ['baseline', 'current', 'summary', 'token']);
});

test('Markdown preview parser 실패와 zero change는 dialog 없이 고정 안전 notice만 보인다', async () => {
  const malicious = 'RAW-ID-777 <script>secret</script>';
  const failed = loadApp({ markdownReadResult: { status: 'ready', text: malicious, token: 'x' },
    markdownParse() { throw new Error(malicious); } });
  await failed.sandbox.__appTest.prepareMarkdownImport();
  assert.equal(failed.document.getElementById('markdown-import-dialog').open, false);
  assert.equal(failed.document.getElementById('toast').textContent,
    'Markdown 편집을 가져올 수 없습니다. 앱에서 생성한 형식과 지원 범위를 확인해 주세요.');
  assert.doesNotMatch(failed.document.getElementById('toast').textContent, /RAW|script|secret|777/);

  const zero = loadApp({ markdownParse: (_text, current) => ({ data: current,
    summary: { total: 0, changed: 0, completedChanged: 0, priorityChanged: 0,
      titleChanged: 0, tagsChanged: 0, categoryChanged: 0, reparented: 0, reordered: 0 } }) });
  await zero.sandbox.__appTest.prepareMarkdownImport();
  assert.equal(zero.document.getElementById('markdown-import-dialog').open, false);
  assert.equal(zero.document.getElementById('toast').textContent, '가져올 Markdown 편집이 없습니다.');
});

test('preview 뒤 앱 baseline 변경은 Store/import/write/mirror 없이 안전하게 중단한다', async () => {
  let revision = 0;
  let storeImports = 0;
  const base = loadApp().Store;
  const Store = { ...base,
    exportData: () => ({ todos: [], categories: [{ id: 'work', name: '업무', hue: 220 }], revision }),
    importData: () => { storeImports += 1; return {}; } };
  const app = loadApp({ Store });
  await app.sandbox.__appTest.prepareMarkdownImport();
  revision = 1;
  await app.sandbox.__appTest.confirmMarkdownImport();
  assert.equal(storeImports, 0);
  assert.equal(app.fileSnapshots.length, 0);
  assert.equal(app.markdownSnapshots.length, 0);
  assert.equal(app.document.getElementById('toast').textContent,
    '미리보기 뒤 앱 내용이 바뀌었습니다. 충돌 해결을 다시 열어 주세요.');
});

test('Markdown import 성공은 verified text 재parse·Store 1회·JSON mirror만 수행하고 count만 알린다', async () => {
  const first = { todos: [], categories: [{ id: 'work', name: '업무', hue: 220 }] };
  const applied = { todos: [{ id: 'safe' }], categories: first.categories };
  let snapshot = first;
  let imports = 0;
  const parsedTexts = [];
  const Store = { ...loadApp().Store, exportData: () => snapshot,
    importData(data) { imports += 1; snapshot = data; return { todos: 1, categories: 1 }; } };
  const app = loadApp({ Store, verifiedText: 'verified exact', markdownParse(text) {
    parsedTexts.push(text);
    return { data: applied, summary: { total: 1, changed: 1, completedChanged: 0,
      priorityChanged: 0, titleChanged: 1, tagsChanged: 0, categoryChanged: 0,
      reparented: 0, reordered: 0 } };
  } });
  app.sandbox.__appTest.showUndo([{ id: 'old' }]);
  await app.sandbox.__appTest.prepareMarkdownImport();
  await app.sandbox.__appTest.confirmMarkdownImport();
  assert.deepEqual(parsedTexts, ['verified markdown', 'verified exact']);
  assert.equal(imports, 1);
  assert.deepEqual(app.fileSnapshots, [applied]);
  assert.equal(app.markdownSnapshots.length, 0);
  assert.equal(app.sandbox.__appTest.state().pendingUndo, null);
  assert.equal(app.document.getElementById('search-input').value, '');
  assert.equal(app.document.getElementById('toast').textContent, '1개 항목의 Markdown 편집을 가져왔습니다.');
});

test('Markdown applied-write/render 오류와 적용 뒤 rejection도 rollback 없이 UI와 JSON mirror를 끝낸다', async () => {
  for (const status of ['applied-write-error', 'applied-render-error']) {
    const app = loadApp({ markdownImportResult: { status }, storeImportResult: { todos: 1 } });
    await app.sandbox.__appTest.prepareMarkdownImport();
    await app.sandbox.__appTest.confirmMarkdownImport();
    assert.equal(app.fileSnapshots.length, 1);
    assert.equal(app.markdownSnapshots.length, 0);
    assert.match(app.document.getElementById('toast').textContent,
      /브라우저 저장에는 적용했지만 Markdown 정본 저장에 실패.*충돌은 유지/s);
  }

  const rejectedAfterApply = loadApp({
    storeImportResult: { todos: 1 },
    onMarkdownImport(_token, apply) {
      apply('verified markdown');
      return Promise.reject(new Error('private post-apply rejection'));
    }
  });
  await rejectedAfterApply.sandbox.__appTest.prepareMarkdownImport();
  await rejectedAfterApply.sandbox.__appTest.confirmMarkdownImport();
  assert.equal(rejectedAfterApply.importCount, 1);
  assert.equal(rejectedAfterApply.fileSnapshots.length, 1);
  assert.equal(rejectedAfterApply.markdownSnapshots.length, 0);
  assert.match(rejectedAfterApply.document.getElementById('toast').textContent,
    /브라우저 저장에는 적용했지만 Markdown 정본 저장에 실패.*충돌은 유지/s);
  assert.doesNotMatch(rejectedAfterApply.document.getElementById('toast').textContent, /private|rejection/);
});

test('Markdown Store 실패·changed·rejection은 UI reset이나 mirror 없이 안전하게 흡수한다', async () => {
  const failed = loadApp({ storeImportResult: null });
  await failed.sandbox.__appTest.prepareMarkdownImport();
  await failed.sandbox.__appTest.confirmMarkdownImport();
  assert.equal(failed.fileSnapshots.length, 0);
  assert.equal(failed.markdownSnapshots.length, 0);
  assert.equal(failed.document.getElementById('toast').textContent,
    '브라우저 저장소에 저장하지 못했습니다. Markdown 충돌은 그대로 유지됩니다.');

  const changed = loadApp({ onMarkdownImport: () => Promise.resolve({ status: 'changed' }) });
  await changed.sandbox.__appTest.prepareMarkdownImport();
  await changed.sandbox.__appTest.confirmMarkdownImport();
  assert.equal(changed.importCount, 0);
  assert.equal(changed.fileSnapshots.length, 0);
  assert.equal(changed.document.getElementById('toast').textContent,
    'Markdown 파일이 다시 바뀌었습니다. 충돌 해결을 다시 열어 주세요.');

  const rejected = loadApp({ markdownImportRejects: true });
  await rejected.sandbox.__appTest.prepareMarkdownImport();
  await rejected.sandbox.__appTest.confirmMarkdownImport();
  assert.match(rejected.document.getElementById('toast').textContent, /가져오지 못했습니다/);
  assert.doesNotMatch(rejected.document.getElementById('toast').textContent, /raw|secret|rejection/);
});

// ── 뽀모도로 구간 수동 전환 (F-22a) ────────────────────

/** 소리를 냈는지 세려고 AudioContext를 갈아 끼운다. pomoChime이 매번 다시 읽는다. */
function countChimes(app) {
  const calls = { count: 0 };
  class Counting { constructor() { calls.count += 1; } }
  app.sandbox.AudioContext = Counting;
  app.sandbox.webkitAudioContext = Counting;
  return calls;
}

const lastRun = (app) => app.savedRuns[app.savedRuns.length - 1];

test('사이클 집중이 끝나면 다음 구간으로 넘어가지 않고 휴식 시작을 기다린다', () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;
  t.togglePomo(true); // 패널 안을 볼 것이므로 사용자가 하듯 먼저 편다
  const chimes = countChimes(app);

  t.cycleEnter(0, 'focus', true);
  t.expirePomo();

  const state = t.pomoState();
  assert.deepEqual(plain(state.pendingNext), { round: 0, phase: 'rest' });
  assert.equal(state.pomoEndsAt, null, '기다리는 동안에는 시계가 돌지 않는다');
  assert.equal(state.pomoLeft, 0);
  assert.equal(state.cyclePhase, 'focus', '끝난 구간을 그대로 붙들고 있다');

  assert.equal(app.document.getElementById('pomo-next').textContent, '휴식 시작');
  assert.equal(app.document.getElementById('pomo-next').hidden, false);
  assert.equal(app.document.getElementById('pomo-toggle').hidden, true,
    '기다리는 동안 `다시 시작`을 함께 두면 어느 쪽이 사이클을 잇는지 읽히지 않는다');
  assert.equal(app.document.getElementById('pomo-time').textContent, '00:00');
  assert.equal(app.document.title, '휴식 시작 · My What Todo');
  assert.equal(chimes.count, 1, '끝났다는 것은 소리로도 알린다');
  assert.equal(app.document.getElementById('toast').textContent,
    '집중 1/4 구간이 끝났습니다. 휴식 시작을 누르면 이어집니다.');

  // 눌러야 비로소 다음 구간이 돈다
  t.pomoAdvance();
  const next = t.pomoState();
  assert.equal(next.pendingNext, null);
  assert.equal(next.cyclePhase, 'rest');
  assert.equal(next.cycleRound, 0);
  assert.equal(next.pomoLength, 5 * 60);
  assert.notEqual(next.pomoEndsAt, null);
});

test('휴식이 끝날 때도 기다리고, 누르면 다음 회차 집중으로 넘어간다', () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;
  t.togglePomo(true); // 패널 안을 볼 것이므로 사용자가 하듯 먼저 편다

  t.cycleEnter(0, 'rest', true);
  t.expirePomo();

  assert.deepEqual(plain(t.pomoState().pendingNext), { round: 1, phase: 'focus' });
  assert.equal(app.document.getElementById('pomo-next').textContent, '집중 시작');
  assert.equal(app.document.getElementById('toast').textContent,
    '휴식 1/4 구간이 끝났습니다. 집중 시작을 누르면 이어집니다.');

  t.pomoAdvance();
  assert.equal(t.pomoState().cycleRound, 1);
  assert.equal(t.pomoState().cyclePhase, 'focus');
});

test('마지막 회차 집중 뒤에는 긴 휴식을 기다리고, 그 뒤 1회차로 돌아온다', () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;
  t.togglePomo(true); // 패널 안을 볼 것이므로 사용자가 하듯 먼저 편다

  t.cycleEnter(3, 'focus', true);
  t.expirePomo();
  assert.equal(app.document.getElementById('pomo-next').textContent, '긴 휴식 시작');

  t.pomoAdvance();
  assert.equal(t.pomoState().pomoLength, 25 * 60, '4회차 휴식만 길게 잡는다');

  t.expirePomo();
  assert.deepEqual(plain(t.pomoState().pendingNext), { round: 0, phase: 'focus' }, '한 바퀴를 돌면 처음으로');
});

test('기다리는 상태는 세션 기록에 남아 새로고침을 넘긴다', () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;

  t.cycleEnter(2, 'focus', true);
  t.expirePomo();
  assert.deepEqual(lastRun(app).next, { round: 2, phase: 'rest' });

  // 그 기록으로 다시 열면 기다리던 자리에 그대로 선다. 패널도 펴 준다 —
  // 눌러야 이어지는 버튼이 접힌 채로 남으면 사이클이 여기서 끝난 것과 같다.
  const back = loadApp({ run: lastRun(app) });
  const chimes = countChimes(back);
  back.sandbox.__appTest.togglePomo(false);
  back.sandbox.__appTest.restorePomoRun();

  assert.deepEqual(plain(back.sandbox.__appTest.pomoState().pendingNext), { round: 2, phase: 'rest' });
  assert.equal(back.document.getElementById('pomodoro').hidden, false);
  assert.equal(back.document.getElementById('pomo-next').textContent, '휴식 시작');
  assert.equal(chimes.count, 0, '되살리면서 소리를 다시 내지는 않는다');
});

test('자리를 비운 사이에 끝난 구간은 소리 없이 다음 구간 대기로 되살아난다', () => {
  const app = loadApp({
    run: { endsAt: Date.now() - 90 * 1000, left: 1500, length: 1500, round: 2, phase: 'focus', next: null }
  });
  const t = app.sandbox.__appTest;
  const chimes = countChimes(app);
  t.togglePomo(false);
  t.restorePomoRun();

  assert.deepEqual(plain(t.pomoState().pendingNext), { round: 2, phase: 'rest' },
    '00:00만 남겨두면 사이클을 이으려고 처음부터 다시 걸어야 한다');
  assert.equal(t.pomoState().pomoLeft, 0);
  assert.equal(app.document.getElementById('pomodoro').hidden, false);
  assert.equal(chimes.count, 0, '흘려보낸 시간을 이제 와 소리로 알리지 않는다');
  assert.equal(app.document.getElementById('toast').textContent, '', '알림도 뒤늦게 띄우지 않는다');
});

test('되살린 남은 시간은 설정 길이를 넘지 않는다', () => {
  // 끝나는 시각은 남길 때 `지금 + 남은 시간`이라 길이를 넘을 수 없다.
  // 그 사이에 기기 시계가 뒤로 조정되면 넘는다.
  const app = loadApp({
    run: { endsAt: Date.now() + 40 * 60 * 1000, left: 1500, length: 1500, round: 0, phase: 'focus', next: null }
  });
  app.sandbox.__appTest.restorePomoRun();

  assert.equal(app.sandbox.__appTest.pomoState().pomoLeft, 1500);
  assert.equal(app.document.getElementById('pomo-time').textContent, '25:00',
    '25분짜리가 40분을 가리키면 안 된다');
});

test('돌아갈 시간이 남은 기록에서는 함께 적힌 대기 구간을 버린다', () => {
  // 우리가 남기는 짝은 아니지만 세션 저장소는 사용자가 고칠 수 있는 자리다.
  const app = loadApp({
    run: {
      endsAt: Date.now() + 600 * 1000, left: 1500, length: 1500,
      round: 1, phase: 'focus', next: { round: 1, phase: 'rest' }
    }
  });
  const t = app.sandbox.__appTest;
  t.restorePomoRun();

  assert.equal(t.pomoState().pendingNext, null);
  assert.notEqual(t.pomoState().pomoEndsAt, null);
  assert.equal(app.document.getElementById('pomo-next').hidden, true);
  assert.equal(app.document.getElementById('pomo-toggle').hidden, false);
});

test('기다리는 중 회차 길이를 고쳐도 대기가 지워지지 않고 새 길이로 시작한다', () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;
  t.togglePomo(true); // 패널 안을 볼 것이므로 사용자가 하듯 먼저 편다

  t.cycleEnter(0, 'focus', true);
  t.expirePomo();
  assert.deepEqual(plain(t.pomoState().pendingNext), { round: 0, phase: 'rest' });

  // 설정 칸 하나를 고친다 — 실제 change 경로를 그대로 탄다
  const rows = app.document.getElementById('pomo-set-rows');
  const field = app.document.createElement('input');
  field.classList.add('pomo-set-input');
  field.dataset.round = '0';
  field.dataset.key = 'rest';
  field.value = '9';
  rows.appendChild(field);
  rows.dispatch('change', { target: field });

  assert.deepEqual(plain(t.pomoState().pendingNext), { round: 0, phase: 'rest' },
    '여기서 구간을 다시 세우면 눌러야 할 `휴식 시작`이 소리 없이 사라진다');
  assert.equal(app.document.getElementById('pomo-next').hidden, false);

  t.pomoAdvance();
  assert.equal(t.pomoState().pomoLength, 9 * 60, '새 길이는 누를 때 다시 읽는다');
});

test('단일 타이머는 기다리지 않고 00:00에서 다시 시작을 남긴다', () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;
  t.togglePomo(true); // 패널 안을 볼 것이므로 사용자가 하듯 먼저 편다

  t.pomoSet(60);
  t.pomoAct();          // 시작
  t.expirePomo();

  assert.equal(t.pomoState().pendingNext, null, '이어질 다음 구간이 없다');
  assert.equal(app.document.getElementById('pomo-next').hidden, true);
  assert.equal(app.document.getElementById('pomo-toggle').hidden, false);
  assert.equal(app.document.getElementById('pomo-toggle').textContent, '다시 시작');
  assert.equal(app.document.getElementById('toast').textContent, '1분이 끝났습니다.');
});

test('초기화와 프리셋은 기다리던 구간을 함께 걷어낸다', () => {
  for (const clear of ['reset', 'preset']) {
    const app = loadApp();
    const t = app.sandbox.__appTest;
    t.togglePomo(true);
    t.cycleEnter(1, 'focus', true);
    t.expirePomo();
    assert.notEqual(t.pomoState().pendingNext, null);

    if (clear === 'reset') t.cycleEnter(0, 'focus', false);
    else t.pomoSet(15 * 60);

    assert.equal(t.pomoState().pendingNext, null, `${clear} 뒤에 대기가 남으면 안 된다`);
    assert.equal(lastRun(app).next, null);
    assert.equal(app.document.getElementById('pomo-next').hidden, true);
    assert.equal(app.document.getElementById('pomo-toggle').hidden, false);
  }
});

// ── 미니 타이머 ─────────────────────────────────────────

test('미니 타이머는 패널이 닫혀 있을 때만 뜨고 ×로 거둔 뒤 패널을 다시 열면 되살아난다', () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;
  const mini = app.document.getElementById('pomo-mini');

  t.togglePomo(true);
  t.cycleEnter(0, 'focus', true);
  assert.equal(mini.hidden, true, '패널이 보이는데 같은 시계를 두 번 그리지 않는다');

  t.togglePomo(false);
  assert.equal(mini.hidden, false);
  assert.equal(app.document.body.classList.contains('has-mini'), true,
    '토스트가 이 자리로 올라오지 않게 알린다');
  assert.equal(app.document.getElementById('pomo-mini-phase').textContent, '집중 1/4');

  app.document.getElementById('pomo-mini-close').click();
  assert.equal(mini.hidden, true);
  assert.equal(app.document.body.classList.contains('has-mini'), false);

  t.togglePomo(true);
  t.togglePomo(false);
  assert.equal(mini.hidden, false, '한 번 거뒀다고 이 탭이 사는 내내 되살릴 길이 없으면 안 된다');
});

test('미니 타이머는 걸린 판이 없으면 패널을 닫아도 뜨지 않는다', () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;

  t.togglePomo(false);
  assert.equal(app.document.getElementById('pomo-mini').hidden, true, '건드린 적 없는 타이머');

  t.cycleEnter(0, 'focus', true);
  t.expirePomo();
  assert.equal(app.document.getElementById('pomo-mini').hidden, false, '기다리는 중에는 뜬다');
  assert.equal(app.document.getElementById('pomo-mini-next').textContent, '휴식 시작');

  // 미니에서 바로 이을 수 있어야 한다. 패널을 열어야만 누를 수 있으면 둔 이유가 없다.
  app.document.getElementById('pomo-mini-next').click();
  assert.equal(t.pomoState().cyclePhase, 'rest');
  assert.equal(app.document.getElementById('pomo-mini-next').hidden, true);
});

test('사라지는 버튼은 포커스를 자리를 이어받는 버튼에게 넘긴다', () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;
  const id = (name) => app.document.getElementById(name);
  const focused = () => app.document.activeElement;

  // 가짜 문서의 getElementById는 서로 이어지지 않은 요소를 만든다. 미니 타이머는
  // "이 안에 포커스가 있었나"로 판정하므로 실제 마크업대로 묶어준다.
  for (const child of ['pomo-mini-open', 'pomo-mini-next', 'pomo-mini-close']) {
    id('pomo-mini').appendChild(id(child));
  }

  // 1) 시간이 되어 `시작`이 사라지는 자리 — 마침 거기에 포커스가 있었다
  t.togglePomo(true);
  t.cycleEnter(0, 'focus', true);
  id('pomo-toggle').focus();
  t.expirePomo();
  assert.equal(focused(), id('pomo-next'), '`시작`이 사라지면 `휴식 시작`이 받는다');

  // 2) 그 `휴식 시작`을 눌러 넘어가면 이번엔 그것이 사라진다
  id('pomo-next').click();
  assert.equal(focused(), id('pomo-toggle'));

  // 3) 미니 타이머의 × — 미니가 통째로 사라지므로 헤더 버튼이 받는다
  t.togglePomo(false);
  assert.equal(id('pomo-mini').hidden, false);
  id('pomo-mini-close').focus();
  id('pomo-mini-close').click();
  assert.equal(focused(), id('pomo-button'));

  // 4) 포커스가 그 버튼에 없었다면 건드리지 않는다
  t.togglePomo(true);
  t.togglePomo(false);
  const outside = id('add-input');
  outside.focus();
  id('pomo-mini-open').click();
  assert.equal(focused(), outside, '누르지도 않은 곳의 포커스를 뺏지 않는다');
});

// ── 빼놓은 창 ───────────────────────────────────────────

/** 저 창의 노드를 클래스로 집는다. 가짜 문서에는 선택자 엔진이 없다. */
function pipParts(app) {
  const win = app.pipWindow;
  const find = (cls, node = win.document.body) => {
    for (const child of node.childNodes) {
      if (child.classList?.contains(cls)) return child;
      const deeper = find(cls, child);
      if (deeper) return deeper;
    }
    return null;
  };
  return { win, find,
    time: find('pip-time'), phase: find('pip-phase'),
    action: find('pip-action'), mode: find('pip-mode'),
    face: find('pomo-dial-face'), fill: find('pomo-dial-fill') };
}

test('빼놓은 창은 눈금과 시간, 누를 것과 보기 방식 버튼을 세운다', async () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;

  t.cycleEnter(0, 'focus', true);
  await t.openPip();

  const p = pipParts(app);
  assert.ok(p.time && p.phase && p.action && p.mode && p.face && p.fill, '여섯 자리가 다 선다');
  assert.equal(p.win.document.body.classList.contains('pip'), true);
  assert.equal(p.win.document.documentElement.lang, 'ko');
  assert.equal(app.pipTimers, 1, '저 창 자신의 인터벌을 건다 — 배경 탭 스로틀링을 비켜간다');

  // 누를 것은 원 안(라벨)에 있다. 밖에 줄을 두면 그만큼 창이 커져야 한다.
  assert.equal(p.action.parentNode.classList.contains('pomo-dial-label'), true);

  // 열자마자 화면이 채워져 있다 (renderPomo가 openPip 끝에서 한 번 돈다)
  assert.equal(p.time.textContent, '25:00');
  assert.equal(p.phase.textContent, '집중 1/4');
  assert.equal(p.win.document.body.classList.contains('is-running'), true);
});

test('빼놓은 창의 아이콘과 읽히는 이름은 상태를 따라간다', async () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;
  const ICONS = t.PIP_ICONS;

  t.togglePomo(true); // 아래에서 패널의 글자와 견준다
  t.cycleEnter(0, 'focus', true);
  await t.openPip();
  const p = pipParts(app);
  const shape = () => p.action.dataset.shape;

  assert.equal(shape(), ICONS.pause, '돌아가는 중에는 멈추기');
  assert.equal(p.action.getAttribute('aria-label'), '일시정지');

  t.pomoAct();                       // 일시정지
  assert.equal(shape(), ICONS.play, '멈춘 뒤에는 돌리기');
  // 무슨 글자인지는 흐른 시간에 달렸다(`시작`·`계속`·`다시 시작`). 검사할 것은
  // **창과 패널이 같은 말을 하는가**다 — 갈라지면 어느 쪽이 맞는지 알 수 없다.
  assert.equal(p.action.getAttribute('aria-label'),
    app.document.getElementById('pomo-toggle').textContent);

  t.pomoAct();                       // 계속
  t.expirePomo();                    // 구간 끝
  assert.equal(shape(), ICONS.next, '기다릴 때는 다음 구간으로 — 다시 미는 것과 다른 일이다');
  assert.equal(p.action.getAttribute('aria-label'), '휴식 시작');
  assert.equal(p.phase.textContent, '휴식 시작',
    '아이콘만으로는 `계속`과 갈라지지 않아, 이름 자리에 누를 것을 적는다');
  assert.equal(p.win.document.body.classList.contains('is-waiting'), true);
});

test('빼놓은 창은 1초마다 아이콘을 다시 만들지 않는다', async () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;

  t.cycleEnter(0, 'focus', true);
  await t.openPip();
  const p = pipParts(app);

  const before = p.action.childNodes[0];
  for (let i = 0; i < 5; i++) t.renderPomo();
  assert.equal(p.action.childNodes[0], before, '같은 모양이면 손대지 않는다');

  t.pomoAct(); // 멈추면 모양이 바뀌므로 이때만 갈린다
  assert.notEqual(p.action.childNodes[0], before);
});

test('보기 방식 버튼은 클래스와 저장값을 함께 바꾸고, 기본은 원형 시계다', async () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;

  assert.equal(app.Store.getPipDial(), true, '처음 열면 원형 시계다');

  t.cycleEnter(0, 'focus', true);
  await t.openPip();
  const p = pipParts(app);

  assert.equal(p.win.document.body.classList.contains('is-text'), false);
  assert.equal(p.mode.getAttribute('aria-label'), '숫자만 보기');

  p.mode.click();
  assert.equal(app.Store.getPipDial(), false, '고른 것은 저장된다');
  assert.equal(p.win.document.body.classList.contains('is-text'), true);
  assert.equal(p.mode.getAttribute('aria-label'), '원형 시계로 보기');

  p.mode.click();
  assert.equal(app.Store.getPipDial(), true);
  assert.equal(p.win.document.body.classList.contains('is-text'), false);
});

test('빼놓은 창은 테마를 따라가고, 닫으면 인터벌과 참조를 놓는다', async () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;

  t.cycleEnter(0, 'focus', true);
  await t.openPip();
  const p = pipParts(app);

  app.document.documentElement.dataset.theme = 'dark';
  app.sandbox.__appTest.renderPomo();
  // 테마는 renderTheme이 물려준다. 여기서는 그 경로를 직접 부른다.
  app.document.getElementById('theme-toggle').dispatch('click');
  assert.equal(p.win.document.documentElement.dataset.theme,
    app.document.documentElement.dataset.theme, '저 창만 반대 색으로 남지 않는다');

  // 미니 타이머는 접힌다 — 같은 시계를 두 군데 띄우지 않는다
  t.togglePomo(false);
  assert.equal(app.document.getElementById('pomo-mini').hidden, true);

  p.win.close();
  assert.equal(app.pipWindow, null);
  assert.equal(app.pipTimers, 0, '거두지 않으면 닫힌 창의 인터벌이 남는다');
  assert.equal(app.document.getElementById('pomo-mini').hidden, false,
    '창이 닫혔으니 미니 타이머가 다시 그 자리를 맡는다');

  // 창으로 빼기 버튼은 패널 안에 있다. 접혀 있는 동안에는 손대지 않고(아무도 못 본다),
  // 펴는 순간 제 글자를 되찾는다.
  t.togglePomo(true);
  assert.equal(app.document.getElementById('pomo-pip').getAttribute('aria-label'),
    '타이머를 창으로 빼기');
});

test('창을 열지 못하면 알리고, 두 번 눌러도 두 번 열지 않는다', async () => {
  const denied = loadApp({ pipRejects: true });
  await denied.sandbox.__appTest.openPip();
  assert.equal(denied.pipWindow, null);
  assert.match(denied.document.getElementById('toast').textContent, /창을 열지 못했습니다/);

  const app = loadApp();
  await Promise.all([app.sandbox.__appTest.openPip(), app.sandbox.__appTest.openPip()]);
  assert.notEqual(app.pipWindow, null);
  assert.equal(app.pipTimers, 1, '두 번째 요청은 거절당하므로 아예 보내지 않는다');
});

test('지원하지 않는 브라우저에서는 창으로 빼기에 손잡이조차 달지 않는다', async () => {
  const app = loadApp({ pipUnsupported: true });
  await app.sandbox.__appTest.openPip();
  assert.equal(app.pipWindow, null);
  // 마크업의 hidden을 풀지도, 누를 손잡이를 달지도 않는다 —
  // 자리만 남겨두면 눌러도 아무 일이 없는 버튼이 된다.
  assert.equal(app.document.getElementById('pomo-pip').listeners.has('click'), false);

  const supported = loadApp();
  assert.equal(supported.document.getElementById('pomo-pip').listeners.has('click'), true);
  assert.equal(supported.document.getElementById('pomo-pip').hidden, false);
});

test('접혀 있는 자리에는 쓰지 않고, 펴는 순간 따라잡는다', () => {
  const app = loadApp();
  const t = app.sandbox.__appTest;
  const id = (n) => app.document.getElementById(n);

  t.togglePomo(true);
  t.pomoSet(60);                       // 패널은 펴고 시계는 접은 기본 상태

  assert.equal(id('pomo-time').textContent, '01:00', '보이는 시계는 따라온다');
  assert.notEqual(id('pomo-dial-time').textContent, '01:00',
    '접힌 시계에는 쓰지 않는다 — 아무도 못 보는 자리다');

  // 펴면 그 자리에서 채워진다. 접힌 동안 밀린 것이 남지 않는다.
  t.togglePomoView(id('pomo-dial'), id('pomo-expand'), true);
  t.renderPomo();
  assert.equal(id('pomo-dial-time').textContent, '01:00', '펴는 순간 따라잡는다');

  // 패널을 접으면 그 안 전체를 건너뛴다. 미니 타이머만 따라온다.
  t.togglePomo(false);
  t.cycleEnter(1, 'rest', true);       // 한 판을 걸어 미니가 뜨게 한다
  assert.equal(id('pomo-mini').hidden, false);
  assert.equal(id('pomo-mini-time').textContent, '05:00', '보이는 미니 타이머는 따라온다');
  assert.equal(id('pomo-time').textContent, '01:00', '접힌 패널 안은 그대로 둔다');
  assert.equal(id('pomo-dial-time').textContent, '01:00');

  // 다시 펴면 한 번에 따라잡는다
  t.togglePomo(true);
  assert.equal(id('pomo-time').textContent, '05:00');
  assert.equal(id('pomo-dial-time').textContent, '05:00');
});

// ── 미니 타이머 불투명도 ────────────────────────────────

test('불투명도는 끄는 동안 화면만 따라오고 손을 뗄 때 한 번 저장한다', () => {
  const app = loadApp();
  const slider = app.document.getElementById('pomo-veil');
  const mini = app.document.getElementById('pomo-mini');
  const readVeil = () => mini.style.getPropertyValue('--mini-veil');

  // 테스트 하네스는 init 블록을 떼어내므로 그 자리에서 도는 것과 같은 경로를 부른다
  app.sandbox.__appTest.paintMiniVeil(app.Store.getMiniOpacity());
  assert.equal(readVeil(), '82%', '저장본에 든 값으로 먼저 칠한다');

  // 끄는 중 — 화면은 따라오되 저장은 하지 않는다. 매 순간 저장하면 판 번호가
  // 수십 번 올라가 다른 탭이 그때마다 통째로 다시 읽는다.
  for (const value of ['70', '55', '40']) {
    slider.value = value;
    slider.dispatch('input');
  }
  assert.equal(readVeil(), '40%');
  assert.equal(app.document.getElementById('pomo-veil-value').textContent, '40%');
  assert.equal(app.Store.getMiniOpacity(), 82, '아직 저장하지 않았다');

  // 손을 뗄 때 한 번
  slider.dispatch('change');
  assert.equal(app.Store.getMiniOpacity(), 40);
  assert.equal(readVeil(), '40%');
});

test('불투명도 손잡이는 저장된 값을 그대로 되돌려준다', () => {
  // step이 1이 아니면 저장된 82가 손잡이에서 80으로 스냅되어, 숫자와 손잡이가
  // 어긋나고 끌어서 82로 돌아갈 길이 사라진다.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const tag = /<input\b[^>]*\bid="pomo-veil"[^>]*>/.exec(html);
  assert.ok(tag, '불투명도 손잡이를 찾지 못했다');
  assert.match(tag[0], /\bstep="1"/);
  assert.match(tag[0], /\bmin="0"/);
  assert.match(tag[0], /\bmax="100"/);
});

test('불투명도 저장이 실패하면 화면을 저장본 값으로 되맞춘다', () => {
  const app = loadApp({ miniOpacityResult: null });
  const slider = app.document.getElementById('pomo-veil');
  const mini = app.document.getElementById('pomo-mini');

  slider.value = '10';
  slider.dispatch('input');
  assert.equal(mini.style.getPropertyValue('--mini-veil'), '10%');

  slider.dispatch('change');
  assert.equal(mini.style.getPropertyValue('--mini-veil'), '82%',
    '화면은 옅은데 다음에 열면 진한 채로 돌아오면 안 된다');
  assert.equal(slider.value, '82');
  assert.match(app.document.getElementById('toast').textContent, /저장하지 못했습니다/);
});

test('상태가 통째로 갈리면 불투명도 칸도 함께 따라간다', () => {
  const app = loadApp({ miniOpacity: 35 });
  const mini = app.document.getElementById('pomo-mini');
  const slider = app.document.getElementById('pomo-veil');

  // 다른 탭이 쓴 것을 채택하는 길. 회차 칸과 같은 함정이라 같은 자리에서 함께 맞춘다.
  app.sandbox.__appTest.adoptExternal();
  assert.equal(mini.style.getPropertyValue('--mini-veil'), '35%');
  assert.equal(slider.value, '35');

  // 상태가 통째로 갈린 자리에서는 포커스가 손잡이에 있어도 저장본이 이긴다.
  // 회차 칸과 같은 규칙이다 — 화면에 남은 값이 저장본과 다르면 그쪽이 거짓말이다.
  app.document.activeElement = slider;
  slider.value = '90';
  app.sandbox.__appTest.adoptExternal();
  assert.equal(slider.value, '35');

  // 반면 회차 하나를 고친 뒤의 되맞춤은 손 안에 있는 칸을 건드리지 않는다
  slider.value = '90';
  app.sandbox.__appTest.syncPomoSettings(false);
  assert.equal(slider.value, '90');
});

// ── 문의하기 ────────────────────────────────────────────

test('가장 긴 한글 문의도 mailto 주소가 2000자에 닿지 않는다', () => {
  // 한 글자당 인코딩 길이가 제일 긴 것이 한글이다 (UTF-8 3바이트 → %XX%XX%XX, 9자).
  // ASCII는 1~3자, 줄바꿈은 3자라 여기에 못 미친다.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const maxOf = (id) => {
    const tag = new RegExp(`<(?:input|textarea)\\b[^>]*\\bid="${id}"[^>]*>`).exec(html);
    assert.ok(tag, `${id} 칸을 찾지 못했다`);
    const found = /\bmaxlength="(\d+)"/.exec(tag[0]);
    assert.ok(found, `${id}에 maxlength가 없다`);
    return Number(found[1]);
  };

  const subject = maxOf('contact-subject');
  const body = maxOf('contact-body');

  // `mailto:`(7) + 주소(22자, app.js의 CONTACT_PARTS) + `?subject=`(9) + `&body=`(6)
  const fixed = 7 + 22 + 9 + 6;
  const worst = fixed + 9 * (subject + body);

  // 2000자는 일부 메일 앱과 운영체제가 주소 뒤를 자르기 시작하는 자리다.
  assert.ok(worst < 2000, `제목 ${subject}자 + 내용 ${body}자 → 최악 ${worst}자로 2000자를 넘는다`);
});

test('빈 문의는 토스트가 아니라 상자 안에서 막고, 실행 취소 5초를 뺏지 않는다', async () => {
  const app = loadApp();
  const dialog = app.document.getElementById('contact-dialog');
  const error = app.document.getElementById('contact-error');
  const body = app.document.getElementById('contact-body');
  const send = () => dialog.dispatch('click', {
    target: { closest: (s) => (s === '[data-choice]' ? { dataset: { choice: 'send' } } : null) }
  });

  // 되돌릴 것이 걸려 있는 상태에서 눌러본다. 토스트로 알렸다면 이 5초에 밀려
  // 아무 일도 일어나지 않은 것처럼 보였을 자리다.
  app.sandbox.__appTest.showUndo([{ id: 'a' }]);
  const toastBefore = app.document.getElementById('toast').textContent;

  app.document.getElementById('contact-button').click();
  body.value = '   ';
  send();

  assert.equal(dialog.open, true, '내용이 비면 상자를 닫지 않는다');
  assert.equal(error.hidden, false);
  assert.equal(body.getAttribute('aria-invalid'), 'true');
  assert.equal(app.document.getElementById('toast').textContent, toastBefore,
    '실행 취소 토스트를 건드리지 않는다');

  // role="alert"이라 자리를 먼저 열고 글은 다음 태스크에 넣는다
  assert.equal(error.textContent, '');
  app.timers.forEach((fn) => fn());
  assert.equal(error.textContent, '내용을 적어주세요.');

  // 내용을 채우면 오류를 거두고 상자를 닫는다
  body.value = '실제 내용';
  send();
  assert.equal(dialog.open, false);
  assert.equal(error.hidden, true);
  assert.equal(body.getAttribute('aria-invalid'), 'false');
  assert.equal(body.value, '', '메일 앱에 넘긴 뒤에만 비운다');
});

// ── 세션 기록 검증 (store) ──────────────────────────────

test('loadRun은 사이클이 아닌 기록과 망가진 next를 버린다', () => {
  const base = { endsAt: null, left: 300, length: 300, phase: 'focus' };
  const { Store, sessionStorage } = loadStore({ context: true });
  const read = (run) => {
    sessionStorage.setItem('daily-todo:v1:run', JSON.stringify(run));
    return Store.loadRun();
  };

  assert.deepEqual(plain(read({ ...base, round: 1, next: { round: 2, phase: 'rest' } }).next),
    { round: 2, phase: 'rest' });

  // 단일 타이머에는 이어질 다음 구간이 없다. 남겨두면 눌러도 갈 곳이 없는 버튼이 선다.
  assert.equal(read({ ...base, round: null, next: { round: 2, phase: 'rest' } }).next, null);
  // 회차가 망가져 단일로 되살아나는 기록도 같은 자리에서 함께 걸러야 한다.
  assert.equal(read({ ...base, round: 99, next: { round: 2, phase: 'rest' } }).next, null);

  assert.equal(read({ ...base, round: 1, next: { round: 4, phase: 'rest' } }).next, null);
  assert.equal(read({ ...base, round: 1, next: { round: 1.5, phase: 'rest' } }).next, null);
  assert.equal(read({ ...base, round: 1, next: 'rest' }).next, null);
  assert.equal(read({ ...base, round: 1 }).next, null);
  // 알 수 없는 구간 이름은 집중으로 읽는다. loadRun의 phase와 같은 태도다.
  assert.deepEqual(plain(read({ ...base, round: 1, next: { round: 0, phase: 'nope' } }).next),
    { round: 0, phase: 'focus' });
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
