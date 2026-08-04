'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadSync({ picker, onError, now = 1_700_000_000_000, render } = {}) {
  class TestDate extends Date { static now() { return typeof now === 'function' ? now() : now; } }
  const sandbox = {
    console, Date: TestDate,
    MarkdownExport: Object.freeze({ render: render ?? ((snapshot) => `STEP:${snapshot.step}\n`) })
  };
  if (picker) sandbox.showSaveFilePicker = picker;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'markdown-sync.js'), 'utf8'), sandbox, {
    filename: 'markdown-sync.js'
  });
  if (onError) sandbox.MarkdownSync.setErrorHandler(onError);
  return sandbox.MarkdownSync;
}

function writableHandle(writes, hooks = {}) {
  return {
    name: hooks.name ?? 'my-what-todo.md',
    async createWritable() {
      hooks.onCreate?.();
      return {
        async write(text) { writes.push(text); await hooks.onWrite?.(text); },
        async close() { await hooks.onClose?.(); },
        async abort() { await hooks.onAbort?.(); }
      };
    }
  };
}

function detectableHandle(initial = '', hooks = {}) {
  const writes = [];
  let bytes = initial;
  let creates = 0;
  const handle = {
    name: hooks.name ?? 'vault.md',
    async getFile() {
      await hooks.onGetFile?.();
      return { async text() { await hooks.onText?.(); return bytes; } };
    },
    async createWritable() {
      creates += 1;
      hooks.onCreate?.();
      return {
        async write(text) { await hooks.onWrite?.(text); writes.push(text); bytes = text; },
        async close() { await hooks.onClose?.(); },
        async abort() { await hooks.onAbort?.(); }
      };
    }
  };
  return {
    handle, writes,
    external(text) { bytes = text; },
    get bytes() { return bytes; },
    get creates() { return creates; }
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('초기 frozen 상태에는 원문이나 오류 객체가 없고 disconnected다', () => {
  const sync = loadSync();
  const state = sync.getState();
  assert.deepEqual({ ...state }, {
    phase: 'disconnected', fileName: null, lastSavedAt: null, saveError: false,
    checkError: false, conflict: false, forcing: false
  });
  assert.equal(Object.isFrozen(state), true);
  assert.throws(() => { state.phase = 'connected'; }, TypeError);
  assert.deepEqual(Object.keys(state), [
    'phase', 'fileName', 'lastSavedAt', 'saveError', 'checkError', 'conflict', 'forcing'
  ]);
});

test('Markdown picker 옵션과 현재 snapshot initial write+close를 정확히 사용한다', async () => {
  const writes = [];
  let options;
  let closes = 0;
  const sync = loadSync({ picker: async (given) => {
    options = given;
    return writableHandle(writes, { name: 'vault.md', onClose: () => { closes += 1; } });
  } });
  assert.equal(await sync.connect(() => ({ step: 1 })), 'connected');
  assert.equal(options.suggestedName, 'my-what-todo.md');
  assert.deepEqual(Array.from(options.types[0].accept['text/markdown']), ['.md']);
  assert.deepEqual(writes, ['STEP:1\n']);
  assert.equal(closes, 1);
  assert.deepEqual({ ...sync.getState() }, {
    phase: 'connected', fileName: 'vault.md', lastSavedAt: 1_700_000_000_000, saveError: false,
    checkError: false, conflict: false, forcing: false
  });
});

test('빠른 연속 save는 호출 순간 render text를 직렬 순서로 쓰고 최신으로 끝난다', async () => {
  const writes = [];
  const gates = [];
  let block = false;
  const handle = writableHandle(writes, {
    onWrite: async () => { if (block) await new Promise((resolve) => gates.push(resolve)); }
  });
  const sync = loadSync({ picker: async () => handle });
  await sync.connect(() => ({ step: 0 }));
  block = true;
  const first = { step: 1 };
  const a = sync.save(first);
  first.step = 99;
  const b = sync.save({ step: 2 });
  while (writes.length < 2) await tick();
  assert.equal(writes[1], 'STEP:1\n');
  gates.shift()();
  while (writes.length < 3) await tick();
  assert.equal(writes[2], 'STEP:2\n');
  gates.shift()();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
});

test('첫 연결 initial write 중 save를 drain해 candidate를 최신 snapshot으로 만든다', async () => {
  const writes = [];
  let release;
  let count = 0;
  const handle = writableHandle(writes, {
    onWrite: async () => { count += 1; if (count === 1) await new Promise((resolve) => { release = resolve; }); }
  });
  const sync = loadSync({ picker: async () => handle });
  const connecting = sync.connect(() => ({ step: 0 }));
  while (!release) await tick();
  const saving = sync.save({ step: 1 });
  release();
  assert.equal(await connecting, 'connected');
  assert.equal(await saving, true);
  assert.equal(writes.at(-1), 'STEP:1\n');
});

test('재연결 중 save는 old handle과 candidate를 모두 최신으로 만든다', async () => {
  const oldWrites = [];
  const newWrites = [];
  const old = writableHandle(oldWrites, { name: 'old.md' });
  let release;
  let count = 0;
  const fresh = writableHandle(newWrites, {
    name: 'fresh.md',
    onWrite: async () => { count += 1; if (count === 1) await new Promise((resolve) => { release = resolve; }); }
  });
  let picked = old;
  const sync = loadSync({ picker: async () => picked });
  await sync.connect(() => ({ step: 0 }));
  picked = fresh;
  const reconnecting = sync.connect(() => ({ step: 10 }));
  while (!release) await tick();
  const saving = sync.save({ step: 11 });
  release();
  assert.equal(await reconnecting, 'connected');
  assert.equal(await saving, true);
  assert.equal(oldWrites.at(-1), 'STEP:11\n');
  assert.equal(newWrites.at(-1), 'STEP:11\n');
});

test('picker 취소와 후보 initial write 실패는 기존 연결·시각·오류 episode를 보존한다', async () => {
  let oldFail = false;
  const old = {
    name: 'old.md',
    async createWritable() { return { async write() { if (oldFail) throw new Error('old fail'); }, async close() {}, async abort() {} }; }
  };
  const broken = { name: 'broken.md', async createWritable() { throw new Error('candidate fail'); } };
  let picked = old;
  const errors = [];
  const sync = loadSync({ picker: async () => {
    if (picked === 'cancel') throw Object.assign(new Error('cancel'), { name: 'AbortError' });
    return picked;
  }, onError: (error) => errors.push(error.message), now: 100 });
  await sync.connect(() => ({ step: 0 }));
  oldFail = true;
  await sync.save({ step: 1 });
  picked = 'cancel';
  assert.equal(await sync.connect(() => ({ step: 2 })), 'cancelled');
  assert.deepEqual({ ...sync.getState() }, {
    phase: 'connected', fileName: 'old.md', lastSavedAt: 100, saveError: true,
    checkError: false, conflict: false, forcing: false
  });
  picked = broken;
  assert.equal(await sync.connect(() => ({ step: 3 })), 'error');
  assert.deepEqual({ ...sync.getState() }, {
    phase: 'connected', fileName: 'old.md', lastSavedAt: 100, saveError: true,
    checkError: false, conflict: false, forcing: false
  });
  assert.deepEqual(errors, ['old fail', 'candidate fail']);
});

test('첫 후보 실패는 disconnected이며 연결 중 save도 false로 완료된다', async () => {
  let release;
  const broken = writableHandle([], {
    onWrite: async () => { await new Promise((resolve) => { release = resolve; }); throw new Error('initial fail'); }
  });
  const sync = loadSync({ picker: async () => broken });
  const connecting = sync.connect(() => ({ step: 0 }));
  while (!release) await tick();
  const saving = sync.save({ step: 1 });
  release();
  assert.equal(await connecting, 'error');
  assert.equal(await saving, false);
  assert.equal(sync.getState().phase, 'disconnected');
});

test('write 실패 뒤 큐는 다음 save 성공으로 복구하고 error episode도 해제한다', async () => {
  let fail = false;
  const writes = [];
  const errors = [];
  const handle = {
    name: 'recover.md',
    async createWritable() { return {
      async write(text) { if (fail) throw new Error('disk full'); writes.push(text); },
      async close() {}, async abort() {}
    }; }
  };
  const sync = loadSync({ picker: async () => handle, onError: (error) => errors.push(error.message) });
  await sync.connect(() => ({ step: 0 }));
  fail = true;
  assert.equal(await sync.save({ step: 1 }), false);
  assert.equal(await sync.save({ step: 2 }), false);
  assert.equal(sync.getState().saveError, true);
  assert.deepEqual(errors, ['disk full']);
  fail = false;
  assert.equal(await sync.save({ step: 3 }), true);
  assert.equal(sync.getState().saveError, false);
  assert.equal(writes.at(-1), 'STEP:3\n');
  fail = true;
  await sync.save({ step: 4 });
  assert.deepEqual(errors, ['disk full', 'disk full']);
});

test('create/write/close 오류에서 abort를 시도하고 rejection을 밖으로 새지 않는다', async () => {
  for (const point of ['create', 'write', 'close']) {
    let fail = false;
    let aborts = 0;
    const handle = {
      async createWritable() {
        if (fail && point === 'create') throw new Error(point);
        return {
          async write() { if (fail && point === 'write') throw new Error(point); },
          async close() { if (fail && point === 'close') throw new Error(point); },
          async abort() { aborts += 1; }
        };
      }
    };
    const sync = loadSync({ picker: async () => handle });
    await sync.connect(() => ({ step: 0 }));
    fail = true;
    assert.equal(await sync.save({ step: 1 }), false);
    assert.equal(aborts, point === 'create' ? 0 : 1);
  }
});

test('connected save render 실패는 write 없이 saveError episode를 열고 다음 성공으로 해제한다', async () => {
  const writes = [];
  let failRender = false;
  const secret = 'PRIVATE_MARKDOWN';
  const errors = [];
  const states = [];
  const sync = loadSync({
    picker: async () => writableHandle(writes),
    render: (value) => { if (failRender) throw new Error(`bad ${secret}`); return `OK:${value.step}\n`; },
    onError: (error) => errors.push(error.message)
  });
  sync.setStatusHandler((state) => states.push({ ...state }));
  await sync.connect(() => ({ step: 0 }));
  failRender = true;
  assert.equal(await sync.save({ step: 1 }), false);
  assert.equal(await sync.save({ step: 2 }), false);
  assert.deepEqual(writes, ['OK:0\n']);
  assert.equal(sync.getState().saveError, true);
  assert.equal(states.at(-1).saveError, true);
  assert.equal(JSON.stringify(sync.getState()).includes(secret), false);
  assert.deepEqual(errors, [`bad ${secret}`], '같은 render 실패 episode는 한 번만 알린다');

  failRender = false;
  assert.equal(await sync.save({ step: 3 }), true);
  assert.equal(sync.getState().saveError, false);
  assert.equal(states.at(-1).saveError, false);
  assert.equal(writes.at(-1), 'OK:3\n');
});

test('첫 연결 initial write gate 중 최신 render 실패는 stale candidate를 활성화하지 않는다', async () => {
  const writes = [];
  const errors = [];
  let release;
  const candidate = writableHandle(writes, {
    onWrite: async () => { await new Promise((resolve) => { release = resolve; }); }
  });
  const sync = loadSync({
    picker: async () => candidate,
    render: (value) => {
      if (value.malformed) throw new Error('private malformed payload');
      return `OK:${value.step}\n`;
    },
    onError: (error) => errors.push(error.message)
  });

  const connecting = sync.connect(() => ({ step: 0 }));
  while (!release) await tick();
  const saving = sync.save({ malformed: true });
  release();

  assert.equal(await connecting, 'error');
  assert.equal(await saving, false);
  assert.deepEqual(writes, ['OK:0\n']);
  assert.deepEqual({ ...sync.getState() }, {
    phase: 'disconnected', fileName: null, lastSavedAt: null, saveError: false,
    checkError: false, conflict: false, forcing: false
  });
  assert.deepEqual(errors, ['private malformed payload']);
});

test('재연결 initial write gate 중 최신 render 실패는 old handle/state를 보존하고 오류 상태화한다', async () => {
  const oldWrites = [];
  const candidateWrites = [];
  const errors = [];
  const old = writableHandle(oldWrites, { name: 'old.md' });
  let release;
  const fresh = writableHandle(candidateWrites, {
    name: 'fresh.md',
    onWrite: async () => { await new Promise((resolve) => { release = resolve; }); }
  });
  let picked = old;
  let failRender = false;
  const sync = loadSync({
    picker: async () => picked,
    render: (value) => {
      if (failRender) throw new Error('newer render failed');
      return `OK:${value.step}\n`;
    },
    onError: (error) => errors.push(error.message),
    now: 100
  });
  await sync.connect(() => ({ step: 0 }));
  picked = fresh;
  const reconnecting = sync.connect(() => ({ step: 10 }));
  while (!release) await tick();
  failRender = true;
  const saving = sync.save({ step: 11 });
  release();

  assert.equal(await reconnecting, 'error');
  assert.equal(await saving, false);
  assert.deepEqual(candidateWrites, ['OK:10\n']);
  assert.deepEqual(oldWrites, ['OK:0\n']);
  assert.deepEqual({ ...sync.getState() }, {
    phase: 'connected', fileName: 'old.md', lastSavedAt: 100, saveError: true,
    checkError: false, conflict: false, forcing: false
  });
  assert.deepEqual(errors, ['newer render failed']);

  failRender = false;
  assert.equal(await sync.save({ step: 12 }), true);
  assert.equal(sync.getState().saveError, false);
  assert.equal(oldWrites.at(-1), 'OK:12\n');
});

test('상태 handler와 error handler가 throw해도 큐와 결과를 보존한다', async () => {
  let fail = false;
  const writes = [];
  const handle = {
    async createWritable() { return {
      async write(text) { if (fail) throw new Error('failed'); writes.push(text); },
      async close() {}, async abort() {}
    }; }
  };
  const sync = loadSync({ picker: async () => handle });
  sync.setStatusHandler(() => { throw new Error('status'); });
  sync.setErrorHandler(() => { throw new Error('notice'); });
  await sync.connect(() => ({ step: 0 }));
  fail = true;
  assert.equal(await sync.save({ step: 1 }), false);
  fail = false;
  assert.equal(await sync.save({ step: 2 }), true);
  assert.equal(writes.at(-1), 'STEP:2\n');
});

test('미지원과 connect busy는 picker/상태를 망가뜨리지 않는다', async () => {
  const unsupported = loadSync();
  assert.equal(unsupported.isSupported(), false);
  assert.equal(await unsupported.connect(() => ({ step: 0 })), 'unsupported');
  assert.equal(await unsupported.save({ step: 1 }), false);

  let release;
  const sync = loadSync({ picker: async () => {
    await new Promise((resolve) => { release = resolve; });
    return writableHandle([]);
  } });
  const first = sync.connect(() => ({ step: 0 }));
  while (!release) await tick();
  assert.equal(await sync.connect(() => ({ step: 99 })), 'busy');
  release();
  assert.equal(await first, 'connected');
});

test('비거나 문자열이 아닌 파일명은 안전한 suggestedName으로 상태화한다', async () => {
  for (const name of ['', null, 42]) {
    const handle = writableHandle([]);
    handle.name = name;
    const sync = loadSync({ picker: async () => handle });
    await sync.connect(() => ({ step: 0 }));
    assert.equal(sync.getState().fileName, 'my-what-todo.md');
  }
});

test('detectable baseline은 unchanged save를 허용하고 external mismatch는 writable 전에 conflict로 막는다', async () => {
  const file = detectableHandle('OLD');
  const sync = loadSync({ picker: async () => file.handle });
  await sync.connect(() => ({ step: 0 }));
  assert.equal(await sync.checkExternal(), 'unchanged');
  assert.equal(await sync.save({ step: 1 }), true);
  file.external('EXTERNAL PRIVATE');
  assert.equal(await sync.save({ step: 2 }), false);
  assert.equal(file.creates, 2);
  assert.equal(sync.getState().conflict, true);
  assert.equal(JSON.stringify(sync.getState()).includes('EXTERNAL PRIVATE'), false);
  assert.deepEqual(Object.keys(sync.getState()), [
    'phase', 'fileName', 'lastSavedAt', 'saveError', 'checkError', 'conflict', 'forcing'
  ]);
});

test('conflict의 빠른 save는 write 없이 최신 render를 보관하고 force가 current부터 drain한다', async () => {
  let release;
  let block = false;
  const file = detectableHandle('', { onWrite: async () => {
    if (block) {
      block = false;
      await new Promise((resolve) => { release = resolve; });
    }
  } });
  const sync = loadSync({ picker: async () => file.handle });
  await sync.connect(() => ({ step: 0 }));
  file.external('external');
  assert.deepEqual(await Promise.all([sync.save({ step: 1 }), sync.save({ step: 2 })]), [false, false]);
  block = true;
  const forceA = sync.forceOverwrite(() => ({ step: 3 }));
  const forceB = sync.forceOverwrite(() => ({ step: 99 }));
  assert.equal(forceA, forceB, 'double force는 같은 promise다');
  while (!release) await tick();
  const saving = sync.save({ step: 4 });
  release();
  while (file.writes.at(-1) !== 'STEP:4\n') await tick();
  block = false;
  release?.();
  assert.equal(await forceA, true);
  assert.equal(await saving, false);
  assert.deepEqual(file.writes.slice(-2), ['STEP:3\n', 'STEP:4\n']);
  assert.equal(sync.getState().conflict, false);
});

test('force 실패는 conflict를 보존하고 다음 explicit force로 복구한다', async () => {
  let fail = false;
  const file = detectableHandle('', { onWrite: () => { if (fail) throw new Error('force fail'); } });
  const sync = loadSync({ picker: async () => file.handle });
  await sync.connect(() => ({ step: 0 }));
  file.external('external');
  await sync.checkExternal();
  fail = true;
  assert.equal(await sync.forceOverwrite(() => ({ step: 1 })), false);
  assert.equal(sync.getState().conflict, true);
  fail = false;
  assert.equal(await sync.forceOverwrite(() => ({ step: 2 })), true);
  assert.equal(file.writes.at(-1), 'STEP:2\n');
  assert.equal(sync.getState().conflict, false);
});

test('keepExternal은 conflict에서 write 없이 disconnect하며 forcing/connect busy는 fail-safe다', async () => {
  let release;
  let gate = false;
  const file = detectableHandle('', { onWrite: async () => {
    if (gate) await new Promise((resolve) => { release = resolve; });
  } });
  const sync = loadSync({ picker: async () => file.handle });
  await sync.connect(() => ({ step: 0 }));
  file.external('external');
  await sync.checkExternal();
  gate = true;
  const forcing = sync.forceOverwrite(() => ({ step: 1 }));
  while (!release) await tick();
  assert.equal(await sync.keepExternal(), 'busy');
  assert.equal(await sync.connect(() => ({ step: 2 })), 'busy');
  release();
  await forcing;
  file.external('external again');
  await sync.checkExternal();
  const writes = file.writes.length;
  assert.equal(await sync.keepExternal(), 'disconnected');
  assert.equal(file.writes.length, writes);
  assert.equal(sync.getState().phase, 'disconnected');
});

test('checkExternal은 unchanged/conflict/read error/unsupported와 transient recovery를 안전하게 반환한다', async () => {
  let readFail = false;
  const errors = [];
  const file = detectableHandle('', { onText: () => { if (readFail) throw new Error('read denied'); } });
  const sync = loadSync({ picker: async () => file.handle, onError: (error) => errors.push(error.message) });
  await sync.connect(() => ({ step: 0 }));
  assert.equal(await sync.checkExternal(), 'unchanged');
  readFail = true;
  assert.equal(await sync.checkExternal(), 'error');
  assert.equal(sync.getState().checkError, true);
  assert.equal(sync.getState().saveError, false);
  readFail = false;
  assert.equal(await sync.checkExternal(), 'unchanged');
  assert.equal(sync.getState().checkError, false);
  file.external('changed');
  assert.equal(await sync.checkExternal(), 'conflict');
  assert.deepEqual(errors, ['read denied']);
  const fallback = loadSync({ picker: async () => writableHandle([]) });
  await fallback.connect(() => ({ step: 0 }));
  assert.equal(await fallback.checkExternal(), 'unsupported');
});

test('automatic save preflight read 오류의 pending Markdown은 unchanged check로 지우지 않는다', async () => {
  let readFail = false;
  const errors = [];
  const file = detectableHandle('', { onGetFile: () => {
    if (readFail) throw new Error('read blocked');
  } });
  const sync = loadSync({
    picker: async () => file.handle,
    onError: (error) => errors.push(error.message)
  });
  await sync.connect(() => ({ step: 'A' }));
  const createsAfterBaseline = file.creates;
  const writesAfterBaseline = file.writes.length;

  readFail = true;
  assert.equal(await sync.save({ step: 'B' }), false);
  assert.equal(sync.getState().checkError, true);
  assert.equal(file.creates, createsAfterBaseline);
  assert.equal(file.writes.length, writesAfterBaseline);

  assert.equal(await sync.checkExternal(), 'error');
  assert.equal(sync.getState().checkError, true);
  assert.equal(JSON.stringify(sync.getState()).includes('B'), false);
  assert.equal(file.creates, createsAfterBaseline);
  assert.equal(file.writes.length, writesAfterBaseline);
  assert.deepEqual(errors, ['read blocked']);

  readFail = false;
  assert.equal(await sync.checkExternal(), 'unchanged');
  assert.equal(sync.getState().checkError, true);
  assert.equal(JSON.stringify(sync.getState()).includes('B'), false);
  assert.equal(file.creates, createsAfterBaseline);
  assert.equal(file.writes.length, writesAfterBaseline);

  assert.equal(await sync.save({ step: 'C' }), true);
  assert.equal(sync.getState().checkError, false);
  assert.equal(file.creates, createsAfterBaseline + 1);
  assert.equal(file.bytes, 'STEP:C\n');
});

test('read-only unchanged check는 기존 write error를 지우지 않는다', async () => {
  let fail = false;
  const file = detectableHandle('', { onWrite: () => { if (fail) throw new Error('disk'); } });
  const sync = loadSync({ picker: async () => file.handle });
  await sync.connect(() => ({ step: 0 }));
  fail = true;
  await sync.save({ step: 1 });
  assert.equal(sync.getState().saveError, true);
  assert.equal(await sync.checkExternal(), 'unchanged');
  assert.equal(sync.getState().saveError, true);
});

test('read-only check 오류가 write failure를 전환해도 pending Markdown은 보존한다', async () => {
  let writeFail = false;
  let readFail = false;
  const errors = [];
  const file = detectableHandle('', {
    onGetFile: () => { if (readFail) throw new Error('read blocked'); },
    onWrite: () => { if (writeFail) throw new Error('write blocked'); }
  });
  const sync = loadSync({
    picker: async () => file.handle,
    onError: (error) => errors.push(error.message)
  });
  await sync.connect(() => ({ step: 'A' }));
  const createsAfterBaseline = file.creates;

  writeFail = true;
  assert.equal(await sync.save({ step: 'B' }), false);
  assert.equal(sync.getState().saveError, true);

  writeFail = false;
  readFail = true;
  assert.equal(await sync.checkExternal(), 'error');
  assert.equal(sync.getState().saveError, false);
  assert.equal(sync.getState().checkError, true);
  assert.equal(file.creates, createsAfterBaseline + 1);

  readFail = false;
  assert.equal(await sync.checkExternal(), 'unchanged');
  assert.equal(sync.getState().checkError, true);
  assert.equal(await sync.save({ step: 'C' }), true);
  assert.equal(sync.getState().checkError, false);
  assert.equal(file.bytes, 'STEP:C\n');
  assert.deepEqual(errors, ['write blocked', 'read blocked']);
});

test('connect initial overwrite 뒤 candidate drain은 baseline preflight로 외부 변경을 보존한다', async () => {
  let releaseFirst;
  let releaseCheck;
  let first = true;
  const file = detectableHandle('', {
    onWrite: async () => {
      if (!first) return;
      first = false;
      await new Promise((resolve) => { releaseFirst = resolve; });
    },
    onGetFile: async () => {
      await new Promise((resolve) => { releaseCheck = resolve; });
    }
  });
  const sync = loadSync({ picker: async () => file.handle });
  const connecting = sync.connect(() => ({ step: 0 }));
  while (!releaseFirst) await tick();
  const saving = sync.save({ step: 1 });
  releaseFirst();
  while (!releaseCheck) await tick();
  file.external('external between writes');
  releaseCheck();
  assert.equal(await connecting, 'error');
  assert.equal(await saving, false);
  assert.equal(file.creates, 1);
  assert.equal(sync.getState().phase, 'disconnected');
});

test('conflict 중 render failure는 candidate를 null로 만들어 stale force를 막는다', async () => {
  let failRender = false;
  const file = detectableHandle();
  const sync = loadSync({
    picker: async () => file.handle,
    render: (value) => { if (failRender) throw new Error('private render'); return `STEP:${value.step}\n`; }
  });
  await sync.connect(() => ({ step: 0 }));
  file.external('external');
  await sync.save({ step: 1 });
  failRender = true;
  await sync.save({ step: 2 });
  assert.equal(await sync.forceOverwrite(() => ({ step: 3 })), false);
  assert.equal(file.writes.length, 1);
  assert.equal(sync.getState().conflict, true);
});

test('conflict 재연결 취소/초기 실패는 active conflict를 보존하고 성공만 새 baseline으로 해제한다', async () => {
  const old = detectableHandle('', { name: 'old.md' });
  const broken = writableHandle([], {
    name: 'broken.md',
    onWrite: () => { throw new Error('candidate failed'); }
  });
  const fresh = detectableHandle('', { name: 'fresh.md' });
  let picked = old.handle;
  const sync = loadSync({ picker: async () => {
    if (picked === 'cancel') throw Object.assign(new Error('cancel'), { name: 'AbortError' });
    return picked;
  } });

  await sync.connect(() => ({ step: 0 }));
  old.external('external old bytes');
  assert.equal(await sync.checkExternal(), 'conflict');

  picked = 'cancel';
  assert.equal(await sync.connect(() => ({ step: 1 })), 'cancelled');
  assert.equal(sync.getState().conflict, true);
  assert.equal(sync.getState().fileName, 'old.md');

  picked = broken;
  assert.equal(await sync.connect(() => ({ step: 2 })), 'error');
  assert.equal(sync.getState().conflict, true);
  assert.equal(sync.getState().fileName, 'old.md');

  picked = fresh.handle;
  assert.equal(await sync.connect(() => ({ step: 3 })), 'connected');
  assert.equal(sync.getState().conflict, false);
  assert.equal(sync.getState().fileName, 'fresh.md');
  assert.equal(await sync.checkExternal(), 'unchanged', '성공한 initial bytes가 새 baseline이다');
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
    console.error(`${failures} markdown sync test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`all ${tests.length} markdown sync tests passed`);
  }
})();
