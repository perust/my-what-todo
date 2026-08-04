/**
 * markdown-export.js — Store export snapshot을 결정론적 Obsidian용 Markdown으로 렌더한다.
 */
(function () {
  'use strict';

  const HEADER = `---
title: My What Todo
generated_by: my-what-todo
format_version: 1
---

# My What Todo

> My What Todo 앱에서 자동 생성한 읽기 전용 보기입니다. 앱에서 변경하면 이 파일을 덮어씁니다.
`;

  const fail = (message) => { throw new TypeError(`Markdown snapshot: ${message}`); };

  const OBJECT_PROTOTYPE_KEYS = Reflect.ownKeys(Object.prototype);

  function samePrototypeDescriptor(candidate, reference) {
    if (!candidate || candidate.enumerable !== reference.enumerable ||
        candidate.configurable !== reference.configurable) return false;
    const candidateAccessor = 'get' in candidate || 'set' in candidate;
    const referenceAccessor = 'get' in reference || 'set' in reference;
    if (candidateAccessor !== referenceAccessor) return false;
    if (referenceAccessor) {
      return typeof candidate.get === typeof reference.get &&
        typeof candidate.set === typeof reference.set;
    }
    return candidate.writable === reference.writable &&
      typeof candidate.value === typeof reference.value &&
      (typeof reference.value !== 'function' || candidate.value.name === reference.value.name);
  }

  // vm/iframe에서 건너온 plain data도 허용하되 각 realm의 정확한 기본 prototype만 받는다.
  function isObjectPrototype(value) {
    if (value === null || Object.getPrototypeOf(value) !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== OBJECT_PROTOTYPE_KEYS.length ||
        OBJECT_PROTOTYPE_KEYS.some((key) => !keys.includes(key))) return false;
    if (OBJECT_PROTOTYPE_KEYS.some((key) => !samePrototypeDescriptor(
      Object.getOwnPropertyDescriptor(value, key),
      Object.getOwnPropertyDescriptor(Object.prototype, key)
    ))) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'constructor');
    return descriptor?.get === undefined && descriptor?.set === undefined &&
      typeof descriptor?.value === 'function' && descriptor.value.name === 'Object' &&
      descriptor.value.prototype === value;
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || isObjectPrototype(prototype);
  }

  function hasPlainArrayPrototype(value) {
    const prototype = Object.getPrototypeOf(value);
    return Array.isArray(prototype) && isObjectPrototype(Object.getPrototypeOf(prototype));
  }

  /** 전체 graph를 descriptor로 순회해 getter를 실행하지 않고 비-plain 값을 렌더 전에 거부한다. */
  function assertPlainGraph(value, active = new WeakSet(), seen = new WeakSet()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('non-finite number');
      return;
    }
    if (typeof value !== 'object') fail(`non-plain ${typeof value} value`);

    const array = Array.isArray(value);
    if (array ? !hasPlainArrayPrototype(value) : !isPlainObject(value)) fail('non-plain prototype');
    if (active.has(value)) fail('cycle');
    if (seen.has(value)) return;

    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) fail('symbol property');
    if (array) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) fail('sparse array');
      }
    }

    active.add(value);
    try {
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (array && !/^(0|[1-9]\d*)$/u.test(key)) fail('non-index array property');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor.get !== undefined || descriptor.set !== undefined) fail('accessor property');
        assertPlainGraph(descriptor.value, active, seen);
      }
    } finally {
      active.delete(value);
    }
    seen.add(value);
  }

  const needString = (value, label, allowEmpty = false) => {
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) fail(`${label} must be a string`);
    return value;
  };

  const needFinite = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be finite`);
    return value;
  };

  function readOwnData(object, key, label = key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
      fail(`${label} must be an own data property`);
    }
    return descriptor.value;
  }

  /** 한 줄로 접은 뒤 HTML을 entity화하고 Markdown 문법 문자를 backslash escape한다. */
  function escapeText(value) {
    return value
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/([\\`*_[\]{}()#+.!|~\-])/g, '\\$1');
  }

  const compare = (a, b) =>
    a.order - b.order ||
    a.createdAt - b.createdAt ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  function encodedId(id) {
    try {
      return encodeURIComponent(id);
    } catch (error) {
      fail('id cannot be encoded');
    }
  }

  function renderItem(item, indent) {
    const checkbox = item.completed ? 'x' : ' ';
    const tags = item.tags.map((tag) => ` #${escapeText(tag)}`).join('');
    return `${' '.repeat(indent)}- [${checkbox}] (P${item.priority}) ${escapeText(item.title)}${tags} <!-- my-what-todo:id=${encodedId(item.id)} -->`;
  }

  function render(snapshot) {
    assertPlainGraph(snapshot);
    if (!isPlainObject(snapshot)) fail('root must be an object');
    const snapshotCategories = readOwnData(snapshot, 'categories');
    const snapshotTodos = readOwnData(snapshot, 'todos');
    if (!Array.isArray(snapshotCategories)) fail('categories must be an array');
    if (!Array.isArray(snapshotTodos)) fail('todos must be an array');

    const categoryIds = new Set();
    const categories = snapshotCategories.map((category, index) => {
      if (!isPlainObject(category)) fail(`category ${index} must be an object`);
      const id = needString(readOwnData(category, 'id', `category ${index} id`), `category ${index} id`);
      if (categoryIds.has(id)) fail(`duplicate category id ${id}`);
      categoryIds.add(id);
      return {
        id,
        name: needString(readOwnData(category, 'name', `category ${id} name`), `category ${id} name`)
      };
    });

    const byId = new Map();
    const todos = snapshotTodos.map((item, index) => {
      if (!isPlainObject(item)) fail(`todo ${index} must be an object`);
      const id = needString(readOwnData(item, 'id', `todo ${index} id`), `todo ${index} id`);
      if (byId.has(id)) fail(`duplicate todo id ${id}`);
      const parentId = readOwnData(item, 'parentId', `todo ${id} parentId`);
      const title = readOwnData(item, 'title', `todo ${id} title`);
      const category = readOwnData(item, 'category', `todo ${id} category`);
      const priority = readOwnData(item, 'priority', `todo ${id} priority`);
      const completed = readOwnData(item, 'completed', `todo ${id} completed`);
      const tags = readOwnData(item, 'tags', `todo ${id} tags`);
      const order = readOwnData(item, 'order', `todo ${id} order`);
      const createdAt = readOwnData(item, 'createdAt', `todo ${id} createdAt`);
      if (parentId !== null && typeof parentId !== 'string') fail(`todo ${id} parentId`);
      needString(title, `todo ${id} title`);
      needString(category, `todo ${id} category`);
      if (!Number.isInteger(priority) || priority < 0 || priority > 3) fail(`todo ${id} priority`);
      if (typeof completed !== 'boolean') fail(`todo ${id} completed`);
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) fail(`todo ${id} tags`);
      needFinite(order, `todo ${id} order`);
      needFinite(createdAt, `todo ${id} createdAt`);
      const normalized = {
        id,
        parentId,
        title,
        category,
        priority,
        completed,
        tags: tags.slice(),
        order,
        createdAt
      };
      byId.set(id, normalized);
      return normalized;
    });

    for (const item of todos) {
      if (item.parentId !== null && !byId.has(item.parentId)) fail(`orphan todo ${item.id}`);
    }

    // parent chain은 최대 한 단계여야 한다. chain walk로 self/다중 cycle도 먼저 구분한다.
    for (const item of todos) {
      const path = new Set();
      let cursor = item;
      let depth = 0;
      while (cursor.parentId !== null) {
        if (path.has(cursor.id)) fail(`todo hierarchy cycle at ${cursor.id}`);
        path.add(cursor.id);
        cursor = byId.get(cursor.parentId);
        depth += 1;
        if (depth > todos.length) fail(`todo hierarchy cycle at ${item.id}`);
      }
      if (depth > 1) fail(`todo ${item.id} exceeds two-level hierarchy`);
    }

    const rootsByCategory = new Map(categories.map((category) => [category.id, []]));
    const otherRoots = [];
    const children = new Map();
    for (const item of todos) {
      if (item.parentId === null) {
        const group = rootsByCategory.get(item.category);
        (group ?? otherRoots).push(item);
      } else {
        if (!children.has(item.parentId)) children.set(item.parentId, []);
        children.get(item.parentId).push(item);
      }
    }

    const lines = [HEADER];
    const appendSection = (name, roots) => {
      lines.push(`## ${escapeText(name)}`);
      if (roots.length === 0) {
        lines.push('_할 일 없음_', '');
        return;
      }
      for (const root of roots.slice().sort(compare)) {
        lines.push(renderItem(root, 0));
        for (const child of (children.get(root.id) ?? []).slice().sort(compare)) {
          lines.push(renderItem(child, 2));
        }
      }
      lines.push('');
    };

    for (const category of categories) appendSection(category.name, rootsByCategory.get(category.id));
    if (otherRoots.length) appendSection('기타', otherRoots);
    return `${lines.join('\n').replace(/\n+$/u, '')}\n`;
  }

  globalThis.MarkdownExport = Object.freeze({ render });
})();
