'use strict';

// Retention policies per vehicle: "keep Recent clips N days" etc. A policy
// only ever MOVES old recordings to the Recycle Bin; protected recordings are
// skipped, and nothing is deleted until the user empties the bin.

const CATEGORIES = ['Recent', 'Sentry', 'Saved', 'Other'];

function defaultPolicy() {
  return { enabled: false, runAt: '03:30', keepDays: { Recent: null, Sentry: null, Saved: null, Other: null }, lastRunAt: null, lastResult: null };
}

function normalizePolicy(input, prev = defaultPolicy()) {
  const out = { ...prev, keepDays: { ...prev.keepDays } };
  if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);
  if (input.runAt !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.runAt))) throw Object.assign(new Error('Run time must be HH:MM.'), { status: 400 });
    out.runAt = String(input.runAt);
  }
  for (const c of CATEGORIES) {
    const v = input.keepDays?.[c];
    if (v === undefined) continue;
    if (v === null || v === '') out.keepDays[c] = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 3650) throw Object.assign(new Error(`${c}: keep between 1 and 3650 days, or leave empty to keep forever.`), { status: 400 });
      out.keepDays[c] = n;
    }
  }
  return out;
}

/** 'YYYY-MM-DD' of `now` in a time zone. */
function dayInZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Recordings a policy would move: older than keepDays by their capture day. */
function selectExpired(recordings, policy, { now = new Date(), timeZone = 'UTC' } = {}) {
  const today = dayInZone(now, timeZone);
  return recordings.filter((r) => {
    const keep = policy.keepDays[r.category];
    if (!keep || r.protected || !r.day) return false;
    return daysBetween(r.day, today) >= keep;
  });
}

class Policies {
  constructor({ db, vehicles, inventory, bin, log }) {
    Object.assign(this, { db, vehicles, inventory, bin, log });
  }

  get(vehicleId) {
    return { ...defaultPolicy(), ...(this.db.get(`policy:${vehicleId}`) || {}) };
  }

  set(vehicleId, input) {
    if (!this.vehicles.get(vehicleId)) throw Object.assign(new Error('No such vehicle.'), { status: 404 });
    const next = normalizePolicy(input, this.get(vehicleId));
    this.db.set(`policy:${vehicleId}`, next);
    return next;
  }

  preview(vehicleId) {
    const vehicle = this.vehicles.get(vehicleId);
    const inv = this.inventory.get(vehicleId);
    if (!vehicle || !inv?.recordings) return { recordings: 0, bytes: 0, byCategory: {} };
    const hit = selectExpired(inv.recordings, this.get(vehicleId), { timeZone: vehicle.timezone });
    const byCategory = {};
    for (const r of hit) {
      byCategory[r.category] = byCategory[r.category] || { recordings: 0, bytes: 0 };
      byCategory[r.category].recordings++;
      byCategory[r.category].bytes += r.bytes;
    }
    return { recordings: hit.length, bytes: hit.reduce((n, r) => n + r.bytes, 0), byCategory, ids: hit.map((r) => r.id) };
  }

  async run(vehicleId) {
    await this.inventory.scan(vehicleId);
    const { ids } = this.preview(vehicleId);
    const result = ids.length ? await this.bin.trash(vehicleId, ids, { reason: 'policy' }) : { moved: [], skipped: [], bytes: 0 };
    const policy = this.get(vehicleId);
    this.db.set(`policy:${vehicleId}`, { ...policy, lastRunAt: Date.now(), lastResult: { moved: result.moved.length, skipped: result.skipped.length, bytes: result.bytes } });
    return result;
  }

  /** Called every minute: run policies whose time has come. */
  async tick(now = new Date()) {
    for (const v of this.vehicles.list()) {
      const p = this.get(v.id);
      if (!p.enabled) continue;
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const ranToday = p.lastRunAt && new Date(p.lastRunAt).toDateString() === now.toDateString();
      if (hhmm >= p.runAt && !ranToday) {
        try {
          await this.run(v.id);
        } catch (err) {
          this.log.warn(`Policy for ${v.name} did not run: ${err.message}`);
          this.db.set(`policy:${v.id}`, { ...p, lastRunAt: Date.now(), lastResult: { error: err.message } });
        }
      }
    }
  }
}

module.exports = { Policies, selectExpired, normalizePolicy, defaultPolicy, dayInZone, CATEGORIES };
