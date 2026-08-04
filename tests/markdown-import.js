'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

function load() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source('markdown-export.js'), sandbox, { filename: 'markdown-export.js' });
  vm.runInContext(source('markdown-import.js'), sandbox, { filename: 'markdown-import.js' });
  return sandbox;
}

function snapshot(overrides = {}) {
  return {
    version: 4,
    theme: 'dark',
    sort: 'manual',
    pomodoro: [
      { focus: 25, rest: 5 }, { focus: 30, rest: 6 },
      { focus: 35, rest: 7 }, { focus: 40, rest: 20 }
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
    id, parentId: null, title: id, category: 'work', priority: 1,
    tags: [], completed: false, createdAt: 100, completedAt: null, order: 0,
    ...fields
  };
}

function fixture() {
  return snapshot({ todos: [
    todo('r1', { title: '첫 제목 # 표시', tags: ['tag one', '둘'], order: 0 }),
    todo('c1', { parentId: 'r1', title: '하위', category: 'work', order: 0, createdAt: 110 }),
    todo('r2', { title: '완료', completed: true, completedAt: 999, order: 1, createdAt: 120 }),
    todo('p1', { title: '개인', category: 'personal', priority: 2, order: 2, createdAt: 130 })
  ] });
}

function lineFor(text, id) {
  return text.split('\n').find((line) => line.endsWith(`id=${encodeURIComponent(id)} -->`));
}

function replaceLine(text, id, next) {
  const old = lineFor(text, id);
  assert.ok(old, `missing fixture line ${id}`);
  return text.replace(`${old}\n`, `${next}\n`);
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function expectError(fn, code) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught, 'typed error expected');
  assert.equal(caught.name, 'MarkdownImportError');
  if (code) assert.equal(caught.code, code);
  assert.equal(typeof caught.message, 'string');
  return caught;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('public frozen API와 exporter escape helper를 제공한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  assert.equal(Object.isFrozen(MarkdownExport), true);
  assert.equal(Object.isFrozen(MarkdownImport), true);
  assert.deepEqual(Object.keys(MarkdownImport), ['parse', 'MarkdownImportError']);
  assert.equal(MarkdownExport.escapeText(' a\n#<& '), 'a \\#&lt;&amp;');
});

test('canonical untouched는 exact roundtrip, zero summary, 무변경, deterministic이다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = fixture();
  const before = JSON.stringify(current);
  const text = MarkdownExport.render(current);
  const a = MarkdownImport.parse(text, current);
  const b = MarkdownImport.parse(text, current);
  assert.deepEqual(plain(a), plain(b));
  assert.deepEqual(plain(a.data), current);
  assert.deepEqual(plain(a.summary), {
    total: 4, changed: 0, completedChanged: 0, priorityChanged: 0,
    titleChanged: 0, tagsChanged: 0, categoryChanged: 0,
    reparented: 0, reordered: 0
  });
  assert.equal(MarkdownExport.render(a.data), text);
  assert.equal(JSON.stringify(current), before);
});

test('checkbox, priority, title, tags 편집과 completedAt 규칙을 반영한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = fixture();
  let text = MarkdownExport.render(current);
  text = replaceLine(text, 'r2', '- [ ] (P0) 새 \\#제목 #new tag #둘 <!-- my-what-todo:id=r2 -->');
  const result = MarkdownImport.parse(text, current);
  const changed = result.data.todos.find((item) => item.id === 'r2');
  assert.deepEqual(plain(changed), {
    ...current.todos[2], title: '새 #제목', tags: ['new tag', '둘'], priority: 0,
    completed: false, completedAt: null
  });
  assert.deepEqual(plain(result.summary), {
    total: 4, changed: 1, completedChanged: 1, priorityChanged: 1,
    titleChanged: 1, tagsChanged: 1, categoryChanged: 0,
    reparented: 0, reordered: 0
  });
});

