'use strict';

const nodeFs = require('fs');
const nodePath = require('path');
const { isValidConcurrency, isValidCustomBitrate, isValidQualityLevel, isValidVerifyMode } = require('./contracts');

const PROFILE_IDS = Object.freeze(['conservative', 'balanced', 'aggressive', 'custom', 'quality']);

const CHANNELS = Object.freeze([
  'converter:chooseFolder',
  'converter:start',
  'converter:getCurrent',
  'converter:pause',
  'converter:resume',
  'converter:cancel',
  'converter:discard',
  'converter:retryFailed',
  'converter:dismissSummary',
  'converter:getCapabilities',
  'converter:subscribeProgress',
  'converter:unsubscribeProgress',
  'converter:runBenchmark',
  'converter:cancelBenchmark',
  'converter:getAuto',
  'converter:setAuto',
  'converter:checkAutoNow'
]);
const AUTO_INTERVALS = new Set([15, 30, 60, 180, 360, 720, 1440]);
const GROUPS = new Set(['RecentClips', 'SavedClips', 'SentryClips']);
const ACTIVE_STATES = new Set([
  'discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry',
  'verifying', 'copying', 'replacing', 'paused', 'paused_network'
]);
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
const LIVE_PROGRESS_PHASES = new Set(['continue', 'end']);
const ITEM_STATE_KEYS = ['queued', 'completed', 'skipped', 'failed'];
const PRIVATE_SNAPSHOT_KEY = /(?:telemetry|sei|nal|payload|owned|publication|stdout|stderr|stack|exception|process|runner)/i;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const registrations = new WeakMap();

class ConverterIpcError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConverterIpcError';
    this.code = code;
  }
}

function fail(code) {
  throw new ConverterIpcError(code);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Requests from the window accept whole numbers only. Data sent to the window
// (job snapshots, benchmark and automatic-conversion status) may carry normal
// finite numbers: file modification times have sub-millisecond fractions, and
// rejecting them silently froze the converter's live view.
function boundedJsonValue(value, byteLimit, { stripPrivate = false, finiteNumbers = false } = {}) {
  const seen = new Set();
  let nodes = 0;
  let stringUnits = 0;
  const visit = (input, key = '') => {
    nodes += 1;
    if (nodes > 20_000) fail('PAYLOAD_TOO_LARGE');
    if (stripPrivate && PRIVATE_SNAPSHOT_KEY.test(key)) return undefined;
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || (!finiteNumbers && !Number.isSafeInteger(input))) fail('INVALID_REQUEST');
      return input;
    }
    if (typeof input === 'string') {
      stringUnits += input.length;
      if (input.length > 32_768 || stringUnits > byteLimit) fail('PAYLOAD_TOO_LARGE');
      return input;
    }
    if (Buffer.isBuffer(input) || ArrayBuffer.isView(input) || typeof input !== 'object' || seen.has(input)) {
      fail('INVALID_REQUEST');
    }
    seen.add(input);
    let output;
    if (Array.isArray(input)) {
      if (input.length > 10_000) fail('PAYLOAD_TOO_LARGE');
      output = input.map((item) => visit(item));
    } else {
      if (!isPlainObject(input)) fail('INVALID_REQUEST');
      if (Object.getOwnPropertySymbols(input).length > 0) fail('INVALID_REQUEST');
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const entries = Object.entries(descriptors);
      if (entries.length > 128) fail('PAYLOAD_TOO_LARGE');
      output = {};
      for (const [childKey, descriptor] of entries) {
        if (childKey.length > 128) fail('INVALID_REQUEST');
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail('INVALID_REQUEST');
        const sanitized = visit(descriptor.value, childKey);
        if (sanitized !== undefined) output[childKey] = sanitized;
      }
    }
    seen.delete(input);
    return output;
  };
  const output = visit(value);
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > byteLimit) fail('PAYLOAD_TOO_LARGE');
  return output;
}

function validatePayload(payload) {
  if (payload === undefined) return undefined;
  return boundedJsonValue(payload, MAX_PAYLOAD_BYTES);
}

function sanitizeSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) fail('INVALID_SNAPSHOT');
  if (!Array.isArray(snapshot.items) || snapshot.items.length <= 256) {
    return boundedJsonValue(snapshot, MAX_SNAPSHOT_BYTES, { stripPrivate: true, finiteNumbers: true });
  }
  const descriptors = Object.getOwnPropertyDescriptors(snapshot);
  if (Object.values(descriptors).some((descriptor) => !Object.prototype.hasOwnProperty.call(descriptor, 'value'))) {
    fail('INVALID_SNAPSHOT');
  }
  const itemCount = snapshot.items.length;
  const itemStateCounts = Object.fromEntries(ITEM_STATE_KEYS.map((state) => [
    state,
    snapshot.items.filter((item) => item?.state === state).length
  ]));
  // In-flight items. Published as "active" because keys matching
  // PRIVATE_SNAPSHOT_KEY (e.g. "processing") are stripped below.
  itemStateCounts.active = snapshot.items.filter((item) => item?.state === 'processing').length;
  const cleanupPendingCount = snapshot.items.filter((item) => String(item?.resultCode || '').includes('cleanup-pending')).length;
  const activeIndex = snapshot.items.findIndex((item) => item?.id === snapshot.activeItemId);
  const failedIndexes = snapshot.items
    .map((item, index) => item?.state === 'failed' ? index : -1)
    .filter((index) => index >= 0);
  let limit = 256;
  while (limit >= 1) {
    const selected = new Set();
    if (activeIndex >= 0) selected.add(activeIndex);
    for (let index = failedIndexes.length - 1; index >= 0 && selected.size < limit; index -= 1) {
      selected.add(failedIndexes[index]);
    }
    for (let index = itemCount - 1; index >= 0 && selected.size < limit; index -= 1) selected.add(index);
    const prepared = {};
    for (const [key, descriptor] of Object.entries(descriptors)) prepared[key] = descriptor.value;
    prepared.items = [...selected].sort((left, right) => left - right).map((index) => snapshot.items[index]);
    prepared.itemCount = itemCount;
    prepared.itemStateCounts = itemStateCounts;
    prepared.cleanupPendingCount = cleanupPendingCount;
    prepared.itemsTruncated = true;
    try {
      return boundedJsonValue(prepared, MAX_SNAPSHOT_BYTES, { stripPrivate: true, finiteNumbers: true });
    } catch (error) {
      if (error?.code !== 'PAYLOAD_TOO_LARGE' || limit === 1) throw error;
      limit = Math.max(1, Math.floor(limit / 2));
    }
  }
  fail('PAYLOAD_TOO_LARGE');
}

function sanitizeLiveProgress(progress) {
  if (!isPlainObject(progress)) fail('INVALID_PROGRESS');
  const descriptors = Object.getOwnPropertyDescriptors(progress);
  const phaseDescriptor = descriptors.phase;
  if (!phaseDescriptor || !Object.prototype.hasOwnProperty.call(phaseDescriptor, 'value')
      || !LIVE_PROGRESS_PHASES.has(phaseDescriptor.value)) fail('INVALID_PROGRESS');
  const sanitized = { phase: phaseDescriptor.value };
  const outTimeDescriptor = descriptors.outTimeUs;
  if (outTimeDescriptor && Object.prototype.hasOwnProperty.call(outTimeDescriptor, 'value')) {
    if (!Number.isSafeInteger(outTimeDescriptor.value) || outTimeDescriptor.value < 0) fail('INVALID_PROGRESS');
    sanitized.outTimeUs = outTimeDescriptor.value;
  }
  const fpsDescriptor = descriptors.fps;
  if (fpsDescriptor && Object.prototype.hasOwnProperty.call(fpsDescriptor, 'value')) {
    if (typeof fpsDescriptor.value !== 'number' || !Number.isFinite(fpsDescriptor.value)
        || fpsDescriptor.value < 0 || fpsDescriptor.value > 1_000_000) fail('INVALID_PROGRESS');
    sanitized.fps = Math.round(fpsDescriptor.value * 10) / 10;
  }
  return sanitized;
}

