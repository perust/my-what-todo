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
  const nextPriority = (p) => (p + 1) % PRIORITY_LEVELS.length;

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
  const importFile = document.getElementById('import-file');
  const importDialog = document.getElementById('import-dialog');
  const importDialogText = document.getElementById('import-dialog-text');
  const helpButton = document.getElementById('help-button');
  const helpDialog = document.getElementById('help-dialog');
  const pomoButton = document.getElementById('pomo-button');
  const pomoPanel = document.getElementById('pomodoro');
  const pomoTime = document.getElementById('pomo-time');
  const pomoLengths = document.querySelector('.pomo-lengths');
  const pomoCustom = document.getElementById('pomo-custom');
  const pomoInput = document.getElementById('pomo-input');
  const pomoToggle = document.getElementById('pomo-toggle');
  const pomoReset = document.getElementById('pomo-reset');
  const pomoPhase = document.getElementById('pomo-phase');
  const pomoCycleButton = document.getElementById('pomo-cycle');
  const pomoExpand = document.getElementById('pomo-expand');
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

  let pendingUndo = null;
  let undoTimer = null;

  /** 삭제 확인을 기다리는 카테고리 id. 항목이 남아 있으면 옮겨갈 곳을 물어야 한다. */
  let pendingCategoryRemove = null;

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

  const nodeFor = (id) =>
    [...list.querySelectorAll('[data-id]')].find((node) => node.dataset.id === id) ?? null;

  /**
   * Store가 null을 주면 저장에 실패해 변경이 통째로 되돌아간 것이다 (PRD §8).
   * 값 검증은 호출 전에 끝내두었으므로, 여기 도달한 null은 저장 실패뿐이다.
   */
  function saved(result) {
    if (result !== null) return result;

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
    pendingCategoryRemove = null;
    draggingId = null;
    hideUndo();

    Store.load();
    renderTheme();
    render();
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
  // 상태를 저장하지 않는다. 1초마다 저장하면 판 번호가 계속 올라가
  // 다른 탭이 그때마다 다시 읽게 된다 (F-20). 새로고침하면 처음으로 돌아간다.
  // ────────────────────────────────────────────────────────────

  const POMO_MIN = 1;
  const POMO_MAX = 180;

  /** 원 둘레. 반지름 44인 원이라 2πr. 채움 길이를 이 값으로 잰다. */
  const DIAL_LENGTH = 2 * Math.PI * 44;

  let pomoLength = 25 * 60; // 설정한 길이(초)
  let pomoLeft = pomoLength; // 남은 시간(초)
  let pomoEndsAt = null; // 실행 중일 때만 값이 있다
  let pomoTick = null;

  /** 사이클 모드일 때만 값이 찬다. 회차는 0부터 세고 화면에는 1부터 보여준다. */
  let cycleRound = null;
  let cyclePhase = 'focus'; // "focus" | "rest"

  const inCycle = () => cycleRound !== null;

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

    pomoLeft = Math.max(0, Math.round((pomoEndsAt - Date.now()) / 1000));
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
    showNotice(`${ended} 끝 — 이어서 ${phaseLabel()}`);
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
    pomoDots.textContent = '';

    for (let i = 0; i < Store.POMO_ROUNDS; i++) {
      const dot = el('li', 'pomo-dot');
      if (inCycle() && i < cycleRound) dot.classList.add('is-done');
      if (inCycle() && i === cycleRound) dot.classList.add('is-now');
      dot.textContent = String(i + 1);
      pomoDots.appendChild(dot);
    }
  }

  function renderPomo() {
    const running = pomoEndsAt !== null;
    const clock = pomoClock(pomoLeft);
    const label = phaseLabel();

    pomoTime.textContent = clock;
    pomoPhase.textContent = label;
    pomoPhase.hidden = label === '';

    // 끝난 뒤에는 한 번 더 눌러 바로 다음 판을 돌릴 수 있게 한다.
    pomoToggle.textContent = running
      ? '일시정지'
      : pomoLeft === 0
        ? '다시 시작'
        : pomoLeft < pomoLength
          ? '계속'
          : '시작';

    pomoPanel.classList.toggle('is-running', running);
    pomoPanel.classList.toggle('is-rest', inCycle() && cyclePhase === 'rest');
    pomoButton.classList.toggle('is-running', running);
    pomoButton.classList.toggle('is-rest', inCycle() && cyclePhase === 'rest');
    pomoCycleButton.classList.toggle('is-active', inCycle());

    // 배경 탭에서도 남은 시간이 보이게 제목에 얹는다
    document.title = running ? `${clock} · ${BASE_TITLE}` : BASE_TITLE;

    for (const preset of document.querySelectorAll('.pomo-preset[data-minutes]')) {
      preset.classList.toggle(
        'is-active',
        !inCycle() && Number(preset.dataset.minutes) * 60 === pomoLength
      );
    }

    // 흐른 만큼 원이 채워진다
    const done = pomoLength > 0 ? 1 - pomoLeft / pomoLength : 0;
    pomoDialFill.style.strokeDasharray = String(DIAL_LENGTH);
    pomoDialFill.style.strokeDashoffset = String(DIAL_LENGTH * (1 - done));
    pomoDialTime.textContent = clock;
    pomoDialPhase.textContent = label || `${Math.round(pomoLength / 60)}분`;
    renderDots();
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
  }

  // ────────────────────────────────────────────────────────────
  // 카테고리 관리
  // ────────────────────────────────────────────────────────────

  function showCategoryError(text) {
    catError.textContent = text;
    catError.hidden = !text;
  }

  function renderCategoryPanel() {
    if (catPanel.hidden) return;

    const list = Store.getCategories();
    catList.textContent = '';

    for (const cat of list) {
      const li = el('li', 'cat-row');

      const dot = el('span', 'cat-dot');
      paintCategory(dot, cat);

      const name = el('span', 'cat-name');
      name.textContent = cat.name;

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

  function captureFocus() {
    const active = document.activeElement;
    if (!active || !list.contains(active)) return null;
    if (active.dataset.draft) return { draft: true };

    const node = active.closest('[data-id]');
    if (!node) return null;

    return {
      id: node.dataset.id,
      action: active.dataset.action ?? null,
      tag: active.dataset.tag ?? null
    };
  }

  function restoreFocus(mark) {
    if (!mark) return;

    if (mark.draft) {
      list.querySelector('[data-draft]')?.focus();
      return;
    }

    const node = nodeFor(mark.id);
    if (!node) return;

    const selector = mark.action
      ? `[data-action="${mark.action}"]${mark.tag ? `[data-tag="${CSS.escape(mark.tag)}"]` : ''}`
      : null;
    (node.querySelector(selector ?? ':scope') ?? node).focus();
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

  /** 우선순위 마커. `보통`은 아무것도 그리지 않지만 자리는 차지한다. (PRD §7) */
  function renderPriority(item, inert) {
    if (inert) {
      const shown = el('span', `todo-priority is-p${item.priority}`);
      shown.textContent = String(item.priority);
      return shown;
    }

    const marker = el('button', `todo-priority is-p${item.priority}`);
    marker.type = 'button';
    marker.dataset.action = 'cycle-priority';
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
      const badge = el('span', 'badge');
      badge.textContent = cat?.name ?? '';
      if (cat) paintCategory(badge, cat);
      row.appendChild(badge);

      if (!context) {
        const add = el('button', 'todo-add-child');
        add.type = 'button';
        add.dataset.action = 'add-child';
        add.textContent = '+';
        add.setAttribute('aria-label', `하위 할 일 추가: ${item.title}`);
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
    draft.setAttribute('aria-label', `하위 할 일 입력: ${root.title}`);

    draft.addEventListener('keydown', (e) => {
      if (e.isComposing) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        closeChildDraft();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();

      const parsed = Parse.parseInput(draft.value);
      if (!parsed.title) {
        closeChildDraft(); // 빈 상태로 Enter → 닫힘
        return;
      }
      if (fits(parsed.title) && saved(Store.addChild(root.id, parsed))) {
        focusDraft = true;
        render(); // 입력창은 그 자리에 다시 열린다
      } else {
        draft.focus();
      }
    });

    row.appendChild(draft);
    li.appendChild(row);
    return li;
  }

  function render() {
    if (editingId !== null) return;

    // 필터 중인 태그가 사라졌으면 전체로 돌아온다 (F-09).
    // 검색어를 뺀 채로 물어야 한다 — 검색 결과가 0건인 것과 태그가 없어진 것은 다르다.
    if (
      filter.type === 'tag' &&
      Store.getRoots({ type: 'tag', value: filter.value }).length === 0
    ) {
      filter = { type: 'all', query: filter.query };
    }
    // 필터 중인 카테고리를 지웠을 때도 마찬가지다
    if (filter.type === 'category' && !Store.getCategories().some((c) => c.id === filter.value)) {
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

  function handleAdd() {
    const parsed = Parse.parseInput(input.value);

    // 공백만 입력했거나 제목이 너무 길면 조용히 무시한다. 내용과 포커스는 그대로 둔다.
    // 제목에 `!`를 적었으면 그게 이긴다. 안 적었으면 옆 선택 상자의 값을 쓴다.
    const chosen = { ...parsed, priority: parsed.priority ?? Number(priority.value) };

    if (fits(parsed.title) && saved(Store.add(chosen, category.value))) {
      input.value = '';
      render();
    }
    input.focus();
  }

  function openChildDraft(rootId) {
    childDraftFor = rootId;
    focusDraft = true;
    render();
  }

  function closeChildDraft() {
    const rootId = childDraftFor;
    childDraftFor = null;
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

    const finish = (save) => {
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
      render();
      nodeFor(id)?.querySelector('[data-action="edit"]')?.focus();
    };

    editor.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    editor.addEventListener('blur', () => finish(true));
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
  }

  /** 되돌릴 것이 없는 단순 알림. 토스트를 같이 쓴다. */
  function showNotice(text) {
    clearTimeout(undoTimer);
    pendingUndo = null;

    const label = el('span');
    label.textContent = text;

    toast.textContent = '';
    toast.appendChild(label);
    toast.hidden = false;

    undoTimer = setTimeout(hideUndo, UNDO_MS);
  }

  function showUndo(removed) {
    clearTimeout(undoTimer);
    pendingUndo = removed;

    const label = el('span');
    // 하위가 함께 지워진 경우에만 개수를 밝힌다 (F-04)
    label.textContent = removed.length > 1 ? `${removed.length}개 항목이 삭제됨` : '삭제됨';

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
    hideUndo();
    if (!items) return;

    saved(Store.restore(items)); // parentId와 order를 그대로 되살리므로 트리째 돌아온다
    render();
  }

  function handleDelete(id, viaKeyboard) {
    const removed = saved(Store.remove(id));
    if (!removed) return;

    if (removed.some((t) => t.id === childDraftFor)) childDraftFor = null;

    render();
    showUndo(removed);

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
      case 'add-child':
        openChildDraft(id);
        break;
      case 'delete':
        // Enter/Space로 누른 버튼 클릭은 detail이 0이다 — 마우스와 구분되는 지점.
        handleDelete(id, e.detail === 0);
        break;
      case 'cycle-priority': {
        const item = itemFor(id);
        if (item) saved(Store.update(id, { priority: nextPriority(item.priority) }));
        render();
        break;
      }
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

  // ── 뽀모도로 ────────────────────────────────────────────

  pomoButton.addEventListener('click', () => togglePomo());

  // 사이클 — 한 번 누르면 1회차 집중부터 끝까지 이어서 돈다
  pomoCycleButton.addEventListener('click', () => {
    cycleEnter(0, 'focus', true);
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
    togglePomoView(pomoDial, pomoExpand, undefined);
    pomoExpand.setAttribute(
      'aria-label',
      pomoDial.hidden ? '시계 펼치기' : '시계 접기'
    );
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

    if (!saved(Store.setPomodoro(cycle))) return;

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
    if (!document.hidden) pomoRefresh();
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
    if (e.key === 'Escape' && searchInput.value) {
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

    render();
    showUndo(removed);
    toast.querySelector('.toast-undo')?.focus();
  });

  // ── 내보내기 / 가져오기 ──────────────────────────────────

  /** 외부에 아무것도 보내지 않는다. Blob을 만들어 브라우저가 저장하게 한다. */
  function download(data, name) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    );
    const link = el('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }

  /** 파일명에 붙일 날짜. toISOString()은 UTC라 한국 오전에는 하루 전으로 찍힌다. */
  const stamp = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  };

  exportButton.addEventListener('click', () => {
    download(Store.exportData(), `my-task-${stamp()}.json`);
    showNotice('내보냈습니다.');
  });

  importButton.addEventListener('click', () => {
    importFile.value = ''; // 같은 파일을 다시 골라도 change가 오게 한다
    importFile.click();
  });

  /** 파일이 정해진 뒤, 덮어쓰기 전에 백업 여부를 묻는다. */
  let pendingImport = null;

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
    if (choice === 'backup') download(Store.exportData(), `my-task-backup-${stamp()}.json`);

    const result = saved(Store.importData(pendingImport));
    pendingImport = null;
    if (!result) return;

    // 가져온 데이터에는 예전 필터가 가리키던 것이 없을 수 있다
    filter = { type: 'all', query: '' };
    searchInput.value = '';
    searchClear.hidden = true;

    renderTheme();
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

    const tab = tabs.children[Number(digit[1]) - 1];
    if (!tab) return;

    e.preventDefault();
    toggleCategory(tab.dataset.value);
    tab.focus();
  });

  catForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const name = catName.value.trim();
    if (!name) return;

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
    if (e.key === 'Enter' && e.isComposing) e.preventDefault();
    if (e.key === 'Escape') toggleCategoryPanel(false);
  });

  catList.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-action]');
    if (!trigger) return;

    switch (trigger.dataset.action) {
      case 'remove-category':
        pendingCategoryRemove = trigger.dataset.id;
        showCategoryError('');
        renderCategoryPanel();
        catList.querySelector('[data-action="confirm-remove-category"]')?.focus();
        break;

      case 'cancel-remove-category':
        pendingCategoryRemove = null;
        renderCategoryPanel();
        break;

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
    if (e.key === 'Escape') toggleCategoryPanel(false);
  });

  tagBar.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-action="filter-tag"]');
    if (chip) toggleTag(chip.dataset.tag);
  });

  /**
   * 다른 탭이 저장하면 이 이벤트가 온다 (이 탭이 쓴 것에는 오지 않는다).
   * 곧바로 따라가야 이 탭의 상태가 낡은 채로 남아 있지 않는다.
   * key가 null이면 저장소 전체가 비워진 것이다.
   */
  addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== Store.STORAGE_KEY) return;
    adoptExternal();
  });

  Store.load();
  renderTheme();
  renderBanner();
  renderPomo();
  render();
  input.focus();
})();
