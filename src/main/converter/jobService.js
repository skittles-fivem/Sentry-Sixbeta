'use strict';

const {
  CONCURRENCY,
  TIMING_PHASES,
  addItemTimings,
  isValidConcurrency,
  createEmptyCounters,
  addCompletedFile,
  serializeSummary,
  targetOutputBytes,
  hasSizeTarget,
  effectiveVerifyMode
} = require('./contracts');
const {
  SAFE_VIDEO_BITRATE_FLOORS,
  buildEncodeArgs,
  calculateInitialBitrate,
  decideSizeRetry
} = require('./encoderPlanner');

const ACTIVE_STATES = new Set([
  'discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry',
  'verifying', 'copying', 'replacing', 'paused', 'paused_network'
]);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'skipped']);
const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REPLACEMENT_PHASES = new Set([
  'candidate-written', 'original-backed-up', 'candidate-promoted',
  'final-validated', 'backup-deleted', 'rollback-started',
  'backup-restored', 'rollback-failed'
]);
const OWNED_KEYS = new Set([
  'stagedSource', 'encodedCandidate', 'publicationSnapshot',
  'destinationPartial', 'replacementCandidate', 'replacementBackup'
]);

class ConverterJobServiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ConverterJobServiceError';
    this.code = code;
  }
}

const MAX_RECORDED_ATTEMPTS = 3; // jobStore rejects more
// States in which a job is not working: time spent in them is left out of its
// elapsed time and average speed (a retry restarts a finished job).
const IDLE_JOB_STATES = new Set(['paused', 'paused_network', 'completed', 'skipped', 'failed', 'cancelled']);

function serviceError(code) {
  return new ConverterJobServiceError(code);
}

// Only read-only waits may be detached on abort. Their late results are observed,
// but cannot continue recovery or start a transaction after shutdown.
function abortableRead(operation, signal) {
  if (signal.aborted) return Promise.reject(serviceError('CANCELLED'));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(serviceError('CANCELLED')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw serviceError('CANCELLED');
      return operation();
    }).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(serviceError('CANCELLED')); else resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function stableFailure(error, fallback = 'operation-failed') {
  const raw = typeof error?.code === 'string' ? error.code.toLowerCase().replace(/_/g, '-') : fallback;
  return SAFE_CODE.test(raw) ? raw : fallback;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function composeOwnership(base = {}, incoming = {}, clearKeys = []) {
  const ownedPaths = { ...(base.ownedPaths || {}) };
  const ownedArtifacts = { ...(base.ownedArtifacts || {}) };
  for (const key of clearKeys) {
    if (!OWNED_KEYS.has(key)) continue;
    delete ownedPaths[key];
    delete ownedArtifacts[key];
  }
  for (const [key, value] of Object.entries(incoming.ownedPaths || {})) {
    if (OWNED_KEYS.has(key)) ownedPaths[key] = value;
  }
  for (const [key, value] of Object.entries(incoming.ownedArtifacts || {})) {
    if (OWNED_KEYS.has(key)) ownedArtifacts[key] = value;
  }
  const result = { ownedPaths, ownedArtifacts };
  if (Object.prototype.hasOwnProperty.call(incoming, 'publicationArtifact')) {
    if (incoming.publicationArtifact) result.publicationArtifact = incoming.publicationArtifact;
  } else if (base.publicationArtifact) result.publicationArtifact = base.publicationArtifact;
  if (incoming.clearPublicationArtifact === true) delete result.publicationArtifact;
  return result;
}

function ownershipOf(value) {
  return composeOwnership({}, value || {});
}

const PRIVATE_SNAPSHOT_KEYS = ['ownedPaths', 'ownedArtifacts', 'publicationArtifact'];

// Frozen items (the job store's own validated copies) cannot change, so the
// snapshot reuses them when they carry nothing private instead of copying
// every item of a large job on each update.
function publicItem(item) {
  if (Object.isFrozen(item) && item && typeof item === 'object'
      && !PRIVATE_SNAPSHOT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(item, key))) return item;
  const safeItem = clone(item);
  for (const key of PRIVATE_SNAPSHOT_KEYS) delete safeItem[key];
  return safeItem;
}

function publicSnapshot(manifest) {
  const snapshot = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'items' || PRIVATE_SNAPSHOT_KEYS.includes(key)) continue;
    snapshot[key] = value && typeof value === 'object' && !Object.isFrozen(value) ? clone(value) : value;
  }
  snapshot.items = (manifest.items || []).map(publicItem);
  return deepFreeze(snapshot);
}

function validateDependencies(deps) {
  if (!deps || typeof deps !== 'object') throw new TypeError('dependencies are required');
  for (const [name, method] of [
    ['store.create', deps.store?.create],
    ['store.transition', deps.store?.transition],
    ['store.load', deps.store?.load],
    ['store.list', deps.store?.list],
    ['scanner', deps.scanner],
    ['planner.select', deps.planner?.select],
    ['planner.selectCpuFallback', deps.planner?.selectCpuFallback],
    ['stagingManager.reserveEncodeOutput', deps.stagingManager?.reserveEncodeOutput],
    ['stagingManager.adoptEncodeOutput', deps.stagingManager?.adoptEncodeOutput],
    ['stagingManager.copyAsset', deps.stagingManager?.copyAsset],
    ['stagingManager.publishSeparate', deps.stagingManager?.publishSeparate],
    ['stagingManager.replaceOriginal', deps.stagingManager?.replaceOriginal],
    ['stagingManager.cleanupOwnedArtifacts', deps.stagingManager?.cleanupOwnedArtifacts],
    ['ensureDestinationParent', deps.ensureDestinationParent],
    ['inspectVideo', deps.inspectVideo],
    ['readTimeline', deps.readTimeline],
    ['verifier', deps.verifier],
    ['spawnProcess', deps.spawnProcess]
  ]) {
    if (typeof method !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (typeof deps.writers?.h265 !== 'function' || typeof deps.writers?.av1 !== 'function') {
    throw new TypeError('codec writers are required');
  }
}

class BoundedQueue {
  constructor(limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('queueLimit must be a positive safe integer');
    this.limit = limit;
    this.values = [];
    this.pushWaiters = [];
    this.shiftWaiters = [];
    this.closed = false;
  }

  async push(value) {
    if (this.closed) throw serviceError('QUEUE_CLOSED');
    if (this.shiftWaiters.length) {
      this.shiftWaiters.shift()({ value, done: false });
      return;
    }
    while (!this.closed && this.values.length >= this.limit) {
      await new Promise((resolve) => this.pushWaiters.push(resolve));
    }
    if (this.closed) throw serviceError('QUEUE_CLOSED');
    this.values.push(value);
  }

  async shift() {
    if (this.values.length) {
      const value = this.values.shift();
      this.pushWaiters.shift()?.();
      return { value, done: false };
    }
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.shiftWaiters.push(resolve));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.shiftWaiters.splice(0)) resolve({ value: undefined, done: true });
    for (const resolve of this.pushWaiters.splice(0)) resolve();
  }
}

