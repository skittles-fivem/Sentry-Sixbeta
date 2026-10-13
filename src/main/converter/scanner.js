'use strict';

const fs = require('fs');
const path = require('path');

const GROUPS = Object.freeze(['RecentClips', 'SavedClips', 'SentryClips']);
const DEFAULT_GROUP_ORDER = Object.freeze(['SavedClips', 'SentryClips', 'RecentClips']);
const GROUP_BY_LOWER_NAME = new Map(GROUPS.map((group) => [group.toLowerCase(), group]));
// Filesystem calls the scanner may have in flight at once. Removable drives and
// network shares answer each realpath/stat/readdir with noticeable latency, so
// overlapping them is what makes discovery fast. The default (1) is the strictly
// sequential, fully lazy walk; the converter runtime opts in to look-ahead.
const DEFAULT_SCAN_CONCURRENCY = 1;

let teslaFilenameModulePromise;

function loadTeslaFilenameModule() {
  if (!teslaFilenameModulePromise) {
    teslaFilenameModulePromise = import('../../shared/teslaFilename.mjs');
  }
  return teslaFilenameModulePromise;
}

function createPathError(root, candidate) {
  const error = new Error(`Path is outside the selected root: ${candidate}`);
  error.code = 'PATH_OUTSIDE_ROOT';
  error.root = root;
  error.path = candidate;
  return error;
}

