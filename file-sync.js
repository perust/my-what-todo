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
  let generation = 0;
  let failedRecord = null;
  let retrying = false;
  let retryPromise = null;

  const serialize = (snapshot) => JSON.stringify(snapshot, null, 2);

  function getState() {
    return Object.freeze({
      phase,
      fileName,
      lastSavedAt,
      saveError: failedRecord !== null && failedRecord.handle === handle,
      retrying
    });
  }

  function publishState() {
    try {
      onStatus(getState());
    } catch (ignored) {
      // 상태 표시 코드의 실패가 파일 저장을 끊어서는 안 된다.
    }
  }

  function publish(nextPhase, nextFileName = fileName, nextLastSavedAt = lastSavedAt) {
    const changed =
      phase !== nextPhase ||
      fileName !== nextFileName ||
      lastSavedAt !== nextLastSavedAt;
    phase = nextPhase;
    fileName = nextFileName;
    lastSavedAt = nextLastSavedAt;
    if (changed) publishState();
    return changed;
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
      if (pending.version === 0) {
        const snapshot = typeof getSnapshot === 'function' ? getSnapshot() : getSnapshot;
        pending.latestText = serialize(snapshot);
        pending.version += 1;
      }

      // 후보가 picker/write를 기다리는 동안 들어온 최신 스냅샷까지 모두 drain한다.
      while (true) {
        const version = pending.version;
        const text = pending.latestText;
        const savedAt = await enqueue(candidate, text);
        if (pending.version === version) {
          handle = candidate;
          failedRecord = null;
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
    let currentGeneration;
    try {
      // 호출 순간 immutable JSON text와 세대를 함께 고정한다.
      text = serialize(snapshot);
      currentGeneration = ++generation;
    } catch (error) {
      // 더 최신 상태를 JSON text로 고정하지 못했으면 현재 파일의 과거 실패본을
      // 다시 쓸 수 없다. 다른 handle에 묶인 실패 레코드는 건드리지 않는다.
      if (failedRecord?.handle === currentHandle) {
        failedRecord = null;
        publishState();
      }
      report(error);
      return Promise.resolve(false);
    }

    if (pending !== null) {
      pending.latestText = text;
      pending.version += 1;
    }

    if (currentHandle === null) return pending.completion;

    return enqueue(currentHandle, text).then(
      (savedAt) => {
        if (handle === currentHandle) {
          let cleared = false;
          if (
            failedRecord?.handle === currentHandle &&
            failedRecord.generation <= currentGeneration
          ) {
            failedRecord = null;
            cleared = true;
          }
          const published = publish(phase, fileName, savedAt);
          // 테스트 시계가 같아 시각이 그대로여도 오류 해제는 공개한다.
          if (cleared && !published) publishState();
        }
        return true;
      },
      (error) => {
        if (handle === currentHandle) {
          const firstInEpisode =
            failedRecord === null || failedRecord.handle !== currentHandle;
          failedRecord = Object.freeze({
            handle: currentHandle,
            text,
            generation: currentGeneration
          });
          publishState();
          if (firstInEpisode) report(error);
        } else {
          report(error);
        }
        return false;
      }
    );
  }

  function retry() {
    if (retryPromise !== null) return retryPromise;
    if (handle === null || failedRecord === null || failedRecord.handle !== handle) {
      return Promise.resolve(false);
    }

    retrying = true;
    publishState();

    // 실행 시점의 실패 레코드를 읽는다. 앞서 queue에 들어온 더 최신 save가 실패하면
    // 그 text를 쓰며, 성공해 오류가 풀렸다면 오래된 text를 다시 쓰지 않는다.
    const job = tail.then(async () => {
      const record = failedRecord;
      if (record === null || record.handle !== handle) return true;
      const savedAt = await writeFile(record.handle, record.text);
      if (failedRecord === record && handle === record.handle) {
        failedRecord = null;
        const published = publish(phase, fileName, savedAt);
        if (!published) publishState();
      }
      return true;
    });
    tail = job.catch(() => {});

    retryPromise = job.then(
      (result) => result,
      () => false
    ).then((result) => {
      retrying = false;
      retryPromise = null;
      publishState();
      return result;
    });
    return retryPromise;
  }

  function setErrorHandler(handler) {
    onError = typeof handler === 'function' ? handler : () => {};
  }

  function setStatusHandler(handler) {
    onStatus = typeof handler === 'function' ? handler : () => {};
    publishState();
  }

  globalThis.FileSync = Object.freeze({
    connect, save, retry, isSupported, getState, setErrorHandler, setStatusHandler
  });
})();
