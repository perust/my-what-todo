/**
 * file-sync.js — 현재 페이지 세션에서만 유지하는 JSON 파일 연결과 직렬 쓰기 큐.
 * 파일 핸들을 브라우저 저장소에 남기지 않는다.
 */
(function () {
  'use strict';

  const PICKER_OPTIONS = {
    suggestedName: 'my-what-todo.json',
    types: [{
      description: 'JSON 파일',
      accept: { 'application/json': ['.json'] }
    }]
  };

  let handle = null;
  let tail = Promise.resolve();
  let onError = () => {};
  let onStatus = () => {};
  let pendingConnection = null;
  let phase = 'disconnected';
  let fileName = null;
  let lastSavedAt = null;

  const serialize = (snapshot) => JSON.stringify(snapshot, null, 2);

  function getState() {
    return Object.freeze({ phase, fileName, lastSavedAt });
  }

  function publish(nextPhase, nextFileName = fileName, nextLastSavedAt = lastSavedAt) {
    if (
      phase === nextPhase &&
      fileName === nextFileName &&
      lastSavedAt === nextLastSavedAt
    ) return;

    phase = nextPhase;
    fileName = nextFileName;
    lastSavedAt = nextLastSavedAt;
    try {
      onStatus(getState());
    } catch (ignored) {
      // 상태 표시 코드의 실패가 파일 저장을 끊어서는 안 된다.
    }
  }

  const safeFileName = (candidate) =>
    typeof candidate?.name === 'string' && candidate.name.trim()
      ? candidate.name
      : PICKER_OPTIONS.suggestedName;

  function report(error) {
    try {
      onError(error);
    } catch (ignored) {
      // 알림 코드의 실패가 파일 큐까지 끊어서는 안 된다.
    }
  }

  async function writeFile(target, text) {
    const writable = await target.createWritable();
    try {
      await writable.write(text);
      await writable.close();
      return Date.now();
    } catch (error) {
      try {
        await writable.abort?.();
      } catch (ignored) {
        // abort 실패로 원래 쓰기 오류를 가리지 않는다.
      }
      throw error;
    }
  }

  function enqueue(target, text) {
    const job = tail.then(() => writeFile(target, text));
    // 한 번 실패해도 다음 스냅샷은 계속 쓸 수 있게 큐 꼬리는 항상 이행시킨다.
    tail = job.catch(() => {});
    return job;
  }

  function isSupported() {
    return typeof globalThis.showSaveFilePicker === 'function';
  }

  async function connect(getSnapshot) {
    if (!isSupported()) return 'unsupported';
    if (pendingConnection !== null) return 'busy';

    let resolveCompletion;
    const pending = {
      version: 0,
      latestText: null,
      completion: new Promise((resolve) => { resolveCompletion = resolve; }),
      finish(success) {
        if (pendingConnection === pending) pendingConnection = null;
        resolveCompletion(success);
      }
    };
    pendingConnection = pending;
    publish('connecting');

    let candidate;
    try {
      candidate = await globalThis.showSaveFilePicker(PICKER_OPTIONS);
    } catch (error) {
      pending.finish(false);
      publish(handle === null ? 'disconnected' : 'connected');
      if (error?.name === 'AbortError') return 'cancelled';
      report(error);
      return 'error';
    }

    try {
      // picker를 기다리는 동안 save가 먼저 들어왔다면 그 최신 스냅샷을 사용한다.
      if (pending.version === 0) {
        const snapshot = typeof getSnapshot === 'function' ? getSnapshot() : getSnapshot;
        pending.latestText = serialize(snapshot);
        pending.version += 1;
      }

      // 쓰는 동안 save가 들어오면 새 버전을 다시 쓴다. 마지막 확인과 handle 교체
      // 사이에는 await가 없어 JS 이벤트 루프에서 변경을 놓치지 않는다.
      while (true) {
        const version = pending.version;
        const text = pending.latestText;
        const savedAt = await enqueue(candidate, text);
        if (pending.version === version) {
          handle = candidate;
          publish('connected', safeFileName(candidate), savedAt);
          pending.finish(true);
          return 'connected';
        }
      }
    } catch (error) {
      pending.finish(false);
      publish(handle === null ? 'disconnected' : 'connected');
      report(error);
      return 'error';
    }
  }

  function save(snapshot) {
    const currentHandle = handle;
    const pending = pendingConnection;
    if (currentHandle === null && pending === null) return Promise.resolve(false);

    let text;
    try {
      // 큐에 객체를 넣지 않고 지금 문자열로 고정해야 호출 뒤의 변경이 섞이지 않는다.
      text = serialize(snapshot);
    } catch (error) {
      report(error);
      return Promise.resolve(false);
    }

    if (pending !== null) {
      pending.latestText = text;
      pending.version += 1;
    }

    // 첫 연결 중 save는 후보 연결의 성공/실패와 함께 정직하게 완료한다.
    if (currentHandle === null) return pending.completion;

    // 재연결 중에도 기존 연결에는 계속 저장한다. 후보 실패 시에도 최신 상태가 남는다.
    return enqueue(currentHandle, text).then(
      (savedAt) => {
        // 재연결이 먼저 성공했다면 뒤늦게 끝난 옛 핸들의 저장 시각으로 역행하지 않는다.
        if (handle === currentHandle) publish(phase, fileName, savedAt);
        return true;
      },
      (error) => {
        report(error);
        return false;
      }
    );
  }

  function setErrorHandler(handler) {
    onError = typeof handler === 'function' ? handler : () => {};
  }

  function setStatusHandler(handler) {
    onStatus = typeof handler === 'function' ? handler : () => {};
    try {
      onStatus(getState());
    } catch (ignored) {
      // 등록 직후 렌더 실패도 저장 기능과 분리한다.
    }
  }

  globalThis.FileSync = Object.freeze({
    connect, save, isSupported, getState, setErrorHandler, setStatusHandler
  });
})();