function responseError(error) {
  const raw = typeof error?.code === 'string' ? error.code.toUpperCase().replace(/-/g, '_') : '';
  const code = SAFE_ERROR_CODE.test(raw) ? raw : 'OPERATION_FAILED';
  return { ok: false, error: { code, retryable: error?.retryable === true } };
}

function wrapped(handler) {
  return async (event, rawPayload) => {
    try {
      const payload = validatePayload(rawPayload);
      return { ok: true, value: await handler(event, payload) };
    } catch (error) {
      return responseError(error);
    }
  };
}

function validateJobId(payload) {
  if (!isPlainObject(payload) || Object.keys(payload).length !== 1) fail('INVALID_JOB_ID');
  return validateSafeJobId(payload.jobId);
}

function validateSafeJobId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || WINDOWS_RESERVED_NAME.test(id)) fail('INVALID_JOB_ID');
  return id;
}

function validateNoPayload(payload) {
  if (payload !== undefined) fail('INVALID_REQUEST');
}

function validateAbsolutePath(value, pathApi) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768 || value.includes('\0')
      || (!pathApi.isAbsolute(value) && !nodePath.win32.isAbsolute(value) && !nodePath.posix.isAbsolute(value))) {
    fail('INVALID_PATH');
  }
  return pathApi.resolve(value);
}

function comparisonPath(value, pathApi, platform) {
  const normalized = pathApi.normalize(pathApi.resolve(value));
  return platform === 'win32' || pathApi === nodePath.win32 ? normalized.toLowerCase() : normalized;
}

function overlaps(left, right, pathApi, platform) {
  const a = comparisonPath(left, pathApi, platform);
  const b = comparisonPath(right, pathApi, platform);
  const relativeAB = pathApi.relative(a, b);
  const relativeBA = pathApi.relative(b, a);
  const contained = (relative) => relative === ''
    || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
  return contained(relativeAB) || contained(relativeBA);
}

async function canonicalDirectory(target, dependencies) {
  const absolute = validateAbsolutePath(target, dependencies.pathApi);
  let stat;
  let real;
  try {
    stat = await dependencies.fs.lstat(absolute);
    real = dependencies.pathApi.resolve(await dependencies.fs.realpath(absolute));
  } catch (_error) {
    fail('PATH_UNAVAILABLE');
  }
  if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()) fail('INVALID_PATH');
  return { absolute, real };
}

