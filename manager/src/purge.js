'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { isValidDay, safeJoin, TYPE_BY_FOLDER } = require('./footage');
const { limiter } = require('./scanner');
const { CLIP_TYPES } = require('./config');

// Finder / Explorer droppings that would otherwise keep an emptied event folder alive.
const JUNK_RE = /^(\._.+|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

/**
 * Delete every file the last scan put on one of `days` (optionally only some
 * clip types), then remove folders that became empty. Only paths that came
 * from the scan are deleted, and folders are removed with rmdir (never
 * recursively), so nothing outside Tesla footage can be lost.
 */
async function purgeDays({ root, files, days, types = CLIP_TYPES, encoder, db, log }) {
  const daySet = new Set(days.filter(isValidDay));
  const typeSet = new Set(types.filter((t) => CLIP_TYPES.includes(t)));
  if (!daySet.size) throw new Error('No valid days to purge.');
  if (!typeSet.size) throw new Error('No clip types selected.');

  const targets = [...files.values()].filter((f) => daySet.has(f.day) && typeSet.has(f.type));
  const rels = new Set(targets.map((f) => f.rel));
  if (encoder) await encoder.cancel(rels);

  const limit = limiter(8);
  const deleted = [];
  const errors = [];
  let freedBytes = 0;
  await Promise.all(targets.map((f) => limit(async () => {
    try {
      await fsp.unlink(safeJoin(root, f.rel));
      deleted.push(f.rel);
      freedBytes += f.size;
    } catch (err) {
      if (err.code === 'ENOENT') deleted.push(f.rel);
      else errors.push({ rel: f.rel, message: err.message });
    }
  })));

  for (const rel of deleted) files.delete(rel);
  if (db) db.deleteFiles(deleted);

  const removedDirs = await removeEmptyDirs(root, deleted, log);
  const summary = { days: [...daySet].sort(), types: [...typeSet], deletedFiles: deleted.length, freedBytes, removedDirs, errors };
  if (db) {
    db.addHistory({
      status: 'purged',
      message: `${summary.days.length} day(s) ${summary.days[0]}${summary.days.length > 1 ? ` to ${summary.days[summary.days.length - 1]}` : ''}: ${deleted.length} files, ${(freedBytes / 1e9).toFixed(2)} GB${errors.length ? `, ${errors.length} errors` : ''}`,
      originalSize: freedBytes
    });
  }
  log?.info(`Purged ${deleted.length} files (${(freedBytes / 1e9).toFixed(2)} GB) from ${summary.days.length} day(s)${errors.length ? `; ${errors.length} could not be deleted` : ''}`);
  return summary;
}

function isProtectedDir(rel) {
  // the root and its direct children (archive targets other tools expect) stay
  if (!rel || rel === '.' || !rel.includes('/')) return true;
  const name = rel.split('/').pop().toLowerCase();
  return Boolean(TYPE_BY_FOLDER[name]) || name === 'teslacam' || name === 'teslausb';
}

/** rmdir parents of deleted files, deepest first, stopping at protected folders. */
async function removeEmptyDirs(root, deletedRels, log) {
  const dirs = new Set();
  for (const rel of deletedRels) {
    let dir = path.posix.dirname(rel);
    while (dir && dir !== '.' && !isProtectedDir(dir)) {
      dirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  const ordered = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
  let removed = 0;
  for (const dir of ordered) {
    const abs = safeJoin(root, dir);
    try {
      const entries = await fsp.readdir(abs);
      if (entries.length && entries.every((n) => JUNK_RE.test(n))) {
        await Promise.all(entries.map((n) => fsp.rm(path.join(abs, n), { force: true })));
      }
      await fsp.rmdir(abs);
      removed++;
    } catch (err) {
      if (err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST' && err.code !== 'ENOENT') {
        log?.warn(`Could not remove folder ${dir}: ${err.message}`);
      }
    }
  }
  return removed;
}

module.exports = { purgeDays, removeEmptyDirs, isProtectedDir };
