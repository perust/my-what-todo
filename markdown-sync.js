/**
 * markdown-sync.js — 페이지 세션 한정 Markdown 연결과 외부 변경 보호형 직렬 쓰기 큐.
 */
(function () {
  'use strict';

  const PICKER_OPTIONS = {
    suggestedName: 'my-what-todo.md',
    types: [{
      description: 'Markdown 파일',
      accept: { 'text/markdown': ['.md'] }
    }]
  };
  const CONFLICT = Symbol('external-markdown-conflict');
  const CHECK_FAILED = Symbol('external-markdown-check-failed');

  let handle = null;
  let tail = Promise.resolve();
  let pendingConnection = null;
  let phase = 'disconnected';
  let fileName = null;
  let lastSavedAt = null;
  let failedRecord = null;
  let conflictRecord = null;
  let conflictEpoch = 0;
  let activeConflictEpoch = null;
  let generation = 0;
  let forcing = false;
  let forcePromise = null;
  let importing = false;
  let importPromise = null;
  let importToken = null;
  let importApply = null;
  let onError = () => {};
  let onStatus = () => {};
  const expectedBytes = new WeakMap();
  const conflictTokens = new WeakMap();

  const safeName = (candidate) =>
    typeof candidate?.name === 'string' && candidate.name.trim()
      ? candidate.name
      : PICKER_OPTIONS.suggestedName;
  const wrapCheckFailure = (error) => Object.freeze({ marker: CHECK_FAILED, error });
  const isCheckFailure = (error) => error?.marker === CHECK_FAILED;
  const reportedError = (error) => isCheckFailure(error) ? error.error : error;
  const statusResult = (status) => Object.freeze({ status });

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
      saveError: activeFailure?.kind === 'write',
      checkError: activeFailure?.kind === 'check',
      conflict: hasConflict(),
      forcing,
      importing
    });
  }

  function publishState() {
    try {
      onStatus(getState());
    } catch (ignored) {
      // 상태 UI가 실패해도 파일 큐는 계속 돈다.
    }
  }

  function publish(nextPhase, nextName = fileName, nextSavedAt = lastSavedAt) {
    const changed = phase !== nextPhase || fileName !== nextName || lastSavedAt !== nextSavedAt;
    phase = nextPhase;
    fileName = nextName;
    lastSavedAt = nextSavedAt;
    if (changed) publishState();
    return changed;
  }

  function report(error) {
    try {
      onError(error);
    } catch (ignored) {
      // 알림 실패가 원래 저장 실패를 rejection으로 바꾸지 않게 한다.
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
        // abort 오류로 원래 오류를 가리지 않는다.
      }
      throw error;
    }
  }

  async function compareExpected(target) {
    if (typeof target?.getFile !== 'function' || !expectedBytes.has(target)) return 'unsupported';
    try {
      const current = await (await target.getFile()).text();
      return current === expectedBytes.get(target) ? 'unchanged' : 'conflict';
    } catch (error) {
      throw wrapCheckFailure(error);
    }
  }

  function enterConflict(target, text, recordGeneration) {
    if (target !== handle) return;
    const first = !hasConflict(target);
    if (first) activeConflictEpoch = ++conflictEpoch;
    conflictRecord = Object.freeze({ handle: target, text, generation: recordGeneration });
    failedRecord = null;
    if (first) publishState();
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

  const isSupported = () => typeof globalThis.showSaveFilePicker === 'function';

  async function connect(getSnapshot) {
    if (!isSupported()) return 'unsupported';
    if (pendingConnection !== null || forcing || importing) return 'busy';

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
        pending.latestText = MarkdownExport.render(snapshot);
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
        if (version === pending.version) {
          handle = candidate;
          failedRecord = null;
          conflictRecord = null;
          activeConflictEpoch = null;
          publish('connected', safeName(candidate), savedAt);
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

  function recordFailure(target, text, recordGeneration, error) {
    if (handle === target) {
      const kind = isCheckFailure(error) ? 'check' : 'write';
      const existing = failedRecord?.handle === target ? failedRecord : null;
      const first = existing === null || existing.kind !== kind;
      if (kind === 'check' && text === null && existing !== null && existing.text !== null) {
        if (existing.kind !== kind) {
          failedRecord = Object.freeze({
            handle: existing.handle,
            text: existing.text,
            generation: existing.generation,
            kind
          });
        }
      } else {
        failedRecord = Object.freeze({ handle: target, text, generation: recordGeneration, kind });
      }
      publishState();
      if (first) report(reportedError(error));
    } else {
      report(reportedError(error));
    }
  }

  function save(snapshot) {
    const currentHandle = handle;
    const pending = pendingConnection;
    if (currentHandle === null && pending === null) return Promise.resolve(false);

    const currentGeneration = ++generation;
    let text;
    try {
      text = MarkdownExport.render(snapshot);
    } catch (error) {
      if (pending !== null) {
        pending.invalid = true;
        pending.version += 1;
      }
      if (hasConflict(currentHandle)) {
        conflictRecord = Object.freeze({ handle: currentHandle, text: null, generation: currentGeneration });
        publishState();
        report(error);
      } else if (currentHandle !== null) {
        recordFailure(currentHandle, null, currentGeneration, error);
      } else {
        report(error);
      }
      return Promise.resolve(false);
    }

    if (pending !== null && !pending.invalid) {
      pending.latestText = text;
      pending.version += 1;
    }
    if (currentHandle === null) return pending.completion;
    if (hasConflict(currentHandle)) {
      conflictRecord = Object.freeze({ handle: currentHandle, text, generation: currentGeneration });
      return Promise.resolve(false);
    }

    return enqueueTask(async () => {
      if (hasConflict(currentHandle)) {
        conflictRecord = Object.freeze({ handle: currentHandle, text, generation: currentGeneration });
        return false;
      }
      try {
        const savedAt = await guardedWrite(currentHandle, text, currentGeneration);
        if (handle === currentHandle) {
          let cleared = false;
          if (failedRecord?.handle === currentHandle && failedRecord.generation <= currentGeneration) {
            failedRecord = null;
            cleared = true;
          }
          const changed = publish(phase, fileName, savedAt);
          if (cleared && !changed) publishState();
        }
        return true;
      } catch (error) {
        if (error === CONFLICT) return false;
        recordFailure(currentHandle, text, currentGeneration, error);
        return false;
      }
    });
  }

  function checkExternal() {
    if (handle === null) return Promise.resolve('disconnected');
    if (pendingConnection !== null || forcing || importing) return Promise.resolve('busy');
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
        if (
          failedRecord?.handle === checkedHandle &&
          failedRecord.kind === 'check' &&
          failedRecord.text === null
        ) {
          failedRecord = null;
          publishState();
        }
        return comparison;
      } catch (error) {
        recordFailure(checkedHandle, null, generation, error);
        return 'error';
      }
    });
  }

  function readConflict() {
    if (handle === null) return Promise.resolve(statusResult('disconnected'));
    if (!hasConflict()) return Promise.resolve(statusResult('not-conflict'));
    if (pendingConnection !== null || forcing || importing) return Promise.resolve(statusResult('busy'));
    const readHandle = handle;
    if (typeof readHandle.getFile !== 'function') return Promise.resolve(statusResult('unsupported'));

    return enqueueTask(async () => {
      if (handle !== readHandle || !hasConflict(readHandle)) return statusResult('stale');
      if (pendingConnection !== null || forcing || importing) return statusResult('busy');
      const readEpoch = activeConflictEpoch;
      try {
        const text = await (await readHandle.getFile()).text();
        if (
          handle !== readHandle || !hasConflict(readHandle) ||
          activeConflictEpoch !== readEpoch
        ) return statusResult('stale');
        const token = Object.freeze(Object.create(null));
        conflictTokens.set(token, Object.freeze({ handle: readHandle, text, epoch: readEpoch }));
        return Object.freeze({ status: 'ready', text, token });
      } catch (error) {
        report(error);
        return statusResult('error');
      }
    }).then((result) => result, (error) => {
      report(error);
      return statusResult('error');
    });
  }

  function isPlainSnapshot(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.prototype.toString.call(value) === '[object Object]';
  }

  function importConflict(token, apply) {
    if (importPromise !== null) {
      if (token === importToken && apply === importApply) return importPromise;
      return Promise.resolve(statusResult('busy'));
    }

    const tokenRecord = token !== null && (typeof token === 'object' || typeof token === 'function')
      ? conflictTokens.get(token)
      : null;
    if (tokenRecord === undefined || tokenRecord === null) return Promise.resolve(statusResult('stale'));
    if (
      handle !== tokenRecord.handle || !hasConflict(tokenRecord.handle) ||
      activeConflictEpoch !== tokenRecord.epoch
    ) {
      conflictTokens.delete(token);
      return Promise.resolve(statusResult('stale'));
    }
    if (pendingConnection !== null || forcing) return Promise.resolve(statusResult('busy'));

    const target = tokenRecord.handle;
    const targetEpoch = tokenRecord.epoch;
    conflictTokens.delete(token);
    importing = true;
    importToken = token;
    importApply = apply;
    publishState();

    const job = enqueueTask(async () => {
      if (
        handle !== target || !hasConflict(target) ||
        activeConflictEpoch !== targetEpoch
      ) return statusResult('stale');
      if (typeof target.getFile !== 'function') return statusResult('unsupported');

      let verifiedText;
      try {
        verifiedText = await (await target.getFile()).text();
      } catch (error) {
        report(error);
        return statusResult('error');
      }
      if (
        handle !== target || !hasConflict(target) ||
        activeConflictEpoch !== targetEpoch
      ) return statusResult('stale');
      if (verifiedText !== tokenRecord.text) return statusResult('changed');

      const generationBeforeApply = generation;
      let snapshot;
      try {
        snapshot = apply(verifiedText);
        if (snapshot !== null && (typeof snapshot === 'object' || typeof snapshot === 'function')) {
          let then;
          try {
            then = snapshot.then;
          } catch (error) {
            report(error);
            return statusResult('apply-error');
          }
          if (typeof then === 'function') return statusResult('apply-error');
        }
      } catch (error) {
        report(error);
        return statusResult('apply-error');
      }
      if (!isPlainSnapshot(snapshot)) return statusResult('apply-failed');

      let rendered;
      try {
        rendered = MarkdownExport.render(snapshot);
      } catch (error) {
        if (
          handle === target && hasConflict(target) &&
          activeConflictEpoch === targetEpoch
        ) {
          conflictRecord = Object.freeze({ handle: target, text: null, generation: ++generation });
        }
        publishState();
        report(error);
        return statusResult('applied-render-error');
      }

      if (
        handle !== target || !hasConflict(target) ||
        activeConflictEpoch !== targetEpoch
      ) return statusResult('stale');
      if (generation === generationBeforeApply) {
        conflictRecord = Object.freeze({ handle: target, text: rendered, generation: ++generation });
      }

      while (
        handle === target && hasConflict(target) &&
        activeConflictEpoch === targetEpoch
      ) {
        const record = conflictRecord;
        if (record.text === null) return statusResult('applied-render-error');
        let savedAt;
        try {
          // 명시적인 import 해결은 검증 직후의 최선형 write이며 CAS는 File API에 없다.
          savedAt = await writeFile(target, record.text);
        } catch (error) {
          report(error);
          return statusResult('applied-write-error');
        }
        if (
          handle === target && conflictRecord === record &&
          activeConflictEpoch === targetEpoch
        ) {
          conflictRecord = null;
          activeConflictEpoch = null;
          failedRecord = null;
          const changed = publish(phase, fileName, savedAt);
          if (!changed) publishState();
          return statusResult('imported');
        }
      }
      return statusResult('stale');
    });

    importPromise = job.then((result) => result, (error) => {
      report(error);
      return statusResult('error');
    }).then((result) => {
      importing = false;
      importPromise = null;
      importToken = null;
      importApply = null;
      publishState();
      return result;
    });
    return importPromise;
  }

  function forceOverwrite(getSnapshot) {
    if (importing) return Promise.resolve('busy');
    if (forcePromise !== null) return forcePromise;
    if (handle === null || !hasConflict()) return Promise.resolve(false);

    const forceHandle = handle;
    const forceEpoch = activeConflictEpoch;
    const forceGeneration = ++generation;
    let text;
    try {
      const snapshot = typeof getSnapshot === 'function' ? getSnapshot() : getSnapshot;
      text = MarkdownExport.render(snapshot);
    } catch (error) {
      conflictRecord = Object.freeze({ handle: forceHandle, text: null, generation: forceGeneration });
      publishState();
      report(error);
      return Promise.resolve(false);
    }
    conflictRecord = Object.freeze({ handle: forceHandle, text, generation: forceGeneration });
    forcing = true;
    publishState();

    const job = enqueueTask(async () => {
      while (
        handle === forceHandle && hasConflict(forceHandle) &&
        activeConflictEpoch === forceEpoch
      ) {
        const record = conflictRecord;
        if (record.text === null) return false;
        let savedAt;
        try {
          // 사용자의 명시적 해결이므로 외부 비교 없이 현재 앱 Markdown을 쓴다.
          savedAt = await writeFile(forceHandle, record.text);
        } catch (error) {
          report(error);
          return false;
        }
        if (
          handle === forceHandle && conflictRecord === record &&
          activeConflictEpoch === forceEpoch
        ) {
          conflictRecord = null;
          activeConflictEpoch = null;
          failedRecord = null;
          const changed = publish(phase, fileName, savedAt);
          if (!changed) publishState();
          return true;
        }
      }
      return false;
    });

    forcePromise = job.then((result) => result, () => false).then((result) => {
      forcing = false;
      forcePromise = null;
      publishState();
      return result;
    });
    return forcePromise;
  }

  function keepExternal() {
    if (handle === null || !hasConflict()) return Promise.resolve(false);
    if (forcing || importing || pendingConnection !== null) return Promise.resolve('busy');
    generation += 1;
    handle = null;
    failedRecord = null;
    conflictRecord = null;
    activeConflictEpoch = null;
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

  globalThis.MarkdownSync = Object.freeze({
    connect,
    save,
    checkExternal,
    readConflict,
    importConflict,
    forceOverwrite,
    keepExternal,
    isSupported,
    getState,
    setErrorHandler,
    setStatusHandler
  });
})();
