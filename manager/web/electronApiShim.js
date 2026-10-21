// window.electronAPI for the Sentry Studio renderer running as a web page
// inside Sentry Six Manager. Same method names and return shapes as
// src/preload.js; calls go to the Sentry Six Manager server over HTTP, and
// converter progress arrives over Server-Sent Events.
//
// URL parameters (set by the manager shell):
//   embed=encoder|viewer   encoder: open the Converter panel, hide the rest
//   root=/footage/<car>    folder the viewer loads on start
//   folder=/footage/<car>/TeslaCam/SentryClips/<event>   open this folder instead
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const embed = params.get('embed') || 'viewer';
  const startFolder = params.get('folder') || params.get('root') || null;
  document.documentElement.dataset.embed = embed;

  const clientId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 64);
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'sentry-six-manager', 'X-Client-Id': clientId };

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers, body: body === undefined ? '' : JSON.stringify(body), credentials: 'same-origin' });
    if (res.status === 401) {
      top.location.href = '/login';
      throw new Error('Signed out');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(data?.error || res.statusText), { status: res.status });
    return data;
  }

  // ---- settings: server copy plus web defaults (no update checks, no Sentry Six API calls)
  const WEB_DEFAULTS = {
    acceptedPrivacyVersion: 2, firstRunComplete: true, welcomeGuideCompleted: true,
    disableAutoUpdate: true, devDisableApiRequests: true
  };
  let contextPromise = null;
  const context = () => (contextPromise ||= fetch('/api/studio/context', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({})));
  let settingsPromise = null;
  const settings = () => (settingsPromise ||= fetch('/api/studio/settings', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({})));

  // ---- converter: invoke + live progress
  const invoke = (name, payload) => post(`/api/converter/invoke/${name}`, payload).catch((err) => ({ ok: false, error: { code: err.status === 401 ? 'SIGNED_OUT' : 'NETWORK_ERROR' } }));
  const converterListeners = { 'converter:progress': new Set(), 'converter:benchmarkProgress': new Set() };
  let source = null;
  let subscribed = false;
  function ensureEvents() {
    if (source) return;
    source = new EventSource(`/api/converter/events?client=${encodeURIComponent(clientId)}`);
    for (const ch of Object.keys(converterListeners)) {
      source.addEventListener(ch, (e) => {
        let payload;
        try {
          payload = JSON.parse(e.data);
        } catch {
          return;
        }
        for (const fn of converterListeners[ch]) fn(payload);
      });
    }
    // After a reconnect the server has a new sender: subscribe again.
    source.addEventListener('hello', () => {
      if (subscribed) invoke('subscribeProgress');
    });
  }
  const waitOpen = () => new Promise((resolve) => {
    if (source.readyState === 1) return resolve();
    const done = () => resolve();
    source.addEventListener('open', done, { once: true });
    setTimeout(done, 3000);
  });

  // ---- folder / file picker (a small modal inside this page)
  function picker({ title, startPath, files = false, extensions = [] }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'sm-picker';
      wrap.innerHTML = `<div class="sm-picker-box" role="dialog" aria-modal="true" aria-label="${title}">
        <div class="sm-picker-head"><strong></strong><button type="button" class="sm-picker-x" aria-label="Close">✕</button></div>
        <div class="sm-picker-path"></div>
        <ul class="sm-picker-list"></ul>
        <div class="sm-picker-foot"><button type="button" class="sm-picker-cancel">Cancel</button><button type="button" class="sm-picker-ok">Select this folder</button></div>
      </div>`;
      wrap.querySelector('strong').textContent = title;
      const list = wrap.querySelector('.sm-picker-list');
      const pathEl = wrap.querySelector('.sm-picker-path');
      const ok = wrap.querySelector('.sm-picker-ok');
      if (files) ok.style.display = 'none';
      let current = null;
      const close = (value) => {
        wrap.remove();
        resolve(value);
      };
      async function show(p) {
        list.innerHTML = '<li class="sm-picker-empty">Loading…</li>';
        let data;
        try {
          data = await post('/api/studio/browse', { path: p || null });
        } catch (err) {
          list.innerHTML = '';
          const li = document.createElement('li');
          li.className = 'sm-picker-empty';
          li.textContent = err.message;
          list.append(li);
          return;
        }
        current = data.path;
        pathEl.textContent = current || 'Vehicle shares';
        ok.disabled = !current;
        list.innerHTML = '';
        const add = (label, target, cls, onClick) => {
          const li = document.createElement('li');
          const b = document.createElement('button');
          b.type = 'button';
          b.className = cls;
          b.textContent = label;
          b.title = target || '';
          b.addEventListener('click', onClick);
          li.append(b);
          list.append(li);
        };
        if (current) add('⬑ Up', data.parent, 'sm-up', () => show(data.parent));
        for (const e of data.entries) add(`📁 ${e.name}`, e.path, 'sm-dir', () => show(e.path));
        if (files && current) {
          const entries = await post('/api/studio/readDir', { path: current }).catch(() => []);
          for (const f of entries.filter((x) => x.isFile && (!extensions.length || extensions.some((ext) => x.name.toLowerCase().endsWith(`.${ext}`))))) {
            add(`📄 ${f.name}`, f.path, 'sm-file', () => close(f.path));
          }
        }
        if (!list.children.length) list.innerHTML = '<li class="sm-picker-empty">No folders here.</li>';
      }
      wrap.querySelector('.sm-picker-x').addEventListener('click', () => close(null));
      wrap.querySelector('.sm-picker-cancel').addEventListener('click', () => close(null));
      ok.addEventListener('click', () => close(current));
      wrap.addEventListener('keydown', (e) => e.key === 'Escape' && close(null));
      document.body.append(wrap);
      show(startPath || null);
    });
  }

  const notAvailable = (what) => ({ success: false, error: `${what} is not available in the web version.` });
  const toShell = (msg) => {
    try {
      if (window.parent !== window) window.parent.postMessage({ source: 'sentry-studio', ...msg }, location.origin);
    } catch {
      // standalone
    }
  };

  const listeners = new Map();
  window.electronAPI = {
    openFolder: (startPath) => picker({ title: 'Choose a folder', startPath }),
    openFile: (filters) => picker({ title: 'Choose a file', files: true, extensions: (filters || []).flatMap((f) => f.extensions || []) }),
    openExternal: (url) => {
      window.open(url, '_blank', 'noopener');
      return Promise.resolve();
    },
    readDir: (dirPath) => post('/api/studio/readDir', { path: dirPath }).catch(() => []),
    readFile: async (filePath) => (await post('/api/studio/readFile', { path: filePath })).text,
    exists: (filePath) => post('/api/studio/exists', { path: filePath }).catch(() => false),
    stat: (filePath) => post('/api/studio/stat', { path: filePath }).catch(() => null),
    getClipThumbnail: (filePath) => post('/api/studio/thumbnail', { path: filePath }).catch(() => null),
    showItemInFolder: (filePath) => {
      toShell({ type: 'showInFolder', path: filePath });
      return Promise.resolve();
    },
    deleteFolder: (folderPath) => post('/api/studio/trashFolder', { path: folderPath }).catch((err) => ({ success: false, error: err.message })),
    deleteFolderWithReload: async (folderPath, baseFolderPath) => {
      const result = await post('/api/studio/trashFolder', { path: folderPath }).catch((err) => ({ success: false, error: err.message }));
      try {
        sessionStorage.setItem('sm-pending-delete', JSON.stringify({ ...result, folderPath, baseFolderPath }));
      } catch {
        // ignore
      }
      location.reload();
      return result;
    },
    checkPendingDelete: async () => {
      try {
        const v = sessionStorage.getItem('sm-pending-delete');
        sessionStorage.removeItem('sm-pending-delete');
        if (v) return { hasPending: true, ...JSON.parse(v) };
      } catch {
        // ignore
      }
      return { hasPending: false };
    },
    loadSentryUsbDrives: async () => notAvailable('Sentry USB drive data'),
    getSentryUsbDriveDetail: async () => null,
    clearSentryUsbDrives: async () => ({ success: true }),
    reverseGeocode: async () => null,

    saveFile: async () => null,
    startExport: async () => notAvailable('Export'),
    cancelExport: async () => ({ success: true }),
    checkFFmpeg: async () => ({ available: false, webVersion: true }),

    chooseConverterFolder: async (purpose, defaultPath) => {
      const chosen = await picker({ title: purpose === 'destination' ? 'Choose the destination folder' : 'Choose the folder to convert', startPath: defaultPath });
      if (!chosen) return { ok: true, value: null };
      return invoke('chooseFolder', { purpose, defaultPath: chosen });
    },
    startConverter: (config) => invoke('start', config),
    getCurrentConverterJob: () => invoke('getCurrent'),
    pauseConverter: (jobId) => invoke('pause', { jobId }),
    resumeConverter: (jobId) => invoke('resume', { jobId }),
    cancelConverter: (jobId) => invoke('cancel', { jobId }),
    discardConverterJob: (jobId) => invoke('discard', { jobId }),
    retryFailedConverter: (jobId) => invoke('retryFailed', { jobId }),
    dismissConverterSummary: (jobId) => invoke('dismissSummary', { jobId }),
    getConverterCapabilities: () => invoke('getCapabilities'),
    runConverterBenchmark: async (request, onProgress) => {
      ensureEvents();
      await waitOpen();
      const fn = (p) => typeof onProgress === 'function' && onProgress(p);
      converterListeners['converter:benchmarkProgress'].add(fn);
      try {
        return await post('/api/converter/invoke/runBenchmark', request).catch(() => ({ ok: false, error: { code: 'NETWORK_ERROR' } }));
      } finally {
        converterListeners['converter:benchmarkProgress'].delete(fn);
      }
    },
    cancelConverterBenchmark: () => invoke('cancelBenchmark'),
    getConverterAuto: () => invoke('getAuto'),
    setConverterAuto: (s) => invoke('setAuto', s),
    checkConverterAutoNow: () => invoke('checkAutoNow'),
    onConverterProgress: (callback) => {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      ensureEvents();
      const set = converterListeners['converter:progress'];
      set.add(callback);
      if (set.size === 1) {
        subscribed = true;
        waitOpen().then(() => invoke('subscribeProgress'));
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        set.delete(callback);
        if (set.size === 0) {
          subscribed = false;
          invoke('unsubscribeProgress');
        }
      };
    },

    getShareConfig: async () => ({ enabled: false }),
    reserveShareCode: async () => notAvailable('Clip sharing'),
    uploadShareClip: async () => notAvailable('Clip sharing'),
    getSharedClips: async () => [],
    syncSharedClips: async () => [],
    deleteSharedClip: async () => notAvailable('Clip sharing'),

    checkForUpdates: async () => ({ updateAvailable: false }),
    installUpdate: async () => ({ success: false }),
    installAndRestart: async () => ({ success: false }),
    skipUpdate: async () => ({ success: true }),
    exitApp: async () => ({ success: false }),
    getChangelog: async () => null,
    getUpdateChannel: async () => 'stable',
    setUpdateChannel: async () => ({ success: false }),
    devOpenDevTools: async () => {}, devResetSettings: async () => {}, devForceLatestVersion: async () => {}, devSetOldVersion: async () => {},
    devGetCurrentVersion: async () => ({ version: (await context()).version || 'web' }), devGetAppPaths: async () => ({}), devReloadApp: async () => location.reload(),
    devCheckPrerelease: async () => null, devInstallPrerelease: async () => ({ success: false }),

    getSetting: async (key) => {
      // The Encoder tab never loads footage into the viewer behind it.
      if (key === 'defaultFolder') return embed === 'encoder' ? null : startFolder;
      // The Encoder tab has no visible map: use OpenStreetMap there so Studio
      // does not probe Google Maps and show its fallback notice over the form.
      if (key === 'mapTileProvider' && embed === 'encoder') return 'osm';
      const all = await settings();
      if (Object.prototype.hasOwnProperty.call(all, key)) return all[key];
      return WEB_DEFAULTS[key];
    },
    setSetting: async (key, value) => {
      if (key === 'defaultFolder') return true; // chosen by the manager per vehicle
      const all = await settings();
      all[key] = value;
      await post('/api/studio/settings', { key, value }).catch(() => {});
      return true;
    },
    relaunchApp: async () => location.reload(),
    notifyMapProviderFallback: () => {},
    isMas: true,
    getSystemInfo: async () => ({ platform: 'web', userAgent: navigator.userAgent }),
    getDiagnostics: async () => ({ platform: 'web' }),
    createSupportTicket: async () => notAvailable('Support chat'),
    sendSupportMessage: async () => notAvailable('Support chat'),
    uploadSupportMedia: async () => notAvailable('Support chat'),
    fetchSupportMessages: async () => ({ success: false, messages: [] }),
    closeSupportTicket: async () => ({ success: false }),
    markSupportRead: async () => ({ success: false }),

    on: (channel, callback) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(callback);
    },
    off: (channel, callback) => listeners.get(channel)?.delete(callback),
    removeAllListeners: (channel) => listeners.delete(channel)
  };

  // Telemetry checks can never be Off in Sentry Six Manager (insurance requirement;
  // the server upgrades Off to Quick as well), so the choice is removed.
  window.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('converterVerifyMode');
    select?.querySelector('option[value="off"]')?.remove();
    if (select && !select.value) select.value = 'quick';
  });

  // Viewer tab: paused while you are on another tab, through Studio's own
  // play / pause button so its state stays right. Playback that starts while
  // away (autoplay after loading, the next clip) is stopped as well.
  if (embed === 'viewer') {
    let away = false;
    const pause = () => {
      const btn = document.getElementById('playBtn');
      const playing = [...document.querySelectorAll('#videoMain, .tile-video')].some((v) => !v.paused && !v.ended);
      if (playing && btn && !btn.disabled) btn.click();
    };
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      if (e.data?.type === 'pause') {
        away = true;
        pause();
      } else if (e.data?.type === 'shown') away = false;
    });
    document.addEventListener('play', () => { if (away) setTimeout(pause, 0); }, true);
  }

  // Encoder tab: open the Converter panel as soon as the Studio UI is built.
  if (embed === 'encoder') {
    // "Review conversion" in Footage hands over that vehicle's folder as the source.
    const useSource = (folder) => {
      const input = document.getElementById('converterSourcePath');
      const busy = document.getElementById('converterChooseSource')?.hidden;
      if (!input || !folder || busy) return;
      input.value = folder;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const open = () => {
      const tab = document.querySelector('[data-panel="converter"]');
      if (!tab) return setTimeout(open, 100);
      tab.click();
      // after the converter has shown its last job's folders
      if (params.get('source')) setTimeout(() => useSource(params.get('source')), 1500);
      return undefined;
    };
    window.addEventListener('DOMContentLoaded', () => setTimeout(open, 0));
    window.addEventListener('message', (e) => {
      if (e.origin === location.origin && e.source === window.parent && e.data?.type === 'use-source') useSource(e.data.folder);
    });
  }
})();
