'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadFileSync({ picker, onError, now = 1_700_000_000_000 } = {}) {
  class TestDate extends Date {
    static now() { return typeof now === 'function' ? now() : now; }
  }
  const sandbox = { console, Date: TestDate };
  if (picker) sandbox.showSaveFilePicker = picker;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'file-sync.js'), 'utf8'), sandbox, {
    filename: 'file-sync.js'
  });
  if (onError) sandbox.FileSync.setErrorHandler(onError);
  return sandbox.FileSync;
}

function writableHandle(writes, hooks = {}) {
  return {
    name: hooks.name ?? 'my-what-todo.json',
    async createWritable() {
      hooks.onCreate?.();
      return {
        async write(text) { hooks.onWrite?.(text); writes.push(text); },
        async close() { hooks.onClose?.(); },
        async abort() { hooks.onAbort?.(); }
      };
    }
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('초기 상태는 외부에서 바꿀 수 없는 disconnected 스냅샷이다', () => {
  const FileSync = loadFileSync();
  const first = FileSync.getState();
  assert.deepEqual({ ...first }, { phase: 'disconnected', fileName: null, lastSavedAt: null });
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => { first.phase = 'connected'; }, TypeError);
  assert.notEqual(FileSync.getState(), first);
  assert.equal(FileSync.getState().phase, 'disconnected');
});

test('연결 중 상태를 알리고 initial write+close 성공 뒤 실제 이름과 시각을 공개한다', async () => {
  const writes = [];
  let releasePicker;
  const pickerGate = new Promise((resolve) => { releasePicker = resolve; });
  const handle = writableHandle(writes, { name: '오늘 할 일.json' });
  const FileSync = loadFileSync({ picker: async () => { await pickerGate; return handle; }, now: 1_234 });
  const states = [];
  FileSync.setStatusHandler((state) => states.push({ ...state }));
  const connecting = FileSync.connect(() => ({ step: 0 }));
  assert.equal(FileSync.getState().phase, 'connecting');
  releasePicker();
  assert.equal(await connecting, 'connected');
  assert.deepEqual({ ...FileSync.getState() }, {
    phase: 'connected', fileName: '오늘 할 일.json', lastSavedAt: 1_234
  });
  assert.deepEqual(states.map((state) => state.phase), ['disconnected', 'connecting', 'connected']);
});

test('일반 save는 write+close 성공 뒤에만 마지막 성공 저장 시각을 갱신한다', async () => {
  let now = 100;
  const FileSync = loadFileSync({ picker: async () => writableHandle([]), now: () => now });
  await FileSync.connect(() => ({ step: 0 }));
  now = 200;
  assert.equal(await FileSync.save({ step: 1 }), true);
  assert.equal(FileSync.getState().lastSavedAt, 200);
});

test('save 실패는 기존 마지막 성공 저장 시각을 바꾸지 않는다', async () => {
  let now = 100;
  let fail = false;
  const handle = {
    name: 'kept.json',
    async createWritable() {
      return { async write() {}, async close() { if (fail) throw new Error('failed'); }, async abort() {} };
    }
  };
  const FileSync = loadFileSync({ picker: async () => handle, now: () => now });
  await FileSync.connect(() => ({ step: 0 }));
  now = 200;
  fail = true;
  assert.equal(await FileSync.save({ step: 1 }), false);
  assert.deepEqual({ ...FileSync.getState() }, {
    phase: 'connected', fileName: 'kept.json', lastSavedAt: 100
  });
});

test('취소한 재연결은 기존 파일 이름과 마지막 성공 시각으로 복귀한다', async () => {
  const original = writableHandle([], { name: 'original.json' });
  let cancel = false;
  const FileSync = loadFileSync({
    picker: async () => {
      if (cancel) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      return original;
    }, now: 300
  });
  await FileSync.connect(() => ({ step: 0 }));
  cancel = true;
  assert.equal(await FileSync.connect(() => ({ step: 1 })), 'cancelled');
  assert.deepEqual({ ...FileSync.getState() }, {
    phase: 'connected', fileName: 'original.json', lastSavedAt: 300
  });
});

test('후보 쓰기에 실패한 재연결은 기존 파일 이름과 마지막 성공 시각으로 복귀한다', async () => {
  const original = writableHandle([], { name: 'original.json' });
  const broken = { name: 'broken.json', async createWritable() { throw new Error('candidate failed'); } };
  let picked = original;
  const FileSync = loadFileSync({ picker: async () => picked, now: 400 });
  await FileSync.connect(() => ({ step: 0 }));
  picked = broken;
  assert.equal(await FileSync.connect(() => ({ step: 1 })), 'error');
  assert.deepEqual({ ...FileSync.getState() }, {
    phase: 'connected', fileName: 'original.json', lastSavedAt: 400
  });
});

test('비거나 문자열이 아닌 handle.name은 안전한 기본 파일명으로 바꾼다', async () => {
  for (const unsafeName of ['', null, 42]) {
    const handle = writableHandle([]);
    handle.name = unsafeName;
    const FileSync = loadFileSync({ picker: async () => handle });
    await FileSync.connect(() => ({}));
    assert.equal(FileSync.getState().fileName, 'my-what-todo.json');
  }
});

test('연결은 JSON picker 옵션을 주고 현재 스냅샷을 들여쓰기 JSON으로 즉시 쓴다', async () => {
  const writes = [];
  let options;
  const handle = writableHandle(writes);
  const FileSync = loadFileSync({
    picker: async (received) => { options = received; return handle; }
  });

  const result = await FileSync.connect(() => ({ todos: [{ id: 'now' }] }));

  assert.equal(result, 'connected');
  assert.equal(options.suggestedName, 'my-what-todo.json');
  assert.equal(options.types[0].accept['application/json'][0], '.json');
  assert.equal(writes[0], JSON.stringify({ todos: [{ id: 'now' }] }, null, 2));
});

test('첫 연결 쓰기 중 save는 연결 완료까지 보존되어 후보 파일을 최신으로 만든다', async () => {
  const writes = [];
  let releaseInitialWrite;
  const initialWriteGate = new Promise((resolve) => { releaseInitialWrite = resolve; });
  let writeCount = 0;
  const candidate = {
    async createWritable() {
      return {
        async write(text) {
          writes.push(text);
          writeCount += 1;
          if (writeCount === 1) await initialWriteGate;
        },
        async close() {}
      };
    }
  };
  const FileSync = loadFileSync({ picker: async () => candidate });

  const connecting = FileSync.connect(() => ({ step: 0 }));
  while (writes.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const saving = FileSync.save({ step: 1 });
  releaseInitialWrite();

  assert.equal(await connecting, 'connected');
  assert.equal(await saving, true);
  assert.equal(writes.at(-1), JSON.stringify({ step: 1 }, null, 2));
});

test('첫 연결 실패 시 연결 중 save도 false로 완료된다', async () => {
  let releaseInitialWrite;
  const initialWriteGate = new Promise((resolve) => { releaseInitialWrite = resolve; });
  let writing = false;
  const candidate = {
    async createWritable() {
      return {
        async write() {
          writing = true;
          await initialWriteGate;
          throw new Error('initial write failed');
        },
        async close() {},
        async abort() {}
      };
    }
  };
  const FileSync = loadFileSync({ picker: async () => candidate });

  const connecting = FileSync.connect(() => ({ step: 0 }));
  while (!writing) await new Promise((resolve) => setImmediate(resolve));
  const saving = FileSync.save({ step: 1 });
  releaseInitialWrite();

  assert.equal(await connecting, 'error');
  assert.equal(await saving, false);
  assert.deepEqual({ ...FileSync.getState() }, {
    phase: 'disconnected', fileName: null, lastSavedAt: null
  });
});

test('picker 취소는 조용히 끝나고 기존 연결을 유지한다', async () => {
  const originalWrites = [];
  const original = writableHandle(originalWrites);
  let pickerMode = 'connect';
  const FileSync = loadFileSync({
    picker: async () => {
      if (pickerMode === 'cancel') throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      return original;
    }
  });

  assert.equal(await FileSync.connect(() => ({ step: 0 })), 'connected');
  pickerMode = 'cancel';
  assert.equal(await FileSync.connect(() => ({ step: 99 })), 'cancelled');
  assert.equal(await FileSync.save({ step: 1 }), true);
  assert.equal(originalWrites.at(-1), JSON.stringify({ step: 1 }, null, 2));
});

test('미지원 브라우저는 picker를 시도하지 않고 unsupported를 돌려준다', async () => {
  const FileSync = loadFileSync();
  assert.equal(FileSync.isSupported(), false);
  assert.equal(await FileSync.connect(() => ({ untouched: true })), 'unsupported');
  assert.equal(await FileSync.save({ untouched: false }), false);
});

test('빠른 연속 저장은 호출 시점 스냅샷을 순서대로 쓰고 최종 파일을 최신으로 만든다', async () => {
  const writes = [];
  const gates = [];
  let block = false;
  const handle = writableHandle(writes, {
    onWrite() {
      if (!block) return;
      return new Promise((resolve) => gates.push(resolve));
    }
  });
  // writable helper의 async write가 hook 반환값을 기다리도록 별도 핸들을 쓴다.
  handle.createWritable = async () => ({
    async write(text) {
      writes.push(text);
      if (block) await new Promise((resolve) => gates.push(resolve));
    },
    async close() {}
  });
  const FileSync = loadFileSync({ picker: async () => handle });
  await FileSync.connect(() => ({ step: 0 }));

  block = true;
  const first = { step: 1 };
  const save1 = FileSync.save(first);
  first.step = 100;
  const save2 = FileSync.save({ step: 2 });
  while (writes.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes.slice(1), [JSON.stringify({ step: 1 }, null, 2)]);

  gates.shift()();
  while (writes.length < 3) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes[2], JSON.stringify({ step: 2 }, null, 2));
  gates.shift()();
  assert.deepEqual(await Promise.all([save1, save2]), [true, true]);
  assert.equal(writes.at(-1), JSON.stringify({ step: 2 }, null, 2));
});

test('재연결 쓰기 중 save는 기존 연결과 새 후보를 모두 최신으로 만든다', async () => {
  const originalWrites = [];
  const candidateWrites = [];
  const original = writableHandle(originalWrites);
  let releaseCandidateWrite;
  const candidateWriteGate = new Promise((resolve) => { releaseCandidateWrite = resolve; });
  let candidateWriteCount = 0;
  const candidate = {
    async createWritable() {
      return {
        async write(text) {
          candidateWrites.push(text);
          candidateWriteCount += 1;
          if (candidateWriteCount === 1) await candidateWriteGate;
        },
        async close() {}
      };
    }
  };
  let picked = original;
  const FileSync = loadFileSync({ picker: async () => picked });
  assert.equal(await FileSync.connect(() => ({ step: 0 })), 'connected');

  picked = candidate;
  const reconnecting = FileSync.connect(() => ({ step: 10 }));
  while (candidateWrites.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const saving = FileSync.save({ step: 11 });
  releaseCandidateWrite();

  assert.equal(await reconnecting, 'connected');
  assert.equal(await saving, true);
  assert.equal(originalWrites.at(-1), JSON.stringify({ step: 11 }, null, 2));
  assert.equal(candidateWrites.at(-1), JSON.stringify({ step: 11 }, null, 2));
});

for (const failurePoint of ['createWritable', 'write', 'close']) {
  test(`재연결 initial ${failurePoint} 실패는 기존 연결을 보존하고 다음 save 큐를 복구한다`, async () => {
    const errors = [];
    const originalWrites = [];
    const original = writableHandle(originalWrites);
    const candidate = {
      async createWritable() {
        if (failurePoint === 'createWritable') throw new Error('candidate create failed');
        return {
          async write() {
            if (failurePoint === 'write') throw new Error('candidate write failed');
          },
          async close() {
            if (failurePoint === 'close') throw new Error('candidate close failed');
          },
          async abort() {}
        };
      }
    };
    let picked = original;
    const FileSync = loadFileSync({
      picker: async () => picked,
      onError: (error) => errors.push(error.message)
    });
    assert.equal(await FileSync.connect(() => ({ step: 0 })), 'connected');

    picked = candidate;
    assert.equal(await FileSync.connect(() => ({ step: 1 })), 'error');
    assert.equal(await FileSync.save({ step: 2 }), true);
    assert.equal(originalWrites.at(-1), JSON.stringify({ step: 2 }, null, 2));
    assert.equal(errors.length, 1);
  });
}

test('동시 connect 재진입은 busy로 거절하고 진행 중 연결을 보존한다', async () => {
  const writes = [];
  let releasePicker;
  const pickerGate = new Promise((resolve) => { releasePicker = resolve; });
  const handle = writableHandle(writes);
  const FileSync = loadFileSync({ picker: async () => { await pickerGate; return handle; } });

  const first = FileSync.connect(() => ({ step: 0 }));
  const second = FileSync.connect(() => ({ step: 99 }));
  releasePicker();
  assert.equal(await second, 'busy');
  assert.equal(await first, 'connected');
  assert.equal(writes.at(-1), JSON.stringify({ step: 0 }, null, 2));
});

test('쓰기 실패는 거절을 밖으로 새지 않게 흡수하고 abort를 시도한다', async () => {
  const errors = [];
  let aborts = 0;
  let fail = false;
  const handle = {
    async createWritable() {
      return {
        async write() { if (fail) throw new Error('disk full'); },
        async close() {},
        async abort() { aborts += 1; }
      };
    }
  };
  const FileSync = loadFileSync({ picker: async () => handle, onError: (error) => errors.push(error.message) });
  await FileSync.connect(() => ({ step: 0 }));

  fail = true;
  assert.equal(await FileSync.save({ step: 1 }), false);
  assert.deepEqual(errors, ['disk full']);
  assert.equal(aborts, 1);
});

test('onError가 throw해도 실패를 흡수하고 다음 save 큐를 복구한다', async () => {
  let fail = false;
  const writes = [];
  const handle = {
    async createWritable() {
      return {
        async write(text) {
          if (fail) throw new Error('write failed');
          writes.push(text);
        },
        async close() {},
        async abort() {}
      };
    }
  };
  const FileSync = loadFileSync({
    picker: async () => handle,
    onError: () => { throw new Error('notification failed'); }
  });
  await FileSync.connect(() => ({ step: 0 }));

  fail = true;
  assert.equal(await FileSync.save({ step: 1 }), false);
  fail = false;
  assert.equal(await FileSync.save({ step: 2 }), true);
  assert.equal(writes.at(-1), JSON.stringify({ step: 2 }, null, 2));
});

test('재연결 후보 close 실패 뒤에도 기존 handle 저장의 새 성공 시각을 보존한다', async () => {
  let now = 100;
  let releaseOriginalClose;
  let originalCloseCount = 0;
  const originalCloseGate = new Promise((resolve) => { releaseOriginalClose = resolve; });
  const original = {
    name: 'original.json',
    async createWritable() {
      return {
        async write() {},
        async close() {
          originalCloseCount += 1;
          if (originalCloseCount === 2) await originalCloseGate;
        }
      };
    }
  };
  let candidateCloseStarted = false;
  let releaseCandidateClose;
  const candidateCloseGate = new Promise((resolve) => { releaseCandidateClose = resolve; });
  const candidate = {
    name: 'candidate.json',
    async createWritable() {
      return {
        async write() {},
        async close() {
          candidateCloseStarted = true;
          await candidateCloseGate;
          throw new Error('candidate close failed');
        },
        async abort() {}
      };
    }
  };
  let releasePicker;
  let picked = original;
  const FileSync = loadFileSync({
    picker: async () => {
      if (picked === original) return original;
      await new Promise((resolve) => { releasePicker = resolve; });
      return candidate;
    },
    now: () => now
  });
  assert.equal(await FileSync.connect(() => ({ step: 0 })), 'connected');

  picked = candidate;
  const reconnecting = FileSync.connect(() => ({ step: 1 }));
  while (!releasePicker) await new Promise((resolve) => setImmediate(resolve));
  now = 200;
  const saving = FileSync.save({ step: 2 });
  releasePicker();
  releaseOriginalClose();
  assert.equal(await saving, true);
  assert.equal(FileSync.getState().lastSavedAt, 200);

  while (!candidateCloseStarted) await new Promise((resolve) => setImmediate(resolve));
  releaseCandidateClose();
  assert.equal(await reconnecting, 'error');
  assert.deepEqual({ ...FileSync.getState() }, {
    phase: 'connected', fileName: 'original.json', lastSavedAt: 200
  });
});

test('연속 save는 close 성공 시각만 순서대로 반영하고 실패 시각은 반영하지 않는다', async () => {
  let now = 100;
  let mode = 'normal';
  const closeGates = [];
  const closeStarted = [];
  const handle = {
    name: 'timed.json',
    async createWritable() {
      const jobMode = mode;
      return {
        async write() {},
        async close() {
          if (jobMode === 'fail') throw new Error('close failed');
          if (jobMode !== 'gated') return;
          closeStarted.push(true);
          await new Promise((resolve) => closeGates.push(resolve));
        },
        async abort() {}
      };
    }
  };
  const FileSync = loadFileSync({ picker: async () => handle, now: () => now });
  assert.equal(await FileSync.connect(() => ({ step: 0 })), 'connected');
  assert.equal(FileSync.getState().lastSavedAt, 100);

  mode = 'fail';
  now = 150;
  assert.equal(await FileSync.save({ step: 'failed' }), false);
  assert.equal(FileSync.getState().lastSavedAt, 100);

  mode = 'gated';
  now = 200;
  const first = FileSync.save({ step: 1 });
  now = 300;
  const second = FileSync.save({ step: 2 });
  while (closeStarted.length < 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FileSync.getState().lastSavedAt, 100, '첫 close 성공 전에는 갱신하지 않는다');

  now = 200;
  closeGates.shift()();
  assert.equal(await first, true);
  assert.equal(FileSync.getState().lastSavedAt, 200);

  while (closeStarted.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FileSync.getState().lastSavedAt, 200, '둘째 close 성공 전에는 첫 성공 시각을 유지한다');
  now = 300;
  closeGates.shift()();
  assert.equal(await second, true);
  assert.equal(FileSync.getState().lastSavedAt, 300);
});

test('status handler 예외와 connecting 재진입에도 큐를 유지하고 최신 후보를 저장한다', async () => {
  const writes = [];
  const unhandled = [];
  let reentrantSave;
  let reentrantConnect;
  let didReenter = false;
  const candidate = writableHandle(writes, { name: 'latest.json' });
  const FileSync = loadFileSync({ picker: async () => candidate });
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    FileSync.setStatusHandler((state) => {
      if (state.phase === 'connecting' && !didReenter) {
        didReenter = true;
        reentrantSave = FileSync.save({ step: 'latest' });
        reentrantConnect = FileSync.connect(() => ({ step: 'stale-connect' }));
      }
      throw new Error('render failed');
    });

    const connecting = FileSync.connect(() => ({ step: 'stale' }));
    assert.equal(await reentrantConnect, 'busy');
    assert.equal(await connecting, 'connected');
    assert.equal(await reentrantSave, true);
    assert.equal(writes.at(-1), JSON.stringify({ step: 'latest' }, null, 2));
    assert.deepEqual({ ...FileSync.getState() }, {
      phase: 'connected', fileName: 'latest.json', lastSavedAt: 1_700_000_000_000
    });

    assert.equal(await FileSync.save({ step: 'after-handler-error' }), true);
    assert.equal(writes.at(-1), JSON.stringify({ step: 'after-handler-error' }, null, 2));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('악성 형태의 handle.name도 실행하지 않고 파일명 문자열 그대로 상태에 보존한다', async () => {
  const malicious = '<img src=x onerror=globalThis.pwned=true>.json';
  const handle = writableHandle([], { name: malicious });
  const FileSync = loadFileSync({ picker: async () => handle });

  assert.equal(await FileSync.connect(() => ({})), 'connected');
  assert.equal(FileSync.getState().fileName, malicious);
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
    console.error(`${failures} file sync test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('all file sync tests passed');
  }
})();