async function canonicalFutureDirectory(target, dependencies) {
  const absolute = validateAbsolutePath(target, dependencies.pathApi);
  let cursor = absolute;
  const suffix = [];
  while (true) {
    try {
      const stat = await dependencies.fs.lstat(cursor);
      if (!stat || typeof stat.isDirectory !== 'function' || !stat.isDirectory()) fail('INVALID_PATH');
      const realAncestor = dependencies.pathApi.resolve(await dependencies.fs.realpath(cursor));
      return { absolute, real: dependencies.pathApi.resolve(realAncestor, ...suffix) };
    } catch (error) {
      if (error instanceof ConverterIpcError) throw error;
      if (!error || error.code !== 'ENOENT') fail('PATH_UNAVAILABLE');
      const parent = dependencies.pathApi.dirname(cursor);
      if (parent === cursor) fail('PATH_UNAVAILABLE');
      suffix.unshift(dependencies.pathApi.basename(cursor));
      cursor = parent;
    }
  }
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

async function validateStartConfig(payload, dependencies, capabilities) {
  const keys = [
    'sourceRoot', 'destinationRoot', 'codec', 'profileId', 'networkMode',
    'outputMode', 'includedGroups', 'replacementConfirmed'
  ];
  const hasGroupOrder = isPlainObject(payload) && Object.prototype.hasOwnProperty.call(payload, 'groupOrder');
  const hasConcurrency = isPlainObject(payload) && Object.prototype.hasOwnProperty.call(payload, 'concurrency');
  const hasBitrate = isPlainObject(payload) && Object.prototype.hasOwnProperty.call(payload, 'bitrateKbps');
  const hasQuality = isPlainObject(payload) && Object.prototype.hasOwnProperty.call(payload, 'qualityLevel');
  const hasVerify = isPlainObject(payload) && Object.prototype.hasOwnProperty.call(payload, 'verifyMode');
  const expectedKeys = [...keys, ...(hasGroupOrder ? ['groupOrder'] : []), ...(hasConcurrency ? ['concurrency'] : []),
    ...(hasBitrate ? ['bitrateKbps'] : []), ...(hasQuality ? ['qualityLevel'] : []), ...(hasVerify ? ['verifyMode'] : [])];
  if (!exactKeys(payload, expectedKeys)) fail('INVALID_REQUEST');
  // Custom profile: an explicit bitrate is required; size profiles take none.
  if (payload.profileId === 'custom' ? !isValidCustomBitrate(payload.bitrateKbps) : hasBitrate) fail('INVALID_BITRATE');
  // Constant quality: a named level is required; other profiles take none.
  if (payload.profileId === 'quality' ? !isValidQualityLevel(payload.qualityLevel) : hasQuality) fail('INVALID_QUALITY');
  if (hasConcurrency && !isValidConcurrency(payload.concurrency)) fail('INVALID_CONCURRENCY');
  if (hasVerify && !isValidVerifyMode(payload.verifyMode)) fail('INVALID_VERIFY_MODE');
  if (!['h265', 'av1'].includes(payload.codec)) fail('INVALID_CODEC');
  if (!PROFILE_IDS.includes(payload.profileId)) fail('INVALID_PROFILE');
  if (!['auto', 'staging', 'direct'].includes(payload.networkMode)) fail('INVALID_NETWORK_MODE');
  if (!['separate', 'replace'].includes(payload.outputMode)) fail('INVALID_OUTPUT_MODE');
  if (!Array.isArray(payload.includedGroups) || payload.includedGroups.length === 0
      || new Set(payload.includedGroups).size !== payload.includedGroups.length
      || payload.includedGroups.some((group) => !GROUPS.has(group))) fail('INVALID_GROUP_SELECTION');
  if (hasGroupOrder && (!Array.isArray(payload.groupOrder) || payload.groupOrder.length !== GROUPS.size
      || new Set(payload.groupOrder).size !== GROUPS.size
      || payload.groupOrder.some((group) => !GROUPS.has(group)))) fail('INVALID_GROUP_ORDER');

  const source = await canonicalDirectory(payload.sourceRoot, dependencies);
  if (payload.outputMode === 'replace') {
    if (payload.destinationRoot !== null) fail('INVALID_PATH');
    if (payload.replacementConfirmed !== true) fail('REPLACEMENT_CONFIRMATION_REQUIRED');
    if (capabilities.replacement !== 'available') fail('REPLACEMENT_UNAVAILABLE');
    // Originals are replaced: never without at least the quick checks.
    const verifyMode = hasVerify && payload.verifyMode === 'off' ? { verifyMode: 'quick' } : {};
    return { ...payload, ...verifyMode, sourceRoot: source.real };
  }
  if (payload.replacementConfirmed !== false) fail('INVALID_REPLACEMENT_CONFIRMATION');
  const destination = await canonicalFutureDirectory(payload.destinationRoot, dependencies);
  for (const sourcePath of [source.absolute, source.real]) {
    for (const destinationPath of [destination.absolute, destination.real]) {
      if (overlaps(sourcePath, destinationPath, dependencies.pathApi, dependencies.platform)) fail('PATH_OVERLAP');
    }
  }
  return { ...payload, sourceRoot: source.real, destinationRoot: destination.real };
}

function chooseCurrent(snapshots) {
  if (!Array.isArray(snapshots)) fail('INVALID_SNAPSHOT');
  const candidates = snapshots.filter((snapshot) => isPlainObject(snapshot));
  const active = candidates.filter((snapshot) => ACTIVE_STATES.has(snapshot.state));
  const visible = active.length ? active : candidates.filter((snapshot) => snapshot.summaryDismissed !== true);
  visible.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0) || (right.revision || 0) - (left.revision || 0));
  return visible.length ? sanitizeSnapshot(visible[0]) : null;
}

