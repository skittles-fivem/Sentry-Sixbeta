'use strict';
// Realistic converter job snapshots, shaped like jobStore manifests
// (src/main/converter/jobStore.js TOP_FIELDS / ITEM_FIELDS / COUNTER_FIELDS).

const GROUPS = ['RecentClips', 'SavedClips', 'SentryClips'];
const CAMERAS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
const SOURCE_ROOT = '/footage/TeslaCam';
const DEST_ROOT = '/converted/TeslaCam';

function baseConfig(overrides = {}) {
  return {
    sourceRoot: SOURCE_ROOT,
    destinationRoot: DEST_ROOT,
    codec: 'h265',
    profileId: 'balanced',
    networkMode: 'auto',
    outputMode: 'separate',
    includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
    groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
    replacementConfirmed: false,
    concurrency: 5,
    verifyMode: 'quick',
    ...overrides
  };
}

function pad(n) { return String(n).padStart(2, '0'); }

// One Tesla event folder = 6 cameras per minute-clip.
function makeItems(count, assign) {
  const items = [];
  const start = Date.UTC(2026, 9, 18, 14, 2, 0);
  let index = 0;
  for (let e = 0; items.length < count; e += 1) {
    const group = ['SavedClips', 'SentryClips', 'RecentClips'][e % 3];
    const eventTime = new Date(start + e * 11 * 60_000);
    const folder = `${eventTime.getUTCFullYear()}-${pad(eventTime.getUTCMonth() + 1)}-${pad(eventTime.getUTCDate())}_${pad(eventTime.getUTCHours())}-${pad(eventTime.getUTCMinutes())}-${pad(eventTime.getUTCSeconds())}`;
    for (let c = 0; c < CAMERAS.length && items.length < count; c += 1) {
      const camera = CAMERAS[c];
      const clipTime = new Date(eventTime.getTime() - 60_000);
      const clipName = `${clipTime.getUTCFullYear()}-${pad(clipTime.getUTCMonth() + 1)}-${pad(clipTime.getUTCDate())}_${pad(clipTime.getUTCHours())}-${pad(clipTime.getUTCMinutes())}-${pad(clipTime.getUTCSeconds())}-${camera}.mp4`;
      const relativePath = group === 'RecentClips' ? `RecentClips/${clipName}` : `${group}/${folder}/${clipName}`;
      const sourceBytes = (camera === 'front' ? 78 : 38) * 1024 * 1024 + ((index * 7919) % 4_000_000);
      const item = {
        id: `item-${String(index).padStart(5, '0')}`,
        state: 'queued',
        kind: 'video',
        group,
        eventId: group === 'RecentClips' ? null : folder,
        relativePath,
        sourcePath: `${SOURCE_ROOT}/${relativePath}`,
        sourceBytes,
        mtimeMs: clipTime.getTime() + 0.437,
        camera,
        eligibleVideo: true
      };
      assign(item, index);
      items.push(item);
      index += 1;
    }
  }
  return items;
}

function countersFrom(items) {
  const counters = {
    files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0,
    groups: Object.fromEntries(GROUPS.map((g) => [g, { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }]))
  };
  for (const item of items) {
    if (item.state !== 'completed' || !item.outputBytes) continue;
    counters.files += 1;
    counters.sourceVideoBytes += item.sourceBytes;
    counters.outputVideoBytes += item.outputBytes;
    counters.savedBytes += item.sourceBytes - item.outputBytes;
    const g = counters.groups[item.group];
    g.files += 1; g.sourceBytes += item.sourceBytes; g.outputBytes += item.outputBytes; g.savedBytes += item.sourceBytes - item.outputBytes;
  }
  counters.copiedAssetBytes = 18_400_000;
  return counters;
}

function timingsFor(files) {
  const per = { inspect: 180, source: 2100, timeline: 900, encode: 21500, metadata: 1400, verify: 3900, saveWait: 600, save: 1800, cleanup: 120 };
  return { files, totalMs: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v * files])) };
}

function completeItem(item, encoder = 'hevc_nvenc') {
  item.state = 'completed';
  item.outputBytes = Math.round(item.sourceBytes * 0.79);
  item.outputPath = `${DEST_ROOT}/${item.relativePath}`;
  item.encoder = encoder;
  item.attempts = 1;
  item.resultCode = 'completed';
}

