'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { classify, localDay, shouldSkipDir, leftoverInfo } = require('./footage');
const { mtimeKey } = require('./db');

/** Tiny promise limiter: at most `max` calls of fn in flight. */
function limiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) => new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    next();
  });
}

/**
 * Walk the footage root. Network shares make every stat a round trip, so
 * directory reads and stats run in parallel (bounded by `concurrency`).
 */
async function scanFootage(root, { concurrency = 16, onProgress } = {}) {
  const started = Date.now();
  const limit = limiter(concurrency);
  const files = new Map();
  const leftovers = [];
  const errors = [];
  let seen = 0;

  async function visit(relDir) {
    let entries;
    try {
      entries = await limit(() => fsp.readdir(path.join(root, relDir), { withFileTypes: true }));
    } catch (err) {
      errors.push({ rel: relDir || '.', message: err.message, code: err.code });
      return;
    }
    const tasks = [];
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (!shouldSkipDir(ent.name)) tasks.push(visit(rel));
        continue;
      }
      if (!ent.isFile()) continue;
      const left = leftoverInfo(ent.name);
      if (left) {
        leftovers.push({ rel, dir: relDir, original: left.original, kind: left.kind });
        continue;
      }
      const info = classify(rel);
      if (!info) continue;
      tasks.push(limit(() => fsp.stat(path.join(root, rel))).then(
        (st) => {
          files.set(rel, {
            rel,
            size: st.size,
            mtimeMs: st.mtimeMs,
            ...info,
            day: info.day || localDay(st.mtimeMs)
          });
          seen++;
          if (onProgress && seen % 500 === 0) onProgress(seen);
        },
        (err) => {
          if (err.code !== 'ENOENT') errors.push({ rel, message: err.message, code: err.code });
        }
      ));
    }
    await Promise.all(tasks);
  }

  await visit('');
  return { files, leftovers, errors, scannedAt: Date.now(), durationMs: Date.now() - started };
}

/** Where a file stands with encoding, based on its DB record. */
function encodeState(file, rec, maxAttempts = 3) {
  if (!file.encodable) return null;
  if (!rec || rec.size !== file.size || rec.mtimeMs !== mtimeKey(file.mtimeMs)) return 'pending';
  if (rec.status === 'failed' && rec.attempts < maxAttempts) return 'pending';
  return rec.status;
}

function emptyTypeTotals() {
  return {
    RecentClips: { bytes: 0, files: 0 },
    SentryClips: { bytes: 0, files: 0 },
    SavedClips: { bytes: 0, files: 0 },
    Other: { bytes: 0, files: 0 }
  };
}

/** Per-day totals, oldest day first. */
function summarizeDays(files, records, maxAttempts = 3) {
  const byDay = new Map();
  for (const f of files.values()) {
    let d = byDay.get(f.day);
    if (!d) {
      d = {
        day: f.day,
        bytes: 0,
        files: 0,
        clips: 0,
        events: new Set(),
        byType: emptyTypeTotals(),
        encode: { encoded: 0, pending: 0, skipped: 0, failed: 0, savedBytes: 0 }
      };
      byDay.set(f.day, d);
    }
    d.bytes += f.size;
    d.files++;
    d.byType[f.type].bytes += f.size;
    d.byType[f.type].files++;
    if (f.eventId) d.events.add(`${f.type}/${f.eventId}`);
    if (f.kind === 'clip') d.clips++;
    const rec = records.get(f.rel);
    const state = encodeState(f, rec, maxAttempts);
    if (state) {
      d.encode[state]++;
      if (state === 'encoded' && rec.originalSize) d.encode.savedBytes += Math.max(0, rec.originalSize - rec.encodedSize);
    }
  }
  return [...byDay.values()]
    .map((d) => ({ ...d, events: d.events.size }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

module.exports = { scanFootage, summarizeDays, encodeState, limiter };
