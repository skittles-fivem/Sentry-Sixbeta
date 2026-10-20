'use strict';

// Manager state (settings, users, sessions, protected clips, Recycle Bin,
// jobs, notifications) in one SQLite file on the local /data volume — never
// on the SMB share, where SQLite locking is unreliable.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS protected (
  vehicle_id TEXT NOT NULL, rel TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (vehicle_id, rel)
);
CREATE TABLE IF NOT EXISTS bin_items (
  id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, label TEXT NOT NULL, category TEXT NOT NULL,
  start_at TEXT, bytes INTEGER NOT NULL, files TEXT NOT NULL, trashed_at INTEGER NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, vehicle_id TEXT, status TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT, external_id TEXT
);
CREATE INDEX IF NOT EXISTS jobs_started ON jobs(started_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_external ON jobs(external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, level TEXT NOT NULL, vehicle_id TEXT,
  title TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  resolved_at INTEGER, read_at INTEGER, dedupe_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_open ON notifications(dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
`;

const parse = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

class ManagerDB {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.cache = new Map();
  }

  q(sql) {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- settings
  get(key, fallback = null) {
    const row = this.q('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? parse(row.value, fallback) : fallback;
  }

  set(key, value) {
    this.q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  // ---- users / sessions
  getUser(username) {
    return this.q('SELECT * FROM users WHERE username = ?').get(username);
  }

  userCount() {
    return Number(this.q('SELECT COUNT(*) AS n FROM users').get().n);
  }

  putUser(username, salt, hash) {
    this.q(`INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, hash = excluded.hash`).run(username, salt, hash, Date.now());
  }

  addSession(tokenHash, username, expiresAt) {
    this.q('INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, username, Date.now(), expiresAt);
  }

  getSession(tokenHash) {
    return this.q('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, Date.now());
  }

  deleteSession(tokenHash) {
    this.q('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteSessionsFor(username) {
    this.q('DELETE FROM sessions WHERE username = ?').run(username);
  }

  pruneSessions() {
    this.q('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }

  // ---- protected clips
  protectedSet(vehicleId) {
    return new Set(this.q('SELECT rel FROM protected WHERE vehicle_id = ?').all(vehicleId).map((r) => r.rel));
  }

  setProtected(vehicleId, rels, on) {
    this.tx(() => {
      for (const rel of rels) {
        if (on) this.q('INSERT OR IGNORE INTO protected (vehicle_id, rel, created_at) VALUES (?, ?, ?)').run(vehicleId, rel, Date.now());
        else this.q('DELETE FROM protected WHERE vehicle_id = ? AND rel = ?').run(vehicleId, rel);
      }
    });
  }

  renameProtected(vehicleId, fromRel, toRel) {
    this.q('UPDATE OR IGNORE protected SET rel = ? WHERE vehicle_id = ? AND rel = ?').run(toRel, vehicleId, fromRel);
  }

  // ---- recycle bin
  addBinItem(item) {
    this.q(`INSERT INTO bin_items (id, vehicle_id, label, category, start_at, bytes, files, trashed_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(item.id, item.vehicleId, item.label, item.category, item.startAt ?? null,
      item.bytes, JSON.stringify(item.files), item.trashedAt, item.reason);
  }

  binItems(vehicleId) {
    const rows = vehicleId
      ? this.q('SELECT * FROM bin_items WHERE vehicle_id = ? ORDER BY trashed_at DESC').all(vehicleId)
      : this.q('SELECT * FROM bin_items ORDER BY trashed_at DESC').all();
    return rows.map(binRow);
  }

  binItem(id) {
    const row = this.q('SELECT * FROM bin_items WHERE id = ?').get(id);
    return row ? binRow(row) : null;
  }

  removeBinItem(id) {
    this.q('DELETE FROM bin_items WHERE id = ?').run(id);
  }

  updateBinFiles(id, files, bytes) {
    this.q('UPDATE bin_items SET files = ?, bytes = ? WHERE id = ?').run(JSON.stringify(files), bytes, id);
  }

  // ---- jobs
  startJob({ type, vehicleId = null, title, detail = null, externalId = null }) {
    if (externalId) {
      const existing = this.q('SELECT id FROM jobs WHERE external_id = ?').get(externalId);
      if (existing) return Number(existing.id);
    }
    const r = this.q('INSERT INTO jobs (type, vehicle_id, status, title, detail, started_at, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(type, vehicleId, 'running', title, detail, Date.now(), externalId);
    return Number(r.lastInsertRowid);
  }

  updateJob(id, { status, detail, result, finished } = {}) {
    const row = this.q('SELECT * FROM jobs WHERE id = ?').get(id);
    if (!row) return;
    this.q('UPDATE jobs SET status = ?, detail = ?, result = ?, finished_at = ? WHERE id = ?').run(
      status ?? row.status, detail ?? row.detail, result === undefined ? row.result : JSON.stringify(result),
      finished ? Date.now() : row.finished_at, id);
  }

  jobByExternal(externalId) {
    const row = this.q('SELECT * FROM jobs WHERE external_id = ?').get(externalId);
    return row ? jobRow(row) : null;
  }

  jobs({ limit = 200, vehicleId } = {}) {
    const rows = vehicleId
      ? this.q('SELECT * FROM jobs WHERE vehicle_id = ? OR vehicle_id IS NULL ORDER BY id DESC LIMIT ?').all(vehicleId, limit)
      : this.q('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(jobRow);
  }

  trimJobs(keep = 2000) {
    this.q("DELETE FROM jobs WHERE status != 'running' AND id <= (SELECT MAX(id) FROM jobs) - ?").run(keep);
  }

  // ---- notifications
  /** Open (or refresh) a notification; one open entry per dedupe key. */
  notify({ kind, level = 'warning', vehicleId = null, title, message = null, dedupeKey = null }) {
    const now = Date.now();
    if (dedupeKey) {
      const open = this.q('SELECT id FROM notifications WHERE dedupe_key = ? AND resolved_at IS NULL').get(dedupeKey);
      if (open) {
        this.q('UPDATE notifications SET level = ?, title = ?, message = ?, updated_at = ? WHERE id = ?').run(level, title, message, now, open.id);
        return Number(open.id);
      }
    }
    const r = this.q(`INSERT INTO notifications (kind, level, vehicle_id, title, message, created_at, updated_at, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(kind, level, vehicleId, title, message, now, now, dedupeKey);
    return Number(r.lastInsertRowid);
  }

  resolve(dedupeKey) {
    this.q('UPDATE notifications SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL').run(Date.now(), dedupeKey);
  }

  resolveId(id) {
    this.q('UPDATE notifications SET resolved_at = COALESCE(resolved_at, ?), read_at = COALESCE(read_at, ?) WHERE id = ?').run(Date.now(), Date.now(), id);
  }

  markRead(ids) {
    this.tx(() => {
      for (const id of ids) this.q('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?').run(Date.now(), id);
    });
  }

  notifications({ open, limit = 200, vehicleId } = {}) {
    let sql = 'SELECT * FROM notifications WHERE 1 = 1';
    const args = [];
    if (open === true) sql += ' AND resolved_at IS NULL';
    if (vehicleId) {
      sql += ' AND (vehicle_id = ? OR vehicle_id IS NULL)';
      args.push(vehicleId);
    }
    sql += ' ORDER BY (resolved_at IS NULL) DESC, updated_at DESC LIMIT ?';
    args.push(limit);
    return this.db.prepare(sql).all(...args).map((r) => ({
      id: Number(r.id), kind: r.kind, level: r.level, vehicleId: r.vehicle_id, title: r.title, message: r.message,
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
      resolvedAt: r.resolved_at === null ? null : Number(r.resolved_at), readAt: r.read_at === null ? null : Number(r.read_at)
    }));
  }

  close() {
    this.db.close();
  }
}

function binRow(r) {
  return {
    id: r.id, vehicleId: r.vehicle_id, label: r.label, category: r.category, startAt: r.start_at,
    bytes: Number(r.bytes), files: parse(r.files, []), trashedAt: Number(r.trashed_at), reason: r.reason
  };
}

function jobRow(r) {
  return {
    id: Number(r.id), type: r.type, vehicleId: r.vehicle_id, status: r.status, title: r.title, detail: r.detail,
    startedAt: Number(r.started_at), finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    result: r.result ? parse(r.result, null) : null, externalId: r.external_id
  };
}

module.exports = { ManagerDB };
