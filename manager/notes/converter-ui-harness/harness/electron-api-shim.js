// Browser stand-in for src/preload.js: window.electronAPI backed by
// fetch (ipcRenderer.invoke) + EventSource (ipcRenderer.on).
// The converter block below is preload.js lines 37-81 copied verbatim; only
// `ipcRenderer` changes. footageConverter.js is loaded unmodified.
(function () {
  'use strict';

  // ------------------------------------------------ ipcRenderer over HTTP
  const clientId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, '');
  const channelListeners = new Map(); // channel -> Set(wrapper)
  let source = null;

  function ensureEvents() {
    if (source) return;
    source = new EventSource(`/api/events?client=${encodeURIComponent(clientId)}`);
    for (const channel of ['converter:progress', 'converter:benchmarkProgress']) {
      source.addEventListener(channel, (message) => {
        let payload;
        try { payload = JSON.parse(message.data); } catch (_) { return; }
        for (const wrapper of [...(channelListeners.get(channel) || [])]) {
          try { wrapper({ sender: null }, payload); } catch (error) { console.error(error); }
        }
      });
    }
  }

  const ipcRenderer = {
    async invoke(channel, payload) {
      ensureEvents();
      try {
        const response = await fetch(`/api/ipc/${encodeURIComponent(channel)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sentry-client': clientId },
          body: JSON.stringify(payload === undefined ? {} : { payload })
        });
        return await response.json(); // already the { ok, value | error } envelope from ipc.js
      } catch (_) {
        return { ok: false, error: { code: 'NETWORK_UNAVAILABLE', retryable: true } };
      }
    },
    on(channel, wrapper) {
      ensureEvents();
      if (!channelListeners.has(channel)) channelListeners.set(channel, new Set());
      channelListeners.get(channel).add(wrapper);
    },
    removeListener(channel, wrapper) { channelListeners.get(channel)?.delete(wrapper); }
  };

  // ------------------------------------------- web folder picker (new UI)
  // Desktop uses dialog.showOpenDialog in the main process. The web build
  // picks in the page, then sends the choice as defaultPath; the server's
  // dialog adapter returns it and ipc.js validates/canonicalizes it.
  function pickFolder(purpose, startPath) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'converter-benchmark-dialog web-folder-picker';
      dialog.innerHTML = `<h3>${purpose === 'source' ? 'Choose source folder' : 'Choose destination folder'}</h3>
        <p class="converter-disclosure">Folders on the server (mounted shares).</p>
        <div class="converter-path-control" style="margin:10px 0"><input readonly data-path></div>
        <div data-list class="converter-order-list" style="max-height:300px;overflow:auto"></div>
        <div class="converter-benchmark-actions">
          <button type="button" class="converter-benchmark-action" data-cancel>Cancel</button>
          <button type="button" class="converter-benchmark-action primary" data-choose>Choose this folder</button>
        </div>`;
      document.body.append(dialog);
      let current = startPath || '/';
      const finish = (value) => { dialog.close(); dialog.remove(); resolve(value); };
      async function show(at) {
        const response = await fetch(`/api/fs/dirs?path=${encodeURIComponent(at)}`).then((r) => r.json()).catch(() => null);
        const value = response?.value;
        if (!value) return;
        current = value.path;
        dialog.querySelector('[data-path]').value = current;
        const list = dialog.querySelector('[data-list]');
        list.replaceChildren(...[value.parent ? ['..', value.parent] : null, ...value.dirs.map((d) => [d.split('/').pop(), d])]
          .filter(Boolean).map(([label, target]) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'converter-order-row';
            row.style.cssText = 'width:100%;text-align:left;cursor:pointer;color:inherit';
            row.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;color:var(--accent-color)">folder</span><span class="converter-order-name"></span><span></span>';
            row.querySelector('.converter-order-name').textContent = label;
            row.addEventListener('click', () => show(target));
            return row;
          }));
        dialog.querySelector('[data-choose]').disabled = current === '/';
      }
      dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
      dialog.querySelector('[data-choose]').addEventListener('click', () => finish(current));
      dialog.addEventListener('cancel', () => finish(null));
      dialog.showModal();
      void show(startPath && startPath !== '/' ? startPath : '/');
    });
  }

  let converterProgressListenerCount = 0;
  const converterApi = {
    chooseConverterFolder: async (purpose, defaultPath) => {
      const picked = await pickFolder(purpose, defaultPath);
      if (!picked) return { ok: true, value: null };
      return ipcRenderer.invoke('converter:chooseFolder', { purpose, defaultPath: picked });
    },
    // ---- verbatim from src/preload.js (lines 41-81) ----
    startConverter: (config) => ipcRenderer.invoke('converter:start', config),
    getCurrentConverterJob: () => ipcRenderer.invoke('converter:getCurrent'),
    pauseConverter: (jobId) => ipcRenderer.invoke('converter:pause', { jobId }),
    resumeConverter: (jobId) => ipcRenderer.invoke('converter:resume', { jobId }),
    cancelConverter: (jobId) => ipcRenderer.invoke('converter:cancel', { jobId }),
    discardConverterJob: (jobId) => ipcRenderer.invoke('converter:discard', { jobId }),
    retryFailedConverter: (jobId) => ipcRenderer.invoke('converter:retryFailed', { jobId }),
    dismissConverterSummary: (jobId) => ipcRenderer.invoke('converter:dismissSummary', { jobId }),
    getConverterCapabilities: () => ipcRenderer.invoke('converter:getCapabilities'),
    runConverterBenchmark: async (request, onProgress) => {
      const wrapper = (_event, progress) => { if (typeof onProgress === 'function') onProgress(progress); };
      ipcRenderer.on('converter:benchmarkProgress', wrapper);
      try {
        return await ipcRenderer.invoke('converter:runBenchmark', request);
      } finally {
        ipcRenderer.removeListener('converter:benchmarkProgress', wrapper);
      }
    },
    cancelConverterBenchmark: () => ipcRenderer.invoke('converter:cancelBenchmark'),
    getConverterAuto: () => ipcRenderer.invoke('converter:getAuto'),
    setConverterAuto: (settings) => ipcRenderer.invoke('converter:setAuto', settings),
    checkConverterAutoNow: () => ipcRenderer.invoke('converter:checkAutoNow'),
    onConverterProgress: (callback) => {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      const wrapper = (_event, payload) => callback(payload);
      let subscribed = true;
      ipcRenderer.on('converter:progress', wrapper);
      converterProgressListenerCount += 1;
      if (converterProgressListenerCount === 1) {
        void Promise.resolve(ipcRenderer.invoke('converter:subscribeProgress')).catch(() => {});
      }
      return () => {
        if (!subscribed) return;
        subscribed = false;
        ipcRenderer.removeListener('converter:progress', wrapper);
        converterProgressListenerCount -= 1;
        if (converterProgressListenerCount === 0) {
          void Promise.resolve(ipcRenderer.invoke('converter:unsubscribeProgress')).catch(() => {});
        }
      };
    }
  };

  // ------------------------- harness-only stand-ins for the rest of the app
  const settings = { firstRunComplete: true, acceptedPrivacyVersion: 99, welcomeGuideCompleted: true, language: 'en', disableAutoUpdate: true };
  const layout = new URLSearchParams(location.search).get('layout');
  if (layout) settings.layoutStyle = layout; // 'classic' = docked sidebar, default 'modern' = floating panel
  const rest = {
    getSetting: async (key) => (key in settings ? settings[key] : null),
    setSetting: async (key, value) => { settings[key] = value; return true; },
    on() {}, off() {}, removeAllListeners() {},
    isMas: false,
    checkForUpdates: async () => ({ updateAvailable: false }),
    getChangelog: async () => null,
    checkPendingDelete: async () => ({ hasPending: false }),
    devGetCurrentVersion: async () => ({ version: '2026.10.0-ai-testing' }),
    getSystemInfo: async () => ({}),
    getDiagnostics: async () => ({}),
    checkFFmpeg: async () => ({ available: true }),
    readDir: async () => [],
    getUpdateChannel: async () => 'stable'
  };
  const api = { ...rest, ...converterApi };
  window.electronAPI = new Proxy(api, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
      return async () => null; // any other desktop-only method
    }
  });
  window.__converterHarness = { clientId };
})();
