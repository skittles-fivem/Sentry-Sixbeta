'use strict';

// Jobs (what the manager did: scans, trash/restore, policy runs,
// conversions, updates) and notifications (things that need attention).
// Both are stored in the DB and announced on the events bus.

const { EventEmitter } = require('events');

class Jobs extends EventEmitter {
  constructor({ db }) {
    super();
    this.db = db;
  }

  start({ type, vehicleId = null, title, detail = null, externalId = null }) {
    const id = this.db.startJob({ type, vehicleId, title, detail, externalId });
    this.emit('changed', id);
    return id;
  }

  update(id, fields) {
    this.db.updateJob(id, fields);
    this.emit('changed', id);
  }

  finish(id, { status = 'done', detail, result } = {}) {
    this.db.updateJob(id, { status, detail, result, finished: true });
    this.db.trimJobs();
    this.emit('changed', id);
  }

  list(opts) {
    return this.db.jobs(opts);
  }
}

class Notifications extends EventEmitter {
  constructor({ db }) {
    super();
    this.db = db;
  }

  raise(n) {
    const id = this.db.notify(n);
    this.emit('changed', id);
    return id;
  }

  resolve(dedupeKey) {
    this.db.resolve(dedupeKey);
    this.emit('changed');
  }

  dismiss(id) {
    this.db.resolveId(id);
    this.emit('changed');
  }

  markRead(ids) {
    this.db.markRead(ids);
    this.emit('changed');
  }

  list(opts) {
    return this.db.notifications(opts);
  }

  /** Keep share / disk alerts in sync with a vehicle's share status. */
  syncShare(vehicle, status) {
    const key = `share:${vehicle.id}`;
    if (!status) return;
    if (!status.healthy) {
      this.raise({
        kind: 'share', level: 'critical', vehicleId: vehicle.id, dedupeKey: key,
        title: `${vehicle.name}: footage share is offline`,
        message: [status.lastError, status.hint].filter(Boolean).join(' ') || 'The share cannot be read.'
      });
    } else this.resolve(key);

    const roKey = `readonly:${vehicle.id}`;
    if (status.healthy && status.writable === false) {
      this.raise({ kind: 'share', level: 'warning', vehicleId: vehicle.id, dedupeKey: roKey, title: `${vehicle.name}: share is read-only`, message: status.lastError || 'Conversions, trash and restore need write access.' });
    } else if (status.writable) this.resolve(roKey);

    const spaceKey = `space:${vehicle.id}`;
    if (status.totalBytes && status.freeBytes !== null) {
      const ratio = status.freeBytes / status.totalBytes;
      if (ratio < 0.05) {
        this.raise({ kind: 'storage', level: 'critical', vehicleId: vehicle.id, dedupeKey: spaceKey, title: `${vehicle.name}: share almost full`, message: `${(ratio * 100).toFixed(1)}% free.` });
      } else if (ratio < 0.1) {
        this.raise({ kind: 'storage', level: 'warning', vehicleId: vehicle.id, dedupeKey: spaceKey, title: `${vehicle.name}: share running low on space`, message: `${(ratio * 100).toFixed(1)}% free.` });
      } else this.resolve(spaceKey);
    }
  }
}

module.exports = { Jobs, Notifications };
