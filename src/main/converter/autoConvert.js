'use strict';

// Automatic conversion: on a schedule, look for clips in the source folder
// that no earlier automatic run has handled and convert just those, with the
// settings saved when it was turned on. An optional time window pauses an
// automatic job outside the chosen hours and resumes it inside them.
//
// "Handled" clips are remembered in a small index per source/output setup
// (relative path -> size and modification time), so each check only stats
// files instead of re-inspecting the whole archive. In separate-output mode a
// clip whose converted copy already exists in the destination is also known.

const crypto = require('crypto');
const nodePath = require('path');

const INTERVAL_MINUTES = Object.freeze([15, 30, 60, 180, 360, 720, 1440]);
const SETTINGS_FILE = 'settings.json';
// Which job this feature paused for the time window (survives restarts, so a
// job the user paused themselves is never resumed automatically).
const STATE_FILE = 'state.json';
const MAX_FAILED_SWEEPS = 3;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  intervalMinutes: 60,
  window: null,
  keepRunning: false,
  openAtLogin: false,
  config: null
});

function autoError(code) {
  return Object.assign(new Error(code), { code });
}

function isHour(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 23;
}

function normalizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw autoError('INVALID_AUTO_SETTINGS');
  const settings = {
    enabled: value.enabled === true,
    intervalMinutes: INTERVAL_MINUTES.includes(value.intervalMinutes) ? value.intervalMinutes : DEFAULT_SETTINGS.intervalMinutes,
    window: null,
    keepRunning: value.keepRunning === true,
    openAtLogin: value.openAtLogin === true,
    config: value.config && typeof value.config === 'object' && !Array.isArray(value.config) ? { ...value.config } : null
  };
  if (value.window !== null && value.window !== undefined) {
    if (!isHour(value.window.startHour) || !isHour(value.window.endHour)
        || value.window.startHour === value.window.endHour) throw autoError('INVALID_AUTO_WINDOW');
    settings.window = { startHour: value.window.startHour, endHour: value.window.endHour };
  }
  if (settings.enabled && !settings.config) throw autoError('AUTO_CONFIG_REQUIRED');
  return settings;
}

// Inside [start, end) with wrap-around past midnight (e.g. 22 -> 6).
function inWindow(window, hour) {
  if (!window) return true;
  return window.startHour < window.endHour
    ? hour >= window.startHour && hour < window.endHour
    : hour >= window.startHour || hour < window.endHour;
}

function setupKey(config) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([config.sourceRoot, config.destinationRoot, config.codec, config.outputMode]))
    .digest('hex').slice(0, 24);
}

