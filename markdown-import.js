/**
 * markdown-import.js — canonical Markdown의 제한된 기존 todo 편집을 strict parse한다.
 */
(function () {
  'use strict';

  const PREFIX = `---
title: My What Todo
generated_by: my-what-todo
format_version: 1
---

# My What Todo

> My What Todo 앱에서 자동 생성한 보기입니다. 지원되는 기존 할 일 편집은 앱의 Markdown 충돌 해결에서 가져올 수 있습니다.

`;
  const ROOT_KEYS = ['version', 'theme', 'sort', 'pomodoro', 'miniOpacity', 'pipDial', 'categories', 'todos'];
  const CATEGORY_KEYS = ['id', 'name', 'hue'];
  const TODO_KEYS = [
    'id', 'parentId', 'title', 'category', 'priority', 'tags',
    'completed', 'createdAt', 'completedAt', 'dueAt', 'repeat', 'order'
  ];
  const REPEAT_KEYS = ['unit', 'anchor'];
  const REPEAT_UNITS = new Set(['day', 'week', 'month', 'year']);
  const POMO_KEYS = ['focus', 'rest'];
  const SORTS = new Set(['priority', 'manual', 'created', 'category', 'completed']);
  const ESCAPED = new Set(['\\', '`', '*', '_', '[', ']', '{', '}', '(', ')', '#', '+', '.', '!', '|', '~', '-']);
  const MESSAGES = Object.freeze({
    INVALID_CURRENT: '현재 데이터 형식이 올바르지 않습니다.',
    INVALID_TEXT: 'Markdown 문서 형식이 올바르지 않습니다.',
    INPUT_TOO_LARGE: 'Markdown 문서가 허용 크기를 초과했습니다.',
    HEADER_MISMATCH: 'Markdown 머리말이 정본 형식과 다릅니다.',
    SECTION_MISMATCH: 'Markdown 카테고리 절이 정본 형식과 다릅니다.',
    TASK_SYNTAX: '할 일 행 형식이 올바르지 않습니다.',
    INVALID_ID: '할 일 식별자 형식이 올바르지 않습니다.',
    UNKNOWN_ID: '알 수 없는 할 일 식별자가 있습니다.',
    DUPLICATE_ID: '같은 할 일 식별자가 두 번 있습니다.',
    MISSING_ID: '기존 할 일 식별자가 누락되었습니다.',
    INVALID_ESCAPE: '제목 또는 태그 escape 형식이 올바르지 않습니다.',
    INVALID_FIELD: '편집한 제목 또는 태그 값이 허용 범위를 벗어났습니다.',
    INVALID_HIERARCHY: '할 일 계층 형식이 올바르지 않습니다.',
    COMPLETION_MISMATCH: '상위와 하위의 완료 상태가 일치하지 않습니다.',
    ROUNDTRIP_MISMATCH: 'Markdown 정본 왕복 검증에 실패했습니다.',
    INTERNAL_ERROR: 'Markdown 가져오기를 처리할 수 없습니다.'
  });

  class MarkdownImportError extends Error {
    constructor(code, options = {}) {
      super(MESSAGES[code] || MESSAGES.INTERNAL_ERROR);
      this.name = 'MarkdownImportError';
      this.code = code;
      if (Number.isInteger(options.line) && options.line > 0) this.line = options.line;
      if (typeof options.field === 'string' && options.field) this.field = options.field;
    }
  }

  function deny(code, options) { throw new MarkdownImportError(code, options); }

  const NATIVE_FUNCTION_TO_STRING = Function.prototype.toString;
  const OBJECT_PROTOTYPE_KEYS = Reflect.ownKeys(Object.prototype);
  const ARRAY_PROTOTYPE_KEYS = Reflect.ownKeys(Array.prototype);

  function functionSource(value) {
    try { return NATIVE_FUNCTION_TO_STRING.call(value); } catch (_) { return ''; }
  }

  function sameDescriptorValue(candidate, reference, compared = new WeakMap()) {
    if (typeof reference === 'function') {
      return typeof candidate === 'function' && functionSource(candidate) === functionSource(reference);
    }
    if (reference === null || typeof reference !== 'object') return Object.is(candidate, reference);
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate) !== Array.isArray(reference)) {
      return false;
    }
    if (compared.get(candidate) === reference) return true;
    compared.set(candidate, reference);
    const candidateHasPrototype = Object.getPrototypeOf(candidate) !== null;
    const referenceHasPrototype = Object.getPrototypeOf(reference) !== null;
    if (candidateHasPrototype !== referenceHasPrototype) return false;
    const candidateKeys = Reflect.ownKeys(candidate);
    const referenceKeys = Reflect.ownKeys(reference);
    return candidateKeys.length === referenceKeys.length &&
      referenceKeys.every((key) => candidateKeys.includes(key) && samePrototypeDescriptor(
        Object.getOwnPropertyDescriptor(candidate, key),
        Object.getOwnPropertyDescriptor(reference, key), compared
      ));
  }

  function samePrototypeDescriptor(candidate, reference, compared) {
    if (!candidate || candidate.enumerable !== reference.enumerable ||
        candidate.configurable !== reference.configurable) return false;
    const candidateAccessor = 'get' in candidate || 'set' in candidate;
    const referenceAccessor = 'get' in reference || 'set' in reference;
    if (candidateAccessor !== referenceAccessor) return false;
    if (referenceAccessor) {
      return sameDescriptorValue(candidate.get, reference.get, compared) &&
        sameDescriptorValue(candidate.set, reference.set, compared);
    }
    return candidate.writable === reference.writable && sameDescriptorValue(candidate.value, reference.value, compared);
  }

  function isNativeConstructor(constructor, name, prototype) {
    if (typeof constructor !== 'function') return false;
    const source = functionSource(constructor);
    const pattern = new RegExp(`^function\\s+${name}\\s*\\(\\s*\\)\\s*\\{\\s*\\[native code\\]\\s*\\}$`, 'u');
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(constructor, 'prototype');
    return pattern.test(source) && prototypeDescriptor?.get === undefined &&
      prototypeDescriptor?.set === undefined && prototypeDescriptor.value === prototype;
  }

  function isObjectPrototype(value) {
    if (!value || Object.getPrototypeOf(value) !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== OBJECT_PROTOTYPE_KEYS.length ||
        OBJECT_PROTOTYPE_KEYS.some((key) => !keys.includes(key))) return false;
    if (OBJECT_PROTOTYPE_KEYS.some((key) => !samePrototypeDescriptor(
      Object.getOwnPropertyDescriptor(value, key), Object.getOwnPropertyDescriptor(Object.prototype, key)
    ))) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'constructor');
    return descriptor?.get === undefined && descriptor?.set === undefined &&
      isNativeConstructor(descriptor.value, 'Object', value);
  }

  function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || isObjectPrototype(prototype);
  }

  function isPlainArray(value) {
    if (!Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(prototype) || !isObjectPrototype(Object.getPrototypeOf(prototype))) return false;
    const keys = Reflect.ownKeys(prototype);
    if (keys.length !== ARRAY_PROTOTYPE_KEYS.length ||
        ARRAY_PROTOTYPE_KEYS.some((key) => !keys.includes(key))) return false;
    if (ARRAY_PROTOTYPE_KEYS.some((key) => !samePrototypeDescriptor(
      Object.getOwnPropertyDescriptor(prototype, key), Object.getOwnPropertyDescriptor(Array.prototype, key)
    ))) return false;
    const constructorDescriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    const lengthDescriptor = Object.getOwnPropertyDescriptor(prototype, 'length');
    return lengthDescriptor?.value === 0 &&
      isNativeConstructor(constructorDescriptor?.value, 'Array', prototype);
  }

  /** 검증을 통과한 반복 규칙의 사본. 모양은 위 REPEAT_KEYS로 이미 확인했다. */
  function cloneRepeat(repeat) {
    return repeat === null ? null : { unit: own(repeat, 'unit'), anchor: own(repeat, 'anchor') };
  }

  function isStandardDataDescriptor(descriptor) {
    return descriptor?.get === undefined && descriptor?.set === undefined &&
      descriptor.enumerable === true && descriptor.configurable === true && descriptor.writable === true;
  }

  function assertPlainGraph(value, seen = new WeakSet()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) deny('INVALID_CURRENT');
      return;
    }
    if (typeof value !== 'object') deny('INVALID_CURRENT');
    const array = Array.isArray(value);
    if (array ? !isPlainArray(value) : !isPlainObject(value)) deny('INVALID_CURRENT');
    if (seen.has(value)) deny('INVALID_CURRENT');
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) deny('INVALID_CURRENT');
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || length.get !== undefined || length.set !== undefined || length.enumerable !== false ||
          length.configurable !== false || length.writable !== true || !Number.isSafeInteger(length.value) ||
          length.value < 0 || keys.length !== length.value + 1) deny('INVALID_CURRENT');
    }
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= keys.length - 1)) deny('INVALID_CURRENT');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isStandardDataDescriptor(descriptor)) deny('INVALID_CURRENT');
      assertPlainGraph(descriptor.value, seen);
    }
  }

  function own(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!isStandardDataDescriptor(descriptor)) deny('INVALID_CURRENT');
    return descriptor.value;
  }

  function exactKeys(object, expected) {
    if (!isPlainObject(object)) deny('INVALID_CURRENT');
    const keys = Reflect.ownKeys(object);
    if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) deny('INVALID_CURRENT');
  }

  function validateCurrent(current) {
    assertPlainGraph(current);
    exactKeys(current, ROOT_KEYS);
    // **일부러 숫자를 못박는다.** `Store.SCHEMA_VERSION`을 따라가게 하면 형식이 바뀔 때
    // 이 관문이 조용히 통과시켜, 새로 늘어난 필드를 여기서 어떻게 다룰지 아무도 안 본다.
    // 여기가 걸려 테스트가 깨지는 것이 곧 "그 필드를 검토하라"는 신호다.
    // 올릴 때는 TODO_KEYS와 아래 항목 검증도 같이 본다.
    if (own(current, 'version') !== 8) deny('INVALID_CURRENT');
    const theme = own(current, 'theme');
    if (theme !== null && theme !== 'light' && theme !== 'dark') deny('INVALID_CURRENT');
    if (!SORTS.has(own(current, 'sort'))) deny('INVALID_CURRENT');

    const pomodoro = own(current, 'pomodoro');
    if (!Array.isArray(pomodoro) || pomodoro.length !== 4) deny('INVALID_CURRENT');
    for (const round of pomodoro) {
      exactKeys(round, POMO_KEYS);
      for (const key of POMO_KEYS) {
        const value = own(round, key);
        if (!Number.isInteger(value) || value < 1 || value > 180) deny('INVALID_CURRENT');
      }
    }

    // 이 값은 Markdown에 실리지도, 편집으로 바뀌지도 않는다. 그래도 여기서 재는 이유는
    // 통과한 snapshot이 그대로 복제되어 Store로 되돌아가기 때문이다 — 범위 밖 값이
    // 지나가면 다른 문으로 들어온 셈이 된다.
    const opacity = own(current, 'miniOpacity');
    if (!Number.isInteger(opacity) || opacity < 0 || opacity > 100) deny('INVALID_CURRENT');
    if (typeof own(current, 'pipDial') !== 'boolean') deny('INVALID_CURRENT');

    const categories = own(current, 'categories');
    if (!Array.isArray(categories) || categories.length < 1 || categories.length > 64) deny('INVALID_CURRENT');
    const categoryIds = new Set();
    const categoryNames = new Set();
    const categoryHeadings = new Set();
    for (const category of categories) {
      exactKeys(category, CATEGORY_KEYS);
      const id = own(category, 'id');
      const name = own(category, 'name');
      const hue = own(category, 'hue');
      const normalizedName = typeof name === 'string' ? name.trim().replace(/\s+/gu, ' ').slice(0, 12) : '';
      if (typeof id !== 'string' || !id || categoryIds.has(id) ||
          typeof name !== 'string' || !name || name !== normalizedName || categoryNames.has(name) ||
          typeof hue !== 'number' || !Number.isFinite(hue) || hue < 0 || hue >= 360) {
        deny('INVALID_CURRENT');
      }
      let heading;
      try { heading = MarkdownExport.escapeText(name); } catch (_) { deny('INVALID_CURRENT'); }
      if (!heading || categoryHeadings.has(heading)) deny('INVALID_CURRENT');
      categoryIds.add(id); categoryNames.add(name); categoryHeadings.add(heading);
    }

    const todos = own(current, 'todos');
    if (!Array.isArray(todos)) deny('INVALID_CURRENT');
    const byId = new Map();
    for (const item of todos) {
      exactKeys(item, TODO_KEYS);
      const id = own(item, 'id');
      const parentId = own(item, 'parentId');
      const title = own(item, 'title');
      const category = own(item, 'category');
      const priority = own(item, 'priority');
      const tags = own(item, 'tags');
      const completed = own(item, 'completed');
      const createdAt = own(item, 'createdAt');
      const completedAt = own(item, 'completedAt');
      const dueAt = own(item, 'dueAt');
      const repeat = own(item, 'repeat');
      const order = own(item, 'order');
      if (typeof id !== 'string' || !id || byId.has(id) ||
          (parentId !== null && (typeof parentId !== 'string' || !parentId)) ||
          typeof title !== 'string' || title.length < 1 || title.length > 100 || title !== title.trim() ||
          !categoryIds.has(category) ||
          !Number.isInteger(priority) || priority < 0 || priority > 3 ||
          !Array.isArray(tags) || tags.length > 5 || new Set(tags).size !== tags.length || tags.some((tag) =>
            typeof tag !== 'string' || !tag || tag !== tag.trim() || tag !== tag.toLowerCase()
          ) ||
          typeof completed !== 'boolean' || typeof createdAt !== 'number' || !Number.isFinite(createdAt) ||
          (completedAt !== null && (typeof completedAt !== 'number' || !Number.isFinite(completedAt))) ||
          (!completed && completedAt !== null) ||
          // 마감은 분 단위다. store가 내림해 담으므로 초가 섞인 값은 우리 것이 아니다.
          (dueAt !== null && (!Number.isInteger(dueAt) || dueAt < 1 || dueAt % 60000 !== 0)) ||
          // 반복은 마감이 있어야 서고, 상위에만 붙는다. 규칙은 store가 만든 모양 그대로다.
          (repeat !== null && (dueAt === null || parentId !== null)) ||
          !Number.isInteger(order) || order < 0) {
        deny('INVALID_CURRENT');
      }
      if (repeat !== null) {
        exactKeys(repeat, REPEAT_KEYS);
        const anchor = own(repeat, 'anchor');
        if (!REPEAT_UNITS.has(own(repeat, 'unit')) ||
            !Number.isInteger(anchor) || anchor < 1 || anchor % 60000 !== 0) {
          deny('INVALID_CURRENT');
        }
      }
      try {
        if (encodeURIComponent(decodeURIComponent(encodeURIComponent(id))) !== encodeURIComponent(id)) deny('INVALID_CURRENT');
      } catch (_) { deny('INVALID_CURRENT'); }
      byId.set(id, item);
    }

    for (const item of todos) {
      const parentId = own(item, 'parentId');
      if (parentId === null) continue;
      const parent = byId.get(parentId);
      if (!parent || own(parent, 'parentId') !== null || own(item, 'category') !== own(parent, 'category')) {
        deny('INVALID_CURRENT');
      }
    }
    const ordersByParent = new Map();
    for (const item of todos) {
      const parentId = own(item, 'parentId');
      const group = ordersByParent.get(parentId) || [];
      group.push(own(item, 'order'));
      ordersByParent.set(parentId, group);
    }
    for (const orders of ordersByParent.values()) {
      const sorted = orders.slice().sort((a, b) => a - b);
      if (sorted.some((order, index) => order !== index)) deny('INVALID_CURRENT');
    }
    const completionByParent = new Map();
    for (const item of todos) {
      const parentId = own(item, 'parentId');
      if (parentId === null) continue;
      const state = completionByParent.get(parentId) || { count: 0, all: true };
      state.count += 1;
      state.all = state.all && own(item, 'completed');
      completionByParent.set(parentId, state);
    }
    for (const parent of todos) {
      const state = completionByParent.get(own(parent, 'id'));
      if (state && own(parent, 'completed') !== state.all) deny('INVALID_CURRENT');
    }
    return { categories, todos, byId };
  }

  function clonePlain(value, seen = new Map()) {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    const out = Array.isArray(value) ? [] : {};
    seen.set(value, out);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      out[key] = clonePlain(own(value, key), seen);
    }
    return out;
  }

  function decodeText(encoded, line, field) {
    let output = '';
    for (let index = 0; index < encoded.length;) {
      const char = encoded[index];
      if (char === '\\') {
        const next = encoded[index + 1];
        if (!ESCAPED.has(next)) deny('INVALID_ESCAPE', { line, field });
        output += next;
        index += 2;
      } else if (char === '&') {
        if (encoded.startsWith('&amp;', index)) { output += '&'; index += 5; }
        else if (encoded.startsWith('&lt;', index)) { output += '<'; index += 4; }
        else if (encoded.startsWith('&gt;', index)) { output += '>'; index += 4; }
        else deny('INVALID_ESCAPE', { line, field });
      } else {
        if (char === '<' || char === '>' || char === '\r' || char === '\n') {
          deny('INVALID_ESCAPE', { line, field });
        }
        output += char;
        index += 1;
      }
    }
    if (MarkdownExport.escapeText(output) !== encoded) deny('INVALID_ESCAPE', { line, field });
    return output;
  }

  function splitPayload(payload) {
    const fields = [];
    let start = 0;
    for (;;) {
      const at = payload.indexOf(' #', start);
      if (at === -1) { fields.push(payload.slice(start)); break; }
      fields.push(payload.slice(start, at));
      start = at + 2;
    }
    return fields;
  }

  function parseTask(line, lineNumber, categoryId, lastRoot, currentById, seen, roots, children) {
    if (line.includes('\t')) deny('INVALID_HIERARCHY', { line: lineNumber });
    const match = /^(  )?- \[([ x])\] \(P([0-3])\) (.*) <!-- my-what-todo:id=([^ ]+) -->$/u.exec(line);
    if (!match) deny('TASK_SYNTAX', { line: lineNumber });
    const child = match[1] === '  ';
    if (child && !lastRoot) deny('INVALID_HIERARCHY', { line: lineNumber });
    const token = match[5];
    let id;
    try {
      id = decodeURIComponent(token);
      if (!id || encodeURIComponent(id) !== token) deny('INVALID_ID', { line: lineNumber });
    } catch (error) {
      if (error instanceof MarkdownImportError) throw error;
      deny('INVALID_ID', { line: lineNumber });
    }
    const current = currentById.get(id);
    if (!current) deny('UNKNOWN_ID', { line: lineNumber });
    if (seen.has(id)) deny('DUPLICATE_ID', { line: lineNumber });
    seen.add(id);

    const encodedFields = splitPayload(match[4]);
    if (!encodedFields[0]) deny('INVALID_FIELD', { line: lineNumber, field: 'title' });
    const decodedTitle = decodeText(encodedFields[0], lineNumber, 'title');
    const decodedTags = encodedFields.slice(1).map((field) => decodeText(field, lineNumber, 'tags'));
    const currentTitleEncoded = MarkdownExport.escapeText(own(current, 'title'));
    const currentTags = own(current, 'tags');
    const tagsUnchanged = encodedFields.length - 1 === currentTags.length &&
      currentTags.every((tag, index) => MarkdownExport.escapeText(tag) === encodedFields[index + 1]);
    const title = encodedFields[0] === currentTitleEncoded ? own(current, 'title') : decodedTitle;
    const tags = tagsUnchanged ? currentTags.slice() : decodedTags;
    if (encodedFields[0] !== currentTitleEncoded && (title.length < 1 || title.length > 100)) {
      deny('INVALID_FIELD', { line: lineNumber, field: 'title' });
    }
    if (!tagsUnchanged) {
      const unique = new Set(tags);
      if (tags.length > 5 || unique.size !== tags.length || tags.some((tag) =>
        !tag || tag !== tag.trim() || tag !== tag.toLowerCase() || tag.length > 100
      )) deny('INVALID_FIELD', { line: lineNumber, field: 'tags' });
    }

    const parsed = {
      id,
      parentId: child ? lastRoot.id : null,
      title,
      category: child ? lastRoot.category : categoryId,
      priority: Number(match[3]),
      tags,
      completed: match[2] === 'x',
      createdAt: own(current, 'createdAt'),
      completedAt: match[2] === (own(current, 'completed') ? 'x' : ' ')
        ? own(current, 'completedAt') : null,
      // 마감과 반복은 Markdown 한 줄에 적히지 않는다. 파일에서 고칠 수 있는 것이
      // 아니므로 **지금 값을 그대로 들고 온다** — 빠뜨리면 파일을 한 번 왕복하는
      // 것만으로 걸어둔 것이 전부 지워진다. createdAt과 같은 성격의 자리다.
      dueAt: own(current, 'dueAt'),
      // **참조를 그대로 물려주지 않는다.** 결과는 아래에서 deepFreeze되는데, 같은
      // 객체를 넘겨준 쪽도 함께 얼어붙는다. 그러면 그 스냅샷으로 다시 파싱할 때
      // "표준 데이터 속성이 아니다"로 거절당해 Markdown 저장이 영영 실패한다.
      repeat: cloneRepeat(own(current, 'repeat')),
      order: child ? (children.get(lastRoot.id)?.length || 0) : roots.length
    };
    if (child) {
      if (!children.has(lastRoot.id)) children.set(lastRoot.id, []);
      children.get(lastRoot.id).push(parsed);
    } else roots.push(parsed);
    return parsed;
  }

  function arraysEqual(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }

  function deepFreeze(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const key of Object.keys(value)) deepFreeze(value[key], seen);
    return Object.freeze(value);
  }

  function parseInternal(text, currentSnapshot) {
    if (!globalThis.MarkdownExport || typeof MarkdownExport.render !== 'function' ||
        typeof MarkdownExport.escapeText !== 'function') deny('INTERNAL_ERROR');
    const validated = validateCurrent(currentSnapshot);
    let currentCanonical;
    try { currentCanonical = MarkdownExport.render(currentSnapshot); }
    catch (_) { deny('INVALID_CURRENT'); }
    if (typeof text !== 'string') deny('INVALID_TEXT');
    const maximum = currentCanonical.length + validated.todos.length * 600 + 4096;
    if (text.length > maximum) deny('INPUT_TOO_LARGE');
    if (!text.startsWith(PREFIX)) deny('HEADER_MISMATCH');
    if (!text.endsWith('\n') || text.endsWith('\n\n')) deny('HEADER_MISMATCH');

    const body = text.slice(PREFIX.length, -1);
    const lines = body.split('\n');
    let cursor = 0;
    const seen = new Set();
    const roots = [];
    const children = new Map();
    const parsedById = new Map();

    for (let categoryIndex = 0; categoryIndex < validated.categories.length; categoryIndex += 1) {
      const category = validated.categories[categoryIndex];
      const expectedHeading = `## ${MarkdownExport.escapeText(own(category, 'name'))}`;
      if (lines[cursor] !== expectedHeading) deny('SECTION_MISMATCH', { line: cursor + 11 });
      cursor += 1;
      let lastRoot = null;
      if (lines[cursor] === '_할 일 없음_') {
        cursor += 1;
      } else {
        let count = 0;
        while (cursor < lines.length && lines[cursor] !== '') {
          const parsed = parseTask(
            lines[cursor], cursor + 11, own(category, 'id'), lastRoot,
            validated.byId, seen, roots, children
          );
          parsedById.set(parsed.id, parsed);
          if (parsed.parentId === null) lastRoot = parsed;
          count += 1;
          cursor += 1;
        }
        if (count === 0) deny('SECTION_MISMATCH', { line: cursor + 11 });
      }
      if (categoryIndex < validated.categories.length - 1) {
        if (lines[cursor] !== '') deny('SECTION_MISMATCH', { line: cursor + 11 });
        cursor += 1;
      }
    }
    if (cursor !== lines.length) deny('SECTION_MISMATCH', { line: cursor + 11 });
    if (seen.size !== validated.todos.length) deny('MISSING_ID');

    for (const root of roots) {
      const kids = children.get(root.id) || [];
      if (kids.length && root.completed !== kids.every((item) => item.completed)) {
        deny('COMPLETION_MISMATCH');
      }
    }

    const data = clonePlain(currentSnapshot);
    const oldById = new Map(validated.todos.map((item) => [own(item, 'id'), item]));
    data.todos = data.todos.map((item) => parsedById.get(item.id));
    const summary = {
      total: data.todos.length, changed: 0, completedChanged: 0, priorityChanged: 0,
      titleChanged: 0, tagsChanged: 0, categoryChanged: 0, reparented: 0, reordered: 0
    };
    for (const next of data.todos) {
      const old = oldById.get(next.id);
      const differences = {
        completedChanged: next.completed !== own(old, 'completed'),
        priorityChanged: next.priority !== own(old, 'priority'),
        titleChanged: next.title !== own(old, 'title'),
        tagsChanged: !arraysEqual(next.tags, own(old, 'tags')),
        categoryChanged: next.category !== own(old, 'category'),
        reparented: next.parentId !== own(old, 'parentId'),
        reordered: next.order !== own(old, 'order')
      };
      let changed = false;
      for (const [key, value] of Object.entries(differences)) {
        if (value) { summary[key] += 1; changed = true; }
      }
      if (changed) summary.changed += 1;
    }

    let rendered;
    try { rendered = MarkdownExport.render(data); }
    catch (_) { deny('ROUNDTRIP_MISMATCH'); }
    if (rendered !== text) deny('ROUNDTRIP_MISMATCH');
    return deepFreeze({ data, summary });
  }

  function parse(text, currentSnapshot) {
    try { return parseInternal(text, currentSnapshot); }
    catch (error) {
      if (error instanceof MarkdownImportError) throw error;
      throw new MarkdownImportError('INTERNAL_ERROR');
    }
  }

  globalThis.MarkdownImport = Object.freeze({ parse, MarkdownImportError });
})();
