'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { classify, localDay, shouldSkipDir, isConverterArtifact } = require('./footage');

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
      if (isConverterArtifact(ent.name)) continue;
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
  return { files, errors, scannedAt: Date.now(), durationMs: Date.now() - started };
}

module.exports = { scanFootage, limiter };
