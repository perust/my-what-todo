'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function load() {
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'markdown-export.js'), 'utf8'), sandbox, {
    filename: 'markdown-export.js'
  });
  return sandbox.MarkdownExport;
}

function snapshot(overrides = {}) {
  return {
    version: 4,
    theme: null,
    sort: 'manual',
    pomodoro: [],
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

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('정본 전체 bytes는 카테고리·계층·완료·우선순위·태그와 끝 newline을 정확히 고정한다', () => {
  const MarkdownExport = load();
  const data = snapshot({ todos: [
    todo('later', { title: '나중', order: 2, createdAt: 10, priority: 3 }),
    todo('root id/한글', { title: '제목', order: 1, createdAt: 20, priority: 0, tags: ['tag', '둘'] }),
    todo('child', { parentId: 'root id/한글', title: '하위 항목', order: 1, createdAt: 30, priority: 2, completed: true })
  ] });
  const expected = `---
title: My What Todo
generated_by: my-what-todo
format_version: 1
---

# My What Todo

> My What Todo 앱에서 자동 생성한 보기입니다. 지원되는 기존 할 일 편집은 앱의 Markdown 충돌 해결에서 가져올 수 있습니다.

## 업무
- [ ] (P0) 제목 #tag #둘 <!-- my-what-todo:id=root%20id%2F%ED%95%9C%EA%B8%80 -->
  - [x] (P2) 하위 항목 <!-- my-what-todo:id=child -->
- [ ] (P3) 나중 <!-- my-what-todo:id=later -->

## 개인
_할 일 없음_
`;
  assert.equal(MarkdownExport.render(data), expected);
  assert.equal(expected.endsWith('\n'), true);
});

test('카테고리 배열 순서와 parent별 order-createdAt-id 정렬은 입력 배열 순서와 무관하다', () => {
  const MarkdownExport = load();
  const items = [
    todo('b', { category: 'personal', order: 0, createdAt: 1 }),
    todo('z', { order: 0, createdAt: 2 }),
    todo('a', { order: 0, createdAt: 2 }),
    todo('first', { order: -1, createdAt: 9 }),
    todo('child-b', { parentId: 'a', order: 0, createdAt: 2 }),
    todo('child-a', { parentId: 'a', order: 0, createdAt: 1 })
  ];
  const text = MarkdownExport.render(snapshot({ todos: items.reverse() }));
  assert.ok(text.indexOf('## 업무') < text.indexOf('## 개인'));
  assert.ok(text.indexOf('(P1) first') < text.indexOf('(P1) a'));
  assert.ok(text.indexOf('(P1) a') < text.indexOf('(P1) z'));
  assert.ok(text.indexOf('child-a') < text.indexOf('child-b'));
});

test('알려진 카테고리에 없는 root는 기타에 보존하고 빈 기타는 만들지 않는다', () => {
  const MarkdownExport = load();
  const withOther = MarkdownExport.render(snapshot({ todos: [todo('lost', { category: 'missing' })] }));
  assert.match(withOther, /## 기타\n- \[ \] \(P1\) lost/);
  const withoutOther = MarkdownExport.render(snapshot());
  assert.doesNotMatch(withoutOther, /## 기타/);
});

test('카테고리·제목·태그의 newline/HTML/Markdown metachar를 실행 불가능하게 escape한다', () => {
  const MarkdownExport = load();
  const data = snapshot({
    categories: [{ id: 'x', name: 'A <b> & [C]\nD', hue: 1 }],
    todos: [todo('x', {
      category: 'x', title: '# hi *x* <script> & ok\r\nnext',
      tags: ['a_b', '<img>&'], priority: 0
    })]
  });
  const text = MarkdownExport.render(data);
  assert.equal(text.includes('## A &lt;b&gt; &amp; \\[C\\] D'), true);
  assert.equal(text.includes('(P0) \\# hi \\*x\\* &lt;script&gt; &amp; ok next #a\\_b #&lt;img&gt;&amp;'), true);
  assert.doesNotMatch(text, /<script>|<img>|\r/);
});

test('ID comment는 encodeURIComponent를 고정해 comment 탈출과 비ASCII를 막는다', () => {
  const MarkdownExport = load();
  const id = 'a --> 한글/%';
  const text = MarkdownExport.render(snapshot({ todos: [todo(id)] }));
  assert.match(text, /my-what-todo:id=a%20--%3E%20%ED%95%9C%EA%B8%80%2F%25 -->/);
  assert.equal(text.includes(`id=${id}`), false);
});

test('같은 snapshot은 언제나 같은 bytes이며 입력 객체를 mutation하지 않는다', () => {
  const MarkdownExport = load();
  const data = snapshot({ todos: [todo('b', { order: 2 }), todo('a', { order: 1, tags: ['Z'] })] });
  const before = JSON.stringify(data);
  const first = MarkdownExport.render(data);
  const second = MarkdownExport.render(data);
  assert.equal(first, second);
  assert.equal(JSON.stringify(data), before);
  assert.doesNotMatch(first, /generated_at|timestamp/i);
});

for (const [name, make] of [
  ['duplicate ID', () => snapshot({ todos: [todo('same'), todo('same')] })],
  ['orphan', () => snapshot({ todos: [todo('child', { parentId: 'missing' })] })],
  ['self cycle', () => snapshot({ todos: [todo('self', { parentId: 'self' })] })],
  ['two-node cycle', () => snapshot({ todos: [todo('a', { parentId: 'b' }), todo('b', { parentId: 'a' })] })]
]) {
  test(`${name} 구조는 명확히 throw하고 text를 만들지 않는다`, () => {
    const MarkdownExport = load();
    assert.throws(() => MarkdownExport.render(make()), /Markdown snapshot:/);
  });
}

test('plain export schema가 아니거나 필수 scalar가 잘못되면 명확히 throw한다', () => {
  const MarkdownExport = load();
  assert.throws(() => MarkdownExport.render(null), /Markdown snapshot:/);
  assert.throws(() => MarkdownExport.render(snapshot({ categories: {}, todos: [] })), /Markdown snapshot:/);
  assert.throws(() => MarkdownExport.render(snapshot({ todos: [todo('x', { priority: 9 })] })), /Markdown snapshot:/);
  assert.throws(() => MarkdownExport.render(snapshot({ todos: [todo('x', { tags: 'tag' })] })), /Markdown snapshot:/);
});

test('plain graph 검증은 accessor를 실행하지 않고 symbol property를 명확히 거부한다', () => {
  const MarkdownExport = load();
  let getterCalls = 0;
  const accessorData = snapshot();
  Object.defineProperty(accessorData, 'hostile', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('getter executed'); }
  });
  assert.throws(() => MarkdownExport.render(accessorData), /Markdown snapshot: accessor property/);
  assert.equal(getterCalls, 0);

  const symbolData = snapshot();
  symbolData[Symbol('hidden')] = 'secret';
  assert.throws(() => MarkdownExport.render(symbolData), /Markdown snapshot: symbol property/);
});

test('plain graph 검증은 sparse array와 custom prototype을 거부한다', () => {
  const MarkdownExport = load();
  const sparse = snapshot({ todos: new Array(1) });
  assert.throws(() => MarkdownExport.render(sparse), /Markdown snapshot: sparse array/);

  const customPrototype = snapshot();
  Object.setPrototypeOf(customPrototype, { inherited: true });
  assert.throws(() => MarkdownExport.render(customPrototype), /Markdown snapshot: non-plain prototype/);
});

test('Object처럼 위조한 custom prototype의 inherited getter를 실행하지 않고 거부한다', () => {
  const MarkdownExport = load();
  let getterCalls = 0;
  const forgedPrototype = Object.create(null);
  const ForgedObject = function Object() {};
  Object.defineProperty(forgedPrototype, 'constructor', {
    value: ForgedObject, writable: true, configurable: true
  });
  ForgedObject.prototype = forgedPrototype;
  Object.defineProperty(forgedPrototype, 'categories', {
    configurable: true,
    get() { getterCalls += 1; throw new Error('getter executed'); }
  });
  const data = Object.create(forgedPrototype);
  data.todos = [];

  assert.throws(() => MarkdownExport.render(data), /Markdown snapshot: non-plain prototype/);
  assert.equal(getterCalls, 0);
});

test('schema의 inherited data categories와 todos는 own field로 인정하지 않는다', () => {
  const MarkdownExport = load();
  Object.defineProperty(Object.prototype, 'categories', {
    value: [], configurable: true
  });
  Object.defineProperty(Object.prototype, 'todos', {
    value: [], configurable: true
  });
  try {
    const inheritedCategories = { todos: [] };
    assert.throws(
      () => MarkdownExport.render(inheritedCategories),
      /Markdown snapshot:/
    );

    const inheritedTodos = { categories: [] };
    assert.throws(
      () => MarkdownExport.render(inheritedTodos),
      /Markdown snapshot:/
    );
  } finally {
    delete Object.prototype.categories;
    delete Object.prototype.todos;
  }
});

test('객체 graph cycle을 hang 없이 거부하고 기존 입력을 건드리지 않는다', () => {
  const MarkdownExport = load();
  const data = snapshot();
  data.extra = data;
  assert.throws(() => MarkdownExport.render(data), /Markdown snapshot: cycle/);
  assert.equal(data.extra, data);
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
    console.error(`${failures} markdown export test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`all ${tests.length} markdown export tests passed`);
  }
})();
