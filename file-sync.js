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
  const CONFLICT = Symbol('external-file-conflict');
  const CHECK_FAILED = Symbol('external-file-check-failed');

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
  let conflictRecord = null;
  let retrying = false;
  let retryPromise = null;
  let forcing = false;
  let forcePromise = null;
  const expectedBytes = new WeakMap();

  const serialize = (snapshot) => JSON.stringify(snapshot, null, 2);
  const wrapCheckFailure = (error) => Object.freeze({ marker: CHECK_FAILED, error });
  const isCheckFailure = (error) => error?.marker === CHECK_FAILED;
  const reportedError = (error) => isCheckFailure(error) ? error.error : error;

  function hasConflict(target = handle) {
    return conflictRecord !== null && conflictRecord.handle === target;
  }

  function getState() {
    const activeFailure = failedRecord !== null && failedRecord.handle === handle && !hasConflict()
      ? failedRecord
      : null;
    return Object.freeze({
      phase,
      fileName,
      lastSavedAt,
      saveError: activeFailure !== null && activeFailure.kind === 'write',
      checkError: activeFailure !== null && activeFailure.kind === 'check',
      retryAvailable:
        activeFailure !== null && activeFailure.kind === 'write' && activeFailure.text !== null,
      retrying,
      conflict: hasConflict(),
      forcing
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
      expectedBytes.set(target, text);
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

  async function compareExpected(target) {
    if (typeof target?.getFile !== 'function' || !expectedBytes.has(target)) {
      return 'unsupported';
    }
    try {
      const file = await target.getFile();
      const current = await file.text();
      return current === expectedBytes.get(target) ? 'unchanged' : 'conflict';
    } catch (error) {
      throw wrapCheckFailure(error);
    }
  }

  function enterConflict(target, text, recordGeneration) {
    if (target !== handle) return;
    const wasConflict = hasConflict(target);
    conflictRecord = Object.freeze({ handle: target, text, generation: recordGeneration });
    failedRecord = null;
    if (!wasConflict) publishState();
  }

  async function guardedWrite(target, text, recordGeneration, initial = false) {
    if (!initial) {
      const comparison = await compareExpected(target);
      if (comparison === 'conflict') {
        enterConflict(target, text, recordGeneration);
        throw CONFLICT;
      }
    }
    return writeFile(target, text);
  }

  function enqueueTask(task) {
    const job = tail.then(task);
    tail = job.catch(() => {});
    return job;
  }

  function isSupported() {
    return typeof globalThis.showSaveFilePicker === 'function';
  }

  async function connect(getSnapshot) {
    if (!isSupported()) return 'unsupported';
    if (pendingConnection !== null || forcing) return 'busy';

    let resolveCompletion;
    const pending = {
      version: 0,
      latestText: null,
      invalid: false,
      finished: false,
      completion: new Promise((resolve) => { resolveCompletion = resolve; }),
      finish(success) {
        if (pending.finished) return;
        pending.finished = true;
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

      let initial = true;
      while (true) {
        if (pending.invalid) {
          pending.finish(false);
          publish(handle === null ? 'disconnected' : 'connected');
          return 'error';
        }
        const version = pending.version;
        const text = pending.latestText;
        const savedAt = await enqueueTask(() => guardedWrite(candidate, text, generation, initial));
        initial = false;
        if (pending.invalid) {
          pending.finish(false);
          publish(handle === null ? 'disconnected' : 'connected');
          return 'error';
        }
        if (pending.version === version) {
          handle = candidate;
          failedRecord = null;
          conflictRecord = null;
          publish('connected', safeFileName(candidate), savedAt);
          pending.finish(true);
          return 'connected';
        }
      }
    } catch (error) {
      pending.finish(false);
      publish(handle === null ? 'disconnected' : 'connected');
      if (error !== CONFLICT && !pending.invalid) report(reportedError(error));
      return 'error';
    }
  }

  function save(snapshot) {
    const currentHandle = handle;
    const pending = pendingConnection;
    if (currentHandle === null && pending === null) return Promise.resolve(false);

    const currentGeneration = ++generation;
    let text;
    try {
      text = serialize(snapshot);
    } catch (error) {
      if (pending !== null) {
        pending.invalid = true;
        pending.version += 1;
      }
      if (failedRecord?.handle === currentHandle) failedRecord = null;
      if (conflictRecord?.handle === currentHandle) {
        conflictRecord = Object.freeze({
          handle: currentHandle,
          text: null,
          generation: currentGeneration
        });
      }
      publishState();
      report(error);
      return Promise.resolve(false);
    }

    if (pending !== null && !pending.invalid) {
      pending.latestText = text;
      pending.version += 1;
    }

    if (currentHandle === null) return pending.completion;
    if (hasConflict(currentHandle)) {
      conflictRecord = Object.freeze({
        handle: currentHandle,
        text,
        generation: currentGeneration
      });
      return Promise.resolve(false);
    }

    return enqueueTask(async () => {
      if (hasConflict(currentHandle)) {
        conflictRecord = Object.freeze({
          handle: currentHandle,
          text,
          generation: currentGeneration
        });
        return false;
      }
      try {
        const savedAt = await guardedWrite(currentHandle, text, currentGeneration);
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
          if (cleared && !published) publishState();
        }
        return true;
      } catch (error) {
        if (error === CONFLICT) return false;
        if (handle === currentHandle) {
          const kind = isCheckFailure(error) ? 'check' : 'write';
          const firstInEpisode =
            failedRecord === null || failedRecord.handle !== currentHandle || failedRecord.kind !== kind;
          failedRecord = Object.freeze({
            handle: currentHandle,
            text,
            generation: currentGeneration,
            kind
          });
          publishState();
          if (firstInEpisode) report(reportedError(error));
        } else {
          report(reportedError(error));
        }
        return false;
      }
    });
  }

  function retry() {
    if (retryPromise !== null) return retryPromise;
    if (
      handle === null || hasConflict() || failedRecord === null ||
      failedRecord.handle !== handle || failedRecord.kind !== 'write' || failedRecord.text === null
    ) {
      return Promise.resolve(false);
    }

    retrying = true;
    publishState();

    const job = enqueueTask(async () => {
      const record = failedRecord;
      if (record === null || record.handle !== handle || hasConflict()) return false;
      try {
        const savedAt = await guardedWrite(record.handle, record.text, record.generation);
        if (failedRecord === record && handle === record.handle) {
          failedRecord = null;
          const published = publish(phase, fileName, savedAt);
          if (!published) publishState();
        }
        return true;
      } catch (error) {
        if (error === CONFLICT) return false;
        if (isCheckFailure(error) && failedRecord === record && handle === record.handle) {
          failedRecord = Object.freeze({
            handle: record.handle,
            text: record.text,
            generation: record.generation,
            kind: 'check'
          });
          publishState();
          report(reportedError(error));
        }
        return false;
      }
    });

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

  function checkExternal() {
    if (handle === null) return Promise.resolve('disconnected');
    if (pendingConnection !== null || forcing) return Promise.resolve('busy');
    const checkedHandle = handle;
    if (typeof checkedHandle.getFile !== 'function' || !expectedBytes.has(checkedHandle)) {
      return Promise.resolve('unsupported');
    }

    return enqueueTask(async () => {
      if (handle !== checkedHandle) return 'disconnected';
      if (hasConflict(checkedHandle)) return 'conflict';
      try {
        const comparison = await compareExpected(checkedHandle);
        if (comparison === 'conflict') {
          enterConflict(checkedHandle, null, generation);
          return 'conflict';
        }
        if (failedRecord?.handle === checkedHandle && failedRecord.kind === 'check') {
          failedRecord = null;
          publishState();
        }
        return comparison;
      } catch (error) {
        if (handle === checkedHandle) {
          const kind = 'check';
          const firstInEpisode =
            failedRecord === null || failedRecord.handle !== checkedHandle || failedRecord.kind !== kind;
          failedRecord = Object.freeze({
            handle: checkedHandle,
            text: null,
            generation,
            kind
          });
          publishState();
          if (firstInEpisode) report(reportedError(error));
        }
        return 'error';
      }
    });
  }

  function forceOverwrite(getSnapshot) {
    if (forcePromise !== null) return forcePromise;
    if (handle === null || !hasConflict()) return Promise.resolve(false);

    const forceHandle = handle;
    const forceGeneration = ++generation;
    let text;
    try {
      const snapshot = typeof getSnapshot === 'function' ? getSnapshot() : getSnapshot;
      text = serialize(snapshot);
    } catch (error) {
      conflictRecord = Object.freeze({
        handle: forceHandle,
        text: null,
        generation: forceGeneration
      });
      publishState();
      report(error);
      return Promise.resolve(false);
    }

    conflictRecord = Object.freeze({
      handle: forceHandle,
      text,
      generation: forceGeneration
    });
    forcing = true;
    publishState();

    const job = enqueueTask(async () => {
      while (handle === forceHandle && hasConflict(forceHandle)) {
        const record = conflictRecord;
        if (record.text === null) return false;
        let savedAt;
        try {
          // 사용자가 고른 명시적 해결 동작이므로 preflight 비교 없이 쓴다.
          savedAt = await writeFile(forceHandle, record.text);
        } catch (error) {
          report(error);
          return false;
        }
        if (
          handle === forceHandle && conflictRecord === record &&
          conflictRecord.generation === record.generation
        ) {
          conflictRecord = null;
          failedRecord = null;
          const published = publish(phase, fileName, savedAt);
          if (!published) publishState();
          return true;
        }
      }
      return false;
    });

    forcePromise = job.then(
      (result) => result,
      () => false
    ).then((result) => {
      forcing = false;
      forcePromise = null;
      publishState();
      return result;
    });
    return forcePromise;
  }

  function keepExternal() {
    if (handle === null || !hasConflict()) return Promise.resolve(false);
    if (forcing || pendingConnection !== null) return Promise.resolve('busy');

    generation += 1;
    handle = null;
    failedRecord = null;
    conflictRecord = null;
    retryPromise = null;
    retrying = false;
    publish('disconnected', null, null);
    return Promise.resolve('disconnected');
  }

  function setErrorHandler(handler) {
    onError = typeof handler === 'function' ? handler : () => {};
  }

  function setStatusHandler(handler) {
    onStatus = typeof handler === 'function' ? handler : () => {};
    publishState();
  }

  globalThis.FileSync = Object.freeze({
    connect,
    save,
    retry,
    checkExternal,
    forceOverwrite,
    keepExternal,
    isSupported,
    getState,
    setErrorHandler,
    setStatusHandler
  });
})();