function snapshotFor(name, now = Date.now()) {
  const id = 'job-20261020-1432';
  const minutes = (m) => m * 60_000;
  if (name === 'none' || name === 'idle' || name === 'auto') return null;

  if (name === 'discovering') {
    const items = makeItems(138, () => {});
    return {
      schemaVersion: 1, id, state: 'discovering', revision: 3, config: baseConfig(), items,
      counters: countersFrom(items), summary: null, discoveryComplete: false,
      createdAt: now - 21_000, updatedAt: now - 500, pausedMs: 0
    };
  }

  if (['encoding', 'verifying', 'paused', 'paused_network', 'cancelled'].includes(name)) {
    const total = name === 'verifying' ? 96 : 1284;
    const completedUntil = name === 'verifying' ? 51 : 412;
    const items = makeItems(total, (item, index) => {
      if (index < completedUntil) completeItem(item);
      if (index === 77 || index === 301) { item.state = 'skipped'; item.resultCode = 'already-converted'; }
      if (index === 133) { item.state = 'failed'; item.failure = { code: 'telemetry-mismatch', retryable: true }; item.attempts = 3; }
      if (index === 260) { item.state = 'failed'; item.failure = { code: 'encoder-failed', retryable: true }; item.attempts = 3; }
    });
    const active = name === 'verifying' ? 1 : 5;
    for (let i = completedUntil; i < completedUntil + active; i += 1) items[i].state = 'processing';
    const config = name === 'verifying'
      ? baseConfig({ concurrency: 1, codec: 'av1', profileId: 'quality', qualityLevel: 'balanced', verifyMode: 'full' })
      : baseConfig();
    if (name === 'verifying') items.forEach((item) => { if (item.encoder) item.encoder = 'av1_nvenc'; });
    const snap = {
      schemaVersion: 1, id, state: name === 'cancelled' ? 'cancelled' : name, revision: 5821,
      config, items, counters: countersFrom(items), summary: null, discoveryComplete: true,
      createdAt: now - minutes(47), updatedAt: name.startsWith('paused') || name === 'cancelled' ? now - minutes(2) : now - 400,
      activeItemId: items[completedUntil].id, pausedMs: name === 'paused' ? minutes(3) : 0,
      timings: timingsFor(completedUntil - 3)
    };
    if (name === 'paused') snap.recovery = { fromState: 'encoding', action: 'restart-encode' };
    if (name === 'paused_network') {
      snap.recovery = { fromState: 'paused_network', action: 'resume-network', pathRole: 'source', resumeState: 'waiting' };
      delete snap.activeItemId;
      for (let i = completedUntil; i < completedUntil + active; i += 1) items[i].state = 'queued';
    }
    if (name === 'cancelled') {
      delete snap.activeItemId;
      for (let i = completedUntil; i < total; i += 1) if (items[i].state === 'processing' || items[i].state === 'queued') items[i].state = 'cancelled';
    }
    return snap;
  }

  if (name === 'completed') {
    const items = makeItems(96, (item, index) => {
      completeItem(item);
      if (index % 31 === 7) { item.state = 'skipped'; item.resultCode = 'already-converted'; delete item.outputBytes; }
      if (index === 40) { item.state = 'failed'; item.failure = { code: 'telemetry-mismatch', retryable: true }; delete item.outputBytes; }
      if (index === 71) { item.state = 'failed'; item.failure = { code: 'encoder-start-failed', retryable: true }; delete item.outputBytes; }
      if (index === 12 || index === 55 || index === 88) item.resultCode = 'hardlink-cleanup-pending';
    });
    const counters = countersFrom(items);
    const summary = {
      ...JSON.parse(JSON.stringify(counters)),
      source: `${(counters.sourceVideoBytes / 1024 ** 3).toFixed(2)} GiB`,
      output: `${(counters.outputVideoBytes / 1024 ** 3).toFixed(2)} GiB`,
      saved: `${(counters.savedBytes / 1024 ** 3).toFixed(2)} GiB`,
      copiedAssets: '17.55 MiB'
    };
    return {
      schemaVersion: 1, id, state: 'completed', revision: 9133, config: baseConfig(), items, counters, summary,
      summaryDismissed: false, discoveryComplete: true, createdAt: now - minutes(14) - 31_000, updatedAt: now - minutes(1),
      pausedMs: 0, timings: timingsFor(counters.files)
    };
  }

  if (name === 'replace-recovery') {
    const items = makeItems(24, (item, index) => { if (index < 9) completeItem(item); });
    items[9].state = 'processing';
    return {
      schemaVersion: 1, id, state: 'paused', revision: 412,
      config: baseConfig({ outputMode: 'replace', destinationRoot: null, replacementConfirmed: true }),
      items, counters: countersFrom(items), summary: null, discoveryComplete: true,
      createdAt: now - minutes(6), updatedAt: now - minutes(5), activeItemId: items[9].id, pausedMs: 0,
      replacementPhase: 'original-backed-up',
      recovery: { fromState: 'replacing', action: 'resume-replacement', phase: 'original-backed-up' }
    };
  }
  throw new Error(`unknown scenario ${name}`);
}