test('root category 이동과 global document order를 반영하고 child category가 상속된다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = fixture();
  let text = MarkdownExport.render(current);
  const r1 = lineFor(text, 'r1');
  const c1 = lineFor(text, 'c1');
  text = text.replace(`${r1}\n${c1}\n`, '');
  text = text.replace('## 개인\n', `## 개인\n${r1}\n${c1}\n`);
  const result = MarkdownImport.parse(text, current);
  const r1next = result.data.todos.find((item) => item.id === 'r1');
  const c1next = result.data.todos.find((item) => item.id === 'c1');
  assert.equal(r1next.category, 'personal');
  assert.equal(c1next.category, 'personal');
  assert.deepEqual(plain(result.data.todos.filter((x) => x.parentId === null)
    .sort((a, b) => a.order - b.order).map((x) => x.id)), ['r2', 'r1', 'p1']);
  assert.equal(result.summary.categoryChanged, 2);
  assert.equal(result.summary.reordered, 2);
});

test('기존 ID를 root/child로 재배치하고 parent별 order를 매긴다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = fixture();
  let text = MarkdownExport.render(current);
  const p1 = lineFor(text, 'p1');
  text = text.replace(`${p1}\n`, '_할 일 없음_\n');
  text = text.replace(`${lineFor(text, 'c1')}\n`, `${lineFor(text, 'c1')}\n  ${p1}\n`);
  const result = MarkdownImport.parse(text, current);
  const moved = result.data.todos.find((item) => item.id === 'p1');
  assert.equal(moved.parentId, 'r1');
  assert.equal(moved.category, 'work');
  assert.equal(moved.order, 1);
  assert.equal(result.summary.reparented, 1);
  assert.equal(result.summary.categoryChanged, 1);
});

test('current title/tag도 Store exact canonical 값만 허용한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const canonical = snapshot({ todos: [todo('canonical', {
    title: '내부  공백', tags: ['space  tag', 'a'.repeat(101)]
  })] });
  const text = MarkdownExport.render(canonical);
  assert.deepEqual(plain(MarkdownImport.parse(text, canonical).data), canonical);

  for (const fields of [
    { title: '' }, { title: ' 앞' }, { title: '뒤 ' }, { title: 'a'.repeat(101) },
    { tags: [''] }, { tags: [' tag'] }, { tags: ['tag '] }, { tags: ['UPPER'] },
    { tags: ['dup', 'dup'] }, { tags: ['1', '2', '3', '4', '5', '6'] }
  ]) {
    const hostile = snapshot({ todos: [todo('canonical', fields)] });
    expectError(() => MarkdownImport.parse(text, hostile), 'INVALID_CURRENT');
  }
});

test('canonical escape reversal은 모든 escape 문자, entity, title #와 tag 내부 공백을 지원한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = snapshot({ todos: [todo('x')] });
  const title = '\\`*_[]{}()#+.!|~- <>&';
  const tags = ['space tag', 'a#b'];
  const next = snapshot({ todos: [todo('x', { title, tags })] });
  const text = MarkdownExport.render(next);
  const result = MarkdownImport.parse(text, current);
  assert.equal(result.data.todos[0].title, title);
  assert.deepEqual(plain(result.data.todos[0].tags), tags);
});

test('header, blank, final newline, category section과 empty marker drift를 거부한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = fixture();
  const text = MarkdownExport.render(current);
  const bad = [
    text.replace('format_version: 1', 'format_version: 2'),
    text.replace('# My What Todo\n\n', '# My What Todo\n'),
    text.slice(0, -1), text + '\n',
    text.replace('## 업무', '## 바꿈'),
    text.replace('## 개인\n', '## 개인\n_할 일 없음_\n'),
    text.replace('## 개인\n', '## 개인\n## 개인\n')
  ];
  for (const value of bad) expectError(() => MarkdownImport.parse(value, current));

  const empty = snapshot();
  const emptyText = MarkdownExport.render(empty);
  expectError(() => MarkdownImport.parse(emptyText.replace('_할 일 없음_', ''), empty));
  expectError(() => MarkdownImport.parse(emptyText.replace('_할 일 없음_', '_없음_'), empty));
});

