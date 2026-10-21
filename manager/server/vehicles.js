'use strict';

// Vehicles: each has its own footage source (an SMB share the container
// mounts at /footage/<id>, or a folder already mounted into the container)
// and its own ShareManager keeping it healthy.
//
// A folder vehicle must live under one of the folder roots (/footage unless
// FOLDER_ROOTS says otherwise) and can never be, contain or sit inside the
// manager's own data, the app, or system folders: otherwise anyone signed in
// could point a "vehicle" at / or /data and read every secret through the
// viewer.

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { ShareManager } = require('./share');
const { normalizeSmb } = require('./mountSpec');
const { isInside } = require('./safePath');

const SYSTEM_DIRS = ['/proc', '/sys', '/dev', '/etc', '/root', '/run', '/boot'];

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

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** Normalize and validate a vehicle definition coming from the UI or env. */
function normalizeVehicle(input, existing = null) {
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, 60);
  if (!name) throw badRequest('Give the vehicle a name.');
  const timezone = String(input.timezone ?? existing?.timezone ?? process.env.TZ ?? 'UTC').trim() || 'UTC';
  if (!validTimezone(timezone)) throw badRequest(`Unknown time zone "${timezone}".`);
  const src = input.source ?? existing?.source ?? {};
  let source;
  if (src.type === 'path') {
    const p = String(src.path || '').trim();
    if (!path.isAbsolute(p) || p.includes('\0')) throw badRequest('The folder must be an absolute path inside the container, e.g. /footage/car.');
    source = { type: 'path', path: path.resolve(p) };
  } else {
    // the UI sends no password to keep the stored one
    source = normalizeSmb(src, existing?.source?.type === 'smb' ? existing.source : null);
  }
  return { name, timezone, source };
}

class VehicleManager extends EventEmitter {
  /**
   * folderRoots: where folder vehicles may live. protectedDirs: folders no
   * vehicle may be, contain or sit inside (the data dir, the app, ...).
   */
  constructor({ db, footageRoot = '/footage', folderRoots = null, protectedDirs = [], logger, mounter = null, mountinfoPath }) {
    super();
    this.db = db;
    this.footageRoot = path.resolve(footageRoot);
    this.folderRoots = (folderRoots || [this.footageRoot]).map((r) => path.resolve(r));
    this.protectedDirs = [...protectedDirs, ...SYSTEM_DIRS].filter(Boolean).map((d) => path.resolve(d));
    this.logger = logger;
    this.log = logger.scope('vehicles');
    this.mounter = mounter;
    this.shareOptions = { mountinfoPath };
    this.shares = new Map();
  }

  /** Throws unless a folder vehicle at `p` is allowed (see the header). */
  checkFolder(p, ignoreId = null) {
    const abs = path.resolve(p);
    const real = (() => {
      try {
        return fs.realpathSync(abs);
      } catch {
        return abs; // checked again (really) every time it is used, see roots()
      }
    })();
    const inRoot = this.folderRoots.some((r) => isInside(abs, r) && isInside(real, realOr(r)));
    if (!inRoot) throw badRequest(`Folder vehicles must be inside ${this.folderRoots.join(' or ')} (mount the folder there with a Docker volume).`);
    for (const d of this.protectedDirs) {
      for (const x of [abs, real]) {
        if (isInside(x, d) || isInside(d, x)) throw badRequest(`A vehicle cannot use ${p}: it overlaps ${d}.`);
      }
    }
    this.checkOverlap(abs, ignoreId);
  }