function normalizeForComparison(value, platform, pathApi) {
  const normalized = pathApi.normalize(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrDescendant(root, candidate, platform, pathApi) {
  const comparableRoot = normalizeForComparison(root, platform, pathApi);
  const comparableCandidate = normalizeForComparison(candidate, platform, pathApi);
  const relative = pathApi.relative(comparableRoot, comparableCandidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

function isSamePath(left, right, platform, pathApi) {
  return normalizeForComparison(left, platform, pathApi) ===
    normalizeForComparison(right, platform, pathApi);
}

function createAdapters(overrides = {}) {
  const concurrency = overrides.concurrency === undefined ? DEFAULT_SCAN_CONCURRENCY : overrides.concurrency;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError('concurrency must be a positive safe integer');
  }
  return {
    concurrency,
    opendir: overrides.opendir || fs.promises.opendir.bind(fs.promises),
    realpath: overrides.realpath || fs.promises.realpath.bind(fs.promises),
    lstat: overrides.lstat || fs.promises.lstat.bind(fs.promises),
    stat: overrides.stat || fs.promises.stat.bind(fs.promises),
    retryOperation: overrides.retryOperation || (async ({ operation }) => operation()),
    signal: overrides.signal,
    loadTeslaFilenameModule: overrides.loadTeslaFilenameModule || loadTeslaFilenameModule,
    path: overrides.path || path,
    platform: overrides.platform || process.platform
  };
}

async function resolveContainedPath(root, relativePath, adapterOverrides = {}) {
  const adapters = createAdapters(adapterOverrides);
  const pathApi = adapters.path;
  const rootPath = pathApi.resolve(root);

  if (typeof relativePath !== 'string' || relativePath.length === 0 || pathApi.isAbsolute(relativePath)) {
    throw createPathError(rootPath, relativePath);
  }

  const candidatePath = pathApi.resolve(rootPath, relativePath);
  if (!isSameOrDescendant(rootPath, candidatePath, adapters.platform, pathApi)) {
    throw createPathError(rootPath, candidatePath);
  }

  const [realRoot, realCandidate] = await Promise.all([
    adapters.realpath(rootPath),
    adapters.realpath(candidatePath)
  ]);

  if (!isSameOrDescendant(realRoot, realCandidate, adapters.platform, pathApi)) {
    throw createPathError(realRoot, realCandidate);
  }

  return realCandidate;
}

function canonicalGroup(name) {
  return GROUP_BY_LOWER_NAME.get(String(name || '').toLowerCase()) || null;
}

function normalizeIncludedGroups(includedGroups) {
  if (includedGroups === undefined) return new Set(GROUPS);
  if (!Array.isArray(includedGroups)) {
    throw new TypeError('includedGroups must be an array');
  }

  const result = new Set();
  for (const value of includedGroups) {
    const group = canonicalGroup(value);
    if (!group) throw new TypeError(`Unknown Tesla clip group: ${value}`);
    result.add(group);
  }
  return result;
}

function normalizeGroupOrder(groupOrder) {
  if (groupOrder === undefined) return DEFAULT_GROUP_ORDER;
  if (!Array.isArray(groupOrder) || groupOrder.length !== GROUPS.length
      || new Set(groupOrder).size !== GROUPS.length
      || groupOrder.some((group) => !GROUPS.includes(group))) {
    throw new TypeError('groupOrder must contain each Tesla clip group exactly once');
  }
  return groupOrder;
}

function isReplacementArtifact(name) {
  return /^(?:TEMP-(?:H265|AV1)-|BACKUP-)/i.test(name);
}

function toRelativePath(parts) {
  return parts.join('/');
}

function classifyEventAsset(filename, group, groupRelativeParts) {
  if (!['SavedClips', 'SentryClips'].includes(group) || groupRelativeParts.length === 0) {
    return null;
  }

  const lowerName = filename.toLowerCase();
  if (lowerName === 'event.json') return 'event-json';
  if (lowerName === 'event.mp4') return 'event-video';
  if (
    /^event\.(?:png|jpe?g|webp)$/i.test(filename) ||
    /^(?:thumb|thumbnail)\.(?:png|jpe?g|webp)$/i.test(filename)
  ) {
    return 'thumbnail';
  }
  return null;
}

function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  return async function run(operation) {
    while (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function cancelledError() {
  return Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
}

async function resolveDestinationRoot(destinationRoot, adapters) {
  if (!destinationRoot) return null;
  const absolutePath = adapters.path.resolve(destinationRoot);
  const missingSegments = [];
  let existingAncestor = absolutePath;

  while (true) {
    try {
      const realAncestor = await adapters.realpath(existingAncestor);
      return {
        absolutePath,
        realPath: adapters.path.resolve(realAncestor, ...missingSegments)
      };
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;

      try {
        const unresolvedEntry = await adapters.lstat(existingAncestor);
        const unsafeError = new Error(`Destination path cannot be resolved safely: ${existingAncestor}`);
        unsafeError.code = 'UNSAFE_DESTINATION_PATH';
        unsafeError.path = existingAncestor;
        unsafeError.cause = error;
        if (unresolvedEntry.isSymbolicLink()) throw unsafeError;
        throw unsafeError;
      } catch (lstatError) {
        if (!lstatError || lstatError.code !== 'ENOENT') throw lstatError;
      }

      const parent = adapters.path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.unshift(adapters.path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

async function* scanTeslaFootage(config = {}, adapterOverrides = {}) {
  if (!config || typeof config.sourceRoot !== 'string' || config.sourceRoot.length === 0) {
    throw new TypeError('sourceRoot is required');
  }

  const adapters = createAdapters(adapterOverrides);
  const pathApi = adapters.path;
  const includedGroups = normalizeIncludedGroups(config.includedGroups);
  const groupOrder = normalizeGroupOrder(config.groupOrder);
  const groupRank = new Map(groupOrder.map((group, index) => [group, index]));
  const sourceRoot = pathApi.resolve(config.sourceRoot);
  const sourceRealPath = await adapters.realpath(sourceRoot);
  const destination = await resolveDestinationRoot(config.destinationRoot, adapters);
  const rootGroup = canonicalGroup(pathApi.basename(sourceRoot));
  const { parseTeslaFilename } = await adapters.loadTeslaFilenameModule();

  if (rootGroup && !includedGroups.has(rootGroup)) return;
  if (destination && (
    isSamePath(destination.absolutePath, sourceRoot, adapters.platform, pathApi) ||
    isSamePath(destination.realPath, sourceRealPath, adapters.platform, pathApi)
  )) {
    throw new TypeError('destinationRoot must differ from sourceRoot');
  }
  const destinationAbsoluteInsideSource = destination &&
    isSameOrDescendant(sourceRoot, destination.absolutePath, adapters.platform, pathApi);
  const destinationRealInsideSource = destination &&
    isSameOrDescendant(sourceRealPath, destination.realPath, adapters.platform, pathApi);

  async function* walk(directoryPath, relativeParts, group, groupRelativeParts) {
    if (adapters.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    const directory = await adapters.retryOperation({
      kind: 'opendir', path: directoryPath, operation: () => adapters.opendir(directoryPath)
    });
    const iterator = directory[Symbol.asyncIterator]();
    try {
      const entries = [];
      while (true) {
        if (adapters.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
        const next = await adapters.retryOperation({
          kind: 'read', path: directoryPath, operation: () => iterator.next()
        });
        if (next.done) break;
        entries.push(next.value);
      }
      entries.sort((left, right) => {
        const leftGroup = canonicalGroup(left.name);
        const rightGroup = canonicalGroup(right.name);
        if (leftGroup && rightGroup) return groupRank.get(leftGroup) - groupRank.get(rightGroup);
        if (leftGroup) return -1;
        if (rightGroup) return 1;
        if (left.name === right.name) return 0;
        return left.name < right.name ? -1 : 1;
      });
      for (const entry of entries) {
      if (adapters.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      if (entry.isFile() && isReplacementArtifact(entry.name)) continue;
      const childPath = pathApi.join(directoryPath, entry.name);
      const childRelativeParts = relativeParts.concat(entry.name);

      if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        const childGroup = group || canonicalGroup(entry.name);
        if (childGroup && !includedGroups.has(childGroup)) continue;

        const childRealPath = await adapters.realpath(childPath);
        if (!isSameOrDescendant(sourceRealPath, childRealPath, adapters.platform, pathApi)) continue;

        if (destination && (
          (destinationAbsoluteInsideSource &&
            isSameOrDescendant(destination.absolutePath, childPath, adapters.platform, pathApi)) ||
          (destinationRealInsideSource &&
            isSameOrDescendant(destination.realPath, childRealPath, adapters.platform, pathApi))
        )) {
          continue;
        }

        const nextGroupRelativeParts = childGroup
          ? (group ? groupRelativeParts.concat(entry.name) : [])
          : [];
        yield* walk(childPath, childRelativeParts, childGroup, nextGroupRelativeParts);
        continue;
      }

      if (!entry.isFile()) continue;

      const parsedFilename = parseTeslaFilename(entry.name);
      const assetType = classifyEventAsset(entry.name, group, groupRelativeParts);
      if (!parsedFilename && !assetType) continue;

      const realFilePath = await adapters.realpath(childPath);
      if (!isSameOrDescendant(sourceRealPath, realFilePath, adapters.platform, pathApi)) continue;

      const fileStat = await adapters.stat(childPath);
      if (!fileStat.isFile()) continue;

      const eventId = group && ['SavedClips', 'SentryClips'].includes(group) && groupRelativeParts.length > 0
        ? groupRelativeParts[0]
        : null;
      const item = {
        kind: parsedFilename ? 'video' : 'asset',
        group: group || null,
        eventId,
        relativePath: toRelativePath(childRelativeParts),
        sourcePath: childPath,
        sourceBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      };

      if (parsedFilename) {
        item.timestampKey = parsedFilename.timestampKey;
        item.camera = parsedFilename.camera;
      } else {
        item.assetType = assetType;
      }

      yield item;
      }
    } finally {
      if (typeof iterator.return === 'function') await iterator.return();
    }
  }

  if (adapters.concurrency === 1) {
    yield* walk(sourceRoot, [], rootGroup, []);
    return;
  }

  // Look-ahead variant: identical decisions, checks and output order as walk(),
  // but the realpath/stat calls for upcoming entries and the listings of
  // upcoming child directories (only once they passed the containment and
  // destination checks) run ahead of the consumer, bounded by one scan-wide
  // limiter and a per-directory window. Results are consumed strictly in order,
  // so an error for entry k surfaces only after entries before it were yielded.
  const limit = createLimiter(adapters.concurrency);
  const window = adapters.concurrency;

  function compareEntries(left, right) {
    const leftGroup = canonicalGroup(left.name);
    const rightGroup = canonicalGroup(right.name);
    if (leftGroup && rightGroup) return groupRank.get(leftGroup) - groupRank.get(rightGroup);
    if (leftGroup) return -1;
    if (rightGroup) return 1;
    if (left.name === right.name) return 0;
    return left.name < right.name ? -1 : 1;
  }

  async function listDirectory(directoryPath) {
    if (adapters.signal?.aborted) throw cancelledError();
    const directory = await adapters.retryOperation({
      kind: 'opendir', path: directoryPath, operation: () => adapters.opendir(directoryPath)
    });
    const iterator = directory[Symbol.asyncIterator]();
    try {
      const entries = [];
      while (true) {
        if (adapters.signal?.aborted) throw cancelledError();
        const next = await adapters.retryOperation({
          kind: 'read', path: directoryPath, operation: () => iterator.next()
        });
        if (next.done) break;
        entries.push(next.value);
      }
      return entries.sort(compareEntries);
    } finally {
      if (typeof iterator.return === 'function') await iterator.return();
      // An iterator that never started does not close its handle on return().
      if (typeof directory.close === 'function') {
        try { await directory.close(); } catch (_) { /* already closed by the iterator */ }
      }
    }
  }

  function quiet(promise) {
    promise.catch(() => undefined);
    return promise;
  }

  // Returns null for entries skipped by cheap synchronous checks (no fs calls),
  // otherwise a promise of null (skipped after checks), a directory to descend
  // into, or an item to yield.
  function prepare(entry, directoryPath, relativeParts, group, groupRelativeParts) {
    if (entry.isFile() && isReplacementArtifact(entry.name)) return null;
    const childPath = pathApi.join(directoryPath, entry.name);
    const childRelativeParts = relativeParts.concat(entry.name);
    if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) return null;

    if (entry.isDirectory()) {
      const childGroup = group || canonicalGroup(entry.name);
      if (childGroup && !includedGroups.has(childGroup)) return null;
      return quiet((async () => {
        const childRealPath = await limit(() => adapters.realpath(childPath));
        if (!isSameOrDescendant(sourceRealPath, childRealPath, adapters.platform, pathApi)) return null;
        if (destination && (
          (destinationAbsoluteInsideSource &&
            isSameOrDescendant(destination.absolutePath, childPath, adapters.platform, pathApi)) ||
          (destinationRealInsideSource &&
            isSameOrDescendant(destination.realPath, childRealPath, adapters.platform, pathApi))
        )) {
          return null;
        }
        return {
          directory: true,
          path: childPath,
          relativeParts: childRelativeParts,
          group: childGroup,
          groupRelativeParts: childGroup ? (group ? groupRelativeParts.concat(entry.name) : []) : [],
          listing: quiet(limit(() => listDirectory(childPath)))
        };
      })());
    }

    if (!entry.isFile()) return null;
    const parsedFilename = parseTeslaFilename(entry.name);
    const assetType = classifyEventAsset(entry.name, group, groupRelativeParts);
    if (!parsedFilename && !assetType) return null;

    return quiet((async () => {
      const realFilePath = await limit(() => adapters.realpath(childPath));
      if (!isSameOrDescendant(sourceRealPath, realFilePath, adapters.platform, pathApi)) return null;
      const fileStat = await limit(() => adapters.stat(childPath));
      if (!fileStat.isFile()) return null;
      const eventId = group && ['SavedClips', 'SentryClips'].includes(group) && groupRelativeParts.length > 0
        ? groupRelativeParts[0]
        : null;
      const item = {
        kind: parsedFilename ? 'video' : 'asset',
        group: group || null,
        eventId,
        relativePath: toRelativePath(childRelativeParts),
        sourcePath: childPath,
        sourceBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      };
      if (parsedFilename) {
        item.timestampKey = parsedFilename.timestampKey;
        item.camera = parsedFilename.camera;
      } else {
        item.assetType = assetType;
      }
      return { item };
    })());
  }

  async function* walkAhead(directoryPath, relativeParts, group, groupRelativeParts, listing) {
    if (adapters.signal?.aborted) throw cancelledError();
    const entries = await (listing || limit(() => listDirectory(directoryPath)));
    const tasks = new Array(entries.length);
    let scheduled = 0;
    for (let index = 0; index < entries.length; index += 1) {
      if (adapters.signal?.aborted) throw cancelledError();
      for (; scheduled < Math.min(entries.length, index + window); scheduled += 1) {
        tasks[scheduled] = prepare(entries[scheduled], directoryPath, relativeParts, group, groupRelativeParts);
      }
      const task = tasks[index];
      tasks[index] = null;
      if (!task) continue;
      const prepared = await task;
      if (adapters.signal?.aborted) throw cancelledError();
      if (!prepared) continue;
      if (prepared.directory) {
        yield* walkAhead(prepared.path, prepared.relativeParts, prepared.group,
          prepared.groupRelativeParts, prepared.listing);
        continue;
      }
      yield prepared.item;
    }
  }

  yield* walkAhead(sourceRoot, [], rootGroup, []);
}

module.exports = {
  GROUPS,
  resolveContainedPath,
  scanTeslaFootage
};