test('ID malformed/noncanonical/unknown/duplicate/missing를 exact-once로 거부한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = fixture();
  const text = MarkdownExport.render(current);
  const r1 = lineFor(text, 'r1');
  const bad = [
    text.replace('id=r1 -->', 'id=% -->'),
    text.replace('id=r1 -->', 'id=%72%31 -->'),
    text.replace('id=r1 -->', 'id=secret-unknown -->'),
    text.replace('id=r2 -->', 'id=r1 -->'),
    text.replace(`${r1}\n`, '')
  ];
  for (const value of bad) expectError(() => MarkdownImport.parse(value, current));
});

test('indentation, hierarchy, orphan/grandchild와 completion invariant를 거부한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = fixture();
  const text = MarkdownExport.render(current);
  const c1 = lineFor(text, 'c1');
  const bad = [
    text.replace(c1, c1.slice(1)),
    text.replace(c1, `\t${c1.trimStart()}`),
    text.replace(c1, `    ${c1.trimStart()}`),
    text.replace(`${lineFor(text, 'r1')}\n${c1}`, `${c1}\n${lineFor(text, 'r1')}`),
    replaceLine(text, 'r1', lineFor(text, 'r1').replace('[ ]', '[x]'))
  ];
  for (const value of bad) expectError(() => MarkdownImport.parse(value, current));
});

test('task syntax와 기타 section/arbitrary Markdown를 거부한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = fixture();
  const text = MarkdownExport.render(current);
  const line = lineFor(text, 'r2');
  const bad = [
    text.replace('- [x]', '* [x]'), text.replace('(P1)', '(P4)'),
    text.replace(' -->\n', ' --> trailing\n'),
    text.replace('## 개인\n', '## 기타\n'),
    text.replace(`${line}\n`, `${line}\n임의 문장\n`)
  ];
  for (const value of bad) expectError(() => MarkdownImport.parse(value, current));
});

test('unknown entity/raw HTML/unknown escape/noncanonical encoded payload를 거부한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = snapshot({ todos: [todo('x')] });
  const text = MarkdownExport.render(current);
  const base = lineFor(text, 'x');
  for (const payload of ['raw & bad', 'raw <bad>', '&quot;', '\\q', 'two  spaces']) {
    const changed = replaceLine(text, 'x', base.replace('(P1) x ', `(P1) ${payload} `));
    expectError(() => MarkdownImport.parse(changed, current));
  }
});

test('edited title/tag limits, lowercase identity, uniqueness를 거부한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = snapshot({ todos: [todo('x')] });
  const text = MarkdownExport.render(current);
  const base = lineFor(text, 'x');
  const payloads = [
    '', 'a'.repeat(101), 'ok #UPPER', 'ok #dup #dup',
    'ok #1 #2 #3 #4 #5 #6', `ok #${'a'.repeat(101)}`
  ];
  for (const payload of payloads) {
    const line = base.replace('(P1) x ', `(P1) ${payload} `);
    expectError(() => MarkdownImport.parse(replaceLine(text, 'x', line), current));
  }
});

test('input length bound를 todo count에 비례해 fail closed한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = snapshot();
  const text = MarkdownExport.render(current);
  expectError(() => MarkdownImport.parse(text + 'x'.repeat(4097), current), 'INPUT_TOO_LARGE');
});

test('current snapshot exact schema/settings/scalars/hierarchy를 strict 검증한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const valid = fixture();
  const text = MarkdownExport.render(valid);
  const hostile = [];
  hostile.push({ ...valid, version: 3 });
  hostile.push({ ...valid, theme: 'blue' });
  hostile.push({ ...valid, sort: 'wat' });
  hostile.push({ ...valid, pomodoro: valid.pomodoro.slice(0, 3) });
  hostile.push({ ...valid, categories: [...valid.categories, { ...valid.categories[0] }] });
  hostile.push({ ...valid, categories: valid.categories.map((x, i) => i ? x : ({ ...x, name: ' 업무 ' })) });
  hostile.push({ ...valid, categories: valid.categories.map((x, i) => i ? x : ({ ...x, hue: 360 })) });
  hostile.push({ ...valid, extra: true });
  hostile.push({ ...valid, todos: valid.todos.map((x, i) => i ? x : ({ ...x, extra: true })) });
  hostile.push({ ...valid, todos: valid.todos.map((x, i) => i ? x : ({ ...x, createdAt: NaN })) });
  hostile.push({ ...valid, todos: valid.todos.map((x, i) => i ? x : ({ ...x, category: 'missing' })) });
  for (const value of hostile) expectError(() => MarkdownImport.parse(text, value), 'INVALID_CURRENT');
});

