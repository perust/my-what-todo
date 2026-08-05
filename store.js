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
  /** 5에서 미니 타이머 불투명도(miniOpacity)가 늘었다. 키는 그대로 두고 이 숫자만 올린다. */
  const SCHEMA_VERSION = 5;
  const MAX_TITLE = 100;
  const MAX_CATEGORY_NAME = 12;

  /**
   * 카테고리 개수 상한. 화면이 감당할 수를 한참 넘겨 잡은 값이지만, 상한이 아예 없으면
   * 카테고리가 수십만 개인 파일 하나로 pickHue의 `Math.min(...used)`가 인자 개수 제한에
   * 걸려 `RangeError`를 던지고 앱이 그 자리에서 멈춘다.
   */
  const MAX_CATEGORIES = 64;

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

  /**
   * 뽀모도로 사이클 — 네 회차를 돌고 처음으로 돌아간다.
   * 1~3회차 뒤에는 짧은 휴식, 4회차 뒤에는 긴 휴식이 온다. 길이는 회차마다 바꾼다.
   */
  const POMO_ROUNDS = 4;
  const POMO_MIN_MINUTES = 1;
  const POMO_MAX_MINUTES = 180;

  const DEFAULT_POMODORO = [
    { focus: 25, rest: 5 },
    { focus: 25, rest: 5 },
    { focus: 25, rest: 5 },
    { focus: 25, rest: 25 }
  ];

  const defaultPomodoro = () => DEFAULT_POMODORO.map((round) => ({ ...round }));

  const clampMinutes = (value, fallback) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= POMO_MIN_MINUTES && n <= POMO_MAX_MINUTES ? n : fallback;
  };

  /**
   * 회차 수는 고정이다. 모자라거나 망가진 자리는 base의 값을 지킨다.
   * base를 넘기지 않으면 공장 기본값이 된다 — 저장본을 처음 읽을 때가 그렇다.
   * 값을 고칠 때는 지금 값을 base로 줘야 한다. 한 칸이 잘못됐다고
   * 손대지도 않은 다른 칸이 기본값으로 돌아가면 안 된다.
   */
  function normalizePomodoro(list, base) {
    const out = (base ?? DEFAULT_POMODORO).map((round) => ({ ...round }));
    if (!Array.isArray(list)) return out;

    for (let i = 0; i < POMO_ROUNDS; i++) {
      const raw = list[i];
      if (!raw || typeof raw !== 'object') continue;
      out[i].focus = clampMinutes(raw.focus, out[i].focus);
      out[i].rest = clampMinutes(raw.rest, out[i].rest);
    }
    return out;
  }

  /**
   * 미니 타이머 바탕이 얼마나 진한가(%). 100이면 불투명하고 0이면 바탕 없이 글자만 뜬다.
   *
   * **글자에는 걸지 않는다.** 통째로 흐리게 하면 대비가 그만큼 떨어지고, 얼마나 떨어졌는지는
   * 계산해보기 전에는 보이지 않는다 — 흐린 회색 글자는 0%에서 3.5:1까지 내려가 AA에 못 미친다.
   * 바탕과 테두리만 옅어지므로 어느 값에서도 글자는 그대로 읽힌다.
   */
  const MINI_OPACITY_DEFAULT = 82;

  const normalizeMiniOpacity = (value) => {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : MINI_OPACITY_DEFAULT;
  };

  /** 처음 열었을 때 주어지는 세 가지. 이후로는 사용자가 늘리고 줄인다. */
  const DEFAULT_CATEGORIES = [
    { id: 'work', name: '업무', hue: 221 },
    { id: 'personal', name: '개인', hue: 142 },
    { id: 'study', name: '공부', hue: 262 }
  ];

  const defaultCategories = () => DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  const normalizeCategoryName = (name) =>
    typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';

  /** 평평한 배열 + parentId. 중첩 객체로 저장하지 않는다. (PRD §5) */
  let todos = [];
  let categories = defaultCategories();
  /** "light" | "dark" | null. null이면 OS 설정을 따른다. */
  let theme = null;
  const validTheme = (value) => (value === 'light' || value === 'dark' ? value : null);
  /** 정렬 모드. 기본은 우선순위순 (F-06). */
  let sort = 'priority';
  /**
   * 뽀모도로 회차별 길이(분). **설정만** 여기 담는다.
   * 돌아가는 상태는 이 블롭에 넣지 않는다 — saveRun/loadRun이 따로 맡는다.
   */
  let pomodoro = defaultPomodoro();
  /** 미니 타이머 바탕의 진하기(%). 테마와 같은 성격의 화면 설정이라 여기 함께 담는다. */
  let miniOpacity = MINI_OPACITY_DEFAULT;
  let corrupted = false;

  /** 마지막으로 읽거나 쓴 저장본의 판 번호. 다른 탭이 쓰면 여기서 벌어진다. */
  let rev = 0;
  /**
   * 판 번호가 없던 저장본의 원문. 판 번호를 넣기 전에 쓰인 v1·v2 블롭이 여기 해당한다.
   * 비교할 판 번호가 없을 때는 **원문이 그대로인 것**이 "그 사이 아무도 쓰지 않았다"는
   * 유일한 증거다. 이걸 들고 있지 않으면 둘 중 하나를 고르게 된다 — 그냥 덮어써서 남의
   * 저장본을 날리거나, 전부 충돌로 보아 옛 저장본을 가진 사람이 영영 저장하지 못하거나.
   */
  let revlessRaw = null;
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

  /** 읽기는 실패해도 던지지 않는다. 못 읽은 것을 없는 것으로 보아야 첫 페인트가 멈추지 않는다. */
  const readRaw = () => {
    if (!backend) return memoryBlob;
    try {
      return backend.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  };

  /**
   * 돌아가는 뽀모도로는 **세션 저장소**에 따로 둔다. 저장 형식(`daily-todo:v1`)에
   * 섞지 않는 이유가 셋 있다.
   *
   * 하나, 판 번호가 올라 다른 탭이 전부 다시 읽는다. 그 탭이 고치던 제목과
   * 되돌릴 수 있던 5초가 타이머를 시작했다는 이유로 날아간다.
   * 둘, 타이머는 탭마다 따로 도는 것이라 탭 사이에서 공유할 것이 아니다.
   * 셋, 내보낸 파일에 끝나는 시각이 들어가면 남의 기기에서 이미 지난 시각이 된다.
   *
   * 세션 저장소는 새로고침을 넘기고 탭을 닫으면 사라진다. 필요한 만큼과 정확히 같다.
   */
  const RUN_KEY = STORAGE_KEY + ':run';

  const runBackend = (() => {
    try {
      const probe = RUN_KEY + ':probe';
      sessionStorage.setItem(probe, '1');
      sessionStorage.removeItem(probe);
      return sessionStorage;
    } catch (e) {
      return null; // 못 쓰면 새로고침에 사라진다. 예전과 같아질 뿐이다.
    }
  })();

  /** 쓰기 실패(QuotaExceededError 등)는 그대로 던진다. 롤백은 commit이 맡는다. */
  const writeRaw = (value) => {
    if (!backend) {
      memoryBlob = value;
      return;
    }
    backend.setItem(STORAGE_KEY, value);
  };

  /**
   * 손상된 저장본을 옆으로 옮기고 빈 목록으로 시작한다.
   * 지우지 않는 이유는 사용자가 나중에 `:corrupted`에서 원본을 건져낼 수 있어야 하기 때문이다.
   * 옮기기까지 실패하면 그냥 넘어간다 — 앱이 뜨는 것이 먼저다.
   */
  function quarantine(raw) {
    corrupted = true;
    try {
      if (backend) {
        backend.setItem(CORRUPTED_KEY, raw);
        backend.removeItem(STORAGE_KEY);
      } else {
        memoryBlob = null;
      }
    } catch (e) {
      /* 옮기지 못해도 앱은 계속 뜬다 */
    }
  }

  /**
   * 저장 블롭의 앞머리. `persist()`는 판 번호 하나 때문에, `peekTheme()`은 테마 하나 때문에
   * 블롭을 통째로 파싱했다 — 항목 1000개(218KB)에서 `JSON.parse` 한 번이 1.79ms고,
   * 그게 변경 한 번의 30%다. `peekTheme()`은 첫 페인트 **앞**이라 그만큼 화면이 늦게 뜬다.
   * `persist()`가 늘 같은 순서로 쓰므로 앞머리는 고정이고, 맨 앞에 앵커를 걸어 두 값만 꺼낸다.
   * 앵커가 없으면 할 일 제목 안에 든 `"rev":`에 잘못 걸린다.
   */
  const HEAD = /^\{"version":\d+,"rev":(\d+),"theme":(null|"light"|"dark"),/;

  /**
   * 저장본에서 판 번호와 테마만 꺼낸다. 앞머리로 먼저 읽고, 모양이 조금이라도 다르면
   * (키 순서가 다르거나, 사람이 들여썼거나, 판 번호가 없는 v1·v2거나) 통째 파싱으로 물러난다.
   * `rev`가 `null`이면 "읽지 못했다"는 뜻이다 — `0`과 구분해야 `persist()`가 물러날 자리를 안다.
   */
  function readHead(raw) {
    const head = HEAD.exec(raw);
    if (head) {
      return { rev: Number(head[1]), theme: head[2] === 'null' ? null : head[2].slice(1, -1) };
    }

    try {
      const parsed = JSON.parse(raw);
      return {
        rev: Number.isFinite(parsed?.rev) ? parsed.rev : null,
        theme: validTheme(parsed?.theme)
      };
    } catch (e) {
      return { rev: null, theme: null };
    }
  }

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
    theme = validTheme(parsed?.theme);
    sort = SORTS.includes(parsed?.sort) ? parsed.sort : 'priority';
    pomodoro = normalizePomodoro(parsed?.pomodoro);
    miniOpacity = normalizeMiniOpacity(parsed?.miniOpacity);

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

    const seenIds = new Set();
    const seenNames = new Set();
    const out = [];

    for (const raw of list) {
      // 상한을 넘긴 나머지는 읽지 않고 버린다. pickHue가 쓰는 자리 하나 때문에
      // 카테고리가 수만 개인 파일이 앱을 멈춰 세울 수 있다.
      if (out.length >= MAX_CATEGORIES) break;
      if (!raw || typeof raw !== 'object') continue;
      if (typeof raw.id !== 'string' || !raw.id || seenIds.has(raw.id)) continue;
      const name = normalizeCategoryName(raw.name).slice(0, MAX_CATEGORY_NAME);
      if (!name) continue;

      // 이름은 목록 안에서 유일해야 한다 (PRD §5). 색은 자동으로 배정되므로 이름까지 같으면
      // 배지만 보고는 어느 쪽인지 가릴 방법이 없다. addCategory·renameCategory가 막는 것을
      // 로드·가져오기 경로도 똑같이 막는다. 자른 뒤의 이름으로 비교해야 12자 너머에서만
      // 다른 이름이 화면에서 같아 보이는 것까지 걸린다.
      if (seenNames.has(name)) continue;

      seenIds.add(raw.id);
      seenNames.add(name);
      out.push({
        id: raw.id,
        name,
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

  /**
   * 3. 순환 참조 제거 (A→B→A, A→A) — 감지된 항목을 상위로 승격.
   *
   * 항목마다 조상 사슬을 끝까지 걸어 올라가면 O(n²)이다. 한 줄로 이어진 5,000개에서 944ms,
   * 20,000개에서 17.8초가 걸렸다. 가져오기는 클릭 핸들러 안에서 도는 동기 작업이라
   * 그동안 탭 전체가 응답하지 않는다.
   *
   * 그래서 지나간 자리를 표시해 한 번의 순회로 끝낸다. 'walking'은 지금 걷는 사슬,
   * 'done'은 이미 끝까지 확인한 사슬이다. 'walking'을 다시 만나면 그 자리가 순환이고,
   * 'done'을 만나면 그 위는 볼 필요가 없다 — 순환이 있었다면 그때 이미 끊었다.
   * 끊는 자리는 예전과 같다. 걷는 순서도, 순환을 만났을 때 누구의 parentId를 지우는지도
   * 그대로라 어떤 항목이 상위로 올라오는지 바뀌지 않는다.
   */
  function breakCycles(list) {
    const byId = new Map(list.map((t) => [t.id, t]));
    const state = new Map();
    const walked = [];

    for (const start of list) {
      if (state.get(start.id) === 'done') continue;

      walked.length = 0;
      let cur = start;

      for (;;) {
        state.set(cur.id, 'walking');
        walked.push(cur.id);

        const parent = cur.parentId ? byId.get(cur.parentId) : null;
        if (!parent) break; // 뿌리이거나 없는 부모를 가리킨다. 고아 승격이 이어서 맡는다.

        const mark = state.get(parent.id);
        if (mark === 'walking') {
          cur.parentId = null; // 이번 걸음에서 지나온 자리로 되돌아왔다 = 순환
          break;
        }
        if (mark === 'done') break;
        cur = parent;
      }

      for (const id of walked) state.set(id, 'done');
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

    const raw = readRaw();
    if (raw) {
      const stored = readHead(raw);

      // 판 번호를 읽을 수 없으면 비교할 것이 없다. 그렇다고 지켜줄 것이 없다고 단정하면
      // 남이 써둔 저장본을 그대로 덮는다. 우리가 load()에서 읽어온 그 원문일 때만 지나가고,
      // 아니면 물러나 load()를 다시 타게 한다 — 손상된 저장본은 그 길에 :corrupted로 옮겨지고,
      // 판 번호가 없는 옛 저장본은 다시 읽혀 그 다음 시도에서 통과한다.
      const mine = stored.rev === null ? raw === revlessRaw : stored.rev === rev;
      if (!mine) {
        lastError = 'conflict';
        return false;
      }
    }

    const next = rev + 1;
    try {
      writeRaw(
        JSON.stringify({
          version: SCHEMA_VERSION,
          rev: next,
          theme,
          sort,
          pomodoro,
          miniOpacity,
          categories,
          todos
        })
      );
    } catch (e) {
      lastError = 'save'; // QuotaExceededError 등
      return false;
    }

    rev = next;
    revlessRaw = null; // 이제 저장소에 든 것은 판 번호가 박힌 우리 블롭이다
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
    const pomoSnapshot = pomodoro.map((r) => ({ ...r }));
    const miniSnapshot = miniOpacity;
    const originals = new Map(todos.map((t) => [t.id, t]));
    let result;

    const undo = () => {
      rollback(snapshot, originals);
      categories = catSnapshot;
      theme = themeSnapshot;
      sort = sortSnapshot;
      pomodoro = pomoSnapshot;
      miniOpacity = miniSnapshot;
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
    /** UI가 "더 만들 수 없습니다"를 저장 실패와 다르게 알릴 수 있도록 함께 내준다. */
    MAX_CATEGORIES,

    /** localStorage를 쓰고 있는가. false면 메모리 폴백 중이라 탭을 닫으면 사라진다. */
    get isPersistent() {
      return backend !== null;
    },

    /**
     * 돌아가는 뽀모도로를 세션 저장소에 남긴다 (F-22).
     * 실패해도 조용히 넘어간다 — 타이머는 그대로 돌고, 새로고침에 사라질 뿐이다.
     */
    saveRun(run) {
      if (!runBackend) return;
      try {
        runBackend.setItem(RUN_KEY, JSON.stringify(run));
      } catch (e) {
        /* 남기지 못해도 지금 돌아가는 타이머는 멀쩡하다 */
      }
    },

    /**
     * 남겨둔 뽀모도로를 돌려준다. 없거나 말이 안 되면 `null`이다.
     * 저장본을 열 때와 같은 태도로 검사한다 — 세션 저장소도 사용자가 고칠 수 있다.
     */
    loadRun() {
      if (!runBackend) return null;

      let parsed;
      try {
        const raw = runBackend.getItem(RUN_KEY);
        if (!raw) return null;
        parsed = JSON.parse(raw);
      } catch (e) {
        return null;
      }
      if (!parsed || typeof parsed !== 'object') return null;

      const { length, left } = parsed;
      if (!Number.isFinite(length) || !Number.isFinite(left)) return null;
      if (length < POMO_MIN_MINUTES * 60 || length > POMO_MAX_MINUTES * 60) return null;
      if (left < 0 || left > length) return null;

      // 돌아가는 중이면 끝나는 시각이 있고, 멈춰 있으면 없다.
      if (parsed.endsAt !== null && !Number.isFinite(parsed.endsAt)) return null;

      // 회차가 망가졌으면 사이클에서 빼고 단일 타이머로 되살린다.
      const round =
        Number.isInteger(parsed.round) && parsed.round >= 0 && parsed.round < POMO_ROUNDS
          ? parsed.round
          : null;

      // 구간이 끝나고 다음을 기다리는 중이었는가. **사이클일 때만 뜻이 있다** —
      // 단일 타이머에는 이어질 다음 구간이 없다. 회차가 망가져 단일로 되살아나는
      // 경우까지 여기서 함께 걸러야, 다음 구간 버튼만 남아 눌러도 갈 곳이 없는
      // 상태가 되지 않는다.
      const raw = parsed.next;
      const next =
        round !== null &&
        raw &&
        typeof raw === 'object' &&
        Number.isInteger(raw.round) &&
        raw.round >= 0 &&
        raw.round < POMO_ROUNDS
          ? { round: raw.round, phase: raw.phase === 'rest' ? 'rest' : 'focus' }
          : null;

      return {
        endsAt: parsed.endsAt ?? null,
        left,
        length,
        round,
        phase: parsed.phase === 'rest' ? 'rest' : 'focus',
        next
      };
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

    /**
     * 저장된 테마만 훔쳐본다. load()보다 먼저, 첫 페인트 전에 불린다.
     * 고른 테마가 OS 설정과 다르면 화면이 한 번 반대 색으로 칠해졌다가 뒤집히기 때문이다.
     * 여기서 load()를 부르면 안 된다 — 손상 데이터를 치워버려서
     * 나중에 app.js가 알림을 띄울 기회를 잃는다. 상태를 하나도 건드리지 않는다.
     *
     * 앞머리만 읽는 것도 첫 페인트를 막고 서 있기 때문이다. 테마 한 글자 때문에
     * 항목 전부를 파싱할 이유가 없다. 모양이 다르면 readHead가 통째 파싱으로 물러난다.
     */
    peekTheme() {
      const raw = readRaw();
      return raw ? readHead(raw).theme : null;
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

    POMO_ROUNDS,
    POMO_MIN_MINUTES,
    POMO_MAX_MINUTES,

    /** 회차별 길이(분). 복사본이라 UI가 목록을 직접 건드릴 수 없다. */
    getPomodoro() {
      return pomodoro.map((round) => ({ ...round }));
    },

    /** list를 넘기지 않으면 공장 기본값으로 되돌린다. */
    setPomodoro(list) {
      const next = list == null ? defaultPomodoro() : normalizePomodoro(list, pomodoro);
      return commit(() => {
        pomodoro = next;
        return pomodoro.map((round) => ({ ...round }));
      });
    },

    MINI_OPACITY_DEFAULT,

    /** 미니 타이머 바탕의 진하기(%). 0이면 바탕 없이 글자만 뜬다. */
    getMiniOpacity() {
      return miniOpacity;
    },

    /**
     * 끌고 있는 동안 부르지 않는다. 한 번 끌 때마다 판 번호가 수십 번 올라가고,
     * 그때마다 다른 탭이 통째로 다시 읽는다 (F-20). 손을 뗄 때 한 번만 부른다.
     */
    setMiniOpacity(value) {
      const next = normalizeMiniOpacity(value);
      return commit(() => {
        miniOpacity = next;
        return next;
      });
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
        pomodoro: pomodoro.map((round) => ({ ...round })),
        miniOpacity,
        categories: categories.map((c) => ({ ...c })),
        todos: todos.map(clone)
      };
    },

    /**
     * 가져온 객체로 통째로 갈아끼운다.
     * 로드와 **같은 검증 파이프라인**을 태우므로 깨진 파일도 앱을 무너뜨리지 않는다.
     */
    importData(raw) {
      // todos 배열이 없으면 우리 형식이 아니다 (PRD §8). app.js가 앞에서 한 번 걸러내지만,
      // 가져온 파일이 앱을 무너뜨릴 수 없어야 하는 책임은 이 파이프라인에 있다.
      // 이 검사가 없으면 `{}`나 `[]`가 그대로 지나가 기존 데이터를 지우고 성공을 보고한다.
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.todos)) return null;

      // adopt는 저장 이전에 상태를 통째로 갈아치운다. 되돌릴 것을 전부 쥐고 들어가야 한다 —
      // 하나라도 빠지면 "되돌렸습니다"라고 알리면서 그 값만 가져온 파일 것으로 남는다.
      const snapshot = {
        todos,
        categories,
        theme,
        sort,
        pomodoro: pomodoro.map((r) => ({ ...r })),
        miniOpacity
      };
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
        pomodoro = snapshot.pomodoro;
        miniOpacity = snapshot.miniOpacity;
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
        renumber(todos);
        invalidate();
        for (const id of parentIds) reconcileParent(find(id));
        return removed;
      });
    },

    load() {
      corrupted = false;
      lastError = null;
      rev = 0;
      revlessRaw = null;
      todos = [];
      invalidate();
      categories = defaultCategories();
      theme = null;
      sort = 'priority';
      pomodoro = defaultPomodoro();
      miniOpacity = MINI_OPACITY_DEFAULT;

      const raw = readRaw();
      if (!raw) return todos;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // 손상된 데이터는 버리지 않고 옆으로 옮긴다. 빈 목록으로 시작한다.
        quarantine(raw);
        return todos;
      }

      // 파싱은 되는데 우리 형식이 아닌 것도 손상이다. 여기서 그냥 빈 목록으로 시작하면
      // 배너도 백업도 없이 멀쩡한 새 앱처럼 보이고, 원본은 저장소에 그대로 남아 있다가
      // 사용자가 항목 하나를 추가하는 순간 예고 없이 덮여 영영 사라진다.
      // 손상 배너와 :corrupted 백업이 있는 이유가 정확히 이 상황이다.
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.todos)) {
        quarantine(raw);
        return todos;
      }

      // 판 번호는 adopt 밖에서 다룬다 — 가져온 파일에는 없는 값이다
      const stamped = Number.isFinite(parsed.rev);
      rev = stamped ? parsed.rev : 0;
      // 판 번호가 없는 저장본은 원문을 쥐고 있어야 persist가 우리 것과 남의 것을 가른다
      revlessRaw = stamped ? null : raw;

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
      const label = normalizeCategoryName(name);
      if (!label || label.length > MAX_CATEGORY_NAME) return null;
      if (categories.some((c) => c.name === label)) return null; // 같은 이름은 구분이 안 된다
      // 로드가 상한 너머를 잘라내므로 여기서도 같은 자리에서 멈춘다.
      // 더 만들 수 있게 두면 다음에 앱을 열 때 예고 없이 사라지고 항목만 남는다.
      if (categories.length >= MAX_CATEGORIES) return null;

      return commit(() => {
        const category = { id: newId(), name: label, hue: pickHue() };
        categories.push(category);
        return category;
      });
    },

    /**
     * 카테고리 이름 변경. 검사는 addCategory와 똑같이 건다.
     * 항목은 id로 카테고리를 가리키므로 이름만 갈아 끼우면 되고, 손댈 것이 없다.
     */
    renameCategory(id, name) {
      if (!hasCategory(id)) return null;

      const label = normalizeCategoryName(name);
      if (!label || label.length > MAX_CATEGORY_NAME) return null;
      // 자기 이름 그대로면 통과시킨다. 다른 카테고리와 겹치는 것만 막는다.
      if (categories.some((c) => c.id !== id && c.name === label)) return null;

      return commit(() => {
        const category = categories.find((c) => c.id === id);
        category.name = label;
        return { ...category };
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
        // 하위는 상위의 카테고리를 상속한다 (F-08). 하위만 따로 바꿔주면 countInCategory는
        // 그 카테고리로 세는데 카테고리 필터는 상위 기준이라 걸리지 않고, 다음 로드에서
        // renumber가 상위 값으로 조용히 되돌린다. 하위의 카테고리는 상위를 통해서만 바뀐다.
        if (item.parentId !== null) return null;
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

        // 상위 카테고리를 바꾸면 하위도 따라간다 (F-03).
        // 여기까지 오는 것은 상위뿐이다 — 하위의 카테고리 변경은 위에서 이미 거절했다.
        if (next.category !== undefined) {
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
        renumber(todos);
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

        // 삭제 뒤 카테고리나 부모가 바뀌었을 수 있다. 되살린 스냅샷의 값을 그대로
        // 믿으면 없는 카테고리가 다시 생기거나 하위만 옛 카테고리에 남는다.
        const byId = new Map(todos.map((item) => [item.id, item]));
        for (const item of revived) {
          if (item.parentId !== null && !byId.has(item.parentId)) item.parentId = null;
          if (item.parentId === null && !hasCategory(item.category)) item.category = categories[0].id;
        }
        for (const item of revived) {
          if (item.parentId !== null) item.category = byId.get(item.parentId).category;
        }

        // 마지막 형제를 지운 뒤 새 항목을 넣으면 둘이 같은 order를 갖는다. 되살린 항목을
        // 동률의 새 항목 앞에 놓아 원래 자리를 최대한 보존하고, 그룹 전체를 즉시 유일한
        // 연속 order로 만든다. 그래야 저장 직후와 다음 load() 뒤의 순서가 같다.
        const revivedAt = new Map(revived.map((item, at) => [item.id, at]));
        const currentAt = new Map(todos.map((item, at) => [item.id, at]));
        const affected = new Set(revived.map((item) => item.parentId));
        for (const parentId of affected) {
          const group = todos.filter((item) => item.parentId === parentId);
          group.sort((a, b) => {
            const byOrder = a.order - b.order;
            if (byOrder) return byOrder;
            const aRevived = revivedAt.has(a.id);
            const bRevived = revivedAt.has(b.id);
            if (aRevived !== bRevived) return aRevived ? -1 : 1;
            return aRevived
              ? revivedAt.get(a.id) - revivedAt.get(b.id)
              : currentAt.get(a.id) - currentAt.get(b.id);
          });
          group.forEach((item, order) => { item.order = order; });
        }

        invalidate();
        reconcileAll();
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

      // 태그 바는 옮겨 다니는 수단이다. 태그 축까지 걸어서 세면 고른 태그 하나만 남아
      // 다른 태그로 건너갈 길이 사라진다. 그래서 태그 축은 빼고 센다.
      // 카테고리와 검색어는 그대로 둔다 — 그건 지금 보고 있는 범위 자체다.
      const scope = f.type === 'tag' ? { type: 'all', query: f.query } : f;
      const counts = new Map();

      for (const item of todos) {
        // 검색 때문에 자식의 문맥으로만 보이는 상위는 그 자체가 scope에 맞은 것이 아니다.
        // 상위의 무관한 태그까지 태그 바에 넣지 않고 직접 맞는 항목만 센다.
        if (!matchesSelf(item, scope)) continue;
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
