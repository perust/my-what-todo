/**
 * app.js — UI 계층. 렌더링과 이벤트만 맡는다. (PRD §4 F-01~F-11, §6, §7, §9)
 *
 * localStorage를 직접 만지지 않는다. 정렬·전파·집계도 하지 않는다.
 * Store가 돌려준 배열을 순서대로 그리기만 한다.
 */
(function () {
  'use strict';

  /** 0이 가장 높다. 마커를 누르면 0 → 1 → 2 → 3 → 0으로 돈다. */
  const PRIORITY_LEVELS = [0, 1, 2, 3];
  const priorityLabel = (p) => (p === 0 ? '0 (가장 높음)' : String(p));

  const UNDO_MS = 5000;
  const VISIBLE_TAGS = 3; // 이보다 많으면 접는다. 항목에 포커스하면 펼쳐진다.

  const ALL = { type: 'all' };

  const form = document.getElementById('add-form');
  const input = document.getElementById('add-input');
  const category = document.getElementById('add-category');
  const priority = document.getElementById('add-priority');
  const list = document.getElementById('todo-list');
  const toast = document.getElementById('toast');
  const tabs = document.getElementById('category-tabs');
  const tagBar = document.getElementById('tag-bar');
  const statsText = document.getElementById('stats-text');
  const progress = document.getElementById('progress');
  const progressFill = document.getElementById('progress-fill');
  const progressPercent = document.getElementById('progress-percent');
  const banner = document.getElementById('banner');
  const listMessage = document.getElementById('list-message');
  const gear = document.getElementById('category-gear');
  const catPanel = document.getElementById('category-panel');
  const catList = document.getElementById('category-list');
  const catForm = document.getElementById('category-add');
  const catName = document.getElementById('category-name');
  const catError = document.getElementById('category-error');
  const themeToggle = document.getElementById('theme-toggle');
  const remainingBadge = document.getElementById('remaining-badge');
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  const clearCompleted = document.getElementById('clear-completed');
  const clearDialog = document.getElementById('clear-dialog');
  const clearDialogText = document.getElementById('clear-dialog-text');
  const sortSelect = document.getElementById('sort-select');
  const exportButton = document.getElementById('export-data');
  const importButton = document.getElementById('import-data');
  const fileConnectButton = document.getElementById('file-connect');
  const fileStatus = document.getElementById('file-status');
  const fileRetryButton = document.getElementById('file-retry');
  const importFile = document.getElementById('import-file');
  const importDialog = document.getElementById('import-dialog');
  const importDialogText = document.getElementById('import-dialog-text');
  const helpButton = document.getElementById('help-button');
  const loginButton = document.getElementById('login-button');
  const loginDialog = document.getElementById('login-dialog');
  const helpDialog = document.getElementById('help-dialog');
  const pomoButton = document.getElementById('pomo-button');
  const pomoPanel = document.getElementById('pomodoro');
  const pomoTime = document.getElementById('pomo-time');
  const pomoLengths = document.querySelector('.pomo-lengths');
  const pomoCustom = document.getElementById('pomo-custom');
  const pomoInput = document.getElementById('pomo-input');
  const pomoApply = document.getElementById('pomo-apply');
  const pomoToggle = document.getElementById('pomo-toggle');
  const pomoReset = document.getElementById('pomo-reset');
  const pomoPhase = document.getElementById('pomo-phase');
  const pomoCycleButton = document.getElementById('pomo-cycle');
  const pomoExpand = document.getElementById('pomo-expand');
  const pomoExpandLabel = document.getElementById('pomo-expand-label');
  const pomoDial = document.getElementById('pomo-dial');
  const pomoDialFill = document.getElementById('pomo-dial-fill');
  const pomoDialTime = document.getElementById('pomo-dial-time');
  const pomoDialPhase = document.getElementById('pomo-dial-phase');
  const pomoDots = document.getElementById('pomo-dots');
  const pomoSettingsButton = document.getElementById('pomo-settings-button');
  const pomoSettings = document.getElementById('pomo-settings');
  const pomoSetRows = document.getElementById('pomo-set-rows');
  const pomoSetDefault = document.getElementById('pomo-set-default');

  const BASE_TITLE = document.title;

  /**
   * 분류 축은 한 번에 하나만 켜진다 (F-09).
   * 검색어는 그 위에 얹히는 별도 축이라 어느 필터와도 함께 걸린다.
   */
  let filter = { type: 'all', query: '' };

  /** 편집 중에는 재렌더를 건너뛴다. 그리는 도중 입력창이 날아가면 포커스를 잃는다. */
  let editingId = null;

  /** 하위 입력창이 열려 있는 상위의 id. 재렌더를 넘어 살아남아야 연속 입력이 된다. */
  let childDraftFor = null;
  let focusDraft = false;

  /**
   * 하위 입력창에 치던 글자. **창이 아니라 내용이 죽는다** —
   * render()가 목록을 통째로 다시 세우면서 값 없는 새 입력창을 끼워 넣기 때문에,
   * 밖에 받아두지 않으면 다른 항목을 체크하는 순간 치던 글자가 사라진다.
   */
  let childDraftText = '';

  let pendingUndo = null;
  let undoTimer = null;
  let queuedNotice = null;
  /**
   * 미뤄둔 알림이 **이 삭제 때문에 생긴 것**인가. 되살리면 그런 알림은 틀린 말이 되지만,
   * 그 사이에 사용자가 다른 버튼을 눌러 생긴 알림은 여전히 맞는 말이라 버리면 안 된다.
   */
  let queuedNoticeFromDelete = false;

  /** 삭제 확인을 기다리는 카테고리 id. 항목이 남아 있으면 옮겨갈 곳을 물어야 한다. */
  let pendingCategoryRemove = null;
  let renamingCategory = null;
  let changingCategory = null;
  let changingPriority = null;

  /** 파일이 정해진 뒤, 덮어쓰기 전에 백업 여부를 묻는 동안 들고 있는 내용. */
  let pendingImport = null;

  /** 끌고 있는 항목의 id. 직접 순서 모드에서만 값이 찬다. */
  let draggingId = null;

  /** 렌더 한 번 동안 재사용하는 카테고리 목록. 행마다 새로 뜨면 100행에 100번 복사된다. */
  let categoryCache = [];
  const categoryOf = (id) => categoryCache.find((c) => c.id === id) ?? null;

  const el = (tag, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  };

  /** 전부 훑어 찾으면 항목 수만큼 배열을 만든다. 선택자로 곧장 집는다. */
  const nodeFor = (id) =>
    id ? list.querySelector(`[data-id="${CSS.escape(id)}"]`) : null;

  /**
   * 바깥을 눌러 대화상자를 닫는다.
   *
   * 뒤 배경(`::backdrop`)을 누르면 이벤트 대상이 대화상자 자신이 된다.
   * 다만 그것만으로는 부족하다 — 대화상자 안쪽 여백을 눌러도 대상은 똑같고,
   * 키보드로 안쪽 버튼을 누르면 좌표가 (0, 0)으로 들어온다.
   * 그래서 자식을 눌렀는지 먼저 거르고, 좌표가 실제로 상자 밖인지 다시 본다.
   *
   * 셋 다 "고르지 않고 닫으면 취소"라서 바깥 클릭으로 닫아도 잃는 것이 없다.
   */
  function closeOnOutsideClick(dialog) {
    dialog.addEventListener('click', (e) => {
      if (e.target !== dialog) return;

      const box = dialog.getBoundingClientRect();
      const inside =
        e.clientX >= box.left &&
        e.clientX <= box.right &&
        e.clientY >= box.top &&
        e.clientY <= box.bottom;

      if (!inside) dialog.close();
    });
  }

  /**
   * Store가 null을 주면 저장에 실패해 변경이 통째로 되돌아간 것이다 (PRD §8).
   * 값 검증은 호출 전에 끝내두었으므로, 여기 도달한 null은 저장 실패뿐이다.
   */
  function saved(result) {
    if (result !== null) {
      FileSync.save(Store.exportData());
      return result;
    }

    // 다른 탭이 먼저 썼다면 우리 손의 상태가 낡은 것이다. 덮어쓰지 않고 최신을 읽는다.
    if (Store.lastError === 'conflict') {
      adoptExternal();
      showNotice('다른 탭에서 먼저 바뀌었습니다. 최신 내용을 불러왔으니 다시 해주세요.');
    } else {
      showNotice('저장하지 못했습니다. 마지막 변경을 되돌렸습니다.');
    }
    return null;
  }

  /**
   * 다른 탭의 변경을 받아들인다.
   * 편집·하위 입력·되돌리기는 이제 없는 항목을 가리킬 수 있으므로 먼저 접는다.
   */
  function adoptExternal() {
    editingId = null;
    childDraftFor = null;
    childDraftText = '';
    pendingCategoryRemove = null;
    renamingCategory = null;
    changingCategory = null;
    changingPriority = null;
    draggingId = null;
    releaseUndoForExternal();

    // 확인을 기다리는 동안 완료 수나 현재 항목 수가 바뀌었을 수 있다. 낡은 문구로
    // 새 상태를 지우지 않도록 두 확인창을 모두 접는다.
    if (clearDialog.open) clearDialog.close();
    if (importDialog.open) importDialog.close();
    pendingImport = null;

    Store.load();
    renderTheme();

    // 뽀모도로 설정도 함께 갈렸다. 입력 칸을 되맞추지 않으면 저장본에는 50분이
    // 들어 있는데 칸에는 25가 남아, 그대로 사이클을 돌리면 50:00이 뜬다.
    syncPomoSettings(true);
    renderPomo();
    render();
  }

  /**
   * `queued`는 이번 프레임에 따라가기를 이미 예약했는지,
   * `deferred`는 숨은 탭에서 읽어만 두고 그리기를 미뤄둔 것이 있는지를 나타낸다.
   * (아래 storage 리스너와 visibilitychange 리스너 참고)
   */
  let adoptQueued = false;
  let adoptDeferred = false;

  /** 보이지 않는 탭에서는 읽기만 한다. rev를 최신으로 들고 있어야 다음 저장의 경합 검사가 산다. */
  function adoptQuietly() {
    Store.load();
    adoptDeferred = true;
  }

  /** 연달아 들어오는 외부 변경을 한 프레임에 한 번으로 합친다. */
  function queueAdopt() {
    // requestAnimationFrame은 숨은 탭에서 멈춘다. 거기서 기다리면 읽지도 못한 채
    // 남으므로, 보이지 않을 때는 프레임을 기다리지 않고 그 자리에서 읽는다.
    if (document.hidden) {
      adoptQuietly();
      return;
    }
    if (adoptQueued) return;

    adoptQueued = true;
    requestAnimationFrame(() => {
      adoptQueued = false;
      if (document.hidden) adoptQuietly(); // 그 사이에 탭이 숨었다
      else adoptExternal();
    });
  }

  const fits = (title) => title && title.length <= Store.MAX_TITLE;

  const itemFor = (id) => Store.getItem(id);

  // ────────────────────────────────────────────────────────────
  // 필터 (F-09)
  // ────────────────────────────────────────────────────────────

  /** 분류 축만 갈아끼운다. 검색어는 그대로 얹혀 있는다. */
  function setFilter(next) {
    filter = { ...next, query: filter.query };
    render();
  }

  function toggleCategory(value) {
    const active = filter.type === 'category' && filter.value === value;
    setFilter(value === 'all' || active ? { type: 'all' } : { type: 'category', value });
  }

  function toggleTag(tag) {
    const active = filter.type === 'tag' && filter.value === tag;
    setFilter(active ? { type: 'all' } : { type: 'tag', value: tag });
  }

  function setQuery(text) {
    filter = { ...filter, query: text };
    searchClear.hidden = !text;
    render();
  }

  const categoryName = (id) => categoryOf(id)?.name ?? '';

  /** 색을 인라인 변수로 넘긴다. 카테고리가 늘어나므로 클래스로는 감당되지 않는다. */
  function paintCategory(node, category) {
    node.style.setProperty('--cat-hue', String(category.hue));
  }

  function renderTabs() {
    tabs.textContent = '';

    const entries = [{ id: 'all', name: '전체' }, ...Store.getCategories()];

    for (const entry of entries) {
      const active =
        entry.id === 'all'
          ? filter.type === 'all'
          : filter.type === 'category' && filter.value === entry.id;

      const tab = el('button', active ? 'tab is-active' : 'tab');
      tab.type = 'button';
      tab.dataset.action = 'filter-category';
      tab.dataset.value = entry.id;
      tab.textContent = entry.name;
      tab.setAttribute('aria-pressed', String(active));

      // 앞에서 아홉 번째까지는 Alt+숫자로 바로 간다
      const slot = entries.indexOf(entry) + 1;
      if (slot <= 9) {
        tab.setAttribute('aria-keyshortcuts', `Alt+${slot}`);
        tab.title = `Alt+${slot}`;
      }
      tabs.appendChild(tab);
    }
  }

  /** 직전에 고른 값은 그대로 두되, 그 카테고리가 사라졌으면 첫 번째로 내려온다. */
  function renderCategorySelect() {
    const previous = category.value;
    const list = Store.getCategories();

    category.textContent = '';
    for (const cat of list) {
      const option = el('option');
      option.value = cat.id;
      option.textContent = cat.name;
      category.appendChild(option);
    }
    category.value = list.some((c) => c.id === previous) ? previous : list[0].id;
  }

  function renderTagBar() {
    const tags = Store.getAllTags(filter);

    tagBar.textContent = '';
    tagBar.hidden = tags.length === 0; // 태그가 없으면 빈 줄을 남기지 않는다

    for (const { tag, openCount } of tags) {
      const active = filter.type === 'tag' && filter.value === tag;

      const chip = el('button', active ? 'tag-chip is-active' : 'tag-chip');
      chip.type = 'button';
      chip.dataset.action = 'filter-tag';
      chip.dataset.tag = tag;
      chip.setAttribute('aria-pressed', String(active));
      chip.setAttribute('aria-label', `태그 필터: ${tag}`);

      const name = el('span');
      name.textContent = `#${tag}`;
      const count = el('span', 'tag-count');
      count.textContent = String(openCount);

      chip.append(name, count);
      tagBar.appendChild(chip);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 테마 — 고르기 전에는 OS 설정을 따른다
  // ────────────────────────────────────────────────────────────

  const prefersDark = () => matchMedia('(prefers-color-scheme: dark)').matches;

  /** 저장된 값이 없으면 OS를 물어본다. 화면에 칠하는 건 언제나 둘 중 하나다. */
  const activeTheme = () => Store.getTheme() ?? (prefersDark() ? 'dark' : 'light');

  function renderTheme() {
    const dark = activeTheme() === 'dark';

    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    themeToggle.setAttribute('aria-checked', String(dark));
    themeToggle.classList.toggle('is-on', dark);
  }

  // ────────────────────────────────────────────────────────────
  // 뽀모도로 타이머
  //
  // 회차 설정은 저장본에 들어가지만 돌아가는 상태는 넣지 않는다. 1초마다 저장하면
  // 판 번호가 계속 올라가 다른 탭이 그때마다 다시 읽게 된다 (F-20).
  // 돌아가는 상태는 세션 저장소에 따로 남겨 새로고침을 넘긴다 — 판 번호를 건드리지
  // 않고, 탭을 닫으면 사라진다 (F-22, savePomoRun 참고).
  // ────────────────────────────────────────────────────────────

  const POMO_MIN = 1;
  const POMO_MAX = 180;

  /** 원 둘레. 반지름 44인 원이라 2πr. 채움 길이를 이 값으로 잰다. */
  const DIAL_LENGTH = 2 * Math.PI * 44;

  /**
   * 같은 문자열을 다시 넣어도 텍스트 노드는 통째로 갈린다.
   * 1초마다 도는 자리에서는 바뀐 것만 쓴다.
   */
  const setText = (node, value) => {
    if (node.textContent !== value) node.textContent = value;
  };

  // 눈금 둘레는 변하지 않는다. 채워지는 길이만 매초 바뀐다.
  pomoDialFill.style.strokeDasharray = String(DIAL_LENGTH);

  let pomoLength = 25 * 60; // 설정한 길이(초)
  let pomoLeft = pomoLength; // 남은 시간(초)
  let pomoEndsAt = null; // 실행 중일 때만 값이 있다
  let pomoTick = null;

  /** 사이클 모드일 때만 값이 찬다. 회차는 0부터 세고 화면에는 1부터 보여준다. */
  let cycleRound = null;
  let cyclePhase = 'focus'; // "focus" | "rest"

  const inCycle = () => cycleRound !== null;

  /**
   * 새로고침을 넘기려고 지금 상태를 세션 저장소에 남긴다 (F-22).
   *
   * 남은 초는 **돌아가는 동안에는 요약에 넣지 않는다.** 끝나는 시각에서 다시 나오는
   * 값이라, 넣으면 1초마다 요약이 달라져 매초 쓰게 된다. 멈춰 있을 때만 그 값이
   * 유일한 근거이므로 그때 넣는다. 덕분에 renderPomo를 매초 불러도 쓰기는
   * 상태가 실제로 바뀔 때만 일어난다 — 시작·멈춤·구간 전환·길이 변경, 한 판에 열 번 남짓이다.
   */
  let savedRunSig = null;

  const pomoRunSig = () =>
    [pomoEndsAt, pomoLength, cycleRound, cyclePhase, pomoEndsAt === null ? pomoLeft : '-'].join('|');

  function savePomoRun() {
    const sig = pomoRunSig();
    if (sig === savedRunSig) return;

    savedRunSig = sig;
    Store.saveRun({
      endsAt: pomoEndsAt,
      left: pomoLeft,
      length: pomoLength,
      round: cycleRound,
      phase: cyclePhase
    });
  }

  /** 남겨둔 타이머를 되살린다. 첫 화면을 그리기 전에 한 번만 부른다. */
  function restorePomoRun() {
    // 되살릴 것이 없으면 지금 상태를 이미 남긴 것으로 친다.
    // 그래야 타이머를 건드린 적 없는 사람에게 아무것도 쓰지 않는다.
    savedRunSig = pomoRunSig();

    const run = Store.loadRun();
    if (!run) return;

    pomoLength = run.length;
    pomoLeft = run.left;
    cycleRound = run.round;
    cyclePhase = run.phase;

    if (run.endsAt === null) return; // 멈춰 있었다. 남은 시간 그대로 세워둔다.

    // 자리를 비운 사이에 끝났으면 끝난 자리에 세워둔다. 지금 와서 소리를 내거나
    // 다음 구간으로 넘기지 않는다 — 흘려보낸 시간을 이제 와 되돌릴 수는 없다.
    pomoLeft = Math.max(0, Math.round((run.endsAt - Date.now()) / 1000));
    if (pomoLeft === 0) return;

    pomoStart();
    togglePomo(true); // 돌아가는 중이라면 보이는 편이 맞다
  }

  const pomoClock = (sec) =>
    `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

  /** 마지막 회차의 휴식만 길게 잡는 것이 뽀모도로 기법이다. */
  const isLongRest = (round) => round === Store.POMO_ROUNDS - 1;

  function phaseLabel() {
    if (!inCycle()) return '';
    const round = cycleRound + 1;
    if (cyclePhase === 'focus') return `집중 ${round}/${Store.POMO_ROUNDS}`;
    return isLongRest(cycleRound) ? '긴 휴식' : `휴식 ${round}/${Store.POMO_ROUNDS}`;
  }

  const phaseMinutes = (round, phase) => {
    const set = Store.getPomodoro()[round];
    return phase === 'focus' ? set.focus : set.rest;
  };

  /**
   * 끝나는 시각을 기준으로 남은 시간을 매번 다시 잰다.
   * 1초씩 빼면 배경 탭에서 타이머가 느려질 때 그만큼 어긋난다.
   */
  function pomoRefresh() {
    if (pomoEndsAt === null) return;

    const left = Math.max(0, Math.round((pomoEndsAt - Date.now()) / 1000));

    // 초 단위로 깨우면 경계를 최대 1초까지 놓친다. 그래서 250ms마다 들여다보되,
    // 남은 초가 그대로면 화면에 바뀔 것이 없으므로 손대지 않는다.
    // 매번 그리면 같은 값을 네 번에 세 번꼴로 다시 쓰고, 문서 제목까지 그때마다 건드린다.
    if (left === pomoLeft) return;

    pomoLeft = left;
    if (pomoLeft === 0) pomoFinish();
    else renderPomo();
  }

  function pomoStart() {
    if (pomoEndsAt !== null || pomoLeft === 0) return;

    pomoEndsAt = Date.now() + pomoLeft * 1000;
    pomoTick = setInterval(pomoRefresh, 250);
    renderPomo();
  }

  function pomoPause() {
    if (pomoEndsAt === null) return;

    pomoLeft = Math.max(0, Math.round((pomoEndsAt - Date.now()) / 1000));
    pomoStop();
    renderPomo();
  }

  function pomoStop() {
    pomoEndsAt = null;
    clearInterval(pomoTick);
    pomoTick = null;
  }

  /** 단일 타이머로 돌아간다. 프리셋이나 직접 입력을 고르면 사이클에서 빠진다. */
  function pomoSet(seconds) {
    pomoStop();
    cycleRound = null;
    pomoLength = seconds;
    pomoLeft = seconds;
    renderPomo();
  }

  /** 사이클의 한 구간을 세운다. run이 true면 바로 이어서 돌린다. */
  function cycleEnter(round, phase, run) {
    pomoStop();
    cycleRound = round;
    cyclePhase = phase;
    pomoLength = phaseMinutes(round, phase) * 60;
    pomoLeft = pomoLength;

    if (run) pomoStart();
    else renderPomo();
  }

  function pomoFinish() {
    pomoStop();
    pomoLeft = 0;

    if (!inCycle()) {
      renderPomo();
      pomoChime(false);
      showNotice(`${Math.round(pomoLength / 60)}분이 끝났습니다.`);
      return;
    }

    // 집중 뒤에는 휴식, 휴식 뒤에는 다음 회차. 마지막 회차를 마치면 처음으로 돌아온다.
    const wasFocus = cyclePhase === 'focus';
    const nextRound = wasFocus ? cycleRound : (cycleRound + 1) % Store.POMO_ROUNDS;
    const nextPhase = wasFocus ? 'rest' : 'focus';

    const ended = phaseLabel();
    cycleEnter(nextRound, nextPhase, true);

    pomoChime(nextPhase === 'focus');
    showNotice(`${ended} 구간이 끝났습니다. 이어서 ${phaseLabel()} 구간을 시작합니다.`);
  }

  /** 소리 파일을 두지 않는다 — 외부 요청 0건을 지키려고 그 자리에서 만든다. */
  function pomoChime(rising) {
    try {
      const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!Ctx) return;

      const ctx = new Ctx();
      ctx.resume?.().catch(() => {}); // 자동재생 정책으로 멈춰 있으면 깨운다
      const now = ctx.currentTime;

      // 다음이 집중이면 올라가고, 휴식이면 내려간다. 보지 않아도 구분된다.
      const tones = rising ? [880, 1175] : [1175, 880];

      tones.forEach((freq, i) => {
        const delay = i * 0.18;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + delay);
        gain.gain.exponentialRampToValueAtTime(0.12, now + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + delay);
        osc.stop(now + delay + 0.17);
      });
      setTimeout(() => ctx.close(), 700);
    } catch (e) {
      /* 소리를 못 내도 타이머는 끝난다 */
    }
  }

  function renderDots() {
    // 회차 수는 고정이다. 매번 헐고 다시 세우면 바뀐 것이 없는 초에도
    // 점 네 개가 계속 새로 만들어진다. 한 번만 세우고 표시만 갈아 끼운다.
    if (pomoDots.children.length !== Store.POMO_ROUNDS) {
      pomoDots.textContent = '';

      for (let i = 0; i < Store.POMO_ROUNDS; i++) {
        const dot = el('li', 'pomo-dot');
        dot.textContent = String(i + 1);
        pomoDots.appendChild(dot);
      }
    }

    const cycle = inCycle();
    for (let i = 0; i < pomoDots.children.length; i++) {
      // toggle은 이미 그 상태면 속성을 건드리지 않는다.
      pomoDots.children[i].classList.toggle('is-done', cycle && i < cycleRound);
      pomoDots.children[i].classList.toggle('is-now', cycle && i === cycleRound);
    }
  }

  function renderPomo() {
    const running = pomoEndsAt !== null;
    const clock = pomoClock(pomoLeft);
    const label = phaseLabel();

    setText(pomoTime, clock);
    setText(pomoPhase, label);
    pomoPhase.hidden = label === '';

    // 끝난 뒤에는 한 번 더 눌러 바로 다음 판을 돌릴 수 있게 한다.
    const toggleLabel = running
      ? '일시정지'
      : pomoLeft === 0
        ? '다시 시작'
        : pomoLeft < pomoLength
          ? '계속'
          : '시작';
    setText(pomoToggle, toggleLabel);

    pomoPanel.classList.toggle('is-running', running);
    pomoPanel.classList.toggle('is-rest', inCycle() && cyclePhase === 'rest');
    pomoButton.classList.toggle('is-running', running);
    pomoButton.classList.toggle('is-rest', inCycle() && cyclePhase === 'rest');
    pomoCycleButton.classList.toggle('is-active', inCycle());

    // 배경 탭에서도 남은 시간이 보이게 제목에 얹는다
    const title = running ? `${clock} · ${BASE_TITLE}` : BASE_TITLE;
    if (document.title !== title) document.title = title;

    // 지금 무엇으로 돌아갈지는 켜진 버튼 하나로 읽는다. 프리셋 중 어느 것도 아니면
    // 직접 입력한 길이라는 뜻이므로 `설정`을 켠다 — 아무것도 켜져 있지 않으면
    // 시작을 눌렀을 때 몇 분짜리가 도는지 알 방법이 없다.
    let onPreset = false;
    for (const preset of document.querySelectorAll('.pomo-preset[data-minutes]')) {
      const active = !inCycle() && Number(preset.dataset.minutes) * 60 === pomoLength;
      if (active) onPreset = true;
      preset.classList.toggle('is-active', active);
    }
    pomoApply.classList.toggle('is-active', !inCycle() && !onPreset);

    // 흐른 만큼 원이 채워진다
    const done = pomoLength > 0 ? 1 - pomoLeft / pomoLength : 0;
    pomoDialFill.style.strokeDashoffset = String(DIAL_LENGTH * (1 - done));
    setText(pomoDialTime, clock);
    setText(pomoDialPhase, label || `${Math.round(pomoLength / 60)}분`);
    renderDots();

    // 상태가 바뀐 자리마다 부르지 않는다. 어차피 전부 여기를 지나므로 여기서 한 번만 본다.
    savePomoRun();
  }

  /**
   * 저장된 값을 입력 칸에 도로 맞춘다. **다시 그리지 않는다** —
   * 한 칸을 고칠 때마다 전부 새로 그리면, 방금 옮겨간 칸이 교체되며
   * 포커스와 입력하던 내용이 사라진다.
   */
  function syncPomoSettings(force) {
    const cycle = Store.getPomodoro();

    for (const field of pomoSetRows.querySelectorAll('.pomo-set-input')) {
      if (!force && field === document.activeElement) continue;
      field.value = String(cycle[Number(field.dataset.round)][field.dataset.key]);
    }
  }

  function renderPomoSettings() {
    if (pomoSettings.hidden) return;

    const cycle = Store.getPomodoro();
    pomoSetRows.textContent = '';

    cycle.forEach((round, i) => {
      const row = el('div', 'pomo-set-row');

      const label = el('span', 'pomo-set-index');
      label.textContent = `${i + 1}회차`;
      row.appendChild(label);

      for (const key of ['focus', 'rest']) {
        const field = el('input', 'pomo-set-input');
        field.type = 'number';
        field.inputMode = 'numeric';
        field.min = String(Store.POMO_MIN_MINUTES);
        field.max = String(Store.POMO_MAX_MINUTES);
        field.step = '1';
        field.value = String(round[key]);
        field.dataset.round = String(i);
        field.dataset.key = key;
        field.setAttribute(
          'aria-label',
          `${i + 1}회차 ${key === 'focus' ? '집중' : '휴식'} 시간(분)`
        );
        row.appendChild(field);
      }
      pomoSetRows.appendChild(row);
    });
  }

  function togglePomo(open) {
    const next = open ?? pomoPanel.hidden;
    pomoPanel.hidden = !next;
    pomoButton.setAttribute('aria-expanded', String(next));
  }

  function togglePomoView(node, button, open) {
    const next = open ?? node.hidden;
    node.hidden = !next;
    button.setAttribute('aria-expanded', String(next));
    button.classList.toggle('is-active', next);

    // 라벨은 여는 자리에서만 고치면 안 된다. Esc로 닫는 길이 따로 있어
    // 거기서 "시계 접기"에 멈춘 채 남는다. 상태를 바꾸는 곳에서 늘 함께 고친다.
    //
    // 눈에 보이는 글자와 읽히는 이름을 한 자리에서 같이 고친다. 따로 두면 한쪽만
    // 고치는 실수가 나고, 그때 음성으로 조작하는 사람은 화면에 없는 말을 불러야 한다.
    // aria-label이 보이는 글자를 그대로 품고 있어야 한다 (WCAG "Label in Name").
    if (button === pomoExpand) {
      setText(pomoExpandLabel, next ? '접기' : '펼치기');
      button.setAttribute('aria-label', next ? '시계 접기' : '시계 펼치기');
    }
  }

  // ────────────────────────────────────────────────────────────
  // 카테고리 관리
  // ────────────────────────────────────────────────────────────

  /** 다음 프레임에 넣기로 한 오류 문구. 그 사이에 지워졌으면 넣지 않는다. */
  let waitingCategoryError = null;

  /**
   * 카테고리 오류 문구.
   *
   * `#category-error`는 `role="alert"`이다. 이런 영역은 **이미 접근성 트리에 있는 상태에서
   * 내용이 바뀌어야** 읽힌다. 숨김이 풀리는 것과 글이 채워지는 것이 한 태스크 안에서
   * 함께 일어나면 브라우저는 "글을 가진 영역이 통째로 새로 생겼다"고 보고, 일부
   * 스크린리더는 그것을 읽지 않는다. **두 줄의 순서를 바꾸는 것으로는 달라지지 않는다** —
   * 접근성 트리는 태스크가 끝난 뒤에 한 번 정리되므로 같은 태스크 안의 순서는 보이지 않는다.
   * 그래서 자리를 빈 채로 먼저 열고, 글은 다음 태스크에 넣어 실제로 태스크를 건넌다.
   *
   * 건너는 수단은 `setTimeout`이다. `requestAnimationFrame`은 **배경 탭에서 멈춘다** —
   * 탭이 숨은 채로 이 함수가 불리면 상자만 열리고 글은 영영 들어가지 않아,
   * 사용자에게는 빈 상자가, 스크린리더에는 읽을 것이 없는 영역이 남는다.
   */
  function showCategoryError(text) {
    // 문구를 띄우는 것만으로는 "이 칸이 지금 잘못됐다"가 전해지지 않는다.
    // 칸 자체에 표시해야 화면을 못 보는 사람도 어디를 고쳐야 하는지 안다.
    catName.setAttribute('aria-invalid', text ? 'true' : 'false');

    waitingCategoryError = text || null;
    catError.textContent = '';

    if (!text) {
      catError.hidden = true;
      return;
    }

    catError.hidden = false;
    setTimeout(() => {
      if (waitingCategoryError === null) return; // 그 사이에 지워졌다
      catError.textContent = waitingCategoryError;
    });
  }

  function renderCategoryPanel() {
    if (catPanel.hidden) return;
    // 이름을 고치는 중이면 다시 그리지 않는다. 입력칸이 통째로 갈려
    // 치던 내용과 커서가 사라지기 때문이다. 할 일 제목을 고칠 때와 같은 규칙이다.
    if (renamingCategory !== null) return;

    const list = Store.getCategories();
    catList.textContent = '';

    for (const cat of list) {
      const li = el('li', 'cat-row');

      const dot = el('span', 'cat-dot');
      paintCategory(dot, cat);

      const name = el('button', 'cat-name');
      name.type = 'button';
      name.dataset.action = 'rename-category';
      name.dataset.id = cat.id;
      name.textContent = cat.name;
      name.setAttribute('aria-label', `카테고리 이름 바꾸기: ${cat.name}`);

      const count = el('span', 'cat-count');
      const used = Store.countInCategory(cat.id);
      count.textContent = used ? `${used}개` : '비어 있음';

      li.append(dot, name, count);

      if (pendingCategoryRemove === cat.id) {
        li.classList.add('is-confirming');
        li.appendChild(renderRemoveConfirm(cat, used, list));
      } else {
        const remove = el('button', 'cat-remove');
        remove.type = 'button';
        remove.dataset.action = 'remove-category';
        remove.dataset.id = cat.id;
        remove.textContent = '삭제';
        remove.setAttribute('aria-label', `카테고리 삭제: ${cat.name}`);
        // 미분류는 없다. 마지막 하나는 지울 수 없다. (F-08)
        remove.disabled = list.length <= 1;
        li.appendChild(remove);
      }
      catList.appendChild(li);
    }
  }

  /** 항목이 남아 있으면 어디로 옮길지 고르게 한다. 비어 있으면 바로 확인만 받는다. */
  function renderRemoveConfirm(cat, used, list) {
    const box = el('div', 'cat-confirm');

    const label = el('span', 'cat-confirm-text');
    label.textContent = used ? `${used}개 항목을 옮길 곳` : '삭제할까요?';
    box.appendChild(label);

    if (used) {
      const select = el('select', 'cat-move');
      select.id = 'category-move';
      select.setAttribute('aria-label', `${cat.name}의 항목을 옮길 카테고리`);
      for (const other of list) {
        if (other.id === cat.id) continue;
        const option = el('option');
        option.value = other.id;
        option.textContent = other.name;
        select.appendChild(option);
      }
      box.appendChild(select);
    }

    const confirm = el('button', 'cat-confirm-yes');
    confirm.type = 'button';
    confirm.dataset.action = 'confirm-remove-category';
    confirm.dataset.id = cat.id;
    confirm.textContent = '삭제';

    const cancel = el('button', 'cat-confirm-no');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel-remove-category';
    cancel.textContent = '취소';

    box.append(confirm, cancel);
    return box;
  }

  function toggleCategoryPanel(open) {
    const next = open ?? catPanel.hidden;

    catPanel.hidden = !next;
    gear.setAttribute('aria-expanded', String(next));
    pendingCategoryRemove = null;
    renamingCategory = null; // 패널을 닫으면 고치던 것도 함께 접는다
    showCategoryError('');

    if (next) {
      renderCategoryPanel();
      catName.focus();
    } else {
      catName.value = '';
      gear.focus();
    }
  }

  // ────────────────────────────────────────────────────────────
  // 진행률 (F-10) — 계산은 전부 Store가 한다
  // ────────────────────────────────────────────────────────────

  function renderStats() {
    const stats = Store.getStats(filter);
    const left = stats.total - stats.done;

    statsText.textContent = `${stats.done} / ${stats.total} 완료`;
    progressFill.style.width = `${stats.percent}%`;
    progressPercent.textContent = `${stats.percent}%`;
    progress.setAttribute('aria-valuenow', String(stats.percent));

    remainingBadge.textContent = left ? `남은 할 일 ${left}` : '';
    remainingBadge.hidden = left === 0;

    // 지울 대상은 필터와 무관하다 — "모두 삭제"이므로 전체를 센다
    const completed = Store.countCompleted();
    clearCompleted.textContent = `완료한 항목 ${completed}개 삭제`;
    clearCompleted.hidden = completed === 0;

    return stats;
  }

  // ────────────────────────────────────────────────────────────
  // 상태별 화면 (PRD §7) — 빈 화면은 안내가 아니라 행동 유도다
  // ────────────────────────────────────────────────────────────

  function renderMessage(stats) {
    let text = '';

    if (list.children.length === 0) {
      // 검색 중이면 그게 0건의 이유다. 분류 축보다 먼저 말한다.
      if (filter.query) text = `"${filter.query}"에 해당하는 할 일이 없습니다.`;
      else if (filter.type === 'category') text = `${categoryName(filter.value)} 카테고리에 할 일이 없습니다.`;
      else if (filter.type === 'tag') text = `#${filter.value} 태그가 붙은 할 일이 없습니다.`;
      else text = '아직 할 일이 없습니다. 위에 입력해서 시작하세요.';
    } else if (stats.total > 0 && stats.done === stats.total) {
      text = `${stats.total}개 모두 완료했습니다.`;
    }

    listMessage.textContent = text;
    listMessage.hidden = text === '';
  }

  /** 저장이 불가능하거나 데이터가 깨진 환경을 로드 직후 한 번 알린다 (PRD §7, §8). */
  function renderBanner() {
    const notes = [];

    if (!Store.isPersistent) {
      notes.push('이 브라우저에서는 데이터가 저장되지 않습니다. 탭을 닫으면 목록이 사라집니다.');
    }
    if (Store.wasCorrupted) {
      notes.push(
        '저장된 데이터가 손상되어 빈 목록으로 시작합니다. 이전 데이터는 daily-todo:v1:corrupted 에 남겨두었습니다.'
      );
    }

    banner.textContent = '';
    banner.hidden = notes.length === 0;

    for (const note of notes) {
      const line = el('p', 'banner-line');
      line.textContent = note;
      banner.appendChild(line);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 렌더링 — 상태가 바뀌면 목록 전체를 다시 그린다. diff하지 않는다.
  // ────────────────────────────────────────────────────────────

  /**
   * 렌더가 통째로 헐고 다시 세우는 영역들.
   *
   * 할 일 목록만 지키면 카테고리 탭·태그 바·카테고리 패널에서 누른 버튼이 매 렌더마다
   * 사라져 포커스가 <body>로 떨어진다. 여기 없는 곳(추가 입력창·검색창·정렬 상자)은
   * 다시 세우지 않으므로 손대지 않는다 — 건드리면 커서 위치와 선택 영역이 함께 날아간다.
   */
  const focusScopes = () => [list, tabs, tagBar, catList];

  function captureFocus() {
    const active = document.activeElement;
    if (!active) return null;

    const scope = focusScopes().find((box) => box.contains(active));
    if (!scope) return null;

    if (active.dataset.draft) return { draft: true, caret: active.selectionStart };

    // data-id는 할 일에서는 바깥 <li>에, 카테고리 패널에서는 버튼 자신에 붙는다.
    // closest는 둘 다 집는다. 탭과 태그 바에는 아예 없어 null이 된다.
    const node = active.closest('[data-id]');
    const action = active.dataset.action ?? null;

    // 태그의 ×는 누르는 순간 그 태그와 함께 사라진다. 같은 자리의 다음 ×로
    // 내려가려면 몇 번째였는지도 들고 있어야 한다.
    const siblings =
      action === 'remove-tag' && node
        ? [...node.querySelectorAll('[data-action="remove-tag"]')]
        : [];

    return {
      scope,
      id: node?.dataset.id ?? null,
      action,
      value: active.dataset.value ?? null,
      tag: active.dataset.tag ?? null,
      at: siblings.indexOf(active)
    };
  }

  function restoreFocus(mark) {
    if (!mark) return;

    if (mark.draft) {
      const draft = list.querySelector('[data-draft]');
      if (!draft) return;

      // 값을 되돌려 넣은 새 입력창이라 캐럿이 맨 앞으로 간다. 치던 자리로 되돌린다.
      const at = mark.caret ?? draft.value.length;
      draft.focus();
      draft.setSelectionRange(at, at);
      return;
    }

    if (mark.action) {
      const attrs =
        `[data-action="${mark.action}"]` +
        (mark.value === null ? '' : `[data-value="${CSS.escape(mark.value)}"]`) +
        (mark.tag === null ? '' : `[data-tag="${CSS.escape(mark.tag)}"]`);

      // 같은 버튼이 항목마다 하나씩 있다. 어느 항목의 것이었는지로 좁힌다.
      for (const found of mark.scope.querySelectorAll(attrs)) {
        if ((found.closest('[data-id]')?.dataset.id ?? null) !== mark.id) continue;
        found.focus();
        return;
      }
    }

    if (mark.id === null) return;
    const node = mark.scope.querySelector(`[data-id="${CSS.escape(mark.id)}"]`);
    if (!node) return;

    // 누르던 버튼이 사라졌다 — 태그의 ×를 눌러 그 태그가 없어진 경우다.
    // 같은 자리의 다음 ×로, 그것도 없으면 제목 버튼으로 내려간다.
    // 바깥 <li>에는 tabindex가 없어 focus()를 불러도 아무 일도 일어나지 않는다.
    const removers = node.querySelectorAll('[data-action="remove-tag"]');
    const next =
      (mark.at >= 0 && removers.length
        ? removers[Math.min(mark.at, removers.length - 1)]
        : null) ?? node.querySelector('[data-action="edit"]');

    next?.focus();
  }

  /**
   * 끌기 손잡이. **직접 순서 모드에서만** 잡힌다.
   * 다른 모드에서는 끌어도 정렬 기준이 자리를 다시 정해 제자리로 튕긴다.
   * 자리는 늘 차지한다 — 모드를 바꿀 때마다 목록 왼쪽이 흔들리면 안 된다.
   */
  function renderHandle(item, context) {
    const manual = Store.getSort() === 'manual';
    if (context || !manual) return el('span', 'todo-handle');

    const handle = el('button', 'todo-handle is-draggable');
    handle.type = 'button';
    handle.dataset.action = 'drag';
    handle.draggable = true;
    handle.textContent = '⠿';
    handle.setAttribute('aria-label', `순서 이동: ${item.title}. Alt+위/아래로도 옮깁니다`);
    handle.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    return handle;
  }

  /**
   * 우선순위 마커. 네 단계를 숫자 그대로 보여준다 — 0이 가장 높다.
   * inert면 문맥 행이라 누를 수 없는 span으로 그린다. (PRD §7)
   */
  function renderPriority(item, inert) {
    if (inert) {
      const shown = el('span', `todo-priority is-p${item.priority}`);
      shown.textContent = String(item.priority);
      return shown;
    }

    const marker = el('button', `todo-priority is-p${item.priority}`);
    marker.type = 'button';
    marker.dataset.action = 'pick-priority';
    marker.textContent = String(item.priority);
    marker.setAttribute(
      'aria-label',
      `우선순위 변경: ${item.title}, 현재 ${priorityLabel(item.priority)}`
    );
    return marker;
  }

  /** 태그 배지. 색은 쓰지 않는다 — 색은 카테고리 전용이다. (PRD §7) */
  function renderTags(item, inert) {
    const box = el('span', 'tags');
    if (!item.tags.length) return box;

    for (const tag of item.tags) {
      const wrap = el('span', 'tag');

      const filterBtn = el('button', 'tag-filter');
      filterBtn.type = 'button';
      filterBtn.dataset.action = 'filter-tag';
      filterBtn.dataset.tag = tag;
      filterBtn.textContent = `#${tag}`;
      filterBtn.setAttribute('aria-label', `태그 필터: ${tag}`);
      wrap.appendChild(filterBtn);

      if (!inert) {
        const removeBtn = el('button', 'tag-remove');
        removeBtn.type = 'button';
        removeBtn.dataset.action = 'remove-tag';
        removeBtn.dataset.tag = tag;
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', `태그 삭제: ${tag}`);
        wrap.appendChild(removeBtn);
      }
      box.appendChild(wrap);
    }

    // 접힌 개수는 화면 폭마다 다르다 — 넓으면 3개까지, 좁으면 1개까지 보인다.
    // CSS는 숫자를 바꿀 수 없으니 둘 다 그려두고 미디어 쿼리로 하나만 보여준다.
    if (item.tags.length > VISIBLE_TAGS) {
      const wide = el('span', 'tag-more tag-more-wide');
      wide.textContent = `+${item.tags.length - VISIBLE_TAGS}`;
      box.appendChild(wide);
    }
    if (item.tags.length > 1) {
      const narrow = el('span', 'tag-more tag-more-narrow');
      narrow.textContent = `+${item.tags.length - 1}`;
      box.appendChild(narrow);
    }
    return box;
  }

  /**
   * children이 null이면 하위 항목이다.
   * context가 true면 태그 필터의 문맥 행 — 보여주기만 하고 조작 수단을 붙이지 않는다.
   */
  function renderRow(item, children, context) {
    const isRoot = children !== null;

    const row = el('div', isRoot ? 'todo' : 'todo todo-child');
    if (item.completed) row.classList.add('is-done');
    row.classList.add(`priority-${item.priority}`);
    if (context) {
      row.classList.add('is-context');
      row.setAttribute('aria-disabled', 'true');
    }

    const check = el('input', 'todo-check');
    check.type = 'checkbox';
    check.checked = item.completed;
    check.dataset.action = 'toggle';
    check.setAttribute('aria-label', `완료: ${item.title}`);
    check.disabled = !!context;

    // 부분 완료는 네이티브 속성으로 표시한다. CSS로 흉내 내지 않는다.
    // 화면에 보이는 하위가 아니라 실제 하위 전부를 기준으로 판단한다.
    if (isRoot) check.indeterminate = !item.completed && children.some((c) => c.completed);

    let title;
    if (context) {
      title = el('span', 'todo-title todo-title-static');
      title.textContent = item.title;
    } else {
      title = el('button', 'todo-title');
      title.type = 'button';
      title.dataset.action = 'edit';
      title.textContent = item.title;
    }

    row.append(
      renderHandle(item, context),
      renderPriority(item, context),
      check,
      title,
      renderTags(item, context)
    );

    if (isRoot) {
      const cat = categoryOf(item.category);

      // 문맥 행은 보여주기만 한다. 그 밖에는 눌러서 소속을 바꾼다 (F-03).
      // 하위는 상위를 따라가므로 상위 행에만 붙는다 — store도 하위의 카테고리
      // 변경은 거절한다.
      const badge = context ? el('span', 'badge') : el('button', 'badge');
      if (!context) {
        badge.type = 'button';
        badge.dataset.action = 'change-category';
        badge.setAttribute(
          'aria-label',
          `카테고리 변경: ${item.title}, 현재 ${cat?.name ?? '없음'}`
        );
      }
      badge.textContent = cat?.name ?? '';
      if (cat) paintCategory(badge, cat);
      row.appendChild(badge);

      if (!context) {
        const add = el('button', 'todo-add-child');
        add.type = 'button';
        add.dataset.action = 'add-child';
        add.textContent = '+';
        // 이 버튼은 열고 닫는다. 지금 어느 쪽인지 이름과 상태로 함께 알린다.
        const open = childDraftFor === item.id;
        add.setAttribute('aria-expanded', String(open));
        add.setAttribute(
          'aria-label',
          open ? `하위 할 일 입력 닫기: ${item.title}` : `하위 할 일 추가: ${item.title}`
        );
        row.appendChild(add);
      }
    }

    if (!context) {
      const remove = el('button', 'todo-delete');
      remove.type = 'button';
      remove.dataset.action = 'delete';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `삭제: ${item.title}`);
      row.appendChild(remove);
    }

    return row;
  }

  /** 하위 입력창. 자식 목록의 맨 끝에 놓여 상위 바로 아래에서 연속 입력을 받는다. */
  function renderChildDraft(root) {
    const li = el('li', 'todo-node');
    const row = el('div', 'todo todo-child todo-draft');

    const draft = el('input', 'todo-draft-input');
    draft.type = 'text';
    draft.dataset.draft = '1';
    draft.placeholder = '하위 할 일';
    draft.value = childDraftText; // 재렌더를 넘어 치던 내용을 되돌려 넣는다
    draft.setAttribute('aria-label', `하위 할 일 입력: ${root.title}`);

    // 치는 족족 밖에 받아둔다. 이 입력창은 매 렌더마다 새로 만들어지므로
    // 여기서 받아두지 않으면 다른 항목을 체크하는 순간 내용이 빈 문자열이 된다.
    draft.addEventListener('input', () => {
      childDraftText = draft.value;
    });

    /** Enter와 `추가` 버튼이 같은 길을 탄다. 둘이 갈라지면 한쪽만 고치게 된다. */
    const submit = () => {
      const parsed = Parse.parseInput(draft.value);
      if (!parsed.title) {
        draft.focus(); // 빈 칸으로 누른 것은 취소가 아니다. 닫으려면 옆의 ×가 있다.
        return;
      }
      const added = fits(parsed.title) ? saved(Store.addChild(root.id, parsed)) : null;

      if (added) {
        childDraftText = ''; // 넣었으니 빈 칸으로 다시 연다
        focusDraft = true;
        const note = hiddenNotice(added);
        render(); // 입력창은 그 자리에 다시 열린다
        if (note) showNotice(note);
      } else {
        draft.focus();
      }
    };

    draft.addEventListener('keydown', (e) => {
      if (e.isComposing) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        closeChildDraft();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();

      // 빈 상태의 Enter는 "다 넣었다"는 뜻으로 계속 받는다. 키보드만 쓰는 사람에게는
      // ×까지 Tab으로 가는 것보다 빠르다. 화면의 출구는 아래 두 버튼이 맡는다.
      if (!Parse.parseInput(draft.value).title) closeChildDraft();
      else submit();
    });

    // 마우스만 쓰는 사람에게는 Enter가 보이지 않는다. 넣는 버튼과 닫는 버튼을
    // 화면에 둔다. hover로 숨기지 않는다 — 터치 화면에는 hover가 없다.
    const add = el('button', 'todo-draft-add');
    add.type = 'button';
    add.textContent = '추가';
    add.setAttribute('aria-label', `하위 할 일 추가: ${root.title}`);
    add.addEventListener('click', submit);

    const close = el('button', 'todo-draft-close');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', `하위 할 일 입력 닫기: ${root.title}`);
    close.addEventListener('click', closeChildDraft);

    row.append(draft, add, close);
    li.appendChild(row);
    return li;
  }

  function render() {
    // 그 자리에서 고치는 중이면 다시 그리지 않는다. 통째로 헐면 편집기와
    // 고르던 목록이 함께 사라진다.
    if (editingId !== null || changingCategory !== null || changingPriority !== null) return;

    // 필터 중인 태그가 사라졌으면 전체로 돌아온다 (F-09).
    // 검색어를 뺀 채로 물어야 한다 — 검색 결과가 0건인 것과 태그가 없어진 것은 다르다.
    //
    // 저절로 풀린 것은 말해준다. 아무 말 없이 목록이 늘어나면 무엇이 잘못됐는지
    // 알 길이 없다. 되돌릴 것이 걸려 있으면 showNotice가 알아서 뒤로 미룬다.
    if (
      filter.type === 'tag' &&
      Store.getRoots({ type: 'tag', value: filter.value }).length === 0
    ) {
      // 되살리면 이 말은 틀린 것이 되므로 "삭제 때문"이라고 표시해 함께 버려지게 한다.
      showNotice(`#${filter.value} 태그가 없어져 전체 목록으로 돌아왔습니다.`, true);
      filter = { type: 'all', query: filter.query };
    }
    // 필터 중인 카테고리를 지웠을 때도 마찬가지다.
    // 이름은 아직 categoryCache에 남아 있다 — 새 목록은 몇 줄 아래에서 받아온다.
    if (filter.type === 'category' && !Store.getCategories().some((c) => c.id === filter.value)) {
      const gone = categoryName(filter.value);
      showNotice(
        gone
          ? `${gone} 카테고리가 없어져 전체 목록으로 돌아왔습니다.`
          : '고른 카테고리가 없어져 전체 목록으로 돌아왔습니다.',
        true
      );
      filter = { type: 'all', query: filter.query };
    }

    const mark = focusDraft ? { draft: true } : captureFocus();
    focusDraft = false;

    categoryCache = Store.getCategories();
    sortSelect.value = Store.getSort();
    list.classList.toggle('is-manual', Store.getSort() === 'manual');

    renderCategorySelect();
    renderCategoryPanel();
    renderTabs();
    renderTagBar();
    const stats = renderStats();

    list.textContent = '';

    // 깊이가 2로 고정이므로 재귀가 필요 없다. 바깥 = 상위, 안쪽 = 하위.
    for (const root of Store.getRoots(filter)) {
      const context = Store.isContextRow(root.id, filter);
      const shownChildren = Store.getChildren(root.id, filter);

      const node = el('li', 'todo-node');
      node.dataset.id = root.id;
      node.appendChild(renderRow(root, Store.getChildren(root.id), context));

      if (shownChildren.length || childDraftFor === root.id) {
        const sub = el('ul', 'todo-children');

        for (const child of shownChildren) {
          const childNode = el('li', 'todo-node');
          childNode.dataset.id = child.id;
          childNode.appendChild(renderRow(child, null, false));
          sub.appendChild(childNode);
        }
        if (childDraftFor === root.id && !context) sub.appendChild(renderChildDraft(root));

        node.appendChild(sub);
      }
      list.appendChild(node);
    }

    renderMessage(stats);
    restoreFocus(mark);
  }

  // ────────────────────────────────────────────────────────────
  // 추가 (F-01, F-02)
  // ────────────────────────────────────────────────────────────

  /**
   * 방금 만든 항목이 지금 걸어둔 필터에 걸리지 않으면, 어디로 갔는지 알릴 문장을 준다.
   * 걸리면 `null`이다 — 눈앞에 나타난 것을 굳이 말할 필요는 없다.
   *
   * **만들어졌는데 화면에 안 나오고 아무 말도 없으면 "추가가 안 먹었다"로 읽힌다.**
   * 그러면 다시 누르게 되고, 보이지 않는 곳에 같은 항목이 하나씩 쌓인다. 하위 입력창은
   * 넣은 뒤에 빈 칸으로 다시 열리기까지 해서, 성공한 모습과 구별이 아예 안 된다.
   *
   * 어느 축이 걸렀는지까지 짚는다. "안 보입니다"만으로는 어디를 눌러야 볼 수 있는지
   * 알 수 없다. 필터가 저절로 풀렸을 때 알리는 것과 같은 이유다 (PRD §13).
   */
  function hiddenNotice(item) {
    const shown =
      item.parentId === null
        ? Store.getRoots(filter).some((t) => t.id === item.id)
        : Store.getChildren(item.parentId, filter).some((t) => t.id === item.id);

    if (shown) return null;

    // 하위는 상위의 카테고리를 따라가므로 카테고리 축에 걸릴 일이 없다.
    if (filter.type === 'category' && item.category !== filter.value) {
      return `${categoryName(item.category)}에 추가했습니다. 지금은 ${categoryName(filter.value)}만 보고 있어서 이 목록에는 나오지 않습니다.`;
    }
    if (filter.type === 'tag' && !item.tags.includes(filter.value)) {
      return `추가했습니다. #${filter.value} 태그가 없어서 이 목록에는 나오지 않습니다.`;
    }
    if (filter.query) {
      return '추가했습니다. 검색어에 걸리지 않아서 이 목록에는 나오지 않습니다.';
    }
    // 위 셋 중 어느 것도 아닌데 안 보인다면 이유를 지어내지 않는다.
    return '추가했습니다. 지금 걸어둔 조건에 맞지 않아서 이 목록에는 나오지 않습니다.';
  }

  function handleAdd() {
    const parsed = Parse.parseInput(input.value);

    // 공백만 입력했거나 제목이 너무 길면 조용히 무시한다. 내용과 포커스는 그대로 둔다.
    // 제목에 `!`를 적었으면 그게 이긴다. 안 적었으면 옆 선택 상자의 값을 쓴다.
    const chosen = { ...parsed, priority: parsed.priority ?? Number(priority.value) };

    if (fits(parsed.title)) {
      const added = saved(Store.add(chosen, category.value));
      if (added) {
        input.value = '';
        const note = hiddenNotice(added);
        // 알림을 render() 뒤에 둔다. render()도 알릴 것이 있으면 알리는데,
        // 방금 누른 것에 대한 답이 그 뒤에 서야 화면에 남는다.
        render();
        if (note) showNotice(note);
      }
    }
    input.focus();
  }

  /** `+`는 여는 버튼이자 닫는 버튼이다. 연 것을 같은 자리에서 닫는 것이 자연스럽다. */
  function openChildDraft(rootId) {
    if (childDraftFor === rootId) {
      closeChildDraft();
      return;
    }
    // 다른 상위에서 치다 만 내용이 따라오면 안 된다
    if (childDraftFor !== rootId) childDraftText = '';
    childDraftFor = rootId;
    focusDraft = true;
    render();
  }

  function closeChildDraft() {
    const rootId = childDraftFor;
    childDraftFor = null;
    childDraftText = '';
    render();
    nodeFor(rootId)?.querySelector('[data-action="add-child"]')?.focus();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    handleAdd();
  });

  // 한글 조합 중의 Enter는 IME가 글자를 확정하는 키다. 여기서 제출하면 두 번 들어간다.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.isComposing) e.preventDefault();
  });

  // ────────────────────────────────────────────────────────────
  // 인라인 수정 (F-03)
  // ────────────────────────────────────────────────────────────

  /** 지금 버튼이 눌려 있는지. 편집을 언제 끝내 그려도 되는지 판단하는 데만 쓴다. */
  let pressing = false;
  addEventListener('pointerdown', () => { pressing = true; }, true);
  addEventListener('pointerup', () => { pressing = false; }, true);
  addEventListener('pointercancel', () => { pressing = false; }, true);

  /**
   * 편집기가 포커스를 잃어 편집이 끝난 뒤 목록을 다시 그린다. **그 자리에서 그리지 않는다.**
   *
   * 마우스는 mousedown → focusout → mouseup → click 순서로 돈다. focusout에서 목록을
   * 통째로 다시 세우면 mousedown을 받은 버튼이 떨어져 나가고, 이어질 click은 갈 곳을
   * 잃는다. 편집을 끝내려고 누른 그 첫 클릭이 통째로 삼켜지는 것이다.
   * 그래서 버튼에서 손을 뗄 때까지 기다렸다가 그린다.
   *
   * 키보드나 프로그램으로 포커스가 옮겨간 경우엔 눌린 버튼이 없으니 다음 태스크에서
   * 바로 그린다. 어느 쪽이든 지금 이 자리에서 그리지 않는 것이 핵심이다.
   */
  function renderAfterPress() {
    const draw = () => setTimeout(() => render(), 0);
    if (pressing) addEventListener('pointerup', draw, { once: true, capture: true });
    else draw();
  }

  function startEdit(id) {
    if (editingId !== null) return;

    const item = itemFor(id);
    const node = nodeFor(id);
    if (!item || !node) return;

    const titleEl = node.querySelector('[data-action="edit"]');
    if (!titleEl) return;

    const editor = el('input', 'todo-edit');
    editor.type = 'text';
    editor.value = item.title; // 태그를 제목에 다시 합치지 않는다 (F-07)
    editor.setAttribute('aria-label', `제목 수정: ${item.title}`);

    editingId = id;
    titleEl.replaceWith(editor);
    editor.focus();
    editor.select();

    /**
     * byKey면 Enter나 Escape로 끝낸 것이다 — 그 자리에서 그리고 제목 버튼으로 돌아간다.
     * 포커스가 빠져나가 끝난 경우엔 그리기를 미루고 포커스도 건드리지 않는다.
     * 사용자가 이미 다른 곳을 골랐기 때문이다. (renderAfterPress 참고)
     */
    const finish = (save, byKey) => {
      if (editingId !== id) return;
      editingId = null;

      if (save) {
        const parsed = Parse.parseInput(editor.value);

        // 빈 제목은 취소로 처리한다. 삭제하지 않는다. 너무 긴 제목도 마찬가지다.
        if (fits(parsed.title)) {
          const patch = { title: parsed.title };

          // 편집 중 입력한 `!`는 "올려라"라는 지시다. 안 썼다고 해서 내리지는 않는다.
          if (parsed.priority !== null) patch.priority = parsed.priority;
          // 새 `#`는 기존 태그에 더한다. 지우는 건 배지의 ×가 맡는다 (F-07).
          if (parsed.tags.length) patch.tags = item.tags.concat(parsed.tags);

          saved(Store.update(id, patch));
        }
      }

      if (!byKey) {
        // 편집기는 지금 걷어낸다. 이 자리만 바꾸므로 방금 누른 버튼은 살아남고,
        // 그리기를 미룬 사이에 바로 다른 항목을 고치기 시작해도 빈 편집기가
        // 남지 않는다 (그때는 미뤄둔 render가 통째로 건너뛴다).
        const fresh = itemFor(id);
        if (fresh) titleEl.textContent = fresh.title;
        editor.replaceWith(titleEl);

        renderAfterPress();
        return;
      }
      render();
      nodeFor(id)?.querySelector('[data-action="edit"]')?.focus();
    };

    editor.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false, true);
      }
    });
    editor.addEventListener('focusout', () => finish(true, false));
  }

  /**
   * 카테고리를 그 자리에서 바꾼다. 제목 편집과 같은 방식이다 —
   * 배지가 목록으로 바뀌고, 고르면 들어가고, Escape로 물린다.
   *
   * 순환 버튼으로 하지 않은 이유는 카테고리가 최대 64개까지 늘기 때문이다.
   * 열 개만 돼도 원하는 것에 닿기까지 아홉 번을 눌러야 한다.
   */
  function startCategoryChange(id) {
    if (changingCategory !== null || editingId !== null) return;

    const item = itemFor(id);
    const node = nodeFor(id);
    if (!item || !node) return;

    const badge = node.querySelector('[data-action="change-category"]');
    if (!badge) return;

    const list = Store.getCategories();
    const picker = el('select', 'badge-select');
    picker.setAttribute('aria-label', `카테고리 변경: ${item.title}`);

    for (const cat of list) {
      const option = el('option');
      option.value = cat.id;
      option.textContent = cat.name;
      picker.appendChild(option);
    }
    picker.value = item.category;

    changingCategory = id;
    badge.replaceWith(picker);
    picker.focus();

    const finish = (save, byKey) => {
      if (changingCategory !== id) return;
      changingCategory = null;

      // 같은 것을 다시 골랐으면 저장할 일이 없다. 판 번호만 괜히 올라간다.
      if (save && picker.value !== item.category) saved(Store.update(id, { category: picker.value }));

      if (!byKey) {
        // 제목 편집과 같은 이유로 이 자리만 되돌린다 (startEdit의 주석 참고).
        const fresh = itemFor(id);
        const cat = fresh ? categoryOf(fresh.category) : null;
        badge.textContent = cat?.name ?? '';
        if (cat) paintCategory(badge, cat);
        picker.replaceWith(badge);

        renderAfterPress();
        return;
      }
      render();
      nodeFor(id)?.querySelector('[data-action="change-category"]')?.focus();
    };

    // 고르는 순간 들어간다. native 목록은 페이지 위 버튼을 누르는 것이 아니라
    // 그 자리에서 그려도 다른 클릭을 삼키지 않는다.
    picker.addEventListener('change', () => finish(true, true));
    picker.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      finish(false, true);
    });
    // 고르지 않고 빠져나갔으면 물린다. 골랐다면 change가 이미 끝냈다.
    picker.addEventListener('focusout', () => finish(false, false));
  }

  /**
   * 우선순위를 그 자리에서 고른다. 카테고리 배지와 같은 방식이다.
   *
   * 예전에는 누를 때마다 0 → 1 → 2 → 3으로 돌았다. 기본 정렬이 우선순위라
   * **한 번 누를 때마다 목록이 다시 서고 그 항목이 달아났다.** 3에서 0으로 가려면
   * 세 번을 눌러야 하는데, 두 번째 누를 자리에는 이미 다른 항목이 와 있다.
   * 한 번에 고르면 정렬도 한 번만 일어난다.
   */
  function startPriorityChange(id) {
    if (changingPriority !== null || changingCategory !== null || editingId !== null) return;

    const item = itemFor(id);
    const node = nodeFor(id);
    if (!item || !node) return;

    const marker = node.querySelector('[data-action="pick-priority"]');
    if (!marker) return;

    const picker = el('select', 'todo-priority-select');
    picker.setAttribute('aria-label', `우선순위 변경: ${item.title}`);

    // 보이는 것은 숫자만 둔다. 추가 폼의 선택기와 같고, 몇 번 써보면 0이 가장 높다는 것을
    // 알게 된다. "가장 높음" 같은 꼬리표는 목록 안에서 자리만 넓힌다.
    for (const level of PRIORITY_LEVELS) {
      const option = el('option');
      option.value = String(level);
      option.textContent = String(level);
      picker.appendChild(option);
    }
    picker.value = String(item.priority);

    changingPriority = id;
    marker.replaceWith(picker);
    picker.focus();

    const finish = (save, byKey) => {
      if (changingPriority !== id) return;
      changingPriority = null;

      // 같은 값을 다시 골랐으면 저장할 일이 없다. 판 번호만 괜히 올라간다.
      const next = Number(picker.value);
      if (save && next !== item.priority) saved(Store.update(id, { priority: next }));

      if (!byKey) {
        // 제목 편집과 같은 이유로 이 자리만 되돌린다 (startEdit의 주석 참고).
        picker.replaceWith(marker);
        renderAfterPress();
        return;
      }
      render();
      nodeFor(id)?.querySelector('[data-action="pick-priority"]')?.focus();
    };

    picker.addEventListener('change', () => finish(true, true));
    picker.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      finish(false, true);
    });
    // 고르지 않고 빠져나갔으면 물린다. 골랐다면 change가 이미 끝냈다.
    picker.addEventListener('focusout', () => finish(false, false));
  }

  // ────────────────────────────────────────────────────────────
  // 삭제 + 실행 취소 (F-04)
  // ────────────────────────────────────────────────────────────

  function hideUndo() {
    clearTimeout(undoTimer);
    undoTimer = null;
    pendingUndo = null;

    // 토스트가 사라질 때 포커스가 그 안에 있었다면 갈 곳을 잃는다.
    const hadFocus = toast.contains(document.activeElement);

    toast.hidden = true;
    toast.textContent = '';

    if (hadFocus) input.focus();

    // 자리를 비켜 기다리던 알림이 있으면 이제 보여준다.
    if (queuedNotice !== null) {
      const text = queuedNotice;
      queuedNotice = null;
      queuedNoticeFromDelete = false;
      showNotice(text);
    }
  }

  /**
   * 외부 변경은 undo 대상만 낡게 만든다. 삭제 때문에 생긴 대기 알림은 함께 버리되,
   * 그 사이 끝난 뽀모도로처럼 삭제와 무관한 알림은 undo 자리가 비면 그대로 알린다.
   */
  function releaseUndoForExternal() {
    if (pendingUndo === null) {
      cancelUndo();
      return;
    }
    if (queuedNoticeFromDelete) {
      queuedNotice = null;
      queuedNoticeFromDelete = false;
    }
    hideUndo();
  }

  /** 가져오기로 상태를 통째로 갈아끼울 때 undo와 그 상태의 대기 알림까지 버린다. */
  function cancelUndo() {
    clearTimeout(undoTimer);
    undoTimer = null;
    pendingUndo = null;
    queuedNotice = null;
    queuedNoticeFromDelete = false;

    const hadFocus = toast.contains(document.activeElement);
    toast.hidden = true;
    toast.textContent = '';
    if (hadFocus) input.focus();
  }

  /**
   * 되돌릴 것이 없는 단순 알림. 토스트를 같이 쓴다.
   *
   * **되돌릴 것이 걸려 있는 동안에는 자리를 뺏지 않는다.** 뽀모도로는 아무 때나
   * 구간이 끝나므로, 방금 지운 항목의 5초가 그 알림에 덮여 사라지곤 했다.
   * 알림은 뒤에 다시 뜨지만, 지운 항목은 그 5초가 지나면 영영 되살릴 수 없다.
   * 미뤄둔 알림은 하나만 들고 있는다 — 밀린 것을 줄줄이 띄우는 편이 더 나쁘다.
   */
  function showNotice(text, fromDelete) {
    if (pendingUndo !== null) {
      queuedNotice = text;
      queuedNoticeFromDelete = fromDelete === true;
      return;
    }

    clearTimeout(undoTimer);

    const label = el('span');
    label.textContent = text;

    toast.textContent = '';
    toast.appendChild(label);
    toast.hidden = false;

    undoTimer = setTimeout(hideUndo, UNDO_MS);
  }

  /**
   * 지운 항목을 되돌릴 토스트.
   *
   * note를 주면 그 문장을 대신 띄우되 버튼은 그대로 남긴다 — 되살리기가 실패한
   * 자리에서 쓴다. 거기서 showNotice로 알리면 버튼이 사라져, 실패했다는 말과 함께
   * 되돌릴 길까지 없어진다.
   */
  function showUndo(removed, note) {
    clearTimeout(undoTimer);

    // 두 번째 삭제가 첫 번째의 5초를 없애지 않게 한 묶음으로 합친다. 같은 상위의
    // 캐스케이드와 완료 일괄 삭제가 겹쳐 들어와도 id 하나당 한 번만 되살린다.
    const merged = new Map((pendingUndo ?? []).map((item) => [item.id, item]));
    for (const item of removed) if (!merged.has(item.id)) merged.set(item.id, item);
    pendingUndo = [...merged.values()];

    const label = el('span');
    // 하위가 함께 지워진 경우에만 개수를 밝힌다 (F-04)
    label.textContent =
      note ??
      (pendingUndo.length > 1 ? `${pendingUndo.length}개 항목을 지웠습니다.` : '지웠습니다.');

    const button = el('button', 'toast-undo');
    button.type = 'button';
    button.textContent = '실행 취소';
    button.addEventListener('click', undo);

    toast.textContent = '';
    toast.append(label, button);
    toast.hidden = false;

    undoTimer = setTimeout(hideUndo, UNDO_MS);
  }

  function undo() {
    const items = pendingUndo;
    if (!items) return;

    // 버튼을 눌러 들어왔는지 미리 본다. 실패해 토스트를 다시 세울 때쯤이면
    // 포커스가 이미 입력창으로 밀려나 있다.
    const fromToast = toast.contains(document.activeElement);

    // 되살아난 것을 확인한 뒤에 토스트를 거둔다. 먼저 거두면 저장에 실패했을 때
    // 다시 누를 곳이 사라져 지운 항목이 영영 돌아오지 않는다.
    if (Store.restore(items) !== null) {
      FileSync.save(Store.exportData());
      // 이 삭제가 부른 알림만 버린다. 되살렸으니 틀린 말이 되기 때문이다 —
      // "태그가 없어졌다"고 알리는 사이에 그 태그는 돌아와 있다. 그 사이에 사용자가
      // 다른 버튼을 눌러 생긴 알림은 여전히 맞는 말이므로 그대로 둔다.
      if (queuedNoticeFromDelete) {
        queuedNotice = null;
        queuedNoticeFromDelete = false;
      }

      // parentId와 order를 그대로 되살리므로 트리째 돌아온다
      hideUndo();
      render();
      return;
    }

    // 실패는 saved()에 맡기지 않는다. saved()의 알림은 되돌릴 것이 걸려 있으면
    // 뒤로 미뤄져 아무 말도 못 하고, 충돌이면 adoptExternal이 토스트째 접어버린다.
    // 실패를 바로 알리면서 다시 누를 버튼도 남겨야 하므로 둘을 한 토스트에 담는다.
    const conflict = Store.lastError === 'conflict';
    if (conflict) adoptExternal(); // 낡은 판으로 다시 눌러봐야 또 부딪힌다

    showUndo(
      items,
      conflict
        ? '다른 탭에서 먼저 바뀌었습니다. 최신 내용을 불러왔으니 다시 눌러주세요.'
        : '되살리지 못했습니다. 다시 눌러주세요.'
    );
    if (fromToast) toast.querySelector('.toast-undo')?.focus();
  }

  function handleDelete(id, viaKeyboard) {
    const removed = saved(Store.remove(id));
    if (!removed) return;

    if (removed.some((t) => t.id === childDraftFor)) {
      childDraftFor = null;
      childDraftText = '';
    }

    // 되돌릴 것을 **먼저** 세운다. 순서를 뒤집으면, 그리는 도중에 나온 알림
    // (태그 필터가 저절로 풀렸다는 것 같은)이 곧바로 실행 취소 토스트에 덮여
    // 사라진다. 먼저 세워두면 showNotice가 그 알림을 뒤로 미뤄준다.
    showUndo(removed);
    render();

    // 지운 행이 사라지면서 포커스도 함께 없어진다. 토스트는 DOM 맨 끝이라
    // Tab으로는 5초 안에 닿기 어렵다. 키보드로 지운 경우엔 바로 얹어준다.
    if (viaKeyboard) toast.querySelector('.toast-undo')?.focus();
  }

  // ────────────────────────────────────────────────────────────
  // 이벤트 위임
  // ────────────────────────────────────────────────────────────

  list.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-action]');
    if (!trigger || !list.contains(trigger)) return;

    const node = trigger.closest('[data-id]');
    if (!node) return;

    const id = node.dataset.id;
    const action = trigger.dataset.action;

    // 문맥 행은 조작 대상이 아니다. 버튼을 안 그렸지만 여기서 한 번 더 막는다.
    if (action !== 'filter-tag' && Store.isContextRow(id, filter)) return;

    switch (action) {
      case 'toggle':
        saved(Store.toggle(id));
        render();
        break;
      case 'edit':
        startEdit(id);
        break;
      case 'change-category':
        startCategoryChange(id);
        break;
      case 'add-child':
        openChildDraft(id);
        break;
      case 'delete':
        // Enter/Space로 누른 버튼 클릭은 detail이 0이다 — 마우스와 구분되는 지점.
        handleDelete(id, e.detail === 0);
        break;
      case 'pick-priority':
        startPriorityChange(id);
        break;
      case 'remove-tag': {
        const item = itemFor(id);
        if (item) saved(Store.update(id, { tags: item.tags.filter((t) => t !== trigger.dataset.tag) }));
        render();
        break;
      }
      case 'filter-tag':
        toggleTag(trigger.dataset.tag);
        break;
    }
  });

  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-action="filter-category"]');
    if (tab) toggleCategory(tab.dataset.value);
  });

  gear.addEventListener('click', () => toggleCategoryPanel());

  helpButton.addEventListener('click', () => {
    if (!helpDialog.open) helpDialog.showModal();
  });

  /**
   * 로그인 화면을 연다. 인증할 서버는 아직 없고, 화면 안의 입력 칸은 잠겨 있다.
   * 무엇이 준비 중이고 지금 데이터가 어디 있는지는 그 화면이 직접 말한다.
   */
  loginButton.addEventListener('click', () => {
    if (!loginDialog.open) loginDialog.showModal();
  });

  loginDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-choice="close"]')) loginDialog.close();
  });

  for (const dialog of [helpDialog, loginDialog, clearDialog, importDialog]) {
    closeOnOutsideClick(dialog);
  }

  // ── 뽀모도로 ────────────────────────────────────────────

  pomoButton.addEventListener('click', () => togglePomo());

  // 사이클 — 한 번 누르면 1회차 집중부터 끝까지 이어서 돈다
  pomoCycleButton.addEventListener('click', () => {
    cycleEnter(0, 'focus', true);
    // 사이클로 넘어갔으니 직접 입력한 숫자는 더 이상 쓰이지 않는다.
    // 칸에 남겨두면 그 값으로 도는 줄 안다.
    pomoInput.value = '';
  });

  pomoLengths.addEventListener('click', (e) => {
    const preset = e.target.closest('.pomo-preset[data-minutes]');
    if (!preset) return;

    pomoSet(Number(preset.dataset.minutes) * 60);
    pomoInput.value = '';
  });

  pomoCustom.addEventListener('submit', (e) => {
    e.preventDefault();

    const minutes = Number(pomoInput.value);
    if (!Number.isInteger(minutes) || minutes < POMO_MIN || minutes > POMO_MAX) {
      showNotice(`${POMO_MIN}분에서 ${POMO_MAX}분 사이로 적어주세요.`);
      pomoInput.focus();
      return;
    }
    pomoSet(minutes * 60);
    pomoInput.blur();
  });

  pomoToggle.addEventListener('click', () => {
    if (pomoEndsAt !== null) {
      pomoPause();
      return;
    }
    if (pomoLeft === 0) pomoLeft = pomoLength; // 끝난 타이머는 처음부터 다시
    pomoStart();
  });

  pomoReset.addEventListener('click', () => {
    // 사이클 중이면 1회차 집중으로 되돌린다. 단일 타이머면 그 길이로 되돌린다.
    if (inCycle()) cycleEnter(0, 'focus', false);
    else pomoSet(pomoLength);
    pomoInput.value = '';
  });

  pomoExpand.addEventListener('click', () => {
    togglePomoView(pomoDial, pomoExpand, undefined); // 라벨은 togglePomoView가 함께 고친다
    renderPomo();
  });

  pomoSettingsButton.addEventListener('click', () => {
    togglePomoView(pomoSettings, pomoSettingsButton, undefined);
    renderPomoSettings();
  });

  // 입력을 마칠 때마다 저장한다. 값이 범위를 벗어나면 store가 예전 값을 지킨다.
  pomoSetRows.addEventListener('change', (e) => {
    const field = e.target.closest('.pomo-set-input');
    if (!field) return;

    const cycle = Store.getPomodoro();
    cycle[Number(field.dataset.round)][field.dataset.key] = Number(field.value);

    if (!saved(Store.setPomodoro(cycle))) {
      // 변경이 통째로 되돌아갔다. 칸에 남은 값은 이제 저장본과 다르므로,
      // 포커스가 그 칸에 있어도 강제로 되맞춘다. 안 그러면 화면은 50분인데
      // 실제로 도는 것은 25분이 된다.
      syncPomoSettings(true);
      renderPomo();
      return;
    }

    syncPomoSettings(false);
    // 지금 돌고 있지 않은 구간이면 새 길이를 곧바로 반영한다
    if (inCycle() && pomoEndsAt === null) cycleEnter(cycleRound, cyclePhase, false);
    else renderPomo();
  });

  pomoSetDefault.addEventListener('click', () => {
    if (!saved(Store.setPomodoro(null))) return;

    syncPomoSettings(true);
    if (inCycle() && pomoEndsAt === null) cycleEnter(cycleRound, cyclePhase, false);
    else renderPomo();
  });

  pomoPanel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    // 안쪽 화면이 열려 있으면 그것부터 닫는다
    if (!pomoSettings.hidden) togglePomoView(pomoSettings, pomoSettingsButton, false);
    else if (!pomoDial.hidden) togglePomoView(pomoDial, pomoExpand, false);
    else {
      togglePomo(false);
      pomoButton.focus();
    }
  });

  // 배경 탭에서는 인터벌이 느려진다. 돌아오면 곧바로 다시 맞춘다.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;

    pomoRefresh();

    // 숨어 있는 동안 읽어만 두고 미뤄둔 변경이 있으면 이제 화면에 옮긴다.
    if (adoptDeferred) {
      adoptDeferred = false;
      adoptExternal();
    }
  });

  helpDialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-choice="close"]')) helpDialog.close();
  });

  themeToggle.addEventListener('click', () => {
    if (saved(Store.setTheme(activeTheme() === 'dark' ? 'light' : 'dark')) === null) return;
    renderTheme();
  });

  // 고르기 전이라면 OS 설정이 바뀔 때 함께 따라간다
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (Store.getTheme() === null) renderTheme();
  });

  searchInput.addEventListener('input', () => setQuery(searchInput.value));

  searchInput.addEventListener('keydown', (e) => {
    // 조합 중의 Escape는 IME가 조합을 무르는 키다. 여기서 받으면 치던 글자가 아니라
    // 검색어 전체가 날아간다.
    if (e.key === 'Escape' && !e.isComposing && searchInput.value) {
      e.preventDefault();
      searchInput.value = '';
      setQuery('');
    }
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    setQuery('');
    searchInput.focus();
  });

  // ── 완료한 항목 모두 삭제 ────────────────────────────────

  clearCompleted.addEventListener('click', () => {
    if (clearDialog.open) return; // 열린 다이얼로그에 showModal()을 부르면 예외가 난다

    const count = Store.countCompleted();
    if (!count) return;

    clearDialogText.textContent = `완료한 항목 ${count}개를 삭제합니다. 되돌릴 수 있습니다.`;
    clearDialog.showModal();
  });

  clearDialog.addEventListener('click', (e) => {
    const button = e.target.closest('[data-choice]');
    if (!button) return;

    clearDialog.close();
    if (button.dataset.choice !== 'confirm') return;

    const removed = saved(Store.removeCompleted());
    if (!removed) return;

    // handleDelete와 같은 이유로 되돌릴 것을 먼저 세운다 — 그리는 도중에 나온
    // 알림이 실행 취소 토스트에 덮이지 않게.
    showUndo(removed);
    render();
    toast.querySelector('.toast-undo')?.focus();
  });

  // ── 내보내기 / 가져오기 ──────────────────────────────────

  const formatSavedTime = (timestamp) => {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };

  function renderFileStatus(state, formatter = formatSavedTime) {
    let text = '파일 연결 안 됨';
    if (state.phase === 'connecting') {
      text = '파일 연결 중…';
    } else if (state.phase === 'connected') {
      const lastSuccess = state.lastSavedAt === null
        ? '아직 성공 기록 없음'
        : `${state.saveError ? '마지막 성공' : '마지막 저장'} ${formatter(state.lastSavedAt)}`;
      text = state.saveError
        ? `${state.fileName} 연결됨 · 저장 실패 · ${lastSuccess}`
        : `${state.fileName} 연결됨 · ${lastSuccess}`;
    }

    setText(fileStatus, text);
    fileConnectButton.disabled = state.phase === 'connecting';
    setText(fileConnectButton, state.phase === 'connected' ? '파일 다시 연결' : '파일 연결');
    fileRetryButton.hidden = !(state.phase === 'connected' && state.saveError);
    fileRetryButton.disabled = !!state.retrying;
    setText(fileRetryButton, state.retrying ? '재시도 중…' : '재시도');
  }

  FileSync.setErrorHandler(() => {
    showNotice('연결한 파일에 저장하지 못했습니다. 브라우저 저장 내용은 그대로 유지됩니다.');
  });
  FileSync.setStatusHandler(renderFileStatus);

  fileRetryButton.addEventListener('click', async () => {
    const success = await FileSync.retry();
    showNotice(success
      ? '파일 저장을 다시 완료했습니다.'
      : '파일 저장 재시도에 실패했습니다.');
  });

  fileConnectButton.addEventListener('click', async () => {
    if (!FileSync.isSupported()) {
      showNotice('이 브라우저는 파일 연결을 지원하지 않습니다. 내보내기와 가져오기를 이용해 주세요.');
      return;
    }

    const result = await FileSync.connect(() => Store.exportData());
    if (result === 'connected') showNotice('파일을 연결했습니다. 이후 변경을 이 파일에 자동 저장합니다.');
  });

  /** 외부에 아무것도 보내지 않는다. Blob을 만들어 브라우저가 저장하게 한다. */
  function download(data, name) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    );
    const link = el('a');
    link.href = url;
    link.download = name;
    link.click();

    // 바로 거두면 브라우저가 아직 blob을 읽기 전이라 내려받기가 취소될 수 있다.
    // 한 박자 뒤에 거둔다.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** 파일명에 붙일 날짜. toISOString()은 UTC라 한국 오전에는 하루 전으로 찍힌다. */
  const stamp = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };

  exportButton.addEventListener('click', () => {
    download(Store.exportData(), `my-what-todo-${stamp()}.json`);
    // 브라우저에 넘기는 것까지가 우리 몫이다. 실제로 저장됐는지는 알 수 없으므로
    // 저장됐다고 단정하지 않는다.
    showNotice('내려받기를 시작했습니다. 파일이 없으면 브라우저의 다운로드 목록을 확인해 주세요.');
  });

  importButton.addEventListener('click', () => {
    importFile.value = ''; // 같은 파일을 다시 골라도 change가 오게 한다
    importFile.click();
  });

  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    if (!file) return;

    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      showNotice('JSON 파일이 아닙니다.');
      return;
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.todos)) {
      showNotice('이 앱에서 내보낸 파일이 아닙니다.');
      return;
    }

    pendingImport = parsed;
    const current = Store.exportData().todos.length;
    importDialogText.textContent =
      `${file.name}에서 ${parsed.todos.length}개를 가져옵니다. ` +
      `지금 있는 ${current}개는 사라집니다.`;
    importDialog.showModal();
  });

  importDialog.addEventListener('click', (e) => {
    const button = e.target.closest('[data-choice]');
    if (!button) return;

    const choice = button.dataset.choice;
    importDialog.close();

    if (choice === 'cancel' || !pendingImport) {
      pendingImport = null;
      return;
    }
    if (choice === 'backup') download(Store.exportData(), `my-what-todo-backup-${stamp()}.json`);

    const result = saved(Store.importData(pendingImport));
    pendingImport = null;
    if (!result) return;

    // 가져오기는 현재 상태를 통째로 바꾼다. 이전 데이터에서 지운 항목을 새 데이터에
    // 섞어 되살릴 수 없도록 성공을 확인한 뒤 undo와 그에 딸린 대기 알림을 버린다.
    cancelUndo();

    // 가져온 데이터에는 예전 필터가 가리키던 것이 없을 수 있다
    filter = { type: 'all', query: '' };
    searchInput.value = '';
    searchClear.hidden = true;

    renderTheme();
    // 뽀모도로 회차 설정도 파일 것으로 갈렸다. 입력 칸을 되맞추지 않으면
    // 화면에는 옛 숫자가 남고 실제로 도는 길이만 달라진다.
    syncPomoSettings(true);
    renderPomo();
    render();
    showNotice(`${result.todos}개를 가져왔습니다.`);
  });

  importDialog.addEventListener('close', () => {
    pendingImport = null;
  });

  // ── 정렬 ────────────────────────────────────────────────

  sortSelect.addEventListener('change', () => {
    if (saved(Store.setSort(sortSelect.value)) === null) sortSelect.value = Store.getSort();
    render();
  });

  // ── 순서 직접 옮기기 — 형제 그룹 안에서만 ────────────────

  const rowOf = (node) => node?.closest('[data-id]') ?? null;

  list.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('[data-action="drag"]');
    if (!handle) return;

    draggingId = rowOf(handle)?.dataset.id ?? null;
    e.dataTransfer.effectAllowed = 'move';
    // 값이 비면 Firefox가 끌기를 시작하지 않는다
    e.dataTransfer.setData('text/plain', draggingId ?? '');
    rowOf(handle)?.classList.add('is-dragging');
  });

  list.addEventListener('dragend', () => {
    draggingId = null;
    for (const n of list.querySelectorAll('.is-dragging, .is-drop-before, .is-drop-after')) {
      n.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
    }
  });

  /** 같은 부모의 형제일 때만 놓을 수 있다. 부모가 바뀌는 이동은 허용하지 않는다. */
  function dropTargetFor(node) {
    if (!draggingId) return null;

    const target = rowOf(node);
    if (!target || target.dataset.id === draggingId) return null;

    const dragged = Store.getItem(draggingId);
    const over = Store.getItem(target.dataset.id);
    return dragged && over && dragged.parentId === over.parentId ? target : null;
  }

  list.addEventListener('dragover', (e) => {
    const target = dropTargetFor(e.target);
    if (!target) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const box = target.getBoundingClientRect();
    const before = e.clientY < box.top + box.height / 2;

    for (const n of list.querySelectorAll('.is-drop-before, .is-drop-after')) {
      n.classList.remove('is-drop-before', 'is-drop-after');
    }
    target.classList.add(before ? 'is-drop-before' : 'is-drop-after');
  });

  list.addEventListener('drop', (e) => {
    const target = dropTargetFor(e.target);
    if (!target) return;
    e.preventDefault();

    const box = target.getBoundingClientRect();
    const before = e.clientY < box.top + box.height / 2;

    let beforeId = target.dataset.id;
    if (!before) {
      // 뒤에 놓는다는 건 "그 다음 형제 앞"이라는 뜻이다
      const siblings = siblingIds(draggingId);
      const at = siblings.indexOf(target.dataset.id);
      beforeId = siblings[at + 1] ?? null;
      if (beforeId === draggingId) beforeId = siblings[at + 2] ?? null;
    }

    const moved = draggingId;
    draggingId = null;
    if (saved(Store.reorder(moved, beforeId)) === null) return;

    render();
    nodeFor(moved)?.querySelector('[data-action="drag"]')?.focus();
  });

  const siblingIds = (id) => {
    const item = Store.getItem(id);
    if (!item) return [];
    const group =
      item.parentId === null ? Store.getRoots(ALL) : Store.getChildren(item.parentId);
    return group.map((t) => t.id);
  };

  /** 마우스 없이도 옮길 수 있어야 한다 (PRD §9). Alt+위/아래. */
  function nudge(id, delta) {
    const siblings = siblingIds(id);
    const at = siblings.indexOf(id);
    const to = at + delta;
    if (at === -1 || to < 0 || to >= siblings.length) return;

    // 아래로 갈 때는 목표 자리의 다음 형제 앞에 끼운다
    const beforeId = delta < 0 ? siblings[to] : (siblings[to + 1] ?? null);
    if (saved(Store.reorder(id, beforeId)) === null) return;

    render();
    nodeFor(id)?.querySelector('[data-action="drag"]')?.focus();
  }

  // ── 단축키 ──────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    // `code`로 본다. macOS에서 Alt+숫자는 `key`가 특수문자로 바뀐다.
    if (!e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;

    if (e.code === 'KeyN') {
      e.preventDefault();
      input.focus();
      input.select();
      return;
    }

    // 직접 순서 모드에서 포커스가 목록 안에 있으면 Alt+위/아래로 옮긴다
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      const row = document.activeElement?.closest?.('[data-id]');
      if (!row || !list.contains(row) || Store.getSort() !== 'manual') return;

      e.preventDefault();
      nudge(row.dataset.id, e.code === 'ArrowUp' ? -1 : 1);
      return;
    }

    const digit = /^Digit([1-9])$/.exec(e.code);
    if (!digit) return;

    const at = Number(digit[1]) - 1;
    const value = tabs.children[at]?.dataset.value;
    if (value === undefined) return;

    e.preventDefault();
    toggleCategory(value); // 렌더가 탭을 통째로 다시 세운다

    // 위에서 집어둔 노드는 이미 떼어낸 죽은 노드라 focus()가 아무 일도 하지 않는다.
    // 새로 그려진 같은 자리의 탭을 다시 집는다.
    tabs.children[at]?.focus();
  });

  catForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const name = catName.value.trim();
    if (!name) return;

    // 개수가 찬 것은 저장 실패가 아니다. 먼저 걸러내지 않으면 addCategory가 준 null을
    // saved()가 "저장하지 못했습니다"로 읽어, 멀쩡한 저장소를 탓하게 된다.
    if (Store.getCategories().length >= Store.MAX_CATEGORIES) {
      showCategoryError(`카테고리는 ${Store.MAX_CATEGORIES}개까지 만들 수 있습니다.`);
      return;
    }
    if (name.length > Store.MAX_CATEGORY_NAME) {
      showCategoryError(`이름은 ${Store.MAX_CATEGORY_NAME}자까지 씁니다.`);
      return;
    }
    if (Store.getCategories().some((c) => c.name === name)) {
      showCategoryError('같은 이름이 이미 있습니다.');
      return;
    }
    if (!saved(Store.addCategory(name))) return;

    catName.value = '';
    showCategoryError('');
    render();
    catName.focus(); // 연달아 만들 수 있게 자리를 지킨다
  });

  catName.addEventListener('keydown', (e) => {
    // 조합 중의 Enter는 IME가 글자를 확정하는 키다. 여기서 제출하면 두 번 들어간다.
    // Escape도 마찬가지로 조합만 물러야 하므로 패널까지 닫지 않는다.
    if (e.isComposing) {
      if (e.key === 'Enter') e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation(); // catPanel까지 올라가면 toggleCategoryPanel이 두 번 불린다
      toggleCategoryPanel(false);
    }
  });

  /**
   * 이름을 그 자리에서 고친다. 할 일 제목과 같은 방식이다 —
   * Enter로 넣고, Escape로 물리고, 다른 데를 누르면 넣는다.
   */
  function startCategoryRename(id) {
    if (renamingCategory !== null) return;

    const cat = Store.getCategories().find((c) => c.id === id);
    const button = catList.querySelector(`[data-action="rename-category"][data-id="${CSS.escape(id)}"]`);
    if (!cat || !button) return;

    pendingCategoryRemove = null;
    showCategoryError('');

    const editor = el('input', 'cat-rename');
    editor.type = 'text';
    editor.value = cat.name;
    editor.maxLength = Store.MAX_CATEGORY_NAME;
    editor.setAttribute('aria-label', `카테고리 이름 수정: ${cat.name}`);

    renamingCategory = id;
    button.replaceWith(editor);
    editor.focus();
    editor.select();

    /** byKey의 뜻은 할 일 제목 편집기와 같다. (startEdit, renderAfterPress 참고) */
    const finish = (save, byKey) => {
      if (renamingCategory !== id) return;
      renamingCategory = null;

      const name = editor.value.trim().replace(/\s+/g, ' ');

      // 이름을 넣지 못한 이유는 말해준다. 조용히 옛 이름으로 돌아가면
      // 왜 안 바뀌었는지 알 길이 없다.
      if (save && name && name !== cat.name) {
        if (name.length > Store.MAX_CATEGORY_NAME) {
          showCategoryError(`이름은 ${Store.MAX_CATEGORY_NAME}자까지 씁니다.`);
        } else if (Store.getCategories().some((c) => c.id !== id && c.name === name)) {
          showCategoryError('같은 이름이 이미 있습니다.');
        } else {
          saved(Store.renameCategory(id, name));
        }
      }

      if (!byKey) {
        // 제목 편집기와 같은 이유로 여기서 편집기만 걷어낸다. (startEdit 참고)
        const fresh = Store.getCategories().find((c) => c.id === id);
        if (fresh) {
          button.textContent = fresh.name;
          button.setAttribute('aria-label', `카테고리 이름 바꾸기: ${fresh.name}`);
        }
        editor.replaceWith(button);

        renderAfterPress();
        return;
      }
      render();
      catList
        .querySelector(`[data-action="rename-category"][data-id="${CSS.escape(id)}"]`)
        ?.focus();
    };

    editor.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // 패널까지 닫아버리지 않는다
        finish(false, true);
      }
    });
    editor.addEventListener('focusout', () => finish(true, false));
  }

  catList.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-action]');
    if (!trigger) return;

    switch (trigger.dataset.action) {
      case 'rename-category':
        startCategoryRename(trigger.dataset.id);
        break;

      case 'remove-category':
        pendingCategoryRemove = trigger.dataset.id;
        showCategoryError('');
        renderCategoryPanel();
        catList.querySelector('[data-action="confirm-remove-category"]')?.focus();
        break;

      case 'cancel-remove-category': {
        // 확인 줄이 통째로 사라지므로 갈 곳을 지정한다. 다른 두 갈래처럼
        // 챙기지 않으면 포커스가 <body>로 떨어진다.
        const back = pendingCategoryRemove;
        pendingCategoryRemove = null;
        renderCategoryPanel();
        if (back) {
          catList
            .querySelector(`[data-action="remove-category"][data-id="${CSS.escape(back)}"]`)
            ?.focus();
        }
        break;
      }

      case 'confirm-remove-category': {
        const id = trigger.dataset.id;
        const moveTo = document.getElementById('category-move')?.value;
        const removed = saved(Store.removeCategory(id, moveTo));

        pendingCategoryRemove = null;
        if (!removed) {
          renderCategoryPanel();
          return;
        }
        render();
        catName.focus();
        break;
      }
    }
  });

  catPanel.addEventListener('keydown', (e) => {
    // 조합 중의 Escape는 조합만 무른다. 패널까지 닫으면 치던 이름이 함께 사라진다.
    if (e.key === 'Escape' && !e.isComposing) toggleCategoryPanel(false);
  });

  tagBar.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-action="filter-tag"]');
    if (chip) toggleTag(chip.dataset.tag);
  });

  /**
   * 다른 탭이 저장하면 이 이벤트가 온다 (이 탭이 쓴 것에는 오지 않는다).
   * 곧바로 따라가야 이 탭의 상태가 낡은 채로 남아 있지 않는다.
   * key가 null이면 저장소 전체가 비워진 것이다.
   *
   * 다만 **이벤트마다 따라가지는 않는다.** 옆 탭에서 Alt+아래를 길게 누르면 초당
   * 스물몇 번씩 들어오는데, 그때마다 통째로 다시 읽고 그리면 이 탭에서 고치던 제목과
   * 되돌릴 수 있던 5초가 그 횟수만큼 날아간다. 플래그만 세우고 한 프레임에 한 번만 돈다.
   */
  addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== Store.STORAGE_KEY) return;
    queueAdopt();
  });

  Store.load();
  renderTheme();
  renderBanner();
  restorePomoRun();
  renderPomo();
  render();
  input.focus();
})();