test('current accessor/symbol/sparse/custom prototype/cycle를 getter 실행 없이 거부한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const valid = fixture();
  const text = MarkdownExport.render(valid);
  let calls = 0;
  const accessor = fixture();
  Object.defineProperty(accessor, 'theme', { enumerable: true, get() { calls += 1; return null; } });
  const symbol = fixture(); symbol[Symbol('secret')] = true;
  const sparse = fixture(); sparse.todos = new Array(2);
  const custom = fixture(); Object.setPrototypeOf(custom, { nope: true });
  const cycle = fixture(); cycle.categories[0].loop = cycle;
  for (const value of [accessor, symbol, sparse, custom, cycle]) {
    expectError(() => MarkdownImport.parse(text, value), 'INVALID_CURRENT');
  }
  assert.equal(calls, 0);
});

test('Object.prototype descriptor clone forged root/category/todo와 ctor lookalike를 거부한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const valid = fixture();
  const text = MarkdownExport.render(valid);
  let calls = 0;

  function forgedObjectPrototype(ctor) {
    const fake = Object.create(null);
    Object.defineProperties(fake, Object.getOwnPropertyDescriptors(Object.prototype));
    Object.defineProperty(fake, 'constructor', {
      ...Object.getOwnPropertyDescriptor(Object.prototype, 'constructor'), value: ctor
    });
    Object.defineProperty(ctor, 'prototype', { value: fake, writable: false });
    return fake;
  }
  const targets = [
    (value, proto) => Object.setPrototypeOf(value, proto),
    (value, proto) => Object.setPrototypeOf(value.categories[0], proto),
    (value, proto) => Object.setPrototypeOf(value.todos[0], proto)
  ];
  for (const apply of targets) {
    const hostile = fixture();
    const FakeObject = function Object() {};
    apply(hostile, forgedObjectPrototype(FakeObject));
    expectError(() => MarkdownImport.parse(text, hostile), 'INVALID_CURRENT');
  }

  const accessorLookalike = fixture();
  const AccessorObject = function Object() {};
  const accessorPrototype = forgedObjectPrototype(AccessorObject);
  const methodDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toString');
  Object.defineProperty(accessorPrototype, 'toString', {
    enumerable: methodDescriptor.enumerable,
    configurable: methodDescriptor.configurable,
    get() { calls += 1; }
  });
  Object.setPrototypeOf(accessorLookalike, accessorPrototype);
  expectError(() => MarkdownImport.parse(text, accessorLookalike), 'INVALID_CURRENT');

  for (const ctor of [Object.bind(null), new Proxy(function Object() {}, {})]) {
    const hostile = fixture();
    let fake;
    try { fake = forgedObjectPrototype(ctor); } catch (_) { continue; }
    Object.setPrototypeOf(hostile, fake);
    expectError(() => MarkdownImport.parse(text, hostile), 'INVALID_CURRENT');
  }
  assert.equal(calls, 0);
});