function createAutoConverter(options = {}) {
  const { service, scanner, fs, directory } = options;
  const pathApi = options.pathApi || nodePath;
  const now = options.now || Date.now;
  const hourOf = options.hourOf || ((ms) => new Date(ms).getHours());
  const isBusy = options.isBusy || (async () => false);
  const tickMs = options.tickMs || 30_000;
  const timers = options.timers || { setInterval, clearInterval };
  const onChange = options.onChange || (() => {});
  if (!service || typeof scanner !== 'function' || !fs || typeof directory !== 'string') {
    throw new TypeError('service, scanner, fs and directory are required');
  }

  let settings = { ...DEFAULT_SETTINGS };
  const status = {
    lastCheckAt: null, nextCheckAt: null, lastNewFiles: null, lastJobId: null,
    activeJobId: null, pausedForWindow: false, checking: false, error: null
  };
  const indexes = new Map(); // setup key -> { files: Map, failures: Map, dirty }
  let timer = null;
  let ticking = null;
  let sweepAbort = null;

  async function writeJson(name, value) {
    await fs.mkdir(directory, { recursive: true });
    const target = pathApi.join(directory, name);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value));
    await fs.rename(temporary, target);
  }

  async function readJson(name) {
    try { return JSON.parse(await fs.readFile(pathApi.join(directory, name), 'utf8')); } catch (_) { return null; }
  }

  async function loadIndex(config) {
    const key = setupKey(config);
    if (!indexes.has(key)) {
      const stored = await readJson(`index-${key}.json`);
      const files = new Map();
      if (stored && stored.files && typeof stored.files === 'object') {
        for (const [relativePath, entry] of Object.entries(stored.files)) {
          if (Array.isArray(entry) && entry.length === 2) files.set(relativePath, entry);
        }
      }
      const failures = new Map(Object.entries(stored?.failures || {}).filter(([, count]) => Number.isSafeInteger(count)));
      indexes.set(key, { key, files, failures, dirty: false });
    }
    return indexes.get(key);
  }

  async function saveIndex(index) {
    if (!index.dirty) return;
    await writeJson(`index-${index.key}.json`, {
      v: 1, files: Object.fromEntries(index.files), failures: Object.fromEntries(index.failures)
    });
    index.dirty = false;
  }

  function remember(index, relativePath, size, mtimeMs) {
    index.files.set(relativePath, [size, mtimeMs]);
    index.failures.delete(relativePath);
    index.dirty = true;
  }

  function knownIn(index, discovered) {
    const entry = index.files.get(discovered.relativePath);
    return Boolean(entry) && entry[0] === discovered.sourceBytes && entry[1] === discovered.mtimeMs;
  }

  // Used by the job service while an automatic job discovers files.
  function isKnown(config, discovered) {
    if (config?.autoConvert !== true) return false;
    const index = indexes.get(setupKey(config));
    return Boolean(index) && knownIn(index, discovered);
  }

  async function destinationExists(config, discovered) {
    if (config.outputMode !== 'separate' || !config.destinationRoot) return false;
    try {
      const target = pathApi.resolve(config.destinationRoot, ...discovered.relativePath.split('/'));
      const stat = await fs.stat(target);
      return stat.isFile() && stat.size > 0;
    } catch (_) {
      return false;
    }
  }

  async function sweep(config) {
    const index = await loadIndex(config);
    const controller = new AbortController();
    sweepAbort = controller;
    let newFiles = 0;
    try {
      for await (const discovered of scanner(config, { signal: controller.signal })) {
        if (knownIn(index, discovered)) continue;
        if (await destinationExists(config, discovered)) {
          remember(index, discovered.relativePath, discovered.sourceBytes, discovered.mtimeMs);
          continue;
        }
        newFiles += 1;
      }
    } finally {
      if (sweepAbort === controller) sweepAbort = null;
    }
    await saveIndex(index);
    return newFiles;
  }

  async function recordFinishedJob(job) {
    const index = await loadIndex(job.config);
    for (const item of job.items || []) {
      if (item.state === 'completed' || item.state === 'skipped') {
        if (job.config.outputMode === 'replace' && item.state === 'completed') {
          // The original was replaced: remember the converted file now there.
          try {
            const stat = await fs.stat(item.sourcePath);
            remember(index, item.relativePath, Number(stat.size), Number(stat.mtimeMs));
          } catch (_) { /* re-examined next time */ }
        } else {
          remember(index, item.relativePath, item.sourceBytes, item.mtimeMs);
        }
      } else if (item.state === 'failed') {
        const count = (index.failures.get(item.relativePath) || 0) + 1;
        // Stop retrying a clip that keeps failing; it stays listed as failed.
        if (count >= MAX_FAILED_SWEEPS) remember(index, item.relativePath, item.sourceBytes, item.mtimeMs);
        else { index.failures.set(item.relativePath, count); index.dirty = true; }
      }
    }
    await saveIndex(index);
  }

  async function setPausedForWindow(jobId) {
    status.pausedForWindow = Boolean(jobId);
    try { await writeJson(STATE_FILE, { pausedForWindowJobId: jobId || null }); } catch (_) { /* best effort */ }
  }

  function changed() {
    try { onChange(getState()); } catch (_) { /* observers are advisory */ }
  }

  async function followActiveJob(insideWindow) {
    let job;
    try { job = await service.get(status.activeJobId); } catch (_) { job = null; }
    if (!job) {
      status.activeJobId = null;
      if (status.pausedForWindow) await setPausedForWindow(null);
      return;
    }
    if (TERMINAL.has(job.state)) {
      await recordFinishedJob(job);
      status.activeJobId = null;
      if (status.pausedForWindow) await setPausedForWindow(null);
      changed();
      return;
    }
    // Turned off: no more automatic pausing or resuming; the job stays as it
    // is for the user to resume or cancel (finished clips are still recorded).
    if (!settings.enabled) return;
    if (!insideWindow && !status.pausedForWindow && job.state !== 'paused') {
      await service.pause(job.id);
      await setPausedForWindow(job.id);
      changed();
    } else if (insideWindow && status.pausedForWindow) {
      if (job.state === 'paused') await service.resume(job.id);
      await setPausedForWindow(null);
      changed();
    }
  }

  async function tickOnce() {
    const time = now();
    const insideWindow = inWindow(settings.window, hourOf(time));
    if (status.activeJobId) {
      await followActiveJob(insideWindow);
      if (status.activeJobId) return;
    }
    if (!settings.enabled || !settings.config || !insideWindow) return;
    if (status.nextCheckAt !== null && time < status.nextCheckAt) return;
    if (await isBusy()) return;
    status.checking = true;
    status.error = null;
    changed();
    try {
      const newFiles = await sweep(settings.config);
      status.lastCheckAt = now();
      status.lastNewFiles = newFiles;
      if (newFiles > 0 && settings.enabled) {
        const jobId = await service.start({ ...settings.config, autoConvert: true });
        status.activeJobId = jobId;
        status.lastJobId = jobId;
      }
    } catch (error) {
      if (error?.code === 'JOB_ACTIVE') {
        // Another conversion started while this check ran: not a failure;
        // check again as soon as it is finished.
        status.checking = false;
        status.nextCheckAt = null;
        changed();
        return;
      }
      status.error = typeof error?.code === 'string' ? error.code : 'AUTO_CHECK_FAILED';
      status.lastCheckAt = now();
    } finally {
      if (status.checking) {
        status.checking = false;
        status.nextCheckAt = status.lastCheckAt + settings.intervalMinutes * 60_000;
        changed();
      }
    }
  }

  function tick() {
    if (!ticking) {
      ticking = tickOnce().catch((error) => {
        status.error = typeof error?.code === 'string' ? error.code : 'AUTO_CHECK_FAILED';
      }).finally(() => { ticking = null; });
    }
    return ticking;
  }

  function getState() {
    return { settings: JSON.parse(JSON.stringify(settings)), status: { ...status } };
  }

  return Object.freeze({
    isKnown,
    getState,
    tick,
    async start() {
      const stored = await readJson(SETTINGS_FILE);
      try { if (stored) settings = normalizeSettings(stored); } catch (_) { settings = { ...DEFAULT_SETTINGS }; }
      if (settings.config) await loadIndex(settings.config);
      // Adopt an automatic job that was still running when the app closed.
      try {
        const jobs = await service.list();
        const running = jobs.find((job) => job.config?.autoConvert === true && !TERMINAL.has(job.state));
        if (running) {
          await loadIndex(running.config);
          status.activeJobId = running.id;
          // Only a pause this feature made is undone automatically.
          const saved = await readJson(STATE_FILE);
          status.pausedForWindow = running.state === 'paused' && saved?.pausedForWindowJobId === running.id;
        }
      } catch (_) { /* nothing to adopt */ }
      if (!timer) {
        timer = timers.setInterval(() => { void tick(); }, tickMs);
        timer?.unref?.(); // never keeps the app (or a test) alive on its own
      }
      void tick();
      return getState();
    },
    async configure(next) {
      const normalized = normalizeSettings(next);
      if (normalized.config) await loadIndex(normalized.config);
      const configChanged = JSON.stringify(normalized.config) !== JSON.stringify(settings.config);
      settings = normalized;
      await writeJson(SETTINGS_FILE, settings);
      if (configChanged || !settings.enabled) status.nextCheckAt = null; // check soon with new settings
      changed();
      void tick();
      return getState();
    },
    async checkNow() {
      status.nextCheckAt = null;
      await tick();
      return getState();
    },
    stop() {
      if (timer) timers.clearInterval(timer);
      timer = null;
      sweepAbort?.abort();
    }
  });
}

module.exports = { createAutoConverter, INTERVAL_MINUTES, inWindow };
