'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadFileSync({ picker, onError } = {}) {
  const sandbox = { console };
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