test('forged/custom Array prototype은 거부하고 cross-realm plain object/array는 허용한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const valid = fixture();
  const text = MarkdownExport.render(valid);

  const custom = fixture();
  Object.setPrototypeOf(custom.todos, []);
  expectError(() => MarkdownImport.parse(text, custom), 'INVALID_CURRENT');

  const forged = fixture();
  const fakeObjectProto = Object.create(null);
  Object.defineProperties(fakeObjectProto, Object.getOwnPropertyDescriptors(Object.prototype));
  const FakeObject = function Object() {};
  Object.defineProperty(FakeObject, 'prototype', { value: fakeObjectProto, writable: false });
  Object.defineProperty(fakeObjectProto, 'constructor', {
    ...Object.getOwnPropertyDescriptor(Object.prototype, 'constructor'), value: FakeObject
  });
  const fakeArrayProto = [];
  Object.defineProperties(fakeArrayProto, Object.getOwnPropertyDescriptors(Array.prototype));
  Object.setPrototypeOf(fakeArrayProto, fakeObjectProto);
  const FakeArray = function Array() {};
  Object.defineProperty(FakeArray, 'prototype', { value: fakeArrayProto, writable: false });
  Object.defineProperty(fakeArrayProto, 'constructor', {
    ...Object.getOwnPropertyDescriptor(Array.prototype, 'constructor'), value: FakeArray
  });
  Object.setPrototypeOf(forged.todos, fakeArrayProto);
  expectError(() => MarkdownImport.parse(text, forged), 'INVALID_CURRENT');

  const foreign = vm.runInNewContext(`(${JSON.stringify(valid)})`);
  assert.deepEqual(plain(MarkdownImport.parse(text, foreign).data), valid);
});

test('모든 schema/index descriptor는 JSON data flags여야 하고 array extra key를 거부한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const valid = fixture();
  const text = MarkdownExport.render(valid);
  const cases = [];
  const changed = (mutate) => { const value = fixture(); mutate(value); cases.push(value); };
  for (const flag of ['enumerable', 'configurable', 'writable']) {
    changed((value) => Object.defineProperty(value, 'theme', { ...Object.getOwnPropertyDescriptor(value, 'theme'), [flag]: false }));
  }
  const nestedFields = [
    (value) => [value.categories[0], 'name'],
    (value) => [value.todos[0], 'title'],
    (value) => [value.pomodoro[0], 'focus'],
    (value) => [value.todos[0].tags, '0'],
    (value) => [value.todos, '0']
  ];
  for (const select of nestedFields) {
    for (const flag of ['enumerable', 'configurable', 'writable']) {
      changed((value) => {
        const [object, key] = select(value);
        Object.defineProperty(object, key, { ...Object.getOwnPropertyDescriptor(object, key), [flag]: false });
      });
    }
  }
  changed((value) => Object.defineProperty(value.todos, 'length', { writable: false }));
  changed((value) => { value.todos.extra = true; });
  changed((value) => Object.defineProperty(value.todos, 'hidden', { value: true }));
  for (const value of cases) expectError(() => MarkdownImport.parse(text, value), 'INVALID_CURRENT');
});

test('cycle뿐 아니라 shared object/array alias도 모두 거부한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const valid = fixture();
  const text = MarkdownExport.render(valid);
  const cases = [];
  const sharedPomo = fixture(); sharedPomo.pomodoro[1] = sharedPomo.pomodoro[0]; cases.push(sharedPomo);
  const sharedCategory = fixture(); sharedCategory.categories[1] = sharedCategory.categories[0]; cases.push(sharedCategory);
  const sharedTodo = fixture(); sharedTodo.todos[1] = sharedTodo.todos[0]; cases.push(sharedTodo);
  const sharedTags = fixture(); sharedTags.todos[1].tags = sharedTags.todos[0].tags; cases.push(sharedTags);
  for (const value of cases) expectError(() => MarkdownImport.parse(text, value), 'INVALID_CURRENT');
});

