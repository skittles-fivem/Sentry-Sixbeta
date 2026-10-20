'use strict';

// Encode state lives on the container's local /data volume, never on the SMB
// share: SQLite file locking over SMB is unreliable.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  rel TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  original_size INTEGER,
  encoded_size INTEGER,
  codec TEXT,
  encoder TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  rel TEXT,
  status TEXT NOT NULL,
  message TEXT,
  original_size INTEGER,
  encoded_size INTEGER,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS history_at ON history(at);
`;

/** mtime as whole milliseconds so float noise never looks like a change. */
function mtimeKey(mtimeMs) {
  return Math.floor(Number(mtimeMs) || 0);
}

function rowToRecord(row) {
  if (!row) return undefined;
  return {
    rel: row.rel,
    size: Number(row.size),
    mtimeMs: Number(row.mtime_ms),
    status: row.status,
    reason: row.reason || null,
    originalSize: row.original_size === null ? null : Number(row.original_size),
    encodedSize: row.encoded_size === null ? null : Number(row.encoded_size),
    codec: row.codec || null,
    encoder: row.encoder || null,
    attempts: Number(row.attempts) || 0,
    updatedAt: Number(row.updated_at)
  };
}

class StateDB {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.stmts = {
      get: this.db.prepare('SELECT * FROM files WHERE rel = ?'),
      all: this.db.prepare('SELECT * FROM files'),
      upsert: this.db.prepare(`
        INSERT INTO files (rel, size, mtime_ms, status, reason, original_size, encoded_size, codec, encoder, attempts, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rel) DO UPDATE SET
          size = excluded.size, mtime_ms = excluded.mtime_ms, status = excluded.status,
          reason = excluded.reason, original_size = excluded.original_size,
          encoded_size = excluded.encoded_size, codec = excluded.codec,
          encoder = excluded.encoder, attempts = excluded.attempts,
          updated_at = excluded.updated_at`),
      del: this.db.prepare('DELETE FROM files WHERE rel = ?'),
      resetFailed: this.db.prepare("DELETE FROM files WHERE status = 'failed'"),
      getSetting: this.db.prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: this.db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      addHistory: this.db.prepare(
        'INSERT INTO history (at, rel, status, message, original_size, encoded_size, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      recentHistory: this.db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT ?'),
      trimHistory: this.db.prepare('DELETE FROM history WHERE id <= (SELECT MAX(id) FROM history) - ?'),
      totals: this.db.prepare(`
        SELECT status, COUNT(*) AS n,
               COALESCE(SUM(original_size), 0) AS orig,
               COALESCE(SUM(encoded_size), 0) AS enc
        FROM files GROUP BY status`)
    };
  }

  getFile(rel) {
    return rowToRecord(this.stmts.get.get(rel));
  }

  allFiles() {
    const map = new Map();
    for (const row of this.stmts.all.all()) map.set(row.rel, rowToRecord(row));
    return map;
  }

  upsertFile(rec) {
    this.stmts.upsert.run(
      rec.rel,
      Number(rec.size),
      mtimeKey(rec.mtimeMs),
      rec.status,
      rec.reason ?? null,
      rec.originalSize ?? null,
      rec.encodedSize ?? null,
      rec.codec ?? null,
      rec.encoder ?? null,
      rec.attempts ?? 0,
      Date.now()
    );
  }

  deleteFiles(rels) {
    this.transaction(() => {
      for (const rel of rels) this.stmts.del.run(rel);
    });
  }

  /** Drop records for files that no longer exist (only after a clean scan). */
  pruneMissing(presentRels) {
    const gone = [];
    for (const row of this.stmts.all.all()) {
      if (!presentRels.has(row.rel)) gone.push(row.rel);
    }
    if (gone.length) this.deleteFiles(gone);
    return gone.length;
  }

  resetFailed() {
    return Number(this.stmts.resetFailed.run().changes);
  }

  getSetting(key, fallback = null) {
    const row = this.stmts.getSetting.get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  setSetting(key, value) {
    this.stmts.setSetting.run(key, JSON.stringify(value));
  }

  addHistory(entry) {
    this.stmts.addHistory.run(
      Date.now(),
      entry.rel ?? null,
      entry.status,
      entry.message ?? null,
      entry.originalSize ?? null,
      entry.encodedSize ?? null,
      entry.durationMs ?? null
    );
    this.stmts.trimHistory.run(1000);
  }

  recentHistory(limit = 50) {
    return this.stmts.recentHistory.all(limit).map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      rel: row.rel,
      status: row.status,
      message: row.message,
      originalSize: row.original_size === null ? null : Number(row.original_size),
      encodedSize: row.encoded_size === null ? null : Number(row.encoded_size),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms)
    }));
  }

  totals() {
    const out = { encoded: 0, skipped: 0, failed: 0, originalBytes: 0, encodedBytes: 0 };
    for (const row of this.stmts.totals.all()) {
      out[row.status] = Number(row.n);
      if (row.status === 'encoded') {
        out.originalBytes = Number(row.orig);
        out.encodedBytes = Number(row.enc);
      }
    }
    return out;
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { StateDB, mtimeKey };
