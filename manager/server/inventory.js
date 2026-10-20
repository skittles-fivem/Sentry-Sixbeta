'use strict';

// Recordings per vehicle, built from a scan of its footage:
//   - each Sentry / Saved event folder is one recording;
//   - Recent (and other) clips are grouped into continuous sessions: a gap
//     of more than ~90 s between one-minute clips starts a new recording.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { scanFootage } = require('./scanner');
const { safeJoin } = require('./footage');

const TS_RE = /(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/;
const CATEGORY = { RecentClips: 'Recent', SentryClips: 'Sentry', SavedClips: 'Saved', Other: 'Other' };
const SESSION_GAP_S = 90;

function tsFrom(name) {
  const m = String(name).match(TS_RE);
  return m ? `${m[1]}_${m[2]}-${m[3]}-${m[4]}` : null;
}

/** Seconds since epoch of a wall-clock key, treating it as UTC (only differences matter). */
function keySeconds(key) {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

const display = (key) => (key ? `${key.slice(0, 10)} ${key.slice(11).replace(/-/g, ':')}` : null);
const hashId = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Group a scan's file map into recordings (newest first). */
function buildRecordings(files, { vehicleId, protectedRels = new Set() } = {}) {
  const events = new Map();
  const loose = new Map(); // dir -> [{file, ts}]
  for (const f of files.values()) {
    const dir = path.posix.dirname(f.rel);
    if (f.eventId && (f.type === 'SentryClips' || f.type === 'SavedClips')) {
      if (!events.has(dir)) events.set(dir, []);
      events.get(dir).push(f);
    } else {
      const ts = tsFrom(path.posix.basename(f.rel));
      if (!ts) continue;
      if (!loose.has(dir)) loose.set(dir, []);
      loose.get(dir).push({ f, ts });
    }
  }

  const recordings = [];
  const finish = (key, type, folder, list, startKey) => {
    const clips = list.filter((f) => f.kind === 'clip');
    const stamps = clips.map((f) => tsFrom(path.posix.basename(f.rel))).filter(Boolean).sort();
    const rels = list.map((f) => f.rel).sort();
    const cameras = [...new Set(clips.map((f) => f.camera).filter(Boolean))].sort();
    const thumb = list.find((f) => /\/thumb\.png$/i.test(f.rel));
    recordings.push({
      id: hashId(`${vehicleId}|${key}`),
      key,
      vehicleId,
      type,
      category: CATEGORY[type] || 'Other',
      folder,
      eventId: list[0].eventId || null,
      // the clip range; for events the folder name is when Sentry/Save triggered
      startKey: stamps[0] || startKey || null,
      start: display(stamps[0] || startKey),
      end: display(stamps[stamps.length - 1] || startKey),
      eventAt: list[0].eventId ? display(startKey) : null,
      day: (stamps[0] || startKey || '').slice(0, 10) || list[0].day,
      files: rels,
      fileCount: rels.length,
      clipCount: clips.length,
      bytes: list.reduce((n, f) => n + f.size, 0),
      cameras,
      thumbRel: thumb ? thumb.rel : null,
      frontRel: (clips.find((f) => f.camera === 'front') || clips[0])?.rel || null,
      protected: rels.some((r) => protectedRels.has(r)),
      mtimeMs: Math.max(...list.map((f) => f.mtimeMs))
    });
  };

  for (const [dir, list] of events) {
    const eventFolder = path.posix.basename(dir);
    finish(`event:${dir}`, list[0].type, dir, list, tsFrom(eventFolder));
  }
  for (const [dir, entries] of loose) {
    entries.sort((a, b) => a.ts.localeCompare(b.ts));
    let session = [];
    let last = null;
    const flush = () => {
      if (!session.length) return;
      finish(`session:${dir}:${session[0].ts}`, session[0].f.type, dir, session.map((e) => e.f), session[0].ts);
      session = [];
    };
    for (const e of entries) {
      const t = keySeconds(e.ts);
      if (last !== null && t - last > SESSION_GAP_S) flush();
      session.push(e);
      last = t;
    }
    flush();
  }
  recordings.sort((a, b) => String(b.startKey).localeCompare(String(a.startKey)));
  return recordings;
}

class Inventory {
  constructor({ vehicles, db, log }) {
    this.vehicles = vehicles;
    this.db = db;
    this.log = log;
    this.state = new Map(); // vehicleId -> { files, recordings, scannedAt, durationMs, errors, scanning }
    this.scans = new Map();
  }

  get(vehicleId) {
    return this.state.get(vehicleId) || null;
  }

  scan(vehicleId) {
    if (this.scans.has(vehicleId)) return this.scans.get(vehicleId);
    const p = (async () => {
      const vehicle = this.vehicles.get(vehicleId);
      if (!vehicle) throw Object.assign(new Error('No such vehicle.'), { status: 404 });
      const share = this.vehicles.share(vehicleId);
      if (share && !share.isHealthy()) throw Object.assign(new Error(`${vehicle.name}: the share is not available.`), { status: 503 });
      const prev = this.state.get(vehicleId);
      this.state.set(vehicleId, { ...(prev || {}), scanning: true });
      try {
        const res = await scanFootage(this.vehicles.rootOf(vehicle));
        const entry = {
          files: res.files,
          scannedAt: res.scannedAt,
          durationMs: res.durationMs,
          errors: res.errors.slice(0, 20),
          errorCount: res.errors.length,
          scanning: false
        };
        entry.recordings = buildRecordings(res.files, { vehicleId, protectedRels: this.db.protectedSet(vehicleId) });
        this.state.set(vehicleId, entry);
        this.log.info(`${vehicle.name}: ${entry.recordings.length} recordings, ${res.files.size} files (${(res.durationMs / 1000).toFixed(1)}s)`);
        return entry;
      } catch (err) {
        this.state.set(vehicleId, { ...(prev || {}), scanning: false, lastError: err.message });
        throw err;
      } finally {
        this.scans.delete(vehicleId);
      }
    })();
    this.scans.set(vehicleId, p);
    return p;
  }

  /** Recompute recordings after files moved (trash/restore) without rescanning. */
  rebuild(vehicleId) {
    const entry = this.state.get(vehicleId);
    if (!entry?.files) return;
    entry.recordings = buildRecordings(entry.files, { vehicleId, protectedRels: this.db.protectedSet(vehicleId) });
  }

  recording(vehicleId, id) {
    return this.state.get(vehicleId)?.recordings?.find((r) => r.id === id) || null;
  }

  totals(vehicleId) {
    const e = this.state.get(vehicleId);
    if (!e?.recordings) return null;
    const by = {};
    for (const r of e.recordings) {
      by[r.category] = by[r.category] || { recordings: 0, bytes: 0 };
      by[r.category].recordings++;
      by[r.category].bytes += r.bytes;
    }
    return {
      recordings: e.recordings.length,
      files: e.files.size,
      bytes: e.recordings.reduce((n, r) => n + r.bytes, 0),
      byCategory: by,
      scannedAt: e.scannedAt
    };
  }

  /** event.json of a Sentry/Saved event, if present and small. */
  async eventInfo(vehicleId, recording) {
    if (!recording.eventId) return null;
    const vehicle = this.vehicles.get(vehicleId);
    const rel = recording.files.find((r) => /\/event\.json$/i.test(r));
    if (!vehicle || !rel) return null;
    try {
      const abs = safeJoin(this.vehicles.rootOf(vehicle), rel);
      const st = await fsp.stat(abs);
      if (st.size > 64 * 1024) return null;
      const data = JSON.parse(await fsp.readFile(abs, 'utf8'));
      const pick = {};
      for (const k of ['timestamp', 'city', 'street', 'est_lat', 'est_lon', 'reason', 'camera']) {
        if (data[k] !== undefined && data[k] !== null) pick[k] = String(data[k]).slice(0, 200);
      }
      return pick;
    } catch {
      return null;
    }
  }
}

module.exports = { Inventory, buildRecordings, tsFrom };