test('current order는 parent sibling별 exact unique 0..n-1이며 input array 순서는 무관하다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const valid = fixture();
  const text = MarkdownExport.render(valid);
  const shuffled = snapshot({ todos: [valid.todos[3], valid.todos[1], valid.todos[2], valid.todos[0]] });
  assert.deepEqual(plain(MarkdownImport.parse(text, shuffled).data), shuffled);

  const cases = [];
  const altered = (id, order) => snapshot({ todos: valid.todos.map((item) => ({ ...item, order: item.id === id ? order : item.order })) });
  for (const order of [-1, -0.5, 0.5]) cases.push(altered('r1', order));
  cases.push(altered('r2', 0)); // duplicate root order
  cases.push(altered('r2', 3)); // root gap
  cases.push(snapshot({ todos: [...valid.todos, todo('c2', { parentId: 'r1', order: 2 })] })); // child gap
  for (const value of cases) expectError(() => MarkdownImport.parse(text, value), 'INVALID_CURRENT');
});

test('settings/category metadata/id/createdAt는 exact plain clone으로 보존한다', () => {
  const { MarkdownExport, MarkdownImport } = load();
  const current = fixture();
  const text = replaceLine(MarkdownExport.render(current), 'p1',
    lineFor(MarkdownExport.render(current), 'p1').replace('(P2)', '(P3)'));
  const result = MarkdownImport.parse(text, current);
  for (const key of ['version', 'theme', 'sort', 'pomodoro', 'categories']) {
    assert.deepEqual(plain(result.data[key]), current[key]);
    if (result.data[key] && typeof result.data[key] === 'object') {
      assert.notEqual(result.data[key], current[key]);
    }
  }
  for (const old of current.todos) {
    const next = result.data.todos.find((x) => x.id === old.id);
    assert.equal(next.id, old.id);
    assert.equal(next.createdAt, old.createdAt);
  }
});

test('result data/summary는 Store.importData에서 silent coercion 없이 exact roundtrip한다', () => {
  const sandbox = { console, Date, Math, crypto: { randomUUID: () => 'new' } };
  const values = new Map();
  sandbox.localStorage = sandbox.sessionStorage = {
    getItem(k) { return values.get(k) ?? null; }, setItem(k, v) { values.set(k, String(v)); }, removeItem(k) { values.delete(k); }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['parse.js', 'store.js', 'markdown-export.js', 'markdown-import.js']) {
    vm.runInContext(source(file), sandbox, { filename: file });
  }
  const current = fixture();
  const text = replaceLine(sandbox.MarkdownExport.render(current), 'p1',
    lineFor(sandbox.MarkdownExport.render(current), 'p1').replace('(P2)', '(P3)'));
  const result = sandbox.MarkdownImport.parse(text, current);
  assert.ok(sandbox.Store.importData(result.data));
  assert.deepEqual(plain(sandbox.Store.exportData()), plain(result.data));
});

test('parse 실패는 isolated Store를 mutation하지 않고 error object에 raw content/ID를 넣지 않는다', () => {
  const sandbox = { console, Date, Math, crypto: { randomUUID: () => 'new' } };
  const values = new Map();
  sandbox.localStorage = sandbox.sessionStorage = {
    getItem(k) { return values.get(k) ?? null; }, setItem(k, v) { values.set(k, String(v)); }, removeItem(k) { values.delete(k); }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['parse.js', 'store.js', 'markdown-export.js', 'markdown-import.js']) vm.runInContext(source(file), sandbox);
  const current = fixture();
  sandbox.Store.importData(current);
  const before = plain(sandbox.Store.exportData());
  const secret = 'SUPER_SECRET_EXTERNAL_ID';
  const bad = sandbox.MarkdownExport.render(current).replace('id=r1 -->', `id=${secret} -->`);
  const error = expectError(() => sandbox.MarkdownImport.parse(bad, current));
  assert.deepEqual(plain(sandbox.Store.exportData()), before);
  const exposed = Reflect.ownKeys(error).map((key) => String(error[key])).join('|');
  assert.equal(exposed.includes(secret), false);
  assert.equal(exposed.includes(lineFor(bad, secret) ?? secret), false);
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) { failures += 1; console.error(`not ok - ${name}: ${error.stack || error.message}`); }
  }
  if (failures) {
    console.error(`${failures} markdown import test(s) failed`);
    process.exitCode = 1;
  } else console.log(`all ${tests.length} markdown import tests passed`);
})();