  /** No two vehicles may share, or nest inside each other's, folders. */
  checkOverlap(root, ignoreId) {
    for (const v of this.list()) {
      if (v.id === ignoreId) continue;
      const other = this.rootOf(v);
      if (isInside(root, other) || isInside(other, root)) throw badRequest(`That folder overlaps the footage of ${v.name} (${other}).`);
    }
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
    try {
      if (env.SMB_SHARE) {
        if (env.SMB_OPTIONS) this.log.warn('SMB_OPTIONS is no longer used: mount options are fixed for security (see README).');
        this.add({ name: env.VEHICLE_NAME || 'My car', timezone: env.TZ || 'UTC', source: {
          type: 'smb', share: env.SMB_SHARE, username: env.SMB_USERNAME || '', password: env.SMB_PASSWORD || '',
          domain: env.SMB_DOMAIN || '', version: env.SMB_VERSION || undefined, encrypt: env.SMB_ENCRYPT !== 'false',
          port: env.SMB_PORT || undefined
        } });
      } else if (env.FOOTAGE_PATH && fs.existsSync(env.FOOTAGE_PATH)) {
        this.add({ name: env.VEHICLE_NAME || 'My car', timezone: env.TZ || 'UTC', source: { type: 'path', path: env.FOOTAGE_PATH } });
      }
    } catch (err) {
      this.log.error(`Could not create the vehicle from the environment: ${err.message}`);
    }
  }

  add(input) {
    const vehicle = normalizeVehicle(input);
    if (vehicle.source.type === 'path') this.checkFolder(vehicle.source.path);
    const taken = new Set(this.list().map((v) => v.id));
    const free = (id) => {
      if (taken.has(id)) return false;
      if (vehicle.source.type !== 'smb') return true;
      try {
        this.checkOverlap(path.join(this.footageRoot, id), null);
        return true;
      } catch {
        return false;
      }
    };
    let id = slug(input.id || vehicle.name);
    if (!ID_RE.test(id)) id = 'vehicle';
    for (let n = 2; !free(id); n++) id = `${slug(vehicle.name).slice(0, 36)}-${n}`;
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
    if (next.source.type === 'path') this.checkFolder(next.source.path, id);
    else this.checkOverlap(path.join(this.footageRoot, id), id);
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
    const smb = vehicle.source.type === 'smb' ? { ...vehicle.source } : { share: '' };
    const share = new ShareManager({
      config: { footagePath: root, smb },
      log: this.logger.scope(`share:${vehicle.id}`),
      id: vehicle.id,
      mounter: this.mounter,
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

  /**
   * The folder Sentry Studio opens for this vehicle: the TeslaCam folder when
   * the share has one (Studio expects RecentClips/SentryClips/SavedClips
   * directly inside), else the share root.
   */
  studioRoot(vehicle) {
    const root = this.rootOf(vehicle);
    this.studioRoots = this.studioRoots || new Map();
    const cached = this.studioRoots.get(vehicle.id);
    if (cached && cached.root === root && Date.now() - cached.at < 60000) return cached.value;
    let value = root;
    try {
      const names = fs.readdirSync(root);
      const hasClipFolders = names.some((n) => /^(recentclips|sentryclips|savedclips)$/i.test(n));
      const tesla = names.find((n) => /^teslacam$/i.test(n));
      if (!hasClipFolders && tesla) value = path.join(root, tesla);
    } catch {
      // share not reachable right now
    }
    this.studioRoots.set(vehicle.id, { root, value, at: Date.now() });
    return value;
  }

  /** Vehicle as the UI sees it: no password, plus live share status. */
  publicView(vehicle) {
    const share = this.shares.get(vehicle.id);
    const source = { ...vehicle.source };
    if (source.type === 'smb') {
      source.passwordSet = Boolean(source.password);
      source.encrypt = source.encrypt !== false;
      delete source.password;
      delete source.options;
    }
    return { id: vehicle.id, name: vehicle.name, timezone: vehicle.timezone, source, root: this.rootOf(vehicle), studioRoot: this.studioRoot(vehicle), share: share ? share.status() : null };
  }

  /**
   * Every vehicle folder the manager may read from or write to, with where
   * each must really be (after symlinks) to count: see safePath.createRealGuard.
   */
  roots() {
    return this.list().map((v) => ({
      path: this.rootOf(v),
      within: v.source.type === 'path' ? this.folderRoots : [this.footageRoot]
    }));
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

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

module.exports = { VehicleManager, normalizeVehicle, slug };
