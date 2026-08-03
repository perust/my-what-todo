/**
 * store.js — 데이터 계층. (PRD §4 F-04·F-06·F-09~F-12, §5, §8)
 *
 * DOM을 모른다. `document`, `window`를 참조하지 않는다.
 * 완료 전파, 정렬, 집계는 전부 여기서 끝낸다. UI는 돌려받은 배열을 그리기만 한다.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'daily-todo:v1';
  const CORRUPTED_KEY = 'daily-todo:v1:corrupted';
  const SCHEMA_VERSION = 3;
  const MAX_TITLE = 100;
  const MAX_CATEGORY_NAME = 12;

  /** 0이 가장 높다. 숫자 자체가 순위라 정렬 가중치를 따로 둘 필요가 없다. */
  const PRIORITIES = [0, 1, 2, 3];
  const DEFAULT_PRIORITY = 1;

  /** v2까지 쓰던 3단계 문자열. 앞의 세 자리로 그대로 옮겨온다. */
  const LEGACY_PRIORITY = { high: 0, normal: 1, low: 2 };

  const normalizePriority = (value) => {
    if (PRIORITIES.includes(value)) return value;
    if (typeof value === 'string' && value in LEGACY_PRIORITY) return LEGACY_PRIORITY[value];
    return DEFAULT_PRIORITY;
  };

  /** 처음 열었을 때 주어지는 세 가지. 이후로는 사용자가 늘리고 줄인다. */
  const DEFAULT_CATEGORIES = [
    { id: 'work', name: '업무', hue: 221 },
    { id: 'personal', name: '개인', hue: 142 },
    { id: 'study', name: '공부', hue: 262 }
  ];

  const defaultCategories = () => DEFAULT_CATEGORIES.map((c) => ({ ...c }));

  /** 평평한 배열 + parentId. 중첩 객체로 저장하지 않는다. (PRD §5) */
  let todos = [];
  let categories = defaultCategories();
  /** "light" | "dark" | null. null이면 OS 설정을 따른다. */
  let theme = null;
  /** 정렬 모드. 기본은 우선순위순 (F-06). */
  let sort = 'priority';
  let corrupted = false;

  /** 마지막으로 읽거나 쓴 저장본의 판 번호. 다른 탭이 쓰면 여기서 벌어진다. */
  let rev = 0;
  /** 직전 저장 실패의 종류. "conflict"(다른 탭이 먼저 씀) | "save"(용량 등) | null */
  let lastError = null;

  const hasCategory = (id) => categories.some((c) => c.id === id);

  // ────────────────────────────────────────────────────────────
  // 저장소 — localStorage가 막히면 메모리로 폴백한다 (PRD §8)
  // ────────────────────────────────────────────────────────────

  let memoryBlob = null;

  const backend = (() => {
    try {
      const probe = STORAGE_KEY + ':probe';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    } catch (e) {
      return null; // 시크릿 모드, 브라우저 차단 등
    }
  })();

  const readRaw = () => (backend ? backend.getItem(STORAGE_KEY) : memoryBlob);

  /** 쓰기 실패(QuotaExceededError 등)는 그대로 던진다. 롤백은 commit이 맡는다. */
  const writeRaw = (value) => {
    if (!backend) {
      memoryBlob = value;
      return;
    }
    backend.setItem(STORAGE_KEY, value);
  };

  const newId = () =>
    crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // ────────────────────────────────────────────────────────────
  // 내부 조회 헬퍼
  // ────────────────────────────────────────────────────────────

  /**
   * 조회 색인. 없으면 그때 만든다.
   * 이게 없으면 항목마다 배열 전체를 훑어 질의가 O(n²)이 된다 — 1000개에서 눈에 띈다.
   * 구조가 바뀌는 곳마다 invalidate()를 부른다.
   */
  let index = null;

  const invalidate = () => {
    index = null;
  };

  function getIndex() {
    if (index) return index;

    const byId = new Map();
    const children = new Map();

    for (const item of todos) {
      byId.set(item.id, item);
      const group = children.get(item.parentId);
      if (group) group.push(item);
      else children.set(item.parentId, [item]);
    }
    index = { byId, children };
    return index;
  }

  const EMPTY = [];

  const find = (id) => getIndex().byId.get(id) ?? null;
  const childrenOf = (parentId) => getIndex().children.get(parentId) ?? EMPTY;
  const hasChildren = (id) => childrenOf(id).length > 0;

  /** 형제 그룹 안에서만 쓰는 비교자들. 트리 구조는 어느 모드에서도 깨지지 않는다. */
  const catRank = (item) => {
    const i = categories.findIndex((c) => c.id === item.category);
    return i === -1 ? categories.length : i;
  };

  const COMPARE = {
    // 기본. 우선순위 1차, order 2차. 완료 여부는 영향을 주지 않는다. (F-06)
    priority: (a, b) => a.priority - b.priority || a.order - b.order,
    manual: (a, b) => a.order - b.order,
    created: (a, b) => a.createdAt - b.createdAt || a.order - b.order,
    category: (a, b) => catRank(a) - catRank(b) || a.order - b.order,
    completed: (a, b) => Number(a.completed) - Number(b.completed) || a.order - b.order
  };

  const SORTS = Object.keys(COMPARE);

  const compare = (a, b) => COMPARE[sort](a, b);

  /** 정렬은 형제 그룹 안에서만. 원본 배열을 건드리지 않는다. */
  const sorted = (group) => group.slice().sort(compare);

  const clone = (item) => ({ ...item, tags: item.tags.slice() });

  const nextOrder = (parentId) =>
    todos.reduce((max, t) => (t.parentId === parentId ? Math.max(max, t.order + 1) : max), 0);

  // ────────────────────────────────────────────────────────────
  // 필터 (PRD §4 F-09)
  // ────────────────────────────────────────────────────────────

  /**
   * 분류 축(전체/카테고리/태그)은 한 번에 하나만 켜진다.
   * 검색어는 그 위에 얹히는 별도 축이라 어느 필터와도 함께 걸린다.
   */
  const normalizeFilter = (filter) => {
    const f = filter ?? {};
    const query = typeof f.query === 'string' ? f.query.trim().toLowerCase() : '';

    if (f.type === 'category' && hasCategory(f.value)) {
      return { type: 'category', value: f.value, query };
    }
    if (f.type === 'tag' && typeof f.value === 'string' && f.value) {
      return { type: 'tag', value: f.value, query };
    }
    return { type: 'all', query };
  };

  const hasTag = (item, tag) => item.tags.includes(tag);

  const matchesQuery = (item, q) =>
    !q || item.title.toLowerCase().includes(q) || item.tags.some((t) => t.includes(q));

  const matchesAxis = (item, f) => {
    // 카테고리 필터는 상위 기준. 하위는 상위 카테고리를 상속하므로 함께 걸린다.
    if (f.type === 'category') {
      const root = item.parentId === null ? item : find(item.parentId);
      return !!root && root.category === f.value;
    }
    if (f.type === 'tag') return hasTag(item, f.value);
    return true;
  };

  /** 그 항목 자체가 필터를 통과하는가. */
  const matchesSelf = (item, f) => matchesAxis(item, f) && matchesQuery(item, f.query);

  /** 자신은 걸리지 않았지만 매칭된 하위를 가져 문맥용으로만 보이는 상위인가. */
  const contextRow = (item, f) =>
    item.parentId === null &&
    !matchesSelf(item, f) &&
    childrenOf(item.id).some((c) => matchesSelf(c, f));

  const isVisible = (item, f) => matchesSelf(item, f) || contextRow(item, f);

  // ────────────────────────────────────────────────────────────
  // 완료 전파 (PRD §4 F-11)
  // ────────────────────────────────────────────────────────────

  const setCompleted = (item, value) => {
    if (item.completed === value) return;
    item.completed = value;
    item.completedAt = value ? Date.now() : null;
  };

  /** 상향 전파와 상향 해제. 하위가 없는 상위는 독립적으로 동작하므로 건드리지 않는다. */
  const reconcileParent = (parent) => {
    if (!parent) return;
    const kids = childrenOf(parent.id);
    if (!kids.length) return;
    setCompleted(parent, kids.every((k) => k.completed));
  };

  /**
   * 지워질 대상 — 완료한 항목과 그 하위 전부.
   * 완료한 상위는 하위도 전부 완료라 사실상 같지만, 데이터가 어긋나 있어도 함께 걷어낸다.
   */
  function completedSet() {
    const doomed = new Map();

    for (const item of todos) {
      if (!item.completed) continue;
      doomed.set(item.id, item);
      for (const child of childrenOf(item.id)) doomed.set(child.id, child);
    }
    return doomed;
  }

  const reconcileAll = () => {
    for (const item of todos) {
      if (item.parentId === null) reconcileParent(item);
    }
  };

  /**
   * 파싱된 객체를 현재 상태로 받아들인다. 저장본을 열 때와 파일을 가져올 때가
   * **같은 검증을 탄다** — 가져온 파일이 앱을 무너뜨릴 수 없다는 뜻이다.
   */
  function adopt(parsed) {
    theme = parsed?.theme === 'light' || parsed?.theme === 'dark' ? parsed.theme : null;
    sort = SORTS.includes(parsed?.sort) ? parsed.sort : 'priority';

    // 카테고리를 먼저 세운다. 항목 검증이 이 목록을 기준으로 돌아간다.
    categories = normalizeCategories(parsed?.categories);

    const list = Array.isArray(parsed?.todos) ? parsed.todos : [];

    todos = validateSchema(list);
    todos = coerceFields(todos);
    todos = breakCycles(todos);
    todos = promoteOrphans(todos);
    todos = flattenDepth(todos);
    todos = renumber(todos);
    invalidate();
    reconcileAll();
  }

  // ────────────────────────────────────────────────────────────
  // 로드 시 검증 (PRD §8 "로드 시 검증 순서")
  // 스키마 → priority/tags 교정 → 순환 참조 → 고아 승격 → 깊이 평탄화 → order 재정렬
  // ────────────────────────────────────────────────────────────

  /** 카테고리 목록 검증. v1 데이터에는 없으므로 그때는 기본 셋으로 시작한다. */
  function normalizeCategories(list) {
    if (!Array.isArray(list)) return defaultCategories();

    const seen = new Set();
    const out = [];

    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      if (typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) continue;
      if (typeof raw.name !== 'string' || !raw.name.trim()) continue;

      seen.add(raw.id);
      out.push({
        id: raw.id,
        name: raw.name.trim().slice(0, MAX_CATEGORY_NAME),
        hue: Number.isFinite(raw.hue) ? (((raw.hue % 360) + 360) % 360) : 0
      });
    }

    // 하나도 못 살렸으면 미분류 상태가 되어버린다. 기본 셋으로 되돌린다.
    return out.length ? out : defaultCategories();
  }

  /** 1. 스키마 검증 — 항목 단위. 불량 항목만 버리고 나머지는 살린다. */
  function validateSchema(list) {
    const seenIds = new Set();
    const out = [];

    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      if (typeof raw.id !== 'string' || !raw.id || seenIds.has(raw.id)) continue;
      if (typeof raw.title !== 'string' || !raw.title.trim()) continue;

      seenIds.add(raw.id);
      out.push({
        id: raw.id,
        parentId: typeof raw.parentId === 'string' && raw.parentId ? raw.parentId : null,
        title: raw.title.trim().slice(0, MAX_TITLE),
        // 카테고리는 이제 지워질 수 있다. 모르는 값이면 버리지 말고 첫 번째로 옮긴다.
        category: hasCategory(raw.category) ? raw.category : categories[0].id,
        priority: raw.priority, // 2단계에서 교정
        tags: raw.tags, // 2단계에서 교정
        completed: raw.completed === true,
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
        completedAt: Number.isFinite(raw.completedAt) ? raw.completedAt : null,
        order: Number.isFinite(raw.order) ? raw.order : 0
      });
    }
    return out;
  }

  /** 2. priority·tags 교정 — 버리지 않고 고친다. */
  function coerceFields(list) {
    for (const item of list) {
      item.priority = normalizePriority(item.priority);
      item.tags = Parse.normalizeTags(item.tags);
      if (!item.completed) item.completedAt = null;
    }
    return list;
  }

  /** 3. 순환 참조 제거 (A→B→A, A→A) — 감지된 항목을 상위로 승격. */
  function breakCycles(list) {
    const byId = new Map(list.map((t) => [t.id, t]));

    for (const item of list) {
      const path = new Set([item.id]);
      let cur = item;

      while (cur.parentId && byId.has(cur.parentId)) {
        if (path.has(cur.parentId)) {
          cur.parentId = null;
          break;
        }
        path.add(cur.parentId);
        cur = byId.get(cur.parentId);
      }
    }
    return list;
  }

  /** 4. 고아 승격 — parentId가 가리키는 부모가 없으면 상위가 된다. */
  function promoteOrphans(list) {
    const ids = new Set(list.map((t) => t.id));
    for (const item of list) {
      if (item.parentId !== null && !ids.has(item.parentId)) item.parentId = null;
    }
    return list;
  }

  /** 5. 깊이 평탄화 — 손자 이상은 상위로 승격해 2단계로 만든다. */
  function flattenDepth(list) {
    const byId = new Map(list.map((t) => [t.id, t]));
    let changed = true;

    // 한 번 승격하면 그 아래가 다시 2단계 안으로 들어오므로 안정될 때까지 반복한다.
    while (changed) {
      changed = false;
      for (const item of list) {
        if (item.parentId === null) continue;
        const parent = byId.get(item.parentId);
        if (parent && parent.parentId !== null) {
          item.parentId = null;
          changed = true;
        }
      }
    }
    return list;
  }

  /** 6. 카테고리 상속 재확인 + 형제 그룹별 order 재정렬. */
  function renumber(list) {
    const byId = new Map(list.map((t) => [t.id, t]));
    const groups = new Map();

    for (const item of list) {
      if (item.parentId !== null) {
        const parent = byId.get(item.parentId);
        if (parent) item.category = parent.category; // 하위는 상위를 상속한다 (F-08)
      }
      // Map은 아무 값이나 키로 받는다. null을 그대로 써서 상위 그룹을 구분한다.
      const key = item.parentId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    for (const group of groups.values()) {
      group.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
      group.forEach((item, i) => {
        item.order = i;
      });
    }
    return list;
  }

  // ────────────────────────────────────────────────────────────
  // 저장 — 실패하면 변경 전체를 롤백한다 (PRD §8 "부분 적용 금지")
  // ────────────────────────────────────────────────────────────

  /**
   * 쓰기 직전에 저장소를 다시 읽어 우리가 마지막으로 본 판(rev)과 같은지 본다.
   * 다르면 그 사이 다른 탭이 썼다는 뜻이라 **덮어쓰지 않고 물러난다**.
   * `storage` 이벤트만으로는 부족하다 — 이벤트가 도착하기 전에 우리가 먼저 쓸 수 있다.
   */
  function persist() {
    lastError = null;

    let stored = null;
    try {
      const raw = readRaw();
      if (raw) stored = JSON.parse(raw);
    } catch (e) {
      stored = null; // 읽을 수 없는 값은 지켜줄 것이 없다
    }

    if (stored && Number.isFinite(stored.rev) && stored.rev !== rev) {
      lastError = 'conflict';
      return false;
    }

    const next = rev + 1;
    try {
      writeRaw(
        JSON.stringify({ version: SCHEMA_VERSION, rev: next, theme, sort, categories, todos })
      );
    } catch (e) {
      lastError = 'save'; // QuotaExceededError 등
      return false;
    }

    rev = next;
    return true;
  }

  /**
   * 스냅샷을 원본 객체 **안에** 되돌린다.
   * 배열만 갈아끼우면 호출부가 이미 들고 있던 참조가 변경된 채 남아 부분 적용이 된다.
   */
  function rollback(snapshot, originals) {
    todos = snapshot.map((saved) => {
      const original = originals.get(saved.id);
      if (!original) return saved;
      Object.assign(original, saved, { tags: saved.tags.slice() });
      return original;
    });
    invalidate();
  }

  /**
   * 변경을 스냅샷으로 감싼다. 저장에 실패하면 전파 포함 전부 되돌리고 null을 준다.
   * 호출부는 null을 "저장하지 못했다"로 읽으면 된다.
   */
  function commit(mutate) {
    const snapshot = todos.map(clone);
    const catSnapshot = categories.map((c) => ({ ...c }));
    const themeSnapshot = theme;
    const sortSnapshot = sort;
    const originals = new Map(todos.map((t) => [t.id, t]));
    let result;

    const undo = () => {
      rollback(snapshot, originals);
      categories = catSnapshot;
      theme = themeSnapshot;
      sort = sortSnapshot;
    };

    try {
      result = mutate();
    } catch (e) {
      undo();
      throw e;
    }

    if (!persist()) {
      undo();
      return null;
    }
    return result;
  }

  /**
   * 새 카테고리의 색조 — 이미 쓰는 색들과 가장 멀리 떨어진 자리를 고른다.
   * 색으로 구분되는 축이라 인접한 색조가 붙으면 구실을 못한다.
   */
  function pickHue() {
    const used = categories.map((c) => c.hue);
    if (!used.length) return DEFAULT_CATEGORIES[0].hue;

    let best = 0;
    let bestGap = -1;

    for (let h = 0; h < 360; h += 5) {
      const gap = Math.min(
        ...used.map((u) => {
          const d = (((h - u) % 360) + 360) % 360;
          return Math.min(d, 360 - d);
        })
      );
      if (gap > bestGap) {
        bestGap = gap;
        best = h;
      }
    }
    return best;
  }

  function createItem(fields) {
    return {
      id: newId(),
      parentId: fields.parentId,
      title: fields.title,
      category: fields.category,
      priority: normalizePriority(fields.priority),
      tags: Parse.normalizeTags(fields.tags),
      completed: false,
      createdAt: Date.now(),
      completedAt: null,
      order: nextOrder(fields.parentId)
    };
  }

  const validTitle = (parsed) => {
    const title = typeof parsed?.title === 'string' ? parsed.title.trim() : '';
    return title && title.length <= MAX_TITLE ? title : null;
  };

  // ────────────────────────────────────────────────────────────
  // 공개 API
  // ────────────────────────────────────────────────────────────

  const Store = {
    /** UI가 storage 이벤트를 걸러낼 때 쓴다. 키를 아는 건 여전히 데이터 계층뿐이다. */
    STORAGE_KEY,
    PRIORITIES,
    MAX_TITLE,
    MAX_CATEGORY_NAME,

    /** localStorage를 쓰고 있는가. false면 메모리 폴백 중이라 탭을 닫으면 사라진다. */
    get isPersistent() {
      return backend !== null;
    },

    /** 직전 load()에서 손상된 데이터를 발견했는가. */
    get wasCorrupted() {
      return corrupted;
    },

    /**
     * 직전 변경이 왜 실패했는가. 변경 API가 null을 줬을 때만 의미가 있다.
     * "conflict"면 다른 탭이 먼저 썼다는 뜻이라, 최신 내용을 다시 읽어야 한다.
     */
    get lastError() {
      return lastError;
    },

    /** 사용자가 고른 테마. null이면 OS 설정을 따른다는 뜻이다. */
    getTheme() {
      return theme;
    },

    setTheme(next) {
      const value = next === 'light' || next === 'dark' ? next : null;
      return commit(() => {
        theme = value;
        return value;
      });
    },

    SORTS,

    getSort() {
      return sort;
    },

    setSort(next) {
      if (!SORTS.includes(next)) return null;
      return commit(() => {
        sort = next;
        return next;
      });
    },

    /**
     * 형제 그룹 안에서 자리를 옮긴다. **부모는 바꾸지 않는다** —
     * 부모가 바뀌면 캐스케이드 범위와 진행률 분모가 함께 흔들린다.
     * beforeId가 null이면 맨 뒤로 보낸다.
     */
    reorder(id, beforeId) {
      const item = find(id);
      if (!item || id === beforeId) return null;

      const before = beforeId ? find(beforeId) : null;
      if (beforeId && (!before || before.parentId !== item.parentId)) return null;

      const group = sorted(childrenOf(item.parentId));
      const rest = group.filter((t) => t.id !== id);
      const at = before ? rest.findIndex((t) => t.id === beforeId) : rest.length;
      if (before && at === -1) return null;

      rest.splice(at, 0, item);

      return commit(() => {
        rest.forEach((t, i) => {
          t.order = i;
        });
        return item;
      });
    },

    /** 저장 형식 그대로 내보낸다. 가져오기가 같은 모양을 그대로 먹을 수 있게. */
    exportData() {
      return {
        version: SCHEMA_VERSION,
        theme,
        sort,
        categories: categories.map((c) => ({ ...c })),
        todos: todos.map(clone)
      };
    },

    /**
     * 가져온 객체로 통째로 갈아끼운다.
     * 로드와 **같은 검증 파이프라인**을 태우므로 깨진 파일도 앱을 무너뜨리지 않는다.
     */
    importData(raw) {
      if (!raw || typeof raw !== 'object') return null;

      const snapshot = { todos, categories, theme, sort };
      adopt(raw);

      const result = commit(() => ({
        todos: todos.length,
        categories: categories.length
      }));

      if (result === null) {
        // 저장에 실패했으면 가져오기 전으로 통째로 되돌린다
        todos = snapshot.todos;
        categories = snapshot.categories;
        theme = snapshot.theme;
        sort = snapshot.sort;
        invalidate();
      }
      return result;
    },

    /** 완료한 항목과 그 하위 전부. 지우기 전에 몇 개인지 물어보려면 필요하다. */
    countCompleted() {
      return completedSet().size;
    },

    /** 완료한 항목을 한 번에 지운다. 되돌리기용으로 지워진 항목 전부를 돌려준다. */
    removeCompleted() {
      const doomed = completedSet();
      if (!doomed.size) return null;

      const removed = [...doomed.values()].map(clone);
      const parentIds = new Set(
        [...doomed.values()].map((t) => t.parentId).filter((id) => id && !doomed.has(id))
      );

      return commit(() => {
        todos = todos.filter((t) => !doomed.has(t.id));
        invalidate();
        for (const id of parentIds) reconcileParent(find(id));
        return removed;
      });
    },

    load() {
      corrupted = false;
      lastError = null;
      rev = 0;
      todos = [];
      invalidate();
      categories = defaultCategories();
      theme = null;
      sort = 'priority';

      const raw = readRaw();
      if (!raw) return todos;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // 손상된 데이터는 버리지 않고 옆으로 옮긴다. 빈 목록으로 시작한다.
        corrupted = true;
        try {
          if (backend) {
            backend.setItem(CORRUPTED_KEY, raw);
            backend.removeItem(STORAGE_KEY);
          } else {
            memoryBlob = null;
          }
        } catch (_) {
          /* 옮기지 못해도 앱은 계속 뜬다 */
        }
        return todos;
      }

      // 판 번호는 adopt 밖에서 다룬다 — 가져온 파일에는 없는 값이다
      rev = Number.isFinite(parsed?.rev) ? parsed.rev : 0;

      adopt(parsed);
      return todos;
    },

    save() {
      return persist();
    },

    // ── 카테고리 ────────────────────────────────────────────

    /** 복사본을 돌려준다. UI가 목록을 직접 건드리지 못하게 한다. */
    getCategories() {
      return categories.map((c) => ({ ...c }));
    },

    /** 해당 카테고리에 속한 항목 수. 상위·하위를 모두 센다. */
    countInCategory(id) {
      return todos.filter((t) => t.category === id).length;
    },

    addCategory(name) {
      const label = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
      if (!label || label.length > MAX_CATEGORY_NAME) return null;
      if (categories.some((c) => c.name === label)) return null; // 같은 이름은 구분이 안 된다

      return commit(() => {
        const category = { id: newId(), name: label, hue: pickHue() };
        categories.push(category);
        return category;
      });
    },

    /**
     * 카테고리 삭제. 항목이 남아 있으면 옮겨갈 곳을 반드시 지정해야 한다 —
     * 미분류는 없기 때문이다 (F-08). 마지막 하나는 지울 수 없다.
     */
    removeCategory(id, moveToId) {
      if (!hasCategory(id) || categories.length <= 1) return null;

      const used = todos.some((t) => t.category === id);
      const target = moveToId !== id && hasCategory(moveToId) ? moveToId : null;
      if (used && !target) return null;

      return commit(() => {
        if (used) {
          for (const item of todos) if (item.category === id) item.category = target;
        }
        const removed = categories.find((c) => c.id === id);
        categories = categories.filter((c) => c.id !== id);
        return removed;
      });
    },

    /** 상위 할 일 추가. parsed는 Parse.parseInput의 결과. */
    add(parsed, category) {
      const title = validTitle(parsed);
      if (!title) return null;

      const cat = hasCategory(category) ? category : categories[0].id;

      return commit(() => {
        const item = createItem({
          parentId: null,
          title,
          category: cat,
          priority: parsed.priority,
          tags: parsed.tags
        });
        todos.push(item);
        invalidate();
        return item;
      });
    },

    /** 하위 할 일 추가. 상위가 아닌 항목에는 붙지 않는다 (3단계 차단). */
    addChild(parentId, parsed) {
      const parent = find(parentId);
      if (!parent || parent.parentId !== null) return null;

      const title = validTitle(parsed);
      if (!title) return null;

      return commit(() => {
        const item = createItem({
          parentId: parent.id,
          title,
          category: parent.category, // 하위는 상위를 상속한다
          priority: parsed.priority,
          tags: parsed.tags
        });
        todos.push(item);
        invalidate();
        reconcileParent(parent); // 미완료 하위가 붙으면 완료였던 상위가 풀린다
        return item;
      });
    },

    /** title / category / priority / tags 부분 갱신. 잘못된 값이면 아무것도 바꾸지 않는다. */
    update(id, patch = {}) {
      const item = find(id);
      if (!item) return null;

      const next = {};

      if (patch.title !== undefined) {
        const title = validTitle({ title: patch.title });
        if (!title) return null;
        next.title = title;
      }
      if (patch.category !== undefined) {
        if (!hasCategory(patch.category)) return null;
        next.category = patch.category;
      }
      if (patch.priority !== undefined) {
        if (!PRIORITIES.includes(patch.priority)) return null;
        next.priority = patch.priority;
      }
      if (patch.tags !== undefined) {
        next.tags = Parse.normalizeTags(patch.tags);
      }

      return commit(() => {
        Object.assign(item, next);

        // 상위 카테고리를 바꾸면 하위도 따라간다 (F-03)
        if (next.category !== undefined && item.parentId === null) {
          for (const child of childrenOf(item.id)) child.category = next.category;
        }
        return item;
      });
    },

    /** 캐스케이드 삭제. 되돌리기용으로 삭제된 항목 전부를 돌려준다. */
    remove(id) {
      const item = find(id);
      if (!item) return null;

      const doomed = [item, ...Store.getDescendants(id)];
      const parentId = item.parentId;

      return commit(() => {
        const ids = new Set(doomed.map((t) => t.id));
        const removed = doomed.map(clone);

        todos = todos.filter((t) => !ids.has(t.id));
        invalidate();
        if (parentId) reconcileParent(find(parentId));

        return removed;
      });
    },

    /** remove()가 돌려준 항목들을 구조·순서·우선순위·태그 그대로 되살린다 (F-04 실행 취소). */
    restore(items) {
      if (!Array.isArray(items) || !items.length) return null;

      return commit(() => {
        const existing = new Set(todos.map((t) => t.id));
        const revived = items.filter((raw) => raw && raw.id && !existing.has(raw.id)).map(clone);
        if (!revived.length) return [];

        todos.push(...revived);
        invalidate();

        // 그 사이 부모가 사라졌다면 상위로 승격한다
        const ids = new Set(todos.map((t) => t.id));
        for (const item of revived) {
          if (item.parentId && !ids.has(item.parentId)) item.parentId = null;
        }
        for (const item of revived) {
          if (item.parentId) reconcileParent(find(item.parentId));
        }
        return revived;
      });
    },

    /** 완료 토글 + 전파. 하향/상향/상향 해제를 전부 여기서 끝낸다. */
    toggle(id) {
      const item = find(id);
      if (!item) return null;

      return commit(() => {
        const next = !item.completed;
        setCompleted(item, next);

        if (item.parentId === null) {
          for (const child of childrenOf(item.id)) setCompleted(child, next); // 하향 전파
        } else {
          reconcileParent(find(item.parentId)); // 상향 전파 / 상향 해제
        }
        return item;
      });
    },

    /** 필터를 통과한 상위 항목, 정렬 적용. */
    getRoots(filter) {
      const f = normalizeFilter(filter);
      return sorted(childrenOf(null).filter((t) => isVisible(t, f)));
    },

    /**
     * 해당 부모의 자식, 정렬 적용.
     * filter를 넘기지 않으면 전부 돌려준다 — indeterminate 판정처럼
     * "화면에 보이는 것"이 아니라 "실제 자식 전부"가 필요한 곳이 있다.
     */
    getChildren(parentId, filter) {
      const f = normalizeFilter(filter);
      return sorted(childrenOf(parentId).filter((t) => isVisible(t, f)));
    },

    /** id로 항목 하나. 색인을 쓰므로 상수 시간이다. */
    getItem(id) {
      return find(id);
    },

    /** 하위가 하나도 없는가. 진행률의 단위다. */
    isLeaf(id) {
      return !!find(id) && !hasChildren(id);
    },

    /** 리프만 센다. 하위를 가진 상위는 분모에서 빠진다. (PRD §4 F-10) */
    getStats(filter) {
      const f = normalizeFilter(filter);
      const leaves = todos.filter((t) => isVisible(t, f) && !hasChildren(t.id));
      const total = leaves.length;
      const done = leaves.filter((t) => t.completed).length;

      return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
    },

    /** 현재 필터에 보이는 항목들이 쓰고 있는 태그와 그 미완료 개수. */
    getAllTags(filter) {
      const f = normalizeFilter(filter);
      const counts = new Map();

      for (const item of todos) {
        if (!isVisible(item, f)) continue;
        for (const tag of item.tags) {
          const open = counts.get(tag) ?? 0;
          counts.set(tag, open + (item.completed ? 0 : 1));
        }
      }

      return [...counts]
        .map(([tag, openCount]) => ({ tag, openCount }))
        .sort((a, b) => a.tag.localeCompare(b.tag, 'ko'));
    },

    /** 캐스케이드 삭제·복원용. 깊이는 2로 고정이지만 폭넓게 훑는다. */
    getDescendants(id) {
      const out = [];
      let frontier = [id];

      while (frontier.length) {
        const next = [];
        for (const parentId of frontier) {
          for (const child of childrenOf(parentId)) {
            out.push(child);
            next.push(child.id);
          }
        }
        frontier = next;
      }
      return out;
    },

    /** 태그 필터에서 문맥용으로만 표시되는 상위인가. 조작을 막는 근거가 된다. */
    isContextRow(id, filter) {
      const item = find(id);
      if (!item) return false;
      return contextRow(item, normalizeFilter(filter));
    }
  };

  global.Store = Store;
})(globalThis);
