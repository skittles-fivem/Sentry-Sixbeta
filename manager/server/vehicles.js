'use strict';

// Vehicles: each has its own footage source (an SMB share the container
// mounts at /footage/<id>, or a folder already mounted into the container)
// and its own ShareManager keeping it healthy.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { ShareManager } = require('./share');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function slug(name) {
  return String(name || 'vehicle').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vehicle';
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Normalize and validate a vehicle definition coming from the UI or env. */
function normalizeVehicle(input, existing = null) {
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 60);
  if (!name) throw Object.assign(new Error('Give the vehicle a name.'), { status: 400 });
  const timezone = String(input.timezone ?? existing?.timezone ?? process.env.TZ ?? 'UTC').trim() || 'UTC';
  if (!validTimezone(timezone)) throw Object.assign(new Error(`Unknown time zone "${timezone}".`), { status: 400 });
  const src = input.source ?? existing?.source ?? {};
  let source;
  if (src.type === 'path') {
    const p = String(src.path || '').trim();
    if (!path.isAbsolute(p)) throw Object.assign(new Error('The folder must be an absolute path inside the container, e.g. /footage/car.'), { status: 400 });
    source = { type: 'path', path: path.resolve(p) };
  } else {
    const share = String(src.share || '').trim().replace(/\\/g, '/');
    if (!/^\/\/[^/]+\/[^/]+/.test(share)) throw Object.assign(new Error('The SMB share must look like //server/share.'), { status: 400 });
    const prevPassword = existing?.source?.type === 'smb' ? existing.source.password : '';
    source = {
      type: 'smb',
      share,
      username: String(src.username || '').trim(),
      // the UI sends no password to keep the stored one
      password: src.password === undefined || src.password === null ? prevPassword : String(src.password),
      domain: String(src.domain || '').trim(),
      version: String(src.version || '3.0').trim() || '3.0',
      options: String(src.options || '').trim()
    };
  }
  return { name, timezone, source };
}

class VehicleManager extends EventEmitter {
  constructor({ db, footageRoot = '/footage', logger, credDir, mountinfoPath, runCmd }) {
    super();
    this.db = db;
    this.footageRoot = footageRoot;
    this.logger = logger;
    this.log = logger.scope('vehicles');
    this.shareOptions = { credDir, mountinfoPath, runCmd };
    this.shares = new Map();
  }

  list() {
    return this.db.get('vehicles', []);
  }

  get(id) {
    return this.list().find((v) => v.id === id) || null;
  }

  /** Where this vehicle's footage is inside the container. */
  rootOf(vehicle) {
    return vehicle.source.type === 'path' ? vehicle.source.path : path.join(this.footageRoot, vehicle.id);
  }

  /** Create a vehicle from SMB_SHARE / FOOTAGE_PATH on first start. */
  bootstrapFromEnv(env = process.env) {
    if (this.list().length) return;
    if (env.SMB_SHARE) {
      this.add({ name: env.VEHICLE_NAME || 'My car', timezone: env.TZ || 'UTC', source: {
        type: 'smb', share: env.SMB_SHARE, username: env.SMB_USERNAME || '', password: env.SMB_PASSWORD || '',
        domain: env.SMB_DOMAIN || '', version: env.SMB_VERSION || '3.0', options: env.SMB_OPTIONS || ''
      } });
    } else if (env.FOOTAGE_PATH && fs.existsSync(env.FOOTAGE_PATH)) {
      this.add({ name: env.VEHICLE_NAME || 'My car', timezone: env.TZ || 'UTC', source: { type: 'path', path: env.FOOTAGE_PATH } });
    }
  }

  add(input) {
    const vehicle = normalizeVehicle(input);
    const taken = new Set(this.list().map((v) => v.id));
    let id = slug(input.id || vehicle.name);
    if (!ID_RE.test(id)) id = 'vehicle';
    for (let n = 2; taken.has(id); n++) id = `${slug(vehicle.name).slice(0, 36)}-${n}`;
    const full = { id, ...vehicle, createdAt: Date.now() };
    this.db.set('vehicles', [...this.list(), full]);
    this.startShare(full);
    this.emit('changed');
    return full;
  }

  async update(id, input) {
    const existing = this.get(id);
    if (!existing) throw Object.assign(new Error('No such vehicle.'), { status: 404 });
    const next = { ...existing, ...normalizeVehicle(input, existing) };
    this.db.set('vehicles', this.list().map((v) => (v.id === id ? next : v)));
    const sourceChanged = JSON.stringify(next.source) !== JSON.stringify(existing.source);
    if (sourceChanged) {
      await this.stopShare(id);
      this.startShare(next);
    }
    this.emit('changed');
    return next;
  }

  /** Forget a vehicle. Its footage is never touched. */
  async remove(id) {
    if (!this.get(id)) throw Object.assign(new Error('No such vehicle.'), { status: 404 });
    await this.stopShare(id);
    this.db.set('vehicles', this.list().filter((v) => v.id !== id));
    this.emit('changed');
  }

  startShare(vehicle) {
    const root = this.rootOf(vehicle);
    const smb = vehicle.source.type === 'smb'
      ? { ...vehicle.source, uid: Number(process.env.PUID || 0), gid: Number(process.env.PGID || 0) }
      : { share: '' };
    const share = new ShareManager({
      config: { footagePath: root, smb },
      log: this.logger.scope(`share:${vehicle.id}`),
      id: vehicle.id,
      ...Object.fromEntries(Object.entries(this.shareOptions).filter(([, v]) => v !== undefined))
    });
    share.on('status', () => this.emit('status', vehicle.id));
    share.on('health', (healthy) => this.emit('health', vehicle.id, healthy));
    this.shares.set(vehicle.id, share);
    share.start().catch((err) => this.log.error(`${vehicle.name}: ${err.message}`));
    return share;
  }

  async stopShare(id) {
    const share = this.shares.get(id);
    if (!share) return;
    this.shares.delete(id);
    await share.stop().catch(() => {});
  }

  startAll() {
    for (const v of this.list()) if (!this.shares.has(v.id)) this.startShare(v);
  }

  async stopAll() {
    await Promise.all([...this.shares.keys()].map((id) => this.stopShare(id)));
  }

  share(id) {
    return this.shares.get(id) || null;
  }

  /** Vehicle as the UI sees it: no password, plus live share status. */
  publicView(vehicle) {
    const share = this.shares.get(vehicle.id);
    const source = { ...vehicle.source };
    if (source.type === 'smb') {
      source.passwordSet = Boolean(source.password);
      delete source.password;
    }
    return { id: vehicle.id, name: vehicle.name, timezone: vehicle.timezone, source, root: this.rootOf(vehicle), share: share ? share.status() : null };
  }

  /** Every folder the manager may read from or write to. */
  roots() {
    return this.list().map((v) => this.rootOf(v));
  }

  vehicleForPath(p) {
    const abs = path.resolve(p);
    for (const v of this.list()) {
      const root = this.rootOf(v);
      if (abs === root || abs.startsWith(root + path.sep)) return v;
    }
    return null;
  }
}

module.exports = { VehicleManager, normalizeVehicle, slug };
