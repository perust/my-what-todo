/**
 * markdown-sync.js — 페이지 세션 한정 Markdown 연결과 실패 복구형 직렬 쓰기 큐.
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

  let handle = null;
  let tail = Promise.resolve();
  let pendingConnection = null;
  let phase = 'disconnected';
  let fileName = null;
  let lastSavedAt = null;
  let failedHandle = null;
  let onError = () => {};
  let onStatus = () => {};

  function getState() {
    return Object.freeze({
      phase,
      fileName,
      lastSavedAt,
      saveError: handle !== null && failedHandle === handle
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

  const safeName = (candidate) =>
    typeof candidate?.name === 'string' && candidate.name.trim()
      ? candidate.name
      : PICKER_OPTIONS.suggestedName;

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
        // abort 오류로 원래 오류를 가리지 않는다.
      }
      throw error;
    }
  }

  function enqueue(target, text) {
    const job = tail.then(() => writeFile(target, text));
    tail = job.catch(() => {});
    return job;
  }

  const isSupported = () => typeof globalThis.showSaveFilePicker === 'function';

  async function connect(getSnapshot) {
    if (!isSupported()) return 'unsupported';
    if (pendingConnection !== null) return 'busy';

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

      // picker/write를 기다리는 동안 save가 갱신한 latest text까지 candidate로 drain한다.
      while (true) {
        if (pending.invalid) {
          pending.finish(false);
          publish(handle === null ? 'disconnected' : 'connected');
          return 'error';
        }
        const version = pending.version;
        const text = pending.latestText;
        const savedAt = await enqueue(candidate, text);
        if (pending.invalid) {
          pending.finish(false);
          publish(handle === null ? 'disconnected' : 'connected');
          return 'error';
        }
        if (version === pending.version) {
          handle = candidate;
          failedHandle = null;
          publish('connected', safeName(candidate), savedAt);
          pending.finish(true);
          return 'connected';
        }
      }
    } catch (error) {
      pending.finish(false);
      publish(handle === null ? 'disconnected' : 'connected');
      if (!pending.invalid) report(error);
      return 'error';
    }
  }

  function save(snapshot) {
    const currentHandle = handle;
    const pending = pendingConnection;
    if (currentHandle === null && pending === null) return Promise.resolve(false);

    let text;
    try {
      // 호출 순간 render해 이후 snapshot mutation과 분리된 immutable string을 큐에 넣는다.
      text = MarkdownExport.render(snapshot);
    } catch (error) {
      if (pending !== null) {
        pending.invalid = true;
        pending.version += 1;
      }
      if (currentHandle !== null && handle === currentHandle) {
        const firstInEpisode = failedHandle !== currentHandle;
        failedHandle = currentHandle;
        publishState();
        if (firstInEpisode) report(error);
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

    return enqueue(currentHandle, text).then(
      (savedAt) => {
        if (handle === currentHandle) {
          const cleared = failedHandle === currentHandle;
          failedHandle = null;
          const changed = publish(phase, fileName, savedAt);
          if (cleared && !changed) publishState();
        }
        return true;
      },
      (error) => {
        if (handle === currentHandle) {
          const firstInEpisode = failedHandle !== currentHandle;
          failedHandle = currentHandle;
          publishState();
          if (firstInEpisode) report(error);
        } else {
          report(error);
        }
        return false;
      }
    );
  }

  function setErrorHandler(handler) {
    onError = typeof handler === 'function' ? handler : () => {};
  }

  function setStatusHandler(handler) {
    onStatus = typeof handler === 'function' ? handler : () => {};
    publishState();
  }

  globalThis.MarkdownSync = Object.freeze({
    connect, save, isSupported, getState, setErrorHandler, setStatusHandler
  });
})();
