'use strict';

// Recycle Bin. "Move to trash" renames a recording's files into
// <vehicle root>/.sentry-recycle-bin/<item>/<original path>.binned — a rename
// on the same share, so it is instant. The .binned suffix keeps the files
// invisible to the converter and the viewer. Nothing in here ever deletes on
// its own: files only go away when the user deletes them forever or empties
// the bin.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { safeJoin, TYPE_BY_FOLDER } = require('./footage');

const BIN_DIR = '.sentry-recycle-bin';
const JUNK_RE = /^(\._.+|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

function isKeptDir(rel) {
  if (!rel || rel === '.' || !rel.includes('/')) return true; // root and its direct children
  const name = rel.split('/').pop().toLowerCase();
  return Boolean(TYPE_BY_FOLDER[name]) || name === 'teslacam' || name === 'teslausb';
}

/** rmdir folders left empty under `root`, deepest first, never recursively. */
async function removeEmptyDirs(root, rels, { keep = isKeptDir } = {}) {
  const dirs = new Set();
  for (const rel of rels) {
    for (let d = path.posix.dirname(rel); d && d !== '.' && !keep(d); d = path.posix.dirname(d)) dirs.add(d);
  }
  for (const d of [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const abs = safeJoin(root, d);
    try {
      const names = await fsp.readdir(abs);
      if (names.length && names.every((n) => JUNK_RE.test(n))) await Promise.all(names.map((n) => fsp.rm(path.join(abs, n), { force: true })));
      await fsp.rmdir(abs);
    } catch {
      // not empty or already gone
    }
  }
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

class RecycleBin {
  constructor({ db, vehicles, inventory, jobs, log, isBusy = () => false }) {
    Object.assign(this, { db, vehicles, inventory, jobs, log, isBusy });
  }

  rootOf(vehicleId) {
    const v = this.vehicles.get(vehicleId);
    if (!v) throw Object.assign(new Error('No such vehicle.'), { status: 404 });
    const share = this.vehicles.share(vehicleId);
    if (share && !share.isWritable()) throw Object.assign(new Error(`${v.name}: the share is not writable right now.`), { status: 503 });
    return { vehicle: v, root: this.vehicles.rootOf(v) };
  }

  /** Move recordings to the bin. Protected or busy recordings are refused. */
  async trash(vehicleId, recordingIds, { reason = 'manual' } = {}) {
    const { vehicle, root } = this.rootOf(vehicleId);
    const inv = this.inventory.get(vehicleId);
    if (!inv?.recordings) throw Object.assign(new Error('Footage has not been scanned yet.'), { status: 409 });
    const wanted = new Set(recordingIds);
    const recordings = inv.recordings.filter((r) => wanted.has(r.id));
    const result = { moved: [], skipped: [], bytes: 0 };
    const jobId = this.jobs.start({ type: reason === 'policy' ? 'policy' : 'trash', vehicleId, title: `Move ${recordings.length} recording(s) to the Recycle Bin` });
    for (const rec of recordings) {
      if (rec.protected) {
        result.skipped.push({ id: rec.id, reason: 'protected' });
        continue;
      }
      const busy = rec.files.find((rel) => this.isBusy(path.join(root, rel)));
      if (busy) {
        result.skipped.push({ id: rec.id, reason: 'converting' });
        continue;
      }
      const itemId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      const moved = [];
      try {
        for (const rel of rec.files) {
          const binRel = `${BIN_DIR}/${itemId}/${rel}.binned`;
          const from = safeJoin(root, rel);
          const to = safeJoin(root, binRel);
          await fsp.mkdir(path.dirname(to), { recursive: true });
          const size = inv.files.get(rel)?.size ?? (await fsp.stat(from)).size;
          await fsp.rename(from, to);
          moved.push({ rel, binRel, size });
        }
      } catch (err) {
        // put back whatever moved so a recording is never split
        for (const m of moved.reverse()) await fsp.rename(safeJoin(root, m.binRel), safeJoin(root, m.rel)).catch(() => {});
        await fsp.rm(safeJoin(root, `${BIN_DIR}/${itemId}`), { recursive: true, force: true }).catch(() => {});
        result.skipped.push({ id: rec.id, reason: err.code === 'ENOENT' ? 'missing' : 'error', message: err.message });
        continue;
      }
      const bytes = moved.reduce((n, m) => n + m.size, 0);
      this.db.addBinItem({
        id: itemId, vehicleId, label: `${rec.category} ${rec.start || ''}`.trim(), category: rec.category,
        startAt: rec.start, bytes, files: moved, trashedAt: Date.now(), reason
      });
      for (const m of moved) inv.files.delete(m.rel);
      result.moved.push(rec.id);
      result.bytes += bytes;
      await removeEmptyDirs(root, rec.files);
    }
    this.inventory.rebuild(vehicleId);
    this.jobs.finish(jobId, {
      status: result.skipped.some((s) => s.reason === 'error') ? 'failed' : 'done',
      detail: `${result.moved.length} moved (${formatBytes(result.bytes)})${result.skipped.length ? `, ${result.skipped.length} skipped` : ''}`,
      result
    });
    this.log.info(`${vehicle.name}: ${result.moved.length} recording(s) moved to the Recycle Bin (${reason})`);
    return result;
  }

  list(vehicleId) {
    return this.db.binItems(vehicleId);
  }

  /** Put an item back where it was; files whose spot is taken stay in the bin. */
  async restore(itemId) {
    const item = this.db.binItem(itemId);
    if (!item) throw Object.assign(new Error('Not in the Recycle Bin.'), { status: 404 });
    const { root } = this.rootOf(item.vehicleId);
    const left = [];
    const restored = [];
    for (const f of item.files) {
      const from = safeJoin(root, f.binRel);
      const to = safeJoin(root, f.rel);
      if (!(await exists(from))) continue;
      if (await exists(to)) {
        left.push({ ...f, conflict: true });
        continue;
      }
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      restored.push(f.rel);
    }
    if (left.length) this.db.updateBinFiles(itemId, left, left.reduce((n, f) => n + f.size, 0));
    else this.db.removeBinItem(itemId);
    await removeEmptyDirs(root, item.files.map((f) => f.binRel), { keep: (d) => d === BIN_DIR || isKeptDir(d) });
    const jobId = this.jobs.start({ type: 'restore', vehicleId: item.vehicleId, title: `Restore ${item.label}` });
    this.jobs.finish(jobId, { status: left.length ? 'failed' : 'done', detail: `${restored.length} file(s) restored${left.length ? `, ${left.length} could not (a file with that name exists)` : ''}` });
    this.inventory.scan(item.vehicleId).catch(() => {});
    return { restored: restored.length, conflicts: left.length };
  }

  /** Permanently delete one item (user action only). */
  async deleteForever(itemId) {
    const item = this.db.binItem(itemId);
    if (!item) throw Object.assign(new Error('Not in the Recycle Bin.'), { status: 404 });
    const { root } = this.rootOf(item.vehicleId);
    let bytes = 0;
    for (const f of item.files) {
      try {
        await fsp.unlink(safeJoin(root, f.binRel));
        bytes += f.size;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    await fsp.rm(safeJoin(root, `${BIN_DIR}/${itemId}`), { recursive: true, force: true });
    this.db.removeBinItem(itemId);
    return { bytes };
  }

  async empty(vehicleId) {
    const items = this.db.binItems(vehicleId);
    const jobId = this.jobs.start({ type: 'empty-bin', vehicleId, title: `Empty the Recycle Bin (${items.length} item(s))` });
    let bytes = 0;
    let failed = 0;
    for (const item of items) {
      try {
        bytes += (await this.deleteForever(item.id)).bytes;
      } catch (err) {
        failed++;
        this.log.warn(`Could not delete ${item.label}: ${err.message}`);
      }
    }
    this.jobs.finish(jobId, { status: failed ? 'failed' : 'done', detail: `${formatBytes(bytes)} freed${failed ? `, ${failed} failed` : ''}` });
    return { deleted: items.length - failed, failed, bytes };
  }

  binBytes(vehicleId) {
    return this.db.binItems(vehicleId).reduce((n, i) => n + i.bytes, 0);
  }
}

function formatBytes(n) {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

module.exports = { RecycleBin, removeEmptyDirs, BIN_DIR, formatBytes };