function createConverterJobService(deps) {
  validateDependencies(deps);
  const store = deps.store;
  const scanner = deps.scanner;
  const planner = deps.planner;
  const staging = deps.stagingManager;
  // GPU decoding is an optimisation only. An encoder whose GPU decode proved
  // unusable is not offered it again; verify stops after repeated fallbacks.
  const encodeDecodeBroken = new Set();
  const verifyDecodeFallbacks = new Map();
  const VERIFY_DECODE_FALLBACK_LIMIT = 3;
  function accelArgs(encoder, options) {
    try {
      const args = deps.decodeAccel(encoder.codec, options);
      return Array.isArray(args) && args.length > 0 ? args : null;
    } catch (_) { return null; }
  }
  function decodeAccelFor(encoder, purpose) {
    if (encoder?.hardware !== true || typeof deps.decodeAccel !== 'function') return null;
    if (purpose === 'verify' && (verifyDecodeFallbacks.get(encoder.codec) || 0) >= VERIFY_DECODE_FALLBACK_LIMIT) return null;
    return accelArgs(encoder);
  }
  // Encode decode tiers, fastest first: GPU frames kept on the GPU (zero-copy),
  // then GPU decode, then (implicitly, after the list) CPU decode.
  function encodeDecodeTiers(encoder) {
    if (encoder?.hardware !== true || typeof deps.decodeAccel !== 'function') return [];
    return [
      { key: `${encoder.codec}:zero-copy`, args: accelArgs(encoder, { zeroCopy: true }) },
      { key: `${encoder.codec}:gpu`, args: accelArgs(encoder) }
    ].filter((tier) => tier.args && !encodeDecodeBroken.has(tier.key));
  }
  const pathApi = deps.pathApi || require('path');
  const clock = deps.clock || { now: Date.now, sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) };
  const network = deps.network || {
    isRetryable: (error) => [
      'ENOENT', 'ENOTCONN', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EIO'
    ].includes(error?.code),
    checkPath: async () => true
  };
  const backoff = {
    initialMs: deps.networkBackoff?.initialMs || 1_000,
    maximumMs: deps.networkBackoff?.maximumMs || 30_000
  };
  if (!Number.isSafeInteger(backoff.initialMs) || backoff.initialMs < 1
      || !Number.isSafeInteger(backoff.maximumMs) || backoff.maximumMs < backoff.initialMs) {
    throw new RangeError('network backoff must use positive bounded integers');
  }
  const ffmpegPath = deps.ffmpegPath || 'ffmpeg';
  // Monotonic clock for per-phase timings (kept separate from deps.clock, which
  // stamps manifests).
  const timingNow = deps.timingNow || (() => performance.now());

  // Attributes elapsed time to phases: mark(phase) charges everything since the
  // previous mark to that phase (retries accumulate).
  function createItemTiming() {
    const phases = Object.fromEntries(TIMING_PHASES.map((phase) => [phase, 0]));
    const started = timingNow();
    let last = started;
    return {
      mark(phase) {
        const now = timingNow();
        phases[phase] += Math.max(0, now - last);
        last = now;
      },
      result() {
        const rounded = Object.fromEntries(Object.entries(phases).map(([phase, ms]) => [phase, Math.round(ms)]));
        return { phases: rounded, totalMs: Math.round(timingNow() - started) };
      }
    };
  }
  const queueLimit = deps.queueLimit || 4;
  // Discovery persists newly found items in batches. 1 keeps the original
  // persist-each-item-before-enqueue cadence; larger values avoid rewriting the
  // whole manifest once per discovered file.
  const discoveryBatchSize = deps.discoveryBatchSize || 1;
  const discoveryFlushMs = deps.discoveryFlushMs ?? 250;
  if (!Number.isSafeInteger(discoveryBatchSize) || discoveryBatchSize < 1
      || !Number.isSafeInteger(discoveryFlushMs) || discoveryFlushMs < 0) {
    throw new RangeError('discovery batching must use positive bounded integers');
  }
  const jobs = new Map();
  const listeners = new Set();
  let shuttingDown = false;
  let commandChain = Promise.resolve();

  function serializeCommand(operation) {
    const result = commandChain.catch(() => undefined).then(operation);
    commandChain = result;
    return result;
  }

  function emit(runtime, type, fields = {}) {
    if (listeners.size === 0) return;
    // Snapshots are already detached, deep-frozen copies; cloning them again
    // per event was a full extra pass over every manifest item.
    const detached = {};
    for (const [key, value] of Object.entries(fields)) {
      detached[key] = value && typeof value === 'object' && Object.isFrozen(value) ? value : clone(value);
    }
    const event = deepFreeze({
      type,
      jobId: runtime.manifest.id,
      revision: runtime.manifest.revision,
      ...detached
    });
    for (const listener of [...listeners]) {
      try { listener(event); } catch (_) { /* listener isolation */ }
    }
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function runtimeFor(manifest) {
    return {
      manifest,
      queue: new BoundedQueue(queueLimit),
      producerDone: false,
      pauseRequested: false,
      cancelRequested: false,
      stopRequested: false,
      pauseWaiters: [],
      // Per-item worker state. With concurrency 1 there is at most one entry,
      // which reproduces the original single-worker pipeline exactly.
      children: new Map(),
      encodeFps: new Map(),
      ownerships: new Map(),
      inFlight: new Set(),
      leadItemId: null,
      commitHolder: null,
      commitWaiters: [],
      liveWorkers: 0,
      parkedWorkers: 0,
      pausePersisted: false,
      abortController: new AbortController(),
      runPromise: null,
      runKind: null,
      persistChain: Promise.resolve(),
      scannerStarted: false,
      itemSequence: manifest.items.length,
      stopPhase: null,
      stopItemId: null
    };
  }

  function update(runtime, buildPatch) {
    const operation = runtime.persistChain.catch(() => undefined).then(async () => {
      let patch = typeof buildPatch === 'function' ? buildPatch(runtime.manifest) : buildPatch;
      // Stamp state changes so a finished job knows when it finished (elapsed
      // time and average speed after completion).
      if (patch && typeof patch.state === 'string' && patch.state !== runtime.manifest.state && !('updatedAt' in patch)) {
        const at = clock.now();
        patch = { ...patch, updatedAt: at };
        // Leaving a pause (including one across an app restart) or retrying a
        // finished job: that time was not working time. updatedAt marks when
        // the idle state began.
        const previous = runtime.manifest;
        if (IDLE_JOB_STATES.has(previous.state) && Number.isSafeInteger(previous.updatedAt)
            && Number.isSafeInteger(at) && at > previous.updatedAt) {
          patch.pausedMs = (Number.isSafeInteger(previous.pausedMs) ? previous.pausedMs : 0) + (at - previous.updatedAt);
        }
      }
      runtime.manifest = await store.transition(runtime.manifest.id, patch);
      if (listeners.size > 0) emit(runtime, 'snapshot', { snapshot: publicSnapshot(runtime.manifest) });
      return runtime.manifest;
    });
    runtime.persistChain = operation;
    return operation;
  }

  function itemPatch(runtime, itemId, changes, jobChanges = {}) {
    return update(runtime, (current) => ({
      ...(isLead(runtime, itemId) ? jobChanges : {}),
      items: current.items.map((item) => item.id === itemId ? mergeItem(item, changes) : item)
    }));
  }

  function ownershipFor(runtime, itemId) {
    return runtime.ownerships.get(itemId) || null;
  }

  function setOwnership(runtime, itemId, value) {
    if (value) runtime.ownerships.set(itemId, value);
    else runtime.ownerships.delete(itemId);
  }

  function concurrencyOf(manifest) {
    const value = manifest?.config?.concurrency;
    return isValidConcurrency(value) ? value : CONCURRENCY.fallback;
  }

  // The job-level recovery fields (state, activeItemId, ownedPaths,
  // ownedArtifacts, publicationArtifact, replacementPhase, recovery) describe a
  // single item, because crash recovery reconciles exactly one active item. With
  // several workers only the "lead" item may write them:
  //   - the commit holder (publishing/replacing is exclusive, see acquireCommit),
  //   - otherwise the oldest in-flight item, or any item when it runs alone.
  // Every other in-flight item persists its ownership on the item itself and is
  // cleaned up and re-queued by recovery (see releaseInterruptedItems).
  function isLead(runtime, itemId) {
    if (runtime.recoveryRequired) return itemId === runtime.recoveryItemId;
    if (runtime.commitHolder) return runtime.commitHolder === itemId;
    if (runtime.inFlight.size <= 1) return true;
    return runtime.leadItemId === itemId;
  }

  function leadItemId(runtime) {
    return runtime.commitHolder || runtime.leadItemId || null;
  }

  function beginItem(runtime, item) {
    runtime.inFlight.add(item.id);
    if (!runtime.leadItemId || !runtime.inFlight.has(runtime.leadItemId)) runtime.leadItemId = item.id;
    setOwnership(runtime, item.id, ownershipOf(item));
  }

  function finishItem(runtime, itemId) {
    const paths = Object.values(ownershipFor(runtime, itemId)?.ownedPaths || {});
    const item = currentItem(runtime, itemId);
    if (typeof staging.releaseLeases === 'function') {
      try { staging.releaseLeases([...paths, ...Object.values(item?.ownedPaths || {})]); } catch (_) { /* best effort */ }
    }
    runtime.inFlight.delete(itemId);
    runtime.ownerships.delete(itemId);
    runtime.children.delete(itemId);
    releaseCommit(runtime, itemId);
    if (runtime.leadItemId === itemId) runtime.leadItemId = runtime.inFlight.values().next().value || null;
  }

  // Publishing (copying) and in-place replacement run one item at a time so the
  // job-level recovery state always describes the item that is mid-transaction.
  // The holder keeps the slot until its outcome, success or failure, is
  // persisted (released in finishItem).
  async function acquireCommit(runtime, itemId) {
    let waited = false;
    while (runtime.commitHolder && runtime.commitHolder !== itemId) {
      waited = true;
      await new Promise((resolve) => runtime.commitWaiters.push(resolve));
    }
    if ((runtime.recoveryRequired && runtime.recoveryItemId !== itemId)
        || (waited && (runtime.cancelRequested || runtime.stopRequested))) {
      runtime.commitWaiters.shift()?.();
      throw serviceError('CANCELLED');
    }
    runtime.commitHolder = itemId;
  }

  function releaseCommit(runtime, itemId) {
    if (runtime.commitHolder !== itemId) return;
    runtime.commitHolder = null;
    runtime.commitWaiters.shift()?.();
  }

  function terminateChildren(runtime) {
    for (const entry of runtime.children.values()) {
      if (entry.terminationRequested) continue;
      entry.terminationRequested = true;
      entry.child.kill('SIGTERM');
    }
  }

  function mergeItem(item, changes) {
    const next = { ...item };
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next;
  }

  function transactionPersistence(runtime, itemId) {
    return async (snapshot) => {
      const clearKeys = Array.isArray(snapshot.clearOwnedKeys) ? snapshot.clearOwnedKeys : [];
      let combined;
      const jobChanges = {};
      if (snapshot.phase && REPLACEMENT_PHASES.has(snapshot.phase)) {
        jobChanges.replacementPhase = snapshot.phase;
        jobChanges.state = 'replacing';
      }
      await update(runtime, (current) => {
        const item = current.items.find((entry) => entry.id === itemId);
        combined = composeOwnership(item || current, snapshot, clearKeys);
        const itemChanges = { ...item, ...combined };
        if (!combined.publicationArtifact) delete itemChanges.publicationArtifact;
        if (snapshot.phase && REPLACEMENT_PHASES.has(snapshot.phase)) itemChanges.replacementPhase = snapshot.phase;
        if (!isLead(runtime, itemId)) {
          return { items: current.items.map((entry) => entry.id === itemId ? itemChanges : entry) };
        }
        return {
          ...jobChanges,
          ownedPaths: combined.ownedPaths,
          ownedArtifacts: combined.ownedArtifacts,
          publicationArtifact: combined.publicationArtifact || null,
          items: current.items.map((entry) => entry.id === itemId ? itemChanges : entry)
        };
      });
      setOwnership(runtime, itemId, combined);
    };
  }

  function nextItemId(runtime) {
    runtime.itemSequence += 1;
    return `item-${String(runtime.itemSequence).padStart(6, '0')}`;
  }

  function createQueueItem(runtime, discovered) {
    return {
      ...clone(discovered),
      id: nextItemId(runtime),
      state: 'queued',
      attempts: 0
    };
  }

  async function produce(runtime) {
    runtime.scannerStarted = true;
    const identity = (item) => `${item.relativePath}\u0000${item.sourcePath}`;
    const known = new Set(runtime.manifest.items.map(identity));
    let pending = [];
    let lastFlush = -Infinity;
    // Items are always persisted before they are enqueued; batching only changes
    // how many share one manifest write.
    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      await update(runtime, (current) => ({ items: [...current.items, ...batch] }));
      if (discoveryBatchSize > 1) lastFlush = clock.now();
      for (const item of batch) await runtime.queue.push(item.id);
    };
    try {
      for await (const discovered of scanner(runtime.manifest.config, {
        signal: runtime.abortController.signal,
        retryOperation: ({ path: affectedPath, operation }) => retryAffectedOperation(runtime, affectedPath, operation)
      })) {
        if (runtime.cancelRequested || runtime.stopRequested) break;
        const key = identity(discovered);
        if (known.has(key)) continue;
        // Automatic jobs skip clips an earlier automatic run already handled.
        if (typeof deps.skipDiscovered === 'function' && deps.skipDiscovered(runtime.manifest.config, discovered)) continue;
        known.add(key);
        pending.push(createQueueItem(runtime, discovered));
        if (pending.length >= discoveryBatchSize || clock.now() - lastFlush >= discoveryFlushMs) await flush();
      }
      if (!runtime.cancelRequested && !runtime.stopRequested) {
        await flush();
        await update(runtime, { discoveryComplete: true });
      }
      runtime.producerDone = true;
      runtime.queue.close();
    } catch (error) {
      runtime.producerDone = true;
      runtime.queue.close();
      const controlledAbort = runtime.cancelRequested || runtime.stopRequested || runtime.recoveryRequired
        || error?.name === 'AbortError' || error?.code === 'CANCELLED';
      if (!controlledAbort) {
        await update(runtime, {
          state: 'failed',
          activeItemId: null,
          summary: null,
          summaryDismissed: false,
          failure: { code: stableFailure(error, 'discovery-failed'), retryable: network.isRetryable(error) === true }
        });
        throw error;
      }
    }
  }

  // A pause lets in-flight items finish; the job reports "paused" once every
  // live worker has parked (with one worker that is immediately, as before).
  async function persistPauseWhenParked(runtime) {
    if (!runtime.pauseRequested || runtime.cancelRequested || runtime.pausePersisted) return;
    // A halted job (failed rollback, stop, fatal worker error) owns its own
    // job-level state; a pause must never overwrite it.
    if (runtime.recoveryRequired || runtime.stopRequested || runtime.halted) return;
    if (runtime.liveWorkers === 0 || runtime.parkedWorkers < runtime.liveWorkers) return;
    runtime.pausePersisted = true;
    await update(runtime, { state: 'paused', activeItemId: null });
    emit(runtime, 'paused');
  }

  async function waitWhilePaused(runtime) {
    if (!runtime.pauseRequested || runtime.cancelRequested) return;
    runtime.parkedWorkers += 1;
    try {
      const parked = new Promise((resolve) => runtime.pauseWaiters.push(resolve));
      await persistPauseWhenParked(runtime);
      await parked;
    } finally {
      runtime.parkedWorkers -= 1;
    }
  }

  async function waitForNetwork(runtime, target, options = {}) {
    // Only one wait persists the job-level paused_network state; concurrent
    // workers waiting on the same outage just poll their own path.
    const persist = options.persist !== false && !runtime.networkPauseOwner
      && (!options.itemId || isLead(runtime, options.itemId));
    const item = currentItem(runtime, options.itemId || leadItemId(runtime) || runtime.manifest.activeItemId);
    const observedState = options.resumeState || runtime.manifest.state;
    const resumeState = observedState === 'discovering' && item ? 'waiting' : observedState;
    const phase = resumeState === 'replacing'
      ? (options.phase || runtime.manifest.replacementPhase)
      : undefined;
    const normalizedTarget = pathApi.resolve(target).toLowerCase();
    const pathRole = options.pathRole || (item && pathApi.resolve(item.sourcePath).toLowerCase() === normalizedTarget
      ? 'source'
      : item && pathApi.resolve(outputPath(runtime.manifest.config, item)).toLowerCase() === normalizedTarget
        ? 'destination' : 'discovery');
    const ownerToken = persist ? {} : null;
    if (persist) runtime.networkPauseOwner = ownerToken;
    // Leadership is re-checked when each write is applied: another item may
    // have entered the exclusive publish/replace phase meanwhile, and its
    // job-level state must not be overwritten.
    const stillLead = () => !options.itemId || isLead(runtime, options.itemId);
    let persisted = false;
    try {
    if (persist) {
      await update(runtime, () => {
        if (!stillLead()) return {};
        persisted = true;
        return {
          state: 'paused_network',
          activeItemId: item?.id || null,
          recovery: {
            fromState: 'paused_network', action: 'resume-network', pathRole, resumeState,
            ...(phase ? { phase } : {})
          }
        };
      });
    }
    emit(runtime, 'paused_network', { status: 'waiting' });
    let delay = backoff.initialMs;
    while (!runtime.cancelRequested && !runtime.stopRequested) {
      let available = false;
      try {
        available = await abortableRead(() => network.checkPath(target, {
          allowAncestor: pathRole === 'destination', signal: runtime.abortController.signal
        }), runtime.abortController.signal) === true;
      } catch (_) { available = false; }
      if (runtime.cancelRequested || runtime.stopRequested) throw serviceError('CANCELLED');
      if (available) {
        if (persisted) {
          await update(runtime, () => (stillLead() ? {
            state: resumeState,
            recovery: null,
            ...(resumeState === 'replacing' ? { replacementPhase: phase } : {})
          } : {}));
        }
        emit(runtime, 'network_reconnected', { status: 'resuming' });
        return;
      }
      await Promise.race([
        clock.sleep(delay),
        new Promise((_, reject) => runtime.abortController.signal.addEventListener('abort',
          () => reject(serviceError('CANCELLED')), { once: true }))
      ]);
      delay = Math.min(backoff.maximumMs, delay * 2);
    }
    throw serviceError('CANCELLED');
    } finally {
      if (ownerToken && runtime.networkPauseOwner === ownerToken) runtime.networkPauseOwner = null;
    }
  }

  function isRetryableNetwork(error, target) {
    return network.isRetryable(error) === true
      || (typeof network.isPathUnavailable === 'function' && network.isPathUnavailable(error, target) === true);
  }

  async function retryAffectedOperation(runtime, target, operation) {
    while (true) {
      if (runtime.abortController.signal.aborted) throw serviceError('CANCELLED');
      try { return await operation(); } catch (error) {
        if (!isRetryableNetwork(error, target)) throw error;
        await waitForNetwork(runtime, target, { persist: false });
      }
    }
  }

  async function retryTransactionOperation(runtime, itemId, target, operation, networkProbePath = target) {
    while (true) {
      try { return await operation(); } catch (error) {
        if (!isRetryableNetwork(error, target)) throw error;
        const reconciled = await reconcileItemOwnership(runtime, itemId, ownershipFor(runtime, itemId));
        if (!reconciled) throw Object.assign(new Error('cleanup pending'), { code: 'OWNED_CLEANUP_FAILED' });
        await waitForNetwork(runtime, networkProbePath, { pathRole: 'destination', itemId });
      }
    }
  }

  function currentItem(runtime, itemId) {
    return runtime.manifest.items.find((item) => item.id === itemId);
  }

  async function prepareDestination(config, destination) {
    const destinationGuard = await deps.ensureDestinationParent({
      destinationRoot: config.destinationRoot,
      destination
    });
    if (!destinationGuard || typeof destinationGuard.revalidate !== 'function') {
      throw serviceError('DESTINATION_CONTAINMENT_UNAVAILABLE');
    }
    await destinationGuard.revalidate();
  }

  function outputPath(config, item) {
    return config.outputMode === 'replace'
      ? item.sourcePath
      : pathApi.resolve(config.destinationRoot, ...item.relativePath.split('/'));
  }

  async function runChild(runtime, itemId, source, target, codec, encoder, { bitrate, quality = null }, decodeAccel = null) {
    const hwFrames = Array.isArray(decodeAccel) && decodeAccel.includes('-hwaccel_output_format');
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
      ...(decodeAccel || []),
      '-i', source,
      ...buildEncodeArgs({ codec, encoder: encoder.codec, bitrate, quality, hwFrames }),
      '-an', '-sn', '-dn',
      '-progress', 'pipe:1', '-nostats',
      '-f', 'mp4', target
    ];
    let child;
    try {
      child = deps.spawnProcess(ffmpegPath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (_) {
      return { ok: false, code: 'encoder-start-failed' };
    }
    if (!child || typeof child.once !== 'function' || !child.stdout?.on || typeof child.kill !== 'function') {
      return { ok: false, code: 'encoder-start-failed' };
    }
    const entry = { child, terminationRequested: false };
    runtime.children.set(itemId, entry);
    // A cancel/stop issued while this item was starting must still stop it.
    if (runtime.cancelRequested || runtime.stopRequested || runtime.recoveryRequired) {
      entry.terminationRequested = true;
      child.kill('SIGTERM');
    }
    child.stderr?.on?.('data', () => {});
    let buffered = '';
    const progress = {};
    child.stdout.on('data', (chunk) => {
      buffered = `${buffered}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)}`.slice(-8192);
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      for (const line of lines) {
        const separator = line.indexOf('=');
        if (separator < 1) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (key === 'out_time_ms' || key === 'out_time_us') {
          const parsed = Number(value);
          if (Number.isSafeInteger(parsed) && parsed >= 0) progress.outTimeUs = parsed;
        } else if (key === 'fps') {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 0) runtime.encodeFps.set(itemId, parsed);
        } else if (key === 'progress' && (value === 'continue' || value === 'end')) {
          progress.phase = value;
          // The UI shows one live progress line: the lead item's, plus the
          // combined frames per second of every encode running right now.
          if (isLead(runtime, itemId)) {
            let fps = 0;
            for (const value of runtime.encodeFps.values()) fps += value;
            emit(runtime, 'progress', { progress: { ...progress, fps: Math.round(fps * 10) / 10 } });
          }
        }
      }
    });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (runtime.children.get(itemId) === entry) runtime.children.delete(itemId);
        runtime.encodeFps.delete(itemId);
        resolve(result);
      };
      child.once('error', () => finish({ ok: false, code: 'encoder-start-failed' }));
      child.once('close', (code, signal) => {
        if (runtime.cancelRequested || runtime.stopRequested || runtime.recoveryRequired || signal) {
          finish({ ok: false, code: 'cancelled' });
        } else finish(code === 0 ? { ok: true } : { ok: false, code: 'encoder-failed' });
      });
    });
  }

  async function cleanupOwnership(runtime, itemId, ownership) {
    if (!ownership?.ownedPaths || !ownership?.ownedArtifacts) return { cleaned: true };
    // Any retained original requires replacement-specific reconciliation. Never
    // hand the backup or its recovery companions to generic cleanup.
    if (ownership.ownedPaths.replacementBackup) return {
      cleaned: false, recoveryRequired: true, cleanupPending: Object.keys(ownership.ownedPaths), ...ownership
    };
    try {
      const result = await staging.cleanupOwnedArtifacts({
        codec: runtime.manifest.config.codec,
        jobId: runtime.manifest.id,
        itemId,
        source: currentItem(runtime, itemId)?.sourcePath,
        sourceRoot: runtime.manifest.config.sourceRoot,
        ownedPaths: ownership.ownedPaths,
        ownedArtifacts: ownership.ownedArtifacts,
        publicationArtifact: ownership.publicationArtifact,
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, itemId)
      });
      if (result.cleaned === true) {
        setOwnership(runtime, itemId, composeOwnership(ownershipFor(runtime, itemId) || ownership, {}, Object.keys(ownership.ownedPaths)));
      } else {
        setOwnership(runtime, itemId, composeOwnership(ownershipFor(runtime, itemId), result));
      }
      return result;
    } catch (error) {
      return { cleaned: false, cleanupPending: error?.cleanupPending || Object.keys(ownership.ownedPaths) };
    }
  }

  async function reconcileItemOwnership(runtime, itemId, ownership) {
    if (!ownership || Object.keys(ownership.ownedPaths || {}).length === 0) return true;
    setOwnership(runtime, itemId, ownershipOf(ownership));
    const cleanup = await cleanupOwnership(runtime, itemId, ownershipFor(runtime, itemId));
    if (cleanup.cleaned === true) {
      await itemPatch(runtime, itemId, {
        ownedPaths: {}, ownedArtifacts: {}, publicationArtifact: undefined, replacementPhase: undefined
      });
      setOwnership(runtime, itemId, ownershipOf(currentItem(runtime, itemId)));
      return true;
    }
    const retained = composeOwnership(ownership, cleanup);
    await itemPatch(runtime, itemId, {
      ownedPaths: retained.ownedPaths,
      ownedArtifacts: retained.ownedArtifacts,
      publicationArtifact: retained.publicationArtifact,
      resultCode: 'cleanup-pending'
    }, {
      ownedPaths: retained.ownedPaths,
      ownedArtifacts: retained.ownedArtifacts,
      publicationArtifact: retained.publicationArtifact || null
    });
    return false;
  }

  // Also used for a video whose conversion would not save space (custom
  // bitrate or constant quality): the original is kept (replace mode) or
  // copied unchanged (separate mode) instead of failing the clip.
  async function processAsset(runtime, item, codes = { retained: 'asset-retained', copied: 'copied' }) {
    if (runtime.manifest.config.outputMode === 'replace') {
      await itemPatch(runtime, item.id, { state: 'skipped', resultCode: codes.retained, eligibleVideo: false }, {
        state: 'waiting', activeItemId: null
      });
      return;
    }
    const destination = outputPath(runtime.manifest.config, item);
    await acquireCommit(runtime, item.id);
    await itemPatch(runtime, item.id, { state: 'processing', eligibleVideo: false }, {
      state: 'copying', activeItemId: item.id
    });
    let result;
    try {
      result = await retryTransactionOperation(runtime, item.id, destination, async () => {
        await prepareDestination(runtime.manifest.config, destination);
        return staging.copyAsset({
          source: item.sourcePath,
          sourceRoot: runtime.manifest.config.sourceRoot,
          destination,
          destinationRoot: runtime.manifest.config.destinationRoot,
          jobId: runtime.manifest.id,
          itemId: item.id,
          signal: runtime.abortController.signal,
          persistTransaction: transactionPersistence(runtime, item.id)
        });
      }, runtime.manifest.config.destinationRoot);
    } catch (error) {
      if (!error?.validFinal?.finalPath || !Number.isSafeInteger(error.validFinal.outputBytes)) throw error;
      result = error.validFinal;
    }
    const publicationCleanup = await cleanupOwnership(runtime, item.id, result);
    const cleanupPending = publicationCleanup.cleanupPending || [];
    const completed = {
      state: 'completed',
      eligibleVideo: false,
      outputPath: result.finalPath,
      outputBytes: result.outputBytes,
      resultCode: cleanupPending.length ? 'completed-cleanup-pending' : codes.copied,
      ownedPaths: publicationCleanup.cleaned === false ? result.ownedPaths : {},
      ownedArtifacts: publicationCleanup.cleaned === false ? result.ownedArtifacts : {}
    };
    await update(runtime, (current) => {
      const finished = { ...current.items.find((entry) => entry.id === item.id), ...completed };
      return {
        state: 'waiting',
        activeItemId: null,
        ownedPaths: null,
        ownedArtifacts: null,
        publicationArtifact: null,
        items: current.items.map((entry) => entry.id === item.id ? finished : entry),
        counters: addCompletedFile(current.counters, finished)
      };
    });
  }

  async function videoSource(runtime, item) {
    let expectedSource;
    const replacing = runtime.manifest.config.outputMode === 'replace';
    if (replacing) {
      if (staging.capabilities?.replacement === 'unavailable') throw serviceError('ATOMIC_PROMOTION_UNSUPPORTED');
      if (typeof staging.captureSource !== 'function') throw serviceError('SOURCE_AUTHORITY_REQUIRED');
    }
    // Fingerprint the original read-only before anything else touches it. When
    // it is copied to local staging, the copy itself fingerprints it with the
    // same identity checks, so a network source is read once instead of twice.
    const captureAuthority = async () => {
      expectedSource = await staging.captureSource({ source: item.sourcePath, signal: runtime.abortController.signal });
      await itemPatch(runtime, item.id, { expectedSource });
    };
    let mode = runtime.manifest.config.networkMode;
    let space;
    if (mode === 'auto') {
      if (typeof deps.classifyPath !== 'function' || typeof deps.chooseStagingMode !== 'function'
          || typeof deps.checkStagingSpace !== 'function') throw serviceError('STAGING_POLICY_UNAVAILABLE');
      const classification = await deps.classifyPath(item.sourcePath);
      space = await deps.checkStagingSpace({ sourceBytes: item.sourceBytes, outputBytes: item.sourceBytes });
      mode = deps.chooseStagingMode({ networkMode: 'auto', classification, space });
    }
    if (mode !== 'staging') {
      if (replacing) await captureAuthority();
      return { source: item.sourcePath, ownership: null, expectedSource };
    }
    if (!space) {
      if (typeof deps.checkStagingSpace !== 'function') throw serviceError('STAGING_POLICY_UNAVAILABLE');
      space = await deps.checkStagingSpace({ sourceBytes: item.sourceBytes, outputBytes: item.sourceBytes });
      if (space?.sufficient !== true) throw serviceError('INSUFFICIENT_STAGING_SPACE');
    }
    await itemPatch(runtime, item.id, { state: 'processing' }, { state: 'staging', activeItemId: item.id });
    const result = await staging.stageSource({
      source: item.sourcePath,
      expectedSource,
      jobId: runtime.manifest.id,
      itemId: item.id,
      signal: runtime.abortController.signal,
      persistTransaction: transactionPersistence(runtime, item.id)
    });
    const stagedAuthority = result.expectedSource || expectedSource;
    if (replacing) {
      // Replacement and its crash recovery both require this fingerprint.
      if (!stagedAuthority) throw serviceError('SOURCE_AUTHORITY_REQUIRED');
      await itemPatch(runtime, item.id, { expectedSource: stagedAuthority });
    }
    return {
      source: result.stagedSource || result.path,
      ownership: result.ownedPaths ? result : null,
      expectedSource: stagedAuthority
    };
  }

  async function processVideoOnce(runtime, item) {
    const signal = runtime.abortController.signal;
    const timing = createItemTiming();
    const inspected = await deps.inspectVideo(item, item.sourcePath, signal);
    timing.mark('inspect');
    if (inspected.codec === 'h265' || inspected.codec === 'av1') {
      await itemPatch(runtime, item.id, {
        state: 'skipped', eligibleVideo: false, resultCode: 'already-converted'
      }, { state: 'waiting', activeItemId: null });
      return;
    }
    if (inspected.codec !== 'h264') throw Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED_CODEC' });
    await itemPatch(runtime, item.id, { state: 'processing', eligibleVideo: true }, {
      state: 'waiting', activeItemId: item.id
    });
    const staged = await videoSource(runtime, item);
    timing.mark('source');
    try {
    const timeline = await deps.readTimeline({ source: staged.source, item, signal });
    timing.mark('timeline');
    const codec = runtime.manifest.config.codec;
    const profileId = runtime.manifest.config.profileId;
    const customBitrate = profileId === 'custom';
    // Constant quality: the encoder holds a quality level; no bitrate or target.
    const quality = profileId === 'quality' ? runtime.manifest.config.qualityLevel : null;
    const noTarget = !hasSizeTarget(profileId);
    const targetBytes = noTarget ? null : targetOutputBytes(item.sourceBytes, profileId);
    let bitrate = quality ? null : customBitrate ? runtime.manifest.config.bitrateKbps * 1000 : calculateInitialBitrate({
      codec,
      targetBytes,
      durationSeconds: inspected.durationSeconds,
      containerReserveBytes: inspected.containerReserveBytes || 0,
      telemetryReserveBytes: inspected.telemetryReserveBytes || 0
    });
    let selected = await planner.select(codec);
    let usedCpuFallback = selected.hardware !== true;
    // Hardware rate-control backends commonly overshoot a byte target on
    // variable-frame-rate Tesla clips. Leave a small headroom so the first
    // candidate normally lands inside the profile window; the bounded retry
    // remains available for encoders that still miss.
    if (selected.hardware === true && !noTarget) bitrate = Math.max(SAFE_VIDEO_BITRATE_FLOORS[codec], Math.floor(bitrate * 0.93));
    let sizeRetryCount = 0;
    let attempts = currentItem(runtime, item.id)?.attempts || 0;
    let latestOwnership = staged.ownership;
    let encodeTiers = encodeDecodeTiers(selected);
    const failedTiers = [];
    let decodeTierRetry = false;

    while (!runtime.cancelRequested && !runtime.stopRequested) {
      // Retrying the same encoder with a slower decode tier is not a new
      // attempt; the job file allows at most 3 recorded attempts per clip.
      if (!decodeTierRetry) attempts += 1;
      decodeTierRetry = false;
      attempts = Math.min(attempts, MAX_RECORDED_ATTEMPTS);
      await itemPatch(runtime, item.id, { attempts, encoder: selected.codec }, {
        state: 'encoding', activeItemId: item.id
      });
      const reserved = await staging.reserveEncodeOutput({
        jobId: runtime.manifest.id,
        itemId: item.id,
        extension: '.mp4',
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      });
      latestOwnership = reserved;
      setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), reserved));
      const usedTier = encodeTiers[0] || null;
      const encoded = await runChild(runtime, item.id, staged.source, reserved.path, codec, selected, { bitrate, quality }, usedTier?.args || null);
      timing.mark('encode');
      if (!encoded.ok) {
        let failedOwnership = reserved;
        try {
          failedOwnership = await staging.adoptEncodeOutput({
            jobId: runtime.manifest.id,
            itemId: item.id,
            ownedPaths: reserved.ownedPaths,
            ownedArtifacts: reserved.ownedArtifacts,
            signal: runtime.abortController.signal,
            persistTransaction: transactionPersistence(runtime, item.id)
          });
          latestOwnership = failedOwnership;
          setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), failedOwnership));
        } catch (_) { /* an absent output remains a safe missing-intent cleanup */ }
        const cleanup = await cleanupOwnership(runtime, item.id, failedOwnership);
        if (cleanup.cleaned === false) {
          setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), failedOwnership));
          throw Object.assign(new Error('cleanup pending'), { code: 'OWNED_CLEANUP_FAILED' });
        }
        if (encoded.code === 'cancelled') throw serviceError('CANCELLED');
        // Retry the same GPU encoder with CPU decoding before giving up on it.
        if (usedTier) {
          failedTiers.push(usedTier.key);
          encodeTiers = encodeTiers.slice(1);
          decodeTierRetry = true;
          continue;
        }
        if (selected.hardware === true && !usedCpuFallback) {
          selected = await planner.selectCpuFallback(codec);
          usedCpuFallback = true;
          continue;
        }
        throw Object.assign(new Error('encode failed'), { code: 'ENCODER_FAILED' });
      }
      // A slower decode tier fixed what a faster one broke: stop offering those.
      for (const key of failedTiers.splice(0)) {
        if (key.startsWith(`${selected.codec}:`)) encodeDecodeBroken.add(key);
      }
      let adopted = await staging.adoptEncodeOutput({
        jobId: runtime.manifest.id,
        itemId: item.id,
        ownedPaths: reserved.ownedPaths,
        ownedArtifacts: reserved.ownedArtifacts,
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      });
      latestOwnership = adopted;
      setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), adopted));
      await itemPatch(runtime, item.id, {}, { state: 'writing-telemetry', activeItemId: item.id });
      try {
        await deps.writers[codec]({
          candidatePath: reserved.path,
          timeline,
          item: clone(currentItem(runtime, item.id)),
          signal
        });
      } catch (error) {
        try {
          adopted = await staging.adoptEncodeOutput({
            jobId: runtime.manifest.id,
            itemId: item.id,
            ownedPaths: adopted.ownedPaths,
            ownedArtifacts: adopted.ownedArtifacts,
            signal: runtime.abortController.signal,
            persistTransaction: transactionPersistence(runtime, item.id)
          });
          latestOwnership = adopted;
          setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), adopted));
        } catch (_) { /* retain the last proven identity for ownership-safe cleanup */ }
        throw error;
      }
      adopted = await staging.adoptEncodeOutput({
        jobId: runtime.manifest.id,
        itemId: item.id,
        ownedPaths: adopted.ownedPaths,
        ownedArtifacts: adopted.ownedArtifacts,
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      });
      latestOwnership = adopted;
      setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), adopted));
      timing.mark('metadata');
      await itemPatch(runtime, item.id, {}, { state: 'verifying', activeItemId: item.id });
      const verifyAccel = decodeAccelFor(selected, 'verify');
      const verifiedEncoder = selected.codec;
      const verification = await deps.verifier({
        source: staged.source,
        candidate: adopted.path,
        codec,
        profileId: runtime.manifest.config.profileId,
        sourceTimeline: timeline,
        sourceDurationUs: Math.round((inspected.durationSeconds || 0) * 1_000_000) || undefined,
        signal: runtime.abortController.signal,
        // Off / quick / full; replacing originals is never below quick.
        verifyMode: effectiveVerifyMode(runtime.manifest.config),
        ...(verifyAccel && effectiveVerifyMode(runtime.manifest.config) === 'full' ? {
          decodeAccel: verifyAccel,
          onDecodeAccelFallback: () => verifyDecodeFallbacks.set(verifiedEncoder, (verifyDecodeFallbacks.get(verifiedEncoder) || 0) + 1)
        } : {})
      });
      timing.mark('verify');
      if (!verification?.ok) {
        const retry = decideSizeRetry({
          retryCount: sizeRetryCount,
          failureReason: verification?.reason,
          codec,
          encoder: selected.codec,
          currentBitrate: bitrate,
          actualBytes: verification?.outputBytes,
          targetBytes
        });
        const cleanup = await cleanupOwnership(runtime, item.id, adopted);
        if (cleanup.cleaned === false) {
          setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), adopted));
          // Cleanup is secondary: preserve the reason this candidate was rejected.
          throw Object.assign(new Error('verification failed; cleanup pending'), {
            code: verification?.reason || 'VERIFICATION_FAILED',
            retryable: verification?.retryable === true
          });
        }
        if (retry.retry) {
          sizeRetryCount += 1;
          bitrate = retry.bitrate;
          continue;
        }
        if (noTarget && verification?.reason === 'not-smaller') throw serviceError('KEEP_ORIGINAL');
        const error = Object.assign(new Error('verification failed'), {
          code: verification?.reason || 'VERIFICATION_FAILED',
          retryable: verification?.retryable === true
        });
        throw error;
      }
      const publicationArtifact = verification.publicationArtifact;
      const destination = outputPath(runtime.manifest.config, item);
      const common = {
        publicationArtifact,
        jobId: runtime.manifest.id,
        itemId: item.id,
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      };
      await acquireCommit(runtime, item.id);
      timing.mark('saveWait');
      await itemPatch(runtime, item.id, {}, {
        state: 'copying',
        activeItemId: item.id
      });
      let published;
      try {
        if (runtime.manifest.config.outputMode !== 'replace') {
          await prepareDestination(runtime.manifest.config, destination);
        }
        published = runtime.manifest.config.outputMode === 'replace'
          ? await staging.replaceOriginal({
            ...common,
            codec: runtime.manifest.config.codec,
            source: item.sourcePath,
            expectedSource: staged.expectedSource,
            sourceRoot: runtime.manifest.config.sourceRoot
          })
          : await staging.publishSeparate({ ...common, destination });
      } catch (error) {
        if (!error?.validFinal?.finalPath || !Number.isSafeInteger(error.validFinal.outputBytes)) {
          if (isRetryableNetwork(error, destination)) {
            const affected = Object.assign(new Error('publication path unavailable'), {
              code: error.code,
              path: destination,
              networkProbePath: runtime.manifest.config.outputMode === 'replace'
                ? runtime.manifest.config.sourceRoot
                : runtime.manifest.config.destinationRoot,
              pathRole: runtime.manifest.config.outputMode === 'replace' ? 'source' : 'destination',
              cause: error,
              retryable: true
            });
            throw affected;
          }
          throw error;
        }
        published = error.validFinal;
      }
      timing.mark('save');
      const publicationCleanup = await cleanupOwnership(runtime, item.id, {
        ...published,
        publicationArtifact
      });
      const candidateCleanup = await cleanupOwnership(runtime, item.id, adopted);
      const stagedCleanup = await cleanupOwnership(runtime, item.id, staged.ownership);
      const cleanupPending = [...new Set([
        ...(publicationCleanup.cleanupPending || []),
        ...(candidateCleanup.cleanupPending || []),
        ...(stagedCleanup.cleanupPending || [])
      ])];
      const residualOwnership = {
        ownedPaths: {
          ...(publicationCleanup.cleaned === false ? published.ownedPaths : {}),
          ...(candidateCleanup.cleaned === false ? adopted.ownedPaths : {}),
          ...(stagedCleanup.cleaned === false ? staged.ownership?.ownedPaths : {})
        },
        ownedArtifacts: {
          ...(publicationCleanup.cleaned === false ? published.ownedArtifacts : {}),
          ...(candidateCleanup.cleaned === false ? adopted.ownedArtifacts : {}),
          ...(stagedCleanup.cleaned === false ? staged.ownership?.ownedArtifacts : {})
        }
      };
      const completed = {
        state: 'completed',
        eligibleVideo: true,
        outputPath: published.finalPath,
        outputBytes: verification.outputBytes,
        attempts,
        encoder: selected.codec,
        resultCode: cleanupPending.length ? 'completed-cleanup-pending' : 'converted',
        ownedPaths: residualOwnership.ownedPaths,
        ownedArtifacts: residualOwnership.ownedArtifacts
      };
      if (residualOwnership.ownedPaths.publicationSnapshot) completed.publicationArtifact = publicationArtifact;
      timing.mark('cleanup');
      const itemTiming = timing.result();
      await update(runtime, (current) => {
        const finished = { ...current.items.find((entry) => entry.id === item.id), ...completed };
        if (!residualOwnership.ownedPaths.publicationSnapshot) delete finished.publicationArtifact;
        delete finished.replacementPhase;
        return {
          state: 'waiting',
          activeItemId: null,
          ownedPaths: null,
          ownedArtifacts: null,
          publicationArtifact: null,
          replacementPhase: null,
          items: current.items.map((entry) => entry.id === item.id ? finished : entry),
          counters: addCompletedFile(current.counters, finished),
          timings: addItemTimings(current.timings, itemTiming.phases)
        };
      });
      emit(runtime, 'item_timing', {
        itemId: item.id, relativePath: item.relativePath, encoder: selected.codec, outputPath: published.finalPath,
        sourceBytes: item.sourceBytes, outputBytes: verification.outputBytes, attempts, ...itemTiming
      });
      return;
    }
    await cleanupOwnership(runtime, item.id, latestOwnership);
    throw serviceError('CANCELLED');
    } catch (error) {
      const cleanup = await cleanupOwnership(runtime, item.id, staged.ownership);
      if (cleanup.cleaned === false) setOwnership(runtime, item.id, composeOwnership(ownershipFor(runtime, item.id), staged.ownership));
      throw error;
    }
  }

  async function keepOriginalWhenNoSavings(runtime, item, operation) {
    try {
      return await operation();
    } catch (error) {
      if (error?.code !== 'KEEP_ORIGINAL' || Object.keys(ownershipFor(runtime, item.id)?.ownedPaths || {}).length > 0) throw error;
      return processAsset(runtime, currentItem(runtime, item.id), { retained: 'no-savings', copied: 'no-savings' });
    }
  }

  async function processVideo(runtime, item) {
    while (!runtime.cancelRequested && !runtime.stopRequested) {
      try {
        return await processVideoOnce(runtime, currentItem(runtime, item.id));
      } catch (error) {
        const affectedPath = typeof error.path === 'string' ? error.path : item.sourcePath;
        if (!isRetryableNetwork(error, affectedPath)) throw error;
        if (Object.keys(ownershipFor(runtime, item.id)?.ownedPaths || {}).length > 0) {
          const reconciled = await reconcileItemOwnership(runtime, item.id, ownershipFor(runtime, item.id));
          if (!reconciled) throw Object.assign(new Error('cleanup pending'), { code: 'OWNED_CLEANUP_FAILED' });
        }
        await waitForNetwork(runtime, error.networkProbePath || affectedPath, { pathRole: error.pathRole, itemId: item.id });
      }
    }
    throw serviceError('CANCELLED');
  }

  async function failItem(runtime, itemId, error) {
    const retryable = error?.retryable === true || isRetryableNetwork(error, currentItem(runtime, itemId)?.sourcePath);
    const code = stableFailure(error);
    // An error without a code is unexpected: keep its details in the log
    // (the job file only records the generic code).
    if (typeof error?.code !== 'string') {
      console.error('[CONVERTER] Unexpected clip failure:', String(error?.stack || error).slice(0, 2000));
    }
    const ownership = ownershipFor(runtime, itemId);
    if (ownership?.ownedPaths?.replacementBackup || error?.code === 'ROLLBACK_FAILED') {
      if (!runtime.recoveryRequired) {
        runtime.recoveryRequired = true;
        runtime.recoveryItemId = itemId;
      }
      runtime.queue.close();
      runtime.abortController.abort();
      // Other workers stop and re-queue their items; they never touch the
      // job-level state this item now owns (see isLead). Workers parked on a
      // pause must wake up and exit too, or the job would never settle.
      terminateChildren(runtime);
      for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
      const phase = runtime.manifest.replacementPhase || 'rollback-failed';
      await itemPatch(runtime, itemId, { state: 'processing', resultCode: 'recovery-required', failure: undefined }, {
        state: 'paused', activeItemId: itemId, replacementPhase: phase,
        recovery: { fromState: 'replacing', phase, action: 'manual-intervention' },
        summary: null, summaryDismissed: false
      });
      return;
    }
    const cleanup = await cleanupOwnership(runtime, itemId, ownership);
    if (cleanup.cleaned === true) setOwnership(runtime, itemId, ownershipOf(ownershipFor(runtime, itemId)));
    const haltedByRecovery = runtime.recoveryRequired && runtime.recoveryItemId !== itemId;
    const stopped = (runtime.stopRequested || haltedByRecovery) && !runtime.cancelRequested;
    const terminallyCancelled = runtime.cancelRequested;
    await itemPatch(runtime, itemId, {
      state: stopped ? 'queued' : (terminallyCancelled ? 'cancelled' : 'failed'),
      failure: stopped || terminallyCancelled ? undefined : { code, retryable },
      resultCode: stopped && cleanup.cleaned !== false ? undefined : (cleanup.cleaned === false ? 'cleanup-pending' : code),
      ownedPaths: cleanup.cleaned === false ? ownership?.ownedPaths : undefined,
      ownedArtifacts: cleanup.cleaned === false ? ownership?.ownedArtifacts : undefined
    }, {
      state: terminallyCancelled ? 'cancelled' : 'waiting',
      activeItemId: null,
      ownedPaths: cleanup.cleaned === false ? ownership?.ownedPaths : {},
      ownedArtifacts: cleanup.cleaned === false ? ownership?.ownedArtifacts : {},
      publicationArtifact: cleanup.cleaned === false ? ownership?.publicationArtifact || null : null,
      replacementPhase: cleanup.cleaned === false ? runtime.manifest.replacementPhase || null : null
    });
  }

  async function work(runtime) {
    runtime.liveWorkers += 1;
    try {
      while (!runtime.cancelRequested && !runtime.stopRequested && !runtime.recoveryRequired) {
        await waitWhilePaused(runtime);
        if (runtime.cancelRequested || runtime.stopRequested) break;
        const next = await runtime.queue.shift();
        if (next.done) break;
        const item = currentItem(runtime, next.value);
        if (!item || item.state !== 'queued') continue;
        beginItem(runtime, item);
        try {
          if (item.kind === 'asset') await processAsset(runtime, item);
          else await keepOriginalWhenNoSavings(runtime, item, () => processVideo(runtime, item));
        } catch (error) {
          await failItem(runtime, item.id, error);
        } finally {
          finishItem(runtime, item.id);
        }
      }
    } catch (error) {
      // A worker that cannot record an outcome fails the job; let the others
      // finish their current item and stop taking new ones.
      runtime.halted = true;
      runtime.queue.close();
      for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
      throw error;
    } finally {
      runtime.liveWorkers -= 1;
      // The remaining workers may all be parked on a pause already.
      await persistPauseWhenParked(runtime).catch(() => undefined);
    }
  }

  async function consume(runtime) {
    const workers = [];
    for (let index = 0; index < concurrencyOf(runtime.manifest); index += 1) workers.push(work(runtime));
    const results = await Promise.allSettled(workers);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  async function finalize(runtime) {
    await runtime.persistChain.catch(() => undefined);
    if (runtime.recoveryRequired || runtime.manifest.recovery?.action === 'manual-intervention') return;
    if (runtime.cancelRequested) {
      // Discovery persists items ahead of the workers, so a cancelled job can
      // hold queued items even after a worker already marked the job cancelled.
      if (runtime.manifest.state !== 'cancelled'
          || runtime.manifest.items.some((item) => item.state === 'queued' || item.state === 'processing')) {
        await update(runtime, (current) => ({
          state: 'cancelled',
          activeItemId: null,
          summary: null,
          summaryDismissed: false,
          failure: null,
          items: current.items.map((item) => item.state === 'queued' || item.state === 'processing'
            ? mergeItem(item, { state: 'cancelled', failure: undefined })
            : item)
        }));
      }
      emit(runtime, 'cancelled');
      return;
    }
    if (runtime.stopRequested) {
      await update(runtime, (current) => {
        const unresolved = current.items.find((item) => Object.keys(item.ownedPaths || {}).length > 0);
        const interrupted = current.items.find((item) => item.id === runtime.stopItemId
          && Object.keys(item.ownedPaths || {}).length > 0);
        const mappedPhase = runtime.stopPhase === 'copying' || runtime.stopPhase === 'replacing'
          ? runtime.stopPhase : 'encoding';
        const recovery = mappedPhase === 'copying'
          ? { fromState: 'copying', action: interrupted ? 'manual-intervention' : 'restart-copy' }
          : mappedPhase === 'replacing' && current.replacementPhase
            ? { fromState: 'replacing', phase: current.replacementPhase, action: 'manual-intervention' }
            : {
              fromState: 'encoding',
              action: interrupted ? 'cleanup-and-restart-encoding' : 'restart-encoding'
            };
        return {
          state: 'paused',
          activeItemId: interrupted?.id || null,
          summary: null,
          summaryDismissed: false,
          failure: null,
          recovery,
          ownedPaths: unresolved?.ownedPaths || {},
          ownedArtifacts: unresolved?.ownedArtifacts || {},
          publicationArtifact: unresolved?.publicationArtifact || null,
          replacementPhase: mappedPhase === 'replacing' ? current.replacementPhase : null,
          items: current.items.map((item) => interrupted?.id === item.id
            ? mergeItem(item, { state: 'processing', failure: undefined })
            : item.state === 'processing' ? mergeItem(item, { state: 'queued', failure: undefined }) : item)
        };
      });
      emit(runtime, 'paused');
      return;
    }
    if (runtime.manifest.state === 'failed') return;
    if (runtime.manifest.discoveryComplete === false) {
      const fromState = runtime.manifest.state === 'discovering' ? 'discovering' : 'waiting';
      await update(runtime, {
        state: 'paused',
        activeItemId: null,
        summary: null,
        summaryDismissed: false,
        failure: null,
        recovery: { fromState, action: 'resume-discovery' }
      });
      emit(runtime, 'paused');
      return;
    }
    const summary = serializeSummary(runtime.manifest.counters);
    await update(runtime, (current) => {
      const unresolved = current.items.find((item) => Object.keys(item.ownedPaths || {}).length > 0);
      return {
        state: 'completed',
        activeItemId: null,
        summary,
        summaryDismissed: false,
        ownedPaths: unresolved?.ownedPaths || {},
        ownedArtifacts: unresolved?.ownedArtifacts || {},
        publicationArtifact: unresolved?.publicationArtifact || null,
        replacementPhase: null
      };
    });
    emit(runtime, 'completed', { summary });
  }

  function launch(runtime, { discover = true, itemIds = [] } = {}) {
    if (runtime.suppressLaunch) return Promise.resolve();
    if (runtime.runPromise && runtime.runKind !== 'recovery') return runtime.runPromise;
    const launchedFromRecovery = runtime.runKind === 'recovery';
    const producer = Promise.resolve().then(async () => {
      for (const itemId of itemIds) await runtime.queue.push(itemId);
      if (discover) await produce(runtime);
      else {
        runtime.producerDone = true;
        runtime.queue.close();
      }
    });
    const consumer = consume(runtime);
    const jobPromise = Promise.allSettled([producer, consumer])
      .then(async (results) => {
        const rejected = results.find((result) => result.status === 'rejected');
        if (rejected && runtime.manifest.state !== 'failed' && !runtime.cancelRequested && !runtime.stopRequested && !runtime.recoveryRequired) {
          await update(runtime, {
            state: 'failed', activeItemId: null, summary: null, summaryDismissed: false,
            failure: { code: stableFailure(rejected.reason), retryable: false }
          });
          return;
        }
        await finalize(runtime);
      });
    const tracked = jobPromise.finally(() => {
      if (runtime.runPromise === tracked) {
        runtime.runPromise = null;
        runtime.runKind = null;
      }
    });
    if (!launchedFromRecovery) {
      runtime.runKind = 'job';
      runtime.runPromise = tracked;
    }
    return tracked;
  }

  async function startUnlocked(config) {
    if (shuttingDown) throw serviceError('SERVICE_SHUTDOWN');
    const persistedJobs = await store.list();
    if (persistedJobs.some((manifest) => ACTIVE_STATES.has(manifest.state))) throw serviceError('JOB_ACTIVE');
    for (const runtime of jobs.values()) {
      if (ACTIVE_STATES.has(runtime.manifest.state) && !TERMINAL_STATES.has(runtime.manifest.state)) {
        throw serviceError('JOB_ACTIVE');
      }
    }
    const created = await store.create({
      config: clone(config),
      state: 'discovering',
      createdAt: clock.now(),
      updatedAt: clock.now(),
      items: [],
      counters: createEmptyCounters(),
      summary: null,
      summaryDismissed: false,
      discoveryComplete: false
    });
    const runtime = runtimeFor(created);
    jobs.set(created.id, runtime);
    emit(runtime, 'started', { snapshot: publicSnapshot(created) });
    launch(runtime, { discover: true });
    return created.id;
  }

  function start(config) {
    return serializeCommand(() => startUnlocked(config));
  }

  async function ensureRuntime(id) {
    if (jobs.has(id)) return jobs.get(id);
    const manifest = await store.load(id);
    if (!manifest) throw serviceError('JOB_NOT_FOUND');
    const runtime = runtimeFor(manifest);
    jobs.set(id, runtime);
    return runtime;
  }

  async function get(id) {
    const runtime = jobs.get(id);
    const manifest = runtime ? runtime.manifest : await store.load(id);
    if (!manifest) throw serviceError('JOB_NOT_FOUND');
    return publicSnapshot(manifest);
  }

  async function list() {
    return deepFreeze((await store.list()).map(publicSnapshot));
  }

  async function pause(id) {
    const runtime = await ensureRuntime(id);
    if (TERMINAL_STATES.has(runtime.manifest.state)) return publicSnapshot(runtime.manifest);
    runtime.pauseRequested = true;
    emit(runtime, 'pause_requested');
    return publicSnapshot(runtime.manifest);
  }

  async function resume(id) {
    const runtime = await ensureRuntime(id);
    if (runtime.manifest.state !== 'paused' && !runtime.pauseRequested) throw serviceError('JOB_NOT_PAUSED');
    await releaseInterruptedSave(runtime);
    if (runtime.manifest.activeItemId && runtime.manifest.recovery) throw serviceError('RECOVERY_REQUIRED');
    runtime.pauseRequested = false;
    runtime.pausePersisted = false;
    await update(runtime, { state: 'waiting', recovery: null });
    for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
    if (!runtime.runPromise) {
      runtime.queue = new BoundedQueue(queueLimit);
      launch(runtime, {
        discover: runtime.manifest.discoveryComplete === false,
        itemIds: runtime.manifest.items.filter((item) => item.state === 'queued').map((item) => item.id)
      });
    }
    emit(runtime, 'resumed');
    return publicSnapshot(runtime.manifest);
  }

  // A job parked mid-replacement (for example by an interrupted replace) can
  // only be cancelled once that original is safe. Re-inspect the files with the
  // replacement truth tables; if they show an unambiguous state, finish or roll
  // back that one item through the normal recovery path, then cancel. Ambiguous
  // states keep RECOVERY_REQUIRED.
  async function resolveReplacementBeforeCancel(runtime, id) {
    if (runtime.runPromise || typeof deps.inspectRecovery !== 'function') throw serviceError('RECOVERY_REQUIRED');
    const signal = runtime.abortController.signal;
    const inspectWithSignal = (manifest) => abortableRead(() => deps.inspectRecovery(manifest, { signal }), signal);
    // The recovery path normally relaunches the queue; for a cancel it must
    // only settle the interrupted item, and the cancel then finalizes the rest.
    runtime.suppressLaunch = true;
    try {
      const recovered = await store.recover(id, inspectWithSignal, { reinspectReplacement: true });
      runtime.manifest = recovered;
      if (recovered.recovery?.fromState !== 'replacing' || recovered.recovery.action === 'manual-intervention') {
        throw serviceError('RECOVERY_REQUIRED');
      }
      await performRecovery(runtime, id, inspectWithSignal, recovered);
      if (runtime.manifest.recovery?.fromState === 'replacing') throw serviceError('RECOVERY_REQUIRED');
    } finally {
      runtime.suppressLaunch = false;
    }
  }

  // A job stopped while saving a clip (the computer crashed, lost power or
  // was shut down mid-save) waits for a decision before it continues: its
  // workers show as busy, Resume answered RECOVERY_REQUIRED and Cancel did
  // nothing, so the job could not be ended from the app. With a separate
  // destination no original is at risk: the interrupted clips' leftover
  // working files are removed (a record is kept of any that cannot be) and
  // the clips go back in the queue, so Resume converts them again and Cancel
  // cancels them. Replacing originals keeps its stricter recovery.
  async function releaseInterruptedSave(runtime) {
    const recovery = runtime.manifest.recovery;
    if (recovery?.action !== 'manual-intervention' || recovery.fromState === 'replacing'
        || runtime.manifest.config.outputMode === 'replace' || runtime.runPromise) return false;
    const interrupted = runtime.manifest.items.filter((item) => item.state === 'processing');
    if (interrupted.some((item) => item.ownedPaths?.replacementBackup)) return false;
    const pending = new Set();
    for (const item of interrupted) {
      if (Object.keys(item.ownedPaths || {}).length === 0) continue;
      if (!await reconcileItemOwnership(runtime, item.id, ownershipOf(item))) pending.add(item.id);
    }
    await update(runtime, (current) => ({
      state: 'paused', activeItemId: null, recovery: null, replacementPhase: null,
      ownedPaths: {}, ownedArtifacts: {}, publicationArtifact: null, failure: null,
      items: current.items.map((entry) => {
        if (entry.state !== 'processing') return entry;
        return pending.has(entry.id)
          ? mergeItem(entry, { state: 'failed', resultCode: 'cleanup-pending', failure: { code: 'interrupted', retryable: false } })
          : mergeItem(entry, { state: 'queued', failure: undefined, resultCode: undefined });
      })
    }));
    for (const item of interrupted) {
      if (!pending.has(item.id)) setOwnership(runtime, item.id, null);
    }
    emit(runtime, 'interrupted_save_released', { pending: pending.size });
    return true;
  }

  async function cancel(id) {
    const runtime = await ensureRuntime(id);
    if (runtime.manifest.recovery?.fromState === 'replacing') await resolveReplacementBeforeCancel(runtime, id);
    await releaseInterruptedSave(runtime);
    // Still waiting on a decision (an original may be at risk): say so instead
    // of returning as if the job had been cancelled.
    if (runtime.manifest.recovery?.action === 'manual-intervention' && !runtime.runPromise) {
      throw serviceError('RECOVERY_REQUIRED');
    }
    if (runtime.manifest.state === 'cancelled') return publicSnapshot(runtime.manifest);
    runtime.cancelRequested = true;
    runtime.abortController.abort();
    runtime.queue.close();
    for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
    terminateChildren(runtime);
    if (runtime.runPromise) await runtime.runPromise;
    else await finalize(runtime);
    return publicSnapshot(runtime.manifest);
  }

  // Last resort for a job that cannot be ended normally (Cancel failed):
  // stop anything it is running and set it aside so the converter is free
  // again. Converted files and the clips themselves are kept; the job file is
  // renamed rather than deleted.
  async function discard(id) {
    const runtime = jobs.get(id);
    if (runtime) {
      runtime.cancelRequested = true;
      runtime.abortController.abort();
      runtime.queue?.close?.();
      for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
      terminateChildren(runtime);
      if (runtime.runPromise) {
        await Promise.race([runtime.runPromise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 30_000).unref?.())]);
      }
      jobs.delete(id);
    }
    if (typeof store.discard !== 'function') throw serviceError('OPERATION_FAILED');
    await store.discard(id);
    for (const listener of listeners) {
      try { listener(deepFreeze({ type: 'discarded', jobId: id })); } catch (_) { /* observers are advisory */ }
    }
    return { jobId: id, discarded: true };
  }

  async function retryFailed(id) {
    const runtime = await ensureRuntime(id);
    if (runtime.manifest.recovery?.fromState === 'replacing') throw serviceError('RECOVERY_REQUIRED');
    if (runtime.runPromise) throw serviceError('JOB_ACTIVE');
    if (!['completed', 'failed'].includes(runtime.manifest.state)) throw serviceError('JOB_NOT_RETRYABLE');
    if (!runtime.manifest.items.some((item) => item.state === 'failed')) throw serviceError('NO_FAILED_ITEMS');
    for (const item of runtime.manifest.items.filter((entry) => entry.state === 'failed')) {
      if (!await reconcileItemOwnership(runtime, item.id, item)) throw serviceError('RECOVERY_REQUIRED');
    }
    await update(runtime, (current) => ({
      state: 'waiting',
      summary: null,
      summaryDismissed: false,
      failure: null,
      items: current.items.map((item) => item.state === 'failed'
        ? mergeItem(item, { state: 'queued', attempts: 0, failure: undefined, resultCode: undefined })
        : item)
    }));
    runtime.queue = new BoundedQueue(queueLimit);
    launch(runtime, {
      discover: false,
      itemIds: runtime.manifest.items.filter((item) => item.state === 'queued').map((item) => item.id)
    });
    return publicSnapshot(runtime.manifest);
  }

  async function dismissSummary(id) {
    const runtime = await ensureRuntime(id);
    if (runtime.manifest.state !== 'completed') throw serviceError('JOB_NOT_COMPLETED');
    await update(runtime, { summary: null, summaryDismissed: true });
    emit(runtime, 'summary_dismissed');
    return publicSnapshot(runtime.manifest);
  }

  // With several workers, items other than the job-level active item may have
  // been mid-encode when the app stopped. They never entered the exclusive
  // publish/replace phase, so their owned artifacts are temporary encode
  // outputs: clean them up and queue the items again.
  async function releaseInterruptedItems(runtime, keepItemId) {
    const interrupted = runtime.manifest.items.filter((entry) => entry.state === 'processing' && entry.id !== keepItemId);
    for (const item of interrupted) {
      if (Object.keys(item.ownedPaths || {}).length === 0) continue;
      if (!await reconcileItemOwnership(runtime, item.id, item)) return false;
    }
    if (interrupted.length === 0) return true;
    const ids = new Set(interrupted.map((entry) => entry.id));
    await update(runtime, (current) => ({
      items: current.items.map((entry) => ids.has(entry.id) && entry.state === 'processing'
        ? mergeItem(entry, { state: 'queued', failure: undefined, resultCode: undefined }) : entry)
    }));
    return true;
  }

  async function performRecovery(runtime, id, inspectWithSignal, recovered) {
    let recovery = recovered.recovery;
    if (concurrencyOf(recovered) > 1 && recovery?.action !== 'manual-intervention'
        && !await releaseInterruptedItems(runtime, recovered.activeItemId)) {
      return publicSnapshot(runtime.manifest);
    }
    if (recovery?.action === 'resume-network') {
      const interrupted = currentItem(runtime, recovered.activeItemId);
      const target = recovery.pathRole === 'destination' && interrupted
        ? recovered.config.destinationRoot
        : recovery.pathRole === 'source' && interrupted ? interrupted.sourcePath : recovered.config.sourceRoot;
      const resumeState = recovery.resumeState || 'waiting';
      await waitForNetwork(runtime, target, { resumeState, phase: recovery.phase, pathRole: recovery.pathRole });
      if (new Set(['staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing']).has(resumeState)) {
        recovered = await store.recover(id, inspectWithSignal);
        runtime.manifest = recovered;
        recovery = recovered.recovery;
      } else {
        if (interrupted && Object.keys(interrupted.ownedPaths || {}).length > 0) {
          setOwnership(runtime, interrupted.id, ownershipOf(interrupted));
          if (!await reconcileItemOwnership(runtime, interrupted.id, ownershipFor(runtime, interrupted.id))) {
            return publicSnapshot(runtime.manifest);
          }
        }
        await update(runtime, (current) => ({
          state: 'waiting', activeItemId: null, recovery: null,
          items: current.items.map((entry) => entry.state === 'processing'
            ? mergeItem(entry, { state: 'queued', failure: undefined }) : entry)
        }));
        runtime.queue = new BoundedQueue(queueLimit);
        await launch(runtime, {
          discover: runtime.manifest.discoveryComplete === false,
          itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
        });
        emit(runtime, 'recovered');
        return publicSnapshot(runtime.manifest);
      }
    }
    if (recovery?.action === 'resume-discovery' || recovery?.action === 'resume-queue') {
      await update(runtime, (current) => ({
        state: 'waiting',
        activeItemId: null,
        recovery: null,
        items: current.items.map((entry) => entry.state === 'processing'
          ? mergeItem(entry, { state: 'queued', failure: undefined }) : entry)
      }));
      runtime.queue = new BoundedQueue(queueLimit);
      await launch(runtime, {
        discover: recovery.action === 'resume-discovery',
        itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
      });
      emit(runtime, 'recovered');
      return publicSnapshot(runtime.manifest);
    }
    const item = currentItem(runtime, recovered.activeItemId);
    if (item?.state === 'completed') {
      await update(runtime, {
        state: 'waiting', activeItemId: null, recovery: null,
        ownedPaths: item.ownedPaths || {}, ownedArtifacts: item.ownedArtifacts || {},
        publicationArtifact: item.publicationArtifact || null, replacementPhase: null
      });
      runtime.queue = new BoundedQueue(queueLimit);
      await launch(runtime, {
        discover: runtime.manifest.discoveryComplete === false,
        itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
      });
      emit(runtime, 'recovered');
      return publicSnapshot(runtime.manifest);
    }
    if (!item || !recovery || recovery.action === 'manual-intervention') return publicSnapshot(recovered);

    async function completeRecovered(finalPath, outputBytes, transactionResult = {}) {
      const publicationArtifact = item.publicationArtifact || recovered.publicationArtifact;
      let retainedResult = transactionResult;
      if (Object.keys(transactionResult.ownedPaths || {}).length > 0) {
        const cleanup = await cleanupOwnership(runtime, item.id, {
          ...transactionResult,
          publicationArtifact
        });
        retainedResult = cleanup.cleaned === true
          ? { ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] }
          : {
            ownedPaths: cleanup.ownedPaths || transactionResult.ownedPaths || {},
            ownedArtifacts: cleanup.ownedArtifacts || transactionResult.ownedArtifacts || {},
            cleanupPending: cleanup.cleanupPending || transactionResult.cleanupPending || []
          };
      }
      const completed = {
        ...item,
        state: 'completed',
        eligibleVideo: true,
        outputPath: finalPath,
        outputBytes,
        resultCode: retainedResult.cleanupPending?.length ? 'completed-cleanup-pending' : 'converted',
        ownedPaths: retainedResult.ownedPaths || {},
        ownedArtifacts: retainedResult.ownedArtifacts || {}
      };
      delete completed.failure;
      if (completed.ownedPaths.publicationSnapshot) completed.publicationArtifact = publicationArtifact;
      else delete completed.publicationArtifact;
      delete completed.replacementPhase;
      await update(runtime, (current) => {
        const counters = addCompletedFile(current.counters, completed);
        return {
          state: 'waiting',
          activeItemId: null,
          recovery: null,
          items: current.items.map((entry) => entry.id === item.id ? completed : entry),
          counters,
          summary: null,
          summaryDismissed: false,
          ownedPaths: completed.ownedPaths,
          ownedArtifacts: completed.ownedArtifacts,
          publicationArtifact: completed.publicationArtifact || null,
          replacementPhase: null
        };
      });
      runtime.queue = new BoundedQueue(queueLimit);
      await launch(runtime, {
        discover: runtime.manifest.discoveryComplete === false,
        itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
      });
    }

    if (recovery.fromState === 'copying') {
      const destination = outputPath(recovered.config, item);
      if (item.kind === 'asset') {
        let result;
        if (recovery.action === 'finalize-copy') {
          const cleanup = await cleanupOwnership(runtime, item.id, item);
          result = {
            finalPath: destination,
            outputBytes: item.sourceBytes,
            ownedPaths: cleanup.cleaned === false ? item.ownedPaths : {},
            ownedArtifacts: cleanup.cleaned === false ? item.ownedArtifacts : {},
            cleanupPending: cleanup.cleanupPending || []
          };
        } else {
          if (item.ownedPaths && Object.keys(item.ownedPaths).length) {
            const cleanup = await cleanupOwnership(runtime, item.id, item);
            if (cleanup.cleaned === false) return publicSnapshot(runtime.manifest);
          }
          await prepareDestination(recovered.config, destination);
          result = await staging.copyAsset({
            source: item.sourcePath,
            sourceRoot: recovered.config.sourceRoot,
            destination,
            destinationRoot: recovered.config.destinationRoot,
            jobId: recovered.id,
            itemId: item.id,
            signal: runtime.abortController.signal,
            persistTransaction: transactionPersistence(runtime, item.id)
          });
          const cleanup = await cleanupOwnership(runtime, item.id, result);
          if (cleanup.cleaned !== false) {
            result = { ...result, ownedPaths: {}, ownedArtifacts: {}, cleanupPending: [] };
          } else {
            result = { ...result, cleanupPending: cleanup.cleanupPending || result.cleanupPending || [] };
          }
        }
        const completed = {
          ...item,
          state: 'completed',
          eligibleVideo: false,
          outputPath: result.finalPath,
          outputBytes: result.outputBytes,
          resultCode: result.cleanupPending?.length ? 'completed-cleanup-pending' : 'copied',
          ownedPaths: result.ownedPaths || {},
          ownedArtifacts: result.ownedArtifacts || {}
        };
        delete completed.failure;
        await update(runtime, (current) => {
          const counters = addCompletedFile(current.counters, completed);
          return {
            state: 'waiting', activeItemId: null, recovery: null,
            items: current.items.map((entry) => entry.id === item.id ? completed : entry),
            counters, summary: null, summaryDismissed: false,
            ownedPaths: completed.ownedPaths, ownedArtifacts: completed.ownedArtifacts,
            publicationArtifact: completed.publicationArtifact || null, replacementPhase: null
          };
        });
        runtime.queue = new BoundedQueue(queueLimit);
        await launch(runtime, {
          discover: runtime.manifest.discoveryComplete === false,
          itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
        });
        emit(runtime, 'recovered');
        return publicSnapshot(runtime.manifest);
      }
      const publicationArtifact = item.publicationArtifact || recovered.publicationArtifact;
      await prepareDestination(recovered.config, destination);
      let result = await staging.recoverCopy({
        action: recovery.action,
        destination,
        publicationArtifact,
        ownedPaths: item.ownedPaths || recovered.ownedPaths,
        ownedArtifacts: item.ownedArtifacts || recovered.ownedArtifacts,
        jobId: recovered.id,
        itemId: item.id,
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      });
      if (result.action === 'restart-copy') {
        await prepareDestination(recovered.config, destination);
        result = await staging.publishSeparate({
          publicationArtifact,
          destination,
          jobId: recovered.id,
          itemId: item.id,
          signal: runtime.abortController.signal,
          persistTransaction: transactionPersistence(runtime, item.id)
        });
      }
      await completeRecovered(result.finalPath, publicationArtifact.size, result);
    } else if (recovery.fromState === 'replacing') {
      const publicationArtifact = item.publicationArtifact || recovered.publicationArtifact;
      if (!item.expectedSource || staging.capabilities?.replacement === 'unavailable') {
        await update(runtime, { state: 'paused', recovery: { ...recovery, action: 'manual-intervention' } });
        return publicSnapshot(runtime.manifest);
      }
      let result = await staging.recoverReplacement({
        codec: recovered.config.codec,
        action: recovery.action,
        source: item.sourcePath,
        expectedSource: item.expectedSource,
        sourceRoot: recovered.config.sourceRoot,
        publicationArtifact: item.publicationArtifact || recovered.publicationArtifact,
        ownedPaths: item.ownedPaths || recovered.ownedPaths,
        ownedArtifacts: item.ownedArtifacts || recovered.ownedArtifacts,
        jobId: recovered.id,
        itemId: item.id,
        signal: runtime.abortController.signal,
        persistTransaction: transactionPersistence(runtime, item.id)
      });
      if (result.action === 'restart-replacement') {
        result = await staging.replaceOriginal({
          codec: recovered.config.codec,
          publicationArtifact,
          source: item.sourcePath,
          expectedSource: item.expectedSource,
          sourceRoot: recovered.config.sourceRoot,
          jobId: recovered.id,
          itemId: item.id,
          signal: runtime.abortController.signal,
          persistTransaction: transactionPersistence(runtime, item.id)
        });
      }
      if (result.phase === 'backup-deleted') {
        await completeRecovered(item.sourcePath, publicationArtifact.size, result);
      } else if (result.phase === 'backup-restored') {
        await itemPatch(runtime, item.id, { state: 'queued', failure: undefined }, {
          state: 'waiting', activeItemId: null, recovery: null, replacementPhase: null
        });
        runtime.queue = new BoundedQueue(queueLimit);
        await launch(runtime, {
          discover: runtime.manifest.discoveryComplete === false,
          itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
        });
      } else {
        await update(runtime, {
          state: 'paused',
          activeItemId: item.id,
          recovery: { fromState: 'replacing', phase: result.phase, action: 'manual-intervention' },
          replacementPhase: result.phase
        });
      }
    } else {
      if (recovery.action === 'cleanup-and-restart-encoding') {
        let interruptedOwnership = item;
        if (item.ownedArtifacts?.encodedCandidate?.state === 'intent') {
          try {
            interruptedOwnership = await staging.adoptEncodeOutput({
              jobId: recovered.id,
              itemId: item.id,
              ownedPaths: item.ownedPaths,
              ownedArtifacts: item.ownedArtifacts,
              signal: runtime.abortController.signal,
              persistTransaction: transactionPersistence(runtime, item.id)
            });
          } catch (_) {
            return publicSnapshot(runtime.manifest);
          }
        }
        const cleanup = await cleanupOwnership(runtime, item.id, interruptedOwnership);
        if (cleanup.cleaned === false) return publicSnapshot(runtime.manifest);
      }
      await itemPatch(runtime, item.id, { state: 'queued', failure: undefined }, {
        state: 'waiting', activeItemId: null, recovery: null
      });
      runtime.queue = new BoundedQueue(queueLimit);
      await launch(runtime, {
        discover: runtime.manifest.discoveryComplete === false,
        itemIds: runtime.manifest.items.filter((entry) => entry.state === 'queued').map((entry) => entry.id)
      });
    }
    emit(runtime, 'recovered');
    return publicSnapshot(runtime.manifest);
  }

  async function recover(id, inspectPaths = deps.inspectRecovery, { deferExecution = false } = {}) {
    let recoveryPromise;
    await serializeCommand(async () => {
      if (shuttingDown) throw serviceError('SERVICE_SHUTDOWN');
      if (typeof inspectPaths !== 'function') throw new TypeError('inspectPaths must be a function');
      const runtime = await ensureRuntime(id);
      // A failed startup can retry reconciliation without abandoning jobs that
      // already reconciled successfully and are still waiting at their gates.
      if (deferExecution && runtime.releaseRecovery) {
        recoveryPromise = runtime.reconciliationPromise;
        return;
      }
      if (runtime.runPromise) throw serviceError('JOB_ACTIVE');
      let reconciled, reconciliationFailed;
      const ready = new Promise((resolve, reject) => { reconciled = resolve; reconciliationFailed = reject; });
      ready.catch(() => {});
      runtime.reconciliationPromise = ready;
      const executionGate = deferExecution
        ? new Promise(resolve => { runtime.releaseRecovery = resolve; }) : Promise.resolve();
      const inspectWithSignal = manifest => abortableRead(
        () => inspectPaths(manifest, { signal: runtime.abortController.signal }), runtime.abortController.signal);
      let tracked;
      const operation = (async () => {
        try {
          const recovered = await store.recover(id, inspectWithSignal);
          runtime.manifest = recovered;
          if (runtime.stopRequested || runtime.cancelRequested) throw serviceError('CANCELLED');
          reconciled(publicSnapshot(recovered));
          await abortableRead(() => executionGate, runtime.abortController.signal);
          runtime.releaseRecovery = null;
          return await performRecovery(runtime, id, inspectWithSignal, recovered);
        } catch (error) {
          reconciliationFailed(error);
          if (!runtime.stopRequested && !runtime.cancelRequested) throw error;
          await finalize(runtime);
          return publicSnapshot(runtime.manifest);
        }
      })();
      tracked = operation.finally(() => {
        if (runtime.runPromise === tracked) {
          runtime.runPromise = null;
          runtime.runKind = null;
          runtime.releaseRecovery = null;
        }
      });
      // Deferred recoveries can reject before the runtime reaches their serial
      // execution slot. Observe failures immediately and retain the same owned
      // promise for whenIdle/shutdown and the runtime's error reporter.
      tracked.catch(error => emit(runtime, 'recovery_failed', { code: stableFailure(error) }));
      runtime.runKind = 'recovery';
      runtime.runPromise = tracked;
      recoveryPromise = deferExecution ? ready : tracked;
    });
    return recoveryPromise;
  }

  async function continueRecovery(id) {
    const runtime = await ensureRuntime(id);
    if (shuttingDown) return runtime.runPromise;
    runtime.releaseRecovery?.();
    return runtime.runPromise;
  }

  async function whenIdle(id) {
    const runtime = await ensureRuntime(id);
    while (runtime.runPromise) await runtime.runPromise;
    return publicSnapshot(runtime.manifest);
  }

  async function shutdown() {
    if (shuttingDown) {
      await Promise.all([...jobs.values()].map((runtime) => runtime.runPromise).filter(Boolean));
      return;
    }
    shuttingDown = true;
    await Promise.all([...jobs.values()].map(async (runtime) => {
      if (TERMINAL_STATES.has(runtime.manifest.state)) return;
      runtime.stopPhase = runtime.manifest.state === 'paused_network'
        ? runtime.manifest.recovery?.resumeState
        : runtime.manifest.state === 'paused' ? runtime.manifest.recovery?.fromState : runtime.manifest.state;
      runtime.stopItemId = runtime.manifest.activeItemId || leadItemId(runtime);
      runtime.stopRequested = true;
      runtime.abortController.abort();
      runtime.queue.close();
      for (const resolve of runtime.pauseWaiters.splice(0)) resolve();
      terminateChildren(runtime);
      if (runtime.runPromise) await runtime.runPromise;
      else await finalize(runtime);
    }));
  }

  return Object.freeze({
    start,
    get,
    list,
    pause: (...args) => serializeCommand(() => pause(...args)),
    resume: (...args) => serializeCommand(() => resume(...args)),
    cancel: (...args) => serializeCommand(() => cancel(...args)),
    discard: (...args) => serializeCommand(() => discard(...args)),
    retryFailed: (...args) => serializeCommand(() => retryFailed(...args)),
    dismissSummary,
    recover,
    continueRecovery,
    shutdown: (...args) => serializeCommand(() => shutdown(...args)),
    subscribe,
    whenIdle
  });
}

module.exports = {
  ConverterJobServiceError,
  createConverterJobService
};