function validateCapabilities(value = {}) {
  const allowed = {
    separatePublication: new Set(['hardlink-cleanup-pending', 'native-atomic', 'unavailable']),
    ownershipCleanup: new Set(['atomic-expected-ownership', 'unavailable']),
    replacement: new Set(['available', 'unavailable']),
    destinationContainment: new Set([
      'pathname-revalidated-non-atomic', 'native-directory-relative-atomic', 'unavailable'
    ])
  };
  const result = {};
  for (const [key, choices] of Object.entries(allowed)) {
    const selected = value[key] || 'unavailable';
    if (!choices.has(selected)) fail('INVALID_CAPABILITY_STATUS');
    result[key] = selected;
  }
  return Object.freeze(result);
}

function registerConverterIpc(options = {}) {
  if (!options.ipcMain || typeof options.ipcMain.handle !== 'function'
      || typeof options.ipcMain.removeHandler !== 'function') throw new TypeError('ipcMain is required');
  const existing = registrations.get(options.ipcMain);
  if (existing) return existing;
  if (!options.dialog || typeof options.dialog.showOpenDialog !== 'function') throw new TypeError('dialog is required');
  if (!options.service || typeof options.service.subscribe !== 'function') throw new TypeError('service is required');

  const dependencies = {
    fs: options.fs || nodeFs.promises,
    pathApi: options.pathApi || nodePath,
    platform: options.platform || process.platform
  };
  const capabilities = validateCapabilities(options.capabilities);
  const senders = new Map();
  let unregistered = false;
  let droppedUpdateLogged = false;

  function removeSender(sender, options = {}) {
    const registration = senders.get(sender);
    if (!registration) return;
    if (options.force !== true && registration.count > 1) {
      registration.count -= 1;
      return;
    }
    senders.delete(sender);
    if (typeof sender.removeListener === 'function') sender.removeListener('destroyed', registration.destroyListener);
  }

  function addSender(sender) {
    if (!sender || typeof sender.send !== 'function' || typeof sender.once !== 'function') fail('INVALID_SENDER');
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) fail('INVALID_SENDER');
    const existingSender = senders.get(sender);
    if (existingSender) {
      existingSender.count += 1;
      return;
    }
    const destroyListener = () => removeSender(sender, { force: true });
    senders.set(sender, { count: 1, destroyListener });
    sender.once('destroyed', destroyListener);
  }

  const unsubscribeService = options.service.subscribe((event) => {
    if (!event || !['snapshot', 'progress'].includes(event.type)) return;
    let payload;
    try {
      if (typeof event.jobId !== 'string' || !SAFE_ID.test(event.jobId) || WINDOWS_RESERVED_NAME.test(event.jobId)
          || !Number.isSafeInteger(event.revision) || event.revision < 0) return;
      const snapshot = event.type === 'snapshot'
        ? sanitizeSnapshot(event.snapshot)
        : { id: event.jobId, revision: event.revision, progress: sanitizeLiveProgress(event.progress) };
      payload = { jobId: event.jobId, revision: event.revision, snapshot };
    } catch (error) {
      // Never drop live updates silently: one bad value used to freeze the view.
      if (!droppedUpdateLogged) {
        droppedUpdateLogged = true;
        console.warn('[CONVERTER] A live update could not be sent to the window:', error?.code || 'UNKNOWN');
      }
      return;
    }
    for (const sender of [...senders.keys()]) {
      if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
        removeSender(sender, { force: true });
        continue;
      }
      try { sender.send('converter:progress', payload); } catch (_error) { /* retry on the next event */ }
    }
  });

  const handlers = {
    'converter:chooseFolder': wrapped(async (_event, payload) => {
      if (!isPlainObject(payload) || !['source', 'destination'].includes(payload.purpose)
          || Object.keys(payload).some((key) => !['purpose', 'defaultPath'].includes(key))) fail('INVALID_REQUEST');
      const dialogOptions = { properties: ['openDirectory'] };
      if (payload.defaultPath !== undefined) dialogOptions.defaultPath = validateAbsolutePath(payload.defaultPath, dependencies.pathApi);
      const result = await options.dialog.showOpenDialog(dialogOptions);
      if (result?.canceled || !Array.isArray(result?.filePaths) || result.filePaths.length === 0) return null;
      return (await canonicalDirectory(result.filePaths[0], dependencies)).real;
    }),
    'converter:start': wrapped(async (_event, payload) => ({
      jobId: validateSafeJobId(await options.service.start(await validateStartConfig(payload, dependencies, capabilities)))
    })),
    'converter:getCurrent': wrapped(async (_event, payload) => {
      validateNoPayload(payload);
      return chooseCurrent(await options.service.list());
    }),
    'converter:pause': wrapped(async (_event, payload) => sanitizeSnapshot(await options.service.pause(validateJobId(payload)))),
    'converter:resume': wrapped(async (_event, payload) => sanitizeSnapshot(await options.service.resume(validateJobId(payload)))),
    'converter:cancel': wrapped(async (_event, payload) => sanitizeSnapshot(await options.service.cancel(validateJobId(payload)))),
    // Sets aside a job that cannot be cancelled; answers with the job now current (or null).
    'converter:discard': wrapped(async (_event, payload) => {
      if (typeof options.service.discard !== 'function') fail('OPERATION_FAILED');
      await options.service.discard(validateJobId(payload));
      return chooseCurrent(await options.service.list());
    }),
    'converter:retryFailed': wrapped(async (_event, payload) => sanitizeSnapshot(await options.service.retryFailed(validateJobId(payload)))),
    'converter:dismissSummary': wrapped(async (_event, payload) => sanitizeSnapshot(await options.service.dismissSummary(validateJobId(payload)))),
    'converter:getCapabilities': wrapped(async (_event, payload) => {
      validateNoPayload(payload);
      return capabilities;
    }),
    'converter:subscribeProgress': wrapped(async (event, payload) => {
      validateNoPayload(payload);
      addSender(event?.sender);
      return null;
    }),
    'converter:unsubscribeProgress': wrapped(async (event, payload) => {
      validateNoPayload(payload);
      removeSender(event?.sender);
      return null;
    }),
    'converter:runBenchmark': wrapped(async (event, payload) => {
      if (typeof options.benchmark?.run !== 'function') fail('BENCHMARK_UNAVAILABLE');
      if (!isPlainObject(payload) || Object.keys(payload)
        .some((key) => !['codec', 'codecs', 'sourceRoot', 'profileId', 'bitrateKbps', 'qualityLevel', 'verifyMode'].includes(key))) fail('INVALID_REQUEST');
      if (payload.verifyMode !== undefined && !isValidVerifyMode(payload.verifyMode)) fail('INVALID_VERIFY_MODE');
      const codecs = payload.codecs === undefined ? [payload.codec] : payload.codecs;
      if (!Array.isArray(codecs) || codecs.length === 0 || codecs.length > 2 || new Set(codecs).size !== codecs.length
          || codecs.some((entry) => !['h265', 'av1'].includes(entry))) fail('INVALID_CODEC');
      const profileId = payload.profileId ?? 'balanced';
      if (!PROFILE_IDS.includes(profileId)) fail('INVALID_PROFILE');
      if (profileId === 'custom' ? !isValidCustomBitrate(payload.bitrateKbps) : payload.bitrateKbps !== undefined) {
        fail('INVALID_BITRATE');
      }
      if (profileId === 'quality' ? !isValidQualityLevel(payload.qualityLevel) : payload.qualityLevel !== undefined) {
        fail('INVALID_QUALITY');
      }
      const sourceRoot = payload.sourceRoot === undefined || payload.sourceRoot === null
        ? null : (await canonicalDirectory(payload.sourceRoot, dependencies)).real;
      const sender = event?.sender;
      return options.benchmark.run({
        codec: codecs[0],
        codecs,
        profileId,
        ...(profileId === 'custom' ? { bitrateKbps: payload.bitrateKbps } : {}),
        ...(profileId === 'quality' ? { qualityLevel: payload.qualityLevel } : {}),
        verifyMode: payload.verifyMode ?? 'quick',
        sourceRoot,
        onProgress: (progress) => {
          try {
            if (sender && !(typeof sender.isDestroyed === 'function' && sender.isDestroyed())) {
              sender.send('converter:benchmarkProgress', boundedJsonValue(progress, MAX_PAYLOAD_BYTES, { finiteNumbers: true }));
            }
          } catch (_error) { /* progress is best effort */ }
        }
      });
    }),
    'converter:cancelBenchmark': wrapped(async (_event, payload) => {
      validateNoPayload(payload);
      options.benchmark?.cancel?.();
      return null;
    }),
    'converter:getAuto': wrapped(async (_event, payload) => {
      validateNoPayload(payload);
      if (typeof options.auto?.get !== 'function') fail('AUTO_UNAVAILABLE');
      return boundedJsonValue(options.auto.get(), MAX_PAYLOAD_BYTES, { finiteNumbers: true });
    }),
    'converter:setAuto': wrapped(async (_event, payload) => {
      if (typeof options.auto?.configure !== 'function') fail('AUTO_UNAVAILABLE');
      if (!isPlainObject(payload) || Object.keys(payload)
        .some((key) => !['enabled', 'intervalMinutes', 'window', 'keepRunning', 'openAtLogin', 'config'].includes(key))) {
        fail('INVALID_REQUEST');
      }
      if (typeof payload.enabled !== 'boolean' || !AUTO_INTERVALS.has(payload.intervalMinutes)
          || typeof payload.keepRunning !== 'boolean' || typeof payload.openAtLogin !== 'boolean') fail('INVALID_REQUEST');
      let window = null;
      if (payload.window !== null && payload.window !== undefined) {
        const { startHour, endHour } = isPlainObject(payload.window) ? payload.window : {};
        if (![startHour, endHour].every((hour) => Number.isSafeInteger(hour) && hour >= 0 && hour <= 23)
            || startHour === endHour) fail('INVALID_AUTO_WINDOW');
        window = { startHour, endHour };
      }
      // The saved job settings pass the same validation as a manual start.
      // Turning it off never validates them, so an unplugged drive or offline
      // share can always be switched off.
      const config = !payload.enabled || payload.config === undefined || payload.config === null
        ? null : await validateStartConfig(payload.config, dependencies, capabilities);
      if (payload.enabled && !config) fail('AUTO_CONFIG_REQUIRED');
      return boundedJsonValue(await options.auto.configure({
        enabled: payload.enabled, intervalMinutes: payload.intervalMinutes, window,
        keepRunning: payload.keepRunning, openAtLogin: payload.openAtLogin, config
      }), MAX_PAYLOAD_BYTES, { finiteNumbers: true });
    }),
    'converter:checkAutoNow': wrapped(async (_event, payload) => {
      validateNoPayload(payload);
      if (typeof options.auto?.checkNow !== 'function') fail('AUTO_UNAVAILABLE');
      return boundedJsonValue(await options.auto.checkNow(), MAX_PAYLOAD_BYTES, { finiteNumbers: true });
    })
  };

  for (const channel of CHANNELS) options.ipcMain.handle(channel, handlers[channel]);

  const registration = Object.freeze({
    channels: CHANNELS,
    capabilities,
    unregister() {
      if (unregistered) return;
      unregistered = true;
      for (const channel of CHANNELS) options.ipcMain.removeHandler(channel);
      for (const sender of [...senders.keys()]) removeSender(sender, { force: true });
      if (typeof unsubscribeService === 'function') unsubscribeService();
      registrations.delete(options.ipcMain);
    }
  });
  registrations.set(options.ipcMain, registration);
  return registration;
}

module.exports = {
  CHANNELS,
  ConverterIpcError,
  registerConverterIpc,
  sanitizeSnapshot
};