function autoStateFor(name, now = Date.now()) {
  if (name === 'auto') {
    return {
      settings: { enabled: true, intervalMinutes: 60, window: { startHour: 1, endHour: 6 }, keepRunning: true, openAtLogin: false, config: baseConfig() },
      status: { lastCheckAt: now - 12 * 60_000, nextCheckAt: now + 48 * 60_000, lastNewFiles: 18, lastJobId: 'job-20261020-0105', activeJobId: null, pausedForWindow: false, checking: false, error: null }
    };
  }
  return {
    settings: { enabled: false, intervalMinutes: 60, window: null, keepRunning: false, openAtLogin: false, config: null },
    status: { lastCheckAt: null, nextCheckAt: null, lastNewFiles: null, lastJobId: null, activeJobId: null, pausedForWindow: false, checking: false, error: null }
  };
}

const BENCHMARK_RESULT = (() => {
  const level = (lvl, fpm, fps, saved, verify, ok = true, failures = []) => ({
    level: lvl, clips: Math.max(lvl, 2), completed: ok ? Math.max(lvl, 2) : 0, failed: ok ? 0 : Math.max(lvl, 2), failures,
    seconds: Math.round((Math.max(lvl, 2) / fpm) * 600) / 10, filesPerMinute: fpm, savedPercent: saved, verifySecondsPerClip: verify, fps, ok
  });
  const h265 = {
    codec: 'h265', encoder: { codec: 'hevc_nvenc', hardware: true }, clips: 8,
    results: [level(1, 5.6, 202.1, 21.3, 3.1), level(2, 10.4, 376.2, 21.1, 3.0), level(4, 17.9, 648, 21.2, 3.2), level(6, 18.3, 661.5, 21.2, 3.4)],
    verifyComparison: [
      { verifyMode: 'off', ...level(4, 24.8, 896.4, 21.2, 0) },
      { verifyMode: 'quick', ...level(4, 17.6, 636.1, 21.2, 2.9) },
      { verifyMode: 'full', ...level(4, 9.1, 328.7, 21.2, 11.8) }
    ]
  };
  h265.best = h265.results[2];
  const av1 = {
    codec: 'av1', encoder: { codec: 'av1_nvenc', hardware: true }, clips: 8,
    results: [level(1, 5.1, 184.0, 34.6, 3.3), level(2, 9.6, 347.3, 34.4, 3.2), level(4, 14.2, 513.8, 34.5, 3.5), level(6, 0, 0, null, null, false, ['encoder-start-failed'])],
    verifyComparison: [
      { verifyMode: 'off', ...level(4, 19.7, 712.9, 34.5, 0) },
      { verifyMode: 'quick', ...level(4, 14.0, 506.6, 34.5, 3.1) },
      { verifyMode: 'full', ...level(4, 7.9, 285.5, 34.5, 12.6) }
    ]
  };
  av1.best = av1.results[2];
  return { ...h265, codecs: [h265, av1] };
})();

const BENCHMARK_RESULT_AV1_UNSUPPORTED = (() => {
  const h265 = { ...BENCHMARK_RESULT.codecs[0], encoder: { codec: 'hevc_vaapi', hardware: true } };
  return { ...h265, codecs: [h265, { codec: 'av1', error: 'UNSUPPORTED', encoder: null, results: [], best: null, clips: 0 }] };
})();

module.exports = { snapshotFor, autoStateFor, baseConfig, BENCHMARK_RESULT, BENCHMARK_RESULT_AV1_UNSUPPORTED, SOURCE_ROOT, DEST_ROOT };
