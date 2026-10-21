'use strict';

// Sentry Manager server: the Sentry Studio viewer and converter as a web app,
// plus file management (vehicles, footage, Recycle Bin, policies, jobs,
// notifications, settings, sign-in, GitHub updates).
//
// Security, in short (README "Security" has the details):
//   - HTTPS on the same port; plain HTTP only redirects to it.
//   - Sign-in required; the first account needs the setup code from the log;
//     cookies are HttpOnly, SameSite=Strict, Secure + __Host- over HTTPS.
//   - Changes that could hand someone the shares or the server need the
//     password again (vehicle sources, updates, certificates, deleting forever).
//   - State-changing requests need X-Requested-With and a matching Origin.
//   - Every file path is resolved through safePath's real-path guard.
//   - When supervised (the Docker image), this process runs as an
//     unprivileged user; the root supervisor only mounts shares and keeps
//     the HTTPS certificate authority.

process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';
// the database holds password hashes and SMB passwords: nothing we create is world-readable
process.umask(0o027);

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { Logger } = require('./log');
const { ManagerDB } = require('./db');
const { Auth } = require('./auth');
const { VehicleManager } = require('./vehicles');
const { Inventory } = require('./inventory');
const { RecycleBin, formatBytes } = require('./recycleBin');
const { Policies } = require('./policies');
const { Jobs, Notifications } = require('./activity');
const { Updater } = require('./updater');
const { Thumbnails } = require('./thumbnails');
const { detectGpus } = require('./gpu');
const { createConverterHost } = require('./converterHost');
const { createConverterBridge } = require('./converterBridge');
const { hiddenPath, readDir, stat, sendMedia, readTextConfined } = require('./studioApi');
const { createRealGuard, isInside } = require('./safePath');
const { createLocalMounter, createIpcMounter } = require('./mounter');
const { VERSIONS, DEFAULT_VERSION, securitySummary } = require('./mountSpec');
const { TlsManager, localTlsSource, supervisorTlsSource, parseHostnames } = require('./tls');
const { Router, HttpError, sendJson, readJson, serveFile } = require('./http');

const APP_ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..', '..'));
const SRC = path.join(APP_ROOT, 'src');
const WEB = path.join(APP_ROOT, 'manager', 'web');
const DATA = path.resolve(process.env.DATA_PATH || '/data');
const RUN_DIR = path.resolve(process.env.RUN_DIR || '/run/sentry-manager');
const FOOTAGE_ROOT = path.resolve(process.env.FOOTAGE_ROOT || '/footage');
const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || '0.0.0.0';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TLS_MODE = (process.env.TLS_MODE || 'auto').toLowerCase(); // auto | off
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SUPERVISED = process.env.SENTRY_SUPERVISED === '1' && typeof process.send === 'function';
const TRUSTED_HOSTS = (process.env.TRUSTED_HOSTS || '').split(/[\s,]+/).filter(Boolean).map((h) => h.toLowerCase());

const CONVERTER_ACTIVE = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing', 'paused', 'paused_network']);
const ITEM_DONE = new Set(['completed', 'skipped', 'failed', 'cancelled']);

// Pages may load scripts, styles, frames and data only from this server, and
// never run inline scripts. Styles allow inline attributes (both UIs set
// style="" in markup). The embedded Studio viewer additionally needs
// 'unsafe-eval' (its bundled protobuf.js builds the telemetry decoder with
// new Function) and map tiles; the shell and sign-in pages get neither.
const cspWith = ({ script = "'self'", img = "'self' data: blob:" }) => [
  "default-src 'self'",
  `script-src ${script}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src ${img}`,
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');
const CSP = cspWith({});
const STUDIO_CSP = cspWith({ script: "'self' 'unsafe-eval'", img: "'self' data: blob: https://*.google.com https://*.tile.openstreetmap.org" });

function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'BUILD_INFO.json'), 'utf8'));
  } catch {
    return {};
  }
}

function studioHtml(html) {
  // Runs before any Studio script: marks web mode and installs window.electronAPI.
  const inject = '<script src="/web/webFlag.js"></script>\n<script src="/web/electronApiShim.js"></script>\n<link rel="stylesheet" href="/web/studioEmbed.css">';
  return html.replace(/<head([^>]*)>/i, (m) => `${m}\n${inject}`);
}

function isSecure(req) {
  if (req.socket?.encrypted) return true;
  return TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

/** The Host header, if it is a plain host[:port] (and trusted, when TRUSTED_HOSTS is set). */
function cleanHost(req) {
  const raw = String((TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
  if (!/^[A-Za-z0-9.\-[\]:]{1,300}$/.test(raw)) return null;
  if (TRUSTED_HOSTS.length) {
    const name = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!TRUSTED_HOSTS.includes(name)) return null;
  }
  return raw;
}

function securityHeaders(req, res, pathname = '') {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=(), fullscreen=(self)');
  res.setHeader('Content-Security-Policy', pathname.startsWith('/studio/') ? STUDIO_CSP : CSP);
  if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function confirmRequired() {
  return Object.assign(new HttpError(403, 'Enter your password to confirm this change.'), { code: 'CONFIRM_PASSWORD', expose: true });
}

async function main() {
  const logger = new Logger({ level: process.env.LOG_LEVEL || 'info' });
  const log = logger.scope('server');
  fs.mkdirSync(DATA, { recursive: true });
  const buildInfo = readBuildInfo();
  const db = new ManagerDB(path.join(DATA, 'manager.db'));
  const auth = new Auth({ db, log: logger.scope('auth'), isSecure, setupFile: path.join(DATA, 'setup-code.txt') });
  auth.bootstrap();
  const jobs = new Jobs({ db });
  const notes = new Notifications({ db });

  const mounter = SUPERVISED
    ? createIpcMounter({ channel: process, footageRoot: FOOTAGE_ROOT })
    : createLocalMounter({
      footageRoot: FOOTAGE_ROOT, credDir: RUN_DIR,
      uid: Number(process.env.PUID ?? process.getuid?.() ?? 0), gid: Number(process.env.PGID ?? process.getgid?.() ?? 0)
    });
  const folderRoots = [FOOTAGE_ROOT, ...(process.env.FOLDER_ROOTS || '').split(':').filter(Boolean)];
  // FOOTAGE_PATH comes from the container environment (trusted), not the UI
  if (process.env.FOOTAGE_PATH) folderRoots.push(process.env.FOOTAGE_PATH);
  const protectedDirs = [DATA, APP_ROOT, RUN_DIR];
  const vehicles = new VehicleManager({ db, footageRoot: FOOTAGE_ROOT, folderRoots, protectedDirs, logger, mounter });
  vehicles.bootstrapFromEnv();
  const inventory = new Inventory({ vehicles, db, log: logger.scope('inventory') });
  const thumbs = new Thumbnails({ dir: path.join(DATA, 'thumbnails'), ffmpegPath: FFMPEG });

  // ---- paths
  // Default place for converted copies ("keep originals" mode); EXTRA_ROOTS adds more.
  fs.mkdirSync(path.join(DATA, 'converted'), { recursive: true });
  const outputRoots = () => [path.join(DATA, 'converted'), ...(process.env.EXTRA_ROOTS || '').split(':').filter(Boolean)];
  const allowedRoots = () => [...vehicles.roots(), ...outputRoots()];
  const deny = () => [DATA, APP_ROOT, RUN_DIR, '/proc', '/sys', '/dev', '/etc', '/root', '/run', '/boot'];
  const allowed = createRealGuard(allowedRoots, { deny });
  const studioReadable = createRealGuard(() => [...allowedRoots(), path.join(DATA, 'thumbnails'), path.join(DATA, 'clip-thumbnails'), path.join(DATA, 'exports')], { deny });

  /** The vehicle whose footage contains this real path, and that root. */
  const vehicleForReal = (real) => {
    for (const v of vehicles.list()) {
      const root = vehicles.rootOf(v);
      let realRoot = root;
      try {
        realRoot = fs.realpathSync(root);
      } catch {
        // not reachable
      }
      if (isInside(real, realRoot)) return { vehicle: v, root: realRoot };
      if (isInside(real, root)) return { vehicle: v, root };
    }
    return null;
  };

  // ---- converter
  const converterJobs = new Map(); // job id -> latest snapshot
  const isBusy = (abs) => {
    for (const s of converterJobs.values()) {
      if (!CONVERTER_ACTIVE.has(s.state) || !s.config?.sourceRoot) continue;
      if ((s.items || []).some((i) => !ITEM_DONE.has(i.state) && i.relativePath && path.join(s.config.sourceRoot, i.relativePath) === abs)) return true;
    }
    return false;
  };
  const converterIdle = () => ![...converterJobs.values()].some((s) => CONVERTER_ACTIVE.has(s.state));
  const bin = new RecycleBin({ db, vehicles, inventory, jobs, log: logger.scope('bin'), isBusy });
  const policies = new Policies({ db, vehicles, inventory, bin, log: logger.scope('policies') });

  const host = createConverterHost({
    dataDir: path.join(DATA, 'converter'),
    tempDir: path.join(DATA, 'converter-temp'),
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    log: logger.scope('converter')
  });
  let bridge = null;
  let clipThumbs = null;

  const updater = new Updater({
    db, log: logger.scope('updater'), dataDir: DATA, appRoot: APP_ROOT, buildInfo, isIdle: converterIdle
  });

  // ---- HTTPS
  const tlsSource = TLS_MODE === 'off' ? null : SUPERVISED && process.env.SENTRY_TLS_DIR
    ? supervisorTlsSource({ dir: process.env.SENTRY_TLS_DIR, channel: process })
    : localTlsSource(new TlsManager({
      dir: path.join(DATA, 'tls'), log: logger.scope('tls'), hostnames: parseHostnames(process.env.TLS_HOSTNAMES || ''),
      certFile: process.env.TLS_CERT_FILE || null, keyFile: process.env.TLS_KEY_FILE || null
    }));

  // ---- live events to the browser
  const clients = new Set();
  const pending = new Set();
  let flushTimer = null;
  const announce = (topic) => {
    pending.add(topic);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const topics = [...pending];
      pending.clear();
      for (const res of clients) res.write(`event: changed\ndata: ${JSON.stringify({ topics })}\n\n`);
    }, 400);
  };
  jobs.on('changed', () => announce('jobs'));
  notes.on('changed', () => announce('notifications'));
  vehicles.on('changed', () => announce('vehicles'));
  vehicles.on('status', (id) => {
    const v = vehicles.get(id);
    if (v) notes.syncShare(v, vehicles.share(id)?.status());
    announce('vehicles');
  });
  vehicles.on('health', (id, healthy) => {
    if (!healthy) return;
    bin.reconcile(id).catch((err) => log.warn(`Recycle Bin check of ${id}: ${err.message}`))
      .then(() => inventory.scan(id)).then(() => announce('inventory'), () => {});
  });

  // ---- routes
  const r = new Router();
  const vehicleOr404 = (id) => {
    const v = vehicles.get(id);
    if (!v) throw new HttpError(404, 'No such vehicle.');
    return v;
  };
  const requireConfirmed = (req) => {
    if (!auth.recentlyConfirmed(req)) throw confirmRequired();
  };
  const vehicleSummary = (v) => ({
    ...vehicles.publicView(v),
    security: v.source.type === 'smb' ? securitySummary({ encrypt: v.source.encrypt !== false, version: v.source.version }) : null,
    inventory: inventory.totals(v.id),
    scanning: Boolean(inventory.get(v.id)?.scanning),
    binBytes: bin.binBytes(v.id),
    binItems: db.binItems(v.id).length,
    policy: policies.get(v.id)
  });
  const clientKey = (req) => req.socket.remoteAddress || '?';

  r.add('GET', '/api/auth/me', (req) => ({ user: auth.user(req), needsSetup: auth.needsSetup(), secure: isSecure(req) }), { public: true });
  r.add('POST', '/api/auth/login', async (req, res, { body }) => {
    const keys = [clientKey(req), `user:${String(body?.username || '').toLowerCase()}`];
    const wait = Math.max(...keys.map((k) => auth.throttled(k)));
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    if (!auth.check(body?.username, body?.password)) {
      keys.forEach((k) => auth.noteFailure(k));
      throw new HttpError(401, 'Wrong user name or password.');
    }
    keys.forEach((k) => auth.noteSuccess(k));
    auth.login(req, res, body.username);
    return { ok: true };
  }, { public: true });
  r.add('POST', '/api/auth/setup', async (req, res, { body }) => {
    const key = `setup:${clientKey(req)}`;
    const wait = auth.throttled(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    try {
      auth.setup(String(body?.username || ''), String(body?.password || ''), body?.code);
    } catch (err) {
      if (err.status === 403) auth.noteFailure(key);
      throw err;
    }
    auth.login(req, res, body.username);
    return { ok: true };
  }, { public: true });
  r.add('POST', '/api/auth/logout', (req, res) => {
    auth.logout(req, res);
    return { ok: true };
  });
  r.add('POST', '/api/auth/confirm', (req, res, { body, user }) => {
    const key = `confirm:${user}`;
    const wait = auth.throttled(key);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    if (!auth.confirm(req, user, body?.password)) {
      auth.noteFailure(key);
      throw new HttpError(401, 'That password is not right.');
    }
    auth.noteSuccess(key);
    return { ok: true };
  });
  r.add('POST', '/api/auth/password', (req, res, { body, user }) => {
    if (!auth.check(user, body?.current)) throw new HttpError(401, 'The current password is wrong.');
    auth.setPassword(user, String(body?.next || ''));
    db.deleteSessionsFor(user);
    auth.forgetConfirmations();
    auth.login(req, res, user);
    return { ok: true };
  });

  r.add('GET', '/api/system', async (req) => ({
    version: { ...buildInfo, ...updater.current() },
    converter: host.runtime ? { ready: true, capabilities: host.runtime.capabilities } : { ready: false, error: host.lastError?.code || null },
    nativeHelper: host.helperAvailable,
    gpu: await detectGpus(),
    dataFree: await fs.promises.statfs(DATA).then((s) => Number(s.bavail) * Number(s.bsize)).catch(() => null),
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    security: {
      https: isSecure(req), tlsMode: TLS_MODE, supervised: SUPERVISED,
      runningAsRoot: process.getuid?.() === 0, uid: process.getuid?.() ?? null
    },
    smbVersions: VERSIONS,
    smbDefaultVersion: DEFAULT_VERSION
  }));

  r.add('GET', '/api/security', (req) => {
    let tls = null;
    try {
      tls = tlsSource ? tlsSource.status() : null;
    } catch (err) {
      tls = { error: err.message };
    }
    return {
      https: isSecure(req), tlsMode: TLS_MODE, trustProxy: TRUST_PROXY, tls,
      supervised: SUPERVISED, runningAsRoot: process.getuid?.() === 0,
      currentHost: cleanHost(req), confirmed: auth.recentlyConfirmed(req)
    };
  });
  r.add('PUT', '/api/security/hostnames', async (req, res, { body }) => {
    requireConfirmed(req);
    if (!tlsSource) throw new HttpError(409, 'HTTPS is turned off (TLS_MODE=off).');
    const list = parseHostnames(Array.isArray(body?.hostnames) ? body.hostnames.join(',') : String(body?.hostnames || ''));
    const out = await tlsSource.setHostnames(list);
    if (httpsServer) httpsServer.setSecureContext({ key: out.key, cert: out.cert });
    return { ok: true, caReplaced: Boolean(out.caReplaced), tls: tlsSource.status() };
  });
  r.add('GET', '/api/security/ca.crt', (req, res) => {
    const pem = tlsSource?.caPem();
    if (!pem) throw new HttpError(404, 'This server uses its own certificate; there is no local certificate authority.');
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="sentry-manager-ca.crt"', 'Cache-Control': 'no-store' });
    res.end(pem);
    return undefined;
  });

  r.add('GET', '/api/vehicles', () => ({ vehicles: vehicles.list().map(vehicleSummary) }));
  r.add('POST', '/api/vehicles', (req, res, { body }) => {
    requireConfirmed(req);
    return vehicleSummary(vehicles.add(body || {}));
  });
  r.add('PUT', '/api/vehicles/:id', async (req, res, { params, body }) => {
    vehicleOr404(params.id);
    if (body?.source !== undefined) requireConfirmed(req);
    return vehicleSummary(await vehicles.update(params.id, body || {}));
  });
  r.add('DELETE', '/api/vehicles/:id', async (req, res, { params }) => {
    requireConfirmed(req);
    await vehicles.remove(params.id);
    return { ok: true };
  });
  r.add('POST', '/api/vehicles/:id/reconnect', async (req, res, { params }) => {
    vehicleOr404(params.id);
    const s = vehicles.share(params.id);
    return { share: s ? await s.reconnect() : null };
  });
  r.add('POST', '/api/vehicles/:id/scan', async (req, res, { params }) => {
    const v = vehicleOr404(params.id);
    const jobId = jobs.start({ type: 'scan', vehicleId: v.id, title: `Refresh inventory of ${v.name}` });
    inventory.scan(v.id)
      .then((e) => jobs.finish(jobId, { detail: `${e.recordings.length} recordings, ${e.files.size} files${e.errorCount ? `, ${e.errorCount} unreadable` : ''}` }))
      .catch((err) => jobs.finish(jobId, { status: 'failed', detail: err.message }))
      .finally(() => announce('inventory'));
    return { ok: true, jobId };
  });

  const publicRecording = (rec) => {
    const { files, ...rest } = rec;
    return rest;
  };
  r.add('GET', '/api/vehicles/:id/recordings', (req, res, { params, query }) => {
    vehicleOr404(params.id);
    const inv = inventory.get(params.id);
    let list = inv?.recordings || [];
    if (query.category && query.category !== 'all') list = list.filter((x) => x.category === query.category);
    if (query.date) list = list.filter((x) => x.day === query.date);
    if (query.protected === '1') list = list.filter((x) => x.protected);
    const offset = Math.max(0, Number(query.offset) || 0);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
    return {
      total: list.length, offset, limit, scannedAt: inv?.scannedAt || null, scanning: Boolean(inv?.scanning), error: inv?.lastError || null,
      dates: [...new Set((inv?.recordings || []).map((x) => x.day))].sort().reverse(),
      recordings: list.slice(offset, offset + limit).map(publicRecording)
    };
  });
  r.add('GET', '/api/vehicles/:id/recordings/:rid', async (req, res, { params }) => {
    const v = vehicleOr404(params.id);
    const rec = inventory.recording(v.id, params.rid);
    if (!rec) throw new HttpError(404, 'Recording not found (it may have moved; refresh the inventory).');
    const root = vehicles.rootOf(v);
    const files = rec.files.map((rel) => ({ rel, path: path.join(root, rel), size: inventory.get(v.id).files.get(rel)?.size ?? null }));
    return { ...publicRecording(rec), root, folderPath: path.join(root, rec.folder), files, event: await inventory.eventInfo(v.id, rec) };
  });
  r.add('GET', '/api/vehicles/:id/recordings/:rid/thumbnail', async (req, res, { params }) => {
    const v = vehicleOr404(params.id);
    const rec = inventory.recording(v.id, params.rid);
    if (!rec) throw new HttpError(404, 'Not found');
    const root = vehicles.rootOf(v);
    const source = rec.thumbRel ? path.join(root, rec.thumbRel) : rec.frontRel ? path.join(root, rec.frontRel) : null;
    const real = source && await allowed.resolve(source);
    if (!real) throw new HttpError(404, 'No thumbnail');
    const file = rec.thumbRel ? real : await thumbs.forClip(real);
    if (!file) throw new HttpError(404, 'No thumbnail');
    await sendMedia(req, res, file, studioReadable.fdInside);
    return undefined;
  });
  r.add('POST', '/api/vehicles/:id/protect', async (req, res, { params, body }) => {
    const v = vehicleOr404(params.id);
    const on = body?.protected !== false;
    const recs = (Array.isArray(body?.ids) ? body.ids : []).map((id) => inventory.recording(v.id, id)).filter(Boolean);
    await bin.setProtected(v.id, recs.flatMap((x) => x.files), on);
    inventory.rebuild(v.id);
    announce('inventory');
    return { ok: true, count: recs.length };
  });
  r.add('POST', '/api/vehicles/:id/trash', async (req, res, { params, body }) => {
    vehicleOr404(params.id);
    const out = await bin.trash(params.id, Array.isArray(body?.ids) ? body.ids : []);
    announce('inventory');
    announce('bin');
    return out;
  });

  r.add('GET', '/api/bin', (req, res, { query }) => ({ items: bin.list(query.vehicle || null) }));
  r.add('POST', '/api/bin/:item/restore', async (req, res, { params }) => {
    const out = await bin.restore(params.item);
    announce('bin');
    announce('inventory');
    return out;
  });
  r.add('POST', '/api/bin/:item/delete', async (req, res, { params, body }) => {
    if (body?.confirm !== true) throw new HttpError(400, 'Confirm permanent deletion.');
    requireConfirmed(req);
    const out = await bin.deleteForever(params.item);
    announce('bin');
    return out;
  });
  r.add('POST', '/api/bin/empty', async (req, res, { body }) => {
    if (body?.confirm !== true) throw new HttpError(400, 'Confirm emptying the Recycle Bin.');
    requireConfirmed(req);
    if (body?.vehicle) vehicleOr404(body.vehicle);
    const out = await bin.empty(body?.vehicle || null);
    announce('bin');
    return out;
  });

  r.add('GET', '/api/vehicles/:id/policy', (req, res, { params }) => ({ policy: policies.get(vehicleOr404(params.id).id), preview: policies.preview(params.id) }));
  r.add('PUT', '/api/vehicles/:id/policy', (req, res, { params, body }) => {
    const policy = policies.set(params.id, body || {});
    return { policy, preview: policies.preview(params.id) };
  });
  r.add('POST', '/api/vehicles/:id/policy/run', async (req, res, { params }) => {
    vehicleOr404(params.id);
    const out = await policies.run(params.id);
    announce('inventory');
    announce('bin');
    return out;
  });

  r.add('GET', '/api/jobs', (req, res, { query }) => ({ jobs: jobs.list({ vehicleId: query.vehicle || undefined, limit: Math.min(500, Number(query.limit) || 200) }) }));
  r.add('GET', '/api/notifications', (req, res, { query }) => ({ notifications: notes.list({ open: query.open === '1' ? true : undefined, vehicleId: query.vehicle || undefined }) }));
  r.add('POST', '/api/notifications/:id/dismiss', (req, res, { params }) => {
    notes.dismiss(Number(params.id));
    return { ok: true };
  });
  r.add('POST', '/api/notifications/read', (req, res, { body }) => {
    notes.markRead((Array.isArray(body?.ids) ? body.ids : []).map(Number).filter(Number.isFinite));
    return { ok: true };
  });

  r.add('GET', '/api/settings', () => ({ appearance: db.get('appearance', { reduceEffects: false }), updater: updater.publicSettings() }));
  r.add('PUT', '/api/settings/appearance', (req, res, { body }) => {
    const next = { reduceEffects: Boolean(body?.reduceEffects) };
    db.set('appearance', next);
    return next;
  });
  r.add('GET', '/api/updater', () => updater.status());
  r.add('PUT', '/api/updater/settings', (req, res, { body }) => {
    requireConfirmed(req);
    return updater.setSettings(body || {});
  });
  r.add('GET', '/api/updater/branches', async () => ({ branches: await updater.branches() }));
  r.add('POST', '/api/updater/check', async () => updater.check());
  r.add('POST', '/api/updater/install', async (req) => {
    requireConfirmed(req);
    const out = await updater.install();
    jobs.finish(jobs.start({ type: 'update', title: `Update to ${out.sha.slice(0, 7)}` }), { detail: 'Installed; restarting' });
    return out;
  });

  // Converter (Encoder tab) — the Studio converter UI talks to these.
  r.add('POST', '/api/converter/invoke/:name', async (req, res, { params, body }) => {
    if (!bridge) return { ok: false, error: { code: host.lastError?.code || 'CONVERTER_STARTING' } };
    return bridge.invoke(params.name, body, req.headers['x-client-id']);
  });

  // Viewer (Studio) file access, confined to the vehicle shares.
  const confined = async (p, guard = studioReadable, opts) => {
    const real = await guard.resolve(p, opts);
    if (!real || hiddenPath(real)) throw new HttpError(403, 'That path is outside the vehicle shares.');
    return real;
  };
  r.add('POST', '/api/studio/readDir', async (req, res, { body }) => {
    const real = await confined(body?.path);
    try {
      return await readDir(real);
    } catch {
      return [];
    }
  });
  r.add('POST', '/api/studio/readFile', async (req, res, { body }) => {
    const real = await confined(body?.path);
    const text = await readTextConfined(real, studioReadable.fdInside, 8 * 1024 * 1024);
    if (text === null) throw new HttpError(404, 'Not readable');
    return { text };
  });
  r.add('POST', '/api/studio/exists', async (req, res, { body }) => {
    const real = await studioReadable.resolve(body?.path);
    return Boolean(real && !hiddenPath(real));
  });
  r.add('POST', '/api/studio/stat', async (req, res, { body }) => {
    const real = await studioReadable.resolve(body?.path);
    return real && !hiddenPath(real) ? stat(real) : null;
  });
  r.add('POST', '/api/studio/thumbnail', async (req, res, { body }) => {
    const real = await studioReadable.resolve(body?.path);
    if (!real || hiddenPath(real) || !clipThumbs) return null;
    try {
      return await clipThumbs.get(real);
    } catch {
      return null;
    }
  });
  r.add('POST', '/api/studio/trashFolder', async (req, res, { body }) => {
    // Studio's "delete folder" (trash icon on an event): goes to the Recycle Bin.
    const real = await confined(body?.path, allowed);
    const found = vehicleForReal(real);
    if (!found) throw new HttpError(403, 'Not inside a vehicle share.');
    const v = found.vehicle;
    if (!inventory.get(v.id)?.recordings) await inventory.scan(v.id);
    const rel = path.relative(found.root, real).split(path.sep).join('/');
    const ids = inventory.get(v.id).recordings.filter((x) => x.folder === rel || x.folder.startsWith(`${rel}/`)).map((x) => x.id);
    if (!ids.length) return { success: false, error: 'Nothing to move to the Recycle Bin in that folder.' };
    const out = await bin.trash(v.id, ids);
    announce('inventory');
    announce('bin');
    return out.skipped.length && !out.moved.length
      ? { success: false, error: out.skipped[0].reason === 'protected' ? 'This recording is protected.' : out.skipped[0].reason === 'converting' ? 'This recording is being converted right now.' : 'Could not move it to the Recycle Bin.' }
      : { success: true };
  });
  r.add('GET', '/api/studio/settings', () => db.get('studio-settings', {}));
  r.add('POST', '/api/studio/settings', (req, res, { body }) => {
    if (!body || typeof body.key !== 'string' || body.key.length > 100) throw new HttpError(400, 'Invalid setting');
    const all = db.get('studio-settings', {});
    all[body.key] = body.value;
    db.set('studio-settings', all);
    return { ok: true };
  });
  const appVersion = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'version.json'), 'utf8')).version || null;
    } catch {
      return null;
    }
  })();
  r.add('GET', '/api/studio/context', () => ({
    version: appVersion ? `${appVersion} (web)` : 'web',
    vehicles: vehicles.list().map((v) => ({ id: v.id, name: v.name, root: vehicles.rootOf(v), timezone: v.timezone })),
    outputRoots: outputRoots()
  }));
  r.add('POST', '/api/studio/browse', async (req, res, { body }) => {
    // Folder picker for the converter / viewer: only allowed roots and their subfolders.
    const roots = allowedRoots().map((x) => (typeof x === 'string' ? x : x.path));
    if (!body?.path) return { path: null, parent: null, entries: roots.map((p) => ({ name: vehicles.vehicleForPath(p)?.name || (p === path.join(DATA, 'converted') ? 'Converted copies' : p), path: p, isDirectory: true })) };
    const real = await confined(body.path, allowed);
    const entries = (await readDir(real).catch(() => [])).filter((e) => e.isDirectory && !e.name.startsWith('.'));
    const realRoots = await Promise.all(roots.map((p) => fs.promises.realpath(p).catch(() => p)));
    const atRoot = roots.some((p) => path.resolve(p) === real) || realRoots.includes(real);
    return { path: real, parent: atRoot ? null : path.dirname(real), entries };
  });

  // ---- HTTP handler
  const PUBLIC_STATIC = new Set(['/login', '/web/login.js', '/web/shell.css', '/web/icon.png']);
  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendJson(res, 400, { error: 'Bad request' });
    }
    const rawPath = url.pathname;
    try {
      securityHeaders(req, res, rawPath);
      if (rawPath === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      const reqHost = cleanHost(req);
      if (!reqHost) return sendJson(res, 421, { error: 'Unknown host name.' });
      // one decoded, normalized path for every static decision: no %2F tricks
      let p;
      try {
        p = decodeURIComponent(rawPath);
      } catch {
        return sendJson(res, 400, { error: 'Bad request' });
      }
      if (p.includes('\0') || p.includes('\\') || path.posix.normalize(p) !== p) return sendJson(res, 400, { error: 'Bad request' });

      const user = auth.user(req);
      const isApi = p.startsWith('/api/');
      const publicStatic = PUBLIC_STATIC.has(p) || (p.startsWith('/web/fonts/') && !p.slice(11).includes('/'));

      if (isApi) {
        const m = r.match(req.method, rawPath);
        if (!m && p !== '/api/events' && p !== '/api/converter/events' && p !== '/api/media') return sendJson(res, 404, { error: 'Not found' });
        if (!user && !(m && m.route.opts.public)) return sendJson(res, 401, { error: 'Sign in first.' });
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (req.headers['x-requested-with'] !== 'sentry-manager') return sendJson(res, 403, { error: 'Missing X-Requested-With header.' });
          const origin = req.headers.origin;
          if (origin && origin !== 'null') {
            let originHost = null;
            try {
              originHost = new URL(origin).host;
            } catch {
              // fall through: refused
            }
            if (originHost !== reqHost) return sendJson(res, 403, { error: 'Cross-site request refused.' });
          }
        }
        if (p === '/api/events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write('event: hello\ndata: {}\n\n');
          clients.add(res);
          const ping = setInterval(() => res.write(': ping\n\n'), 20000);
          req.on('close', () => {
            clearInterval(ping);
            clients.delete(res);
          });
          return undefined;
        }
        if (p === '/api/converter/events') {
          if (!bridge) return sendJson(res, 503, { error: 'Converter is starting' });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write('event: hello\ndata: {}\n\n');
          bridge.attachEvents(String(url.searchParams.get('client') || '').slice(0, 64), res);
          return undefined;
        }
        if (p === '/api/media') {
          const real = await studioReadable.resolve(url.searchParams.get('path') || '');
          if (!real || hiddenPath(real)) return sendJson(res, 403, { error: 'Outside the vehicle shares.' });
          return sendMedia(req, res, real, studioReadable.fdInside);
        }
        const body = req.method === 'GET' ? undefined : await readJson(req, p.startsWith('/api/converter/') ? 256 * 1024 : 1024 * 1024);
        const out = await m.route.handler(req, res, { params: m.params, query: Object.fromEntries(url.searchParams), body, user });
        if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
        return undefined;
      }

      if (!user && !publicStatic) {
        res.writeHead(302, { Location: `/login${p === '/' ? '' : `?next=${encodeURIComponent(p + url.search)}`}` });
        return res.end();
      }
      const serve = async (root, rel, opts) => {
        if (!(await serveFile(req, res, root, rel, opts))) notFound(res);
      };
      if (p === '/' || p === '/index.html') return serve(WEB, 'index.html');
      if (p === '/login') return serve(WEB, 'login.html');
      if (p.startsWith('/web/')) return serve(WEB, p.slice(5), { cache: p.includes('/fonts/') ? 'public, max-age=604800' : 'no-cache' });
      if (p === '/studio' || p === '/studio/') {
        res.writeHead(302, { Location: `/studio/index.html${url.search}` });
        return res.end();
      }
      if (p.startsWith('/studio/')) {
        const rel = p.slice('/studio/'.length);
        return serve(path.join(SRC, 'renderer'), rel, rel === 'index.html' ? { transform: studioHtml } : {});
      }
      if (p.startsWith('/shared/')) return serve(path.join(SRC, 'shared'), p.slice(8));
      if (p.startsWith('/assets/')) return serve(path.join(APP_ROOT, 'assets'), p.slice(8));
      return notFound(res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error(`${req.method} ${rawPath}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 && !err.status ? 'Internal error' : err.message || 'Error', ...(err.expose && err.code ? { code: err.code } : {}) });
      else res.end();
      return undefined;
    }
  };
  function notFound(res) {
    sendJson(res, 404, { error: 'Not found' });
  }

  // ---- listen: HTTPS, with plain HTTP on the same port answering only with a redirect
  let httpsServer = null;
  const servers = [];
  if (!tlsSource) {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(PORT, HOST, () => log.warn(`Sentry Manager on http://${HOST}:${PORT} WITHOUT HTTPS (TLS_MODE=off): only use this behind a reverse proxy that does HTTPS.`));
  } else {
    const material = await tlsSource.load();
    httpsServer = https.createServer({ key: material.key, cert: material.cert, minVersion: 'TLSv1.2' }, handler);
    const redirect = http.createServer((req, res) => {
      if (String(req.url).split('?')[0] === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      const target = cleanHost(req) || `localhost:${PORT}`;
      let pathAndQuery = '/';
      try {
        const u = new URL(req.url, 'http://localhost');
        pathAndQuery = u.pathname + u.search;
      } catch {
        // keep "/"
      }
      res.writeHead(308, { Location: `https://${target}${pathAndQuery}`, 'Cache-Control': 'no-store' });
      return res.end();
    });
    const front = net.createServer((socket) => {
      socket.setTimeout(15000, () => socket.destroy());
      socket.on('error', () => socket.destroy());
      socket.once('data', (chunk) => {
        socket.setTimeout(0);
        socket.pause();
        socket.unshift(chunk);
        // a TLS connection starts with a handshake record (0x16)
        (chunk[0] === 0x16 ? httpsServer : redirect).emit('connection', socket);
        process.nextTick(() => socket.resume());
      });
    });
    servers.push(front, httpsServer, redirect);
    front.listen(PORT, HOST, () => log.info(`Sentry Manager on https://${HOST}:${PORT} (${buildInfo.sha ? buildInfo.sha.slice(0, 7) : 'dev'})`));
  }
  vehicles.startAll();

  // Converter starts in the background; the Encoder tab shows "starting" until ready.
  host.start().then(async (runtime) => {
    bridge = createConverterBridge({ runtime, resolvePath: (p, opts) => allowed.resolve(p, opts), log: logger.scope('converter') });
    const { createClipThumbnails } = require(path.join(SRC, 'main/clipThumbnails'));
    clipThumbs = createClipThumbnails({ directory: path.join(DATA, 'clip-thumbnails'), ffmpegPath: FFMPEG, ffprobePath: FFPROBE, spawn });
    runtime.service.subscribe((event) => {
      if (event?.type !== 'snapshot' || !event.snapshot) return;
      converterJobs.set(event.snapshot.id, event.snapshot);
      mirrorConverterJob(event.snapshot);
    });
    // jobs from before a restart (a paused one still owns its clips)
    for (const s of await runtime.service.list().catch(() => [])) if (!converterJobs.has(s.id)) converterJobs.set(s.id, s);
  }).catch((err) => log.error(`Converter unavailable: ${err.code || err.message}`));

  // Clip results of a converter job (its counters only hold files and bytes).
  function converterCounts(s) {
    const out = { converted: 0, skipped: 0, failed: 0 };
    for (const item of s.items || []) {
      if (item?.kind !== 'video') continue;
      if (item.state === 'completed' && item.eligibleVideo !== false) out.converted++;
      else if (item.state === 'skipped') out.skipped++;
      else if (item.state === 'failed') out.failed++;
    }
    return out;
  }

  function mirrorConverterJob(s) {
    const externalId = `converter:${s.id}`;
    const src = s.config?.sourceRoot || '';
    const v = vehicleForReal(src)?.vehicle || vehicles.vehicleForPath(src);
    const c = converterCounts(s);
    const saved = Number(s.counters?.savedBytes) || 0;
    const detail = [`${c.converted} converted`, `${c.skipped} skipped`, `${c.failed} failed`].join(', ') + (saved > 0 ? ` · ${formatBytes(saved)} saved` : '');
    let jobId = db.jobByExternal(externalId)?.id;
    if (!jobId) jobId = jobs.start({ type: 'conversion', vehicleId: v?.id || null, title: `Convert ${v ? v.name : src} to ${String(s.config?.codec || '').toUpperCase()}`, externalId });
    const terminal = !CONVERTER_ACTIVE.has(s.state);
    const existing = db.jobByExternal(externalId);
    if (terminal && existing?.status === 'running') {
      jobs.finish(jobId, { status: c.failed > 0 || s.state === 'failed' ? 'failed' : s.state === 'cancelled' ? 'cancelled' : 'done', detail });
      if (c.failed > 0) {
        notes.raise({ kind: 'conversion', level: 'warning', vehicleId: v?.id || null, dedupeKey: `conversion-failed:${s.id}`,
          title: `${c.failed} clip(s) could not be converted`, message: 'The originals were kept. Open the Encoder tab for details and Retry failed.' });
      }
    } else if (!terminal) {
      jobs.update(jobId, { detail: `${s.state}: ${detail}` });
    }
  }

  // housekeeping
  setInterval(() => {
    policies.tick().then(() => announce('bin')).catch(() => {});
    updater.tick().catch(() => {});
    db.pruneSessions();
  }, 60 * 1000).unref();
  setInterval(() => {
    for (const v of vehicles.list()) if (vehicles.share(v.id)?.isHealthy()) inventory.scan(v.id).then(() => announce('inventory')).catch(() => {});
  }, Number(process.env.SCAN_INTERVAL_MINUTES || 15) * 60 * 1000).unref();
  // renew the HTTPS certificate before it expires (checked daily)
  if (tlsSource) {
    setInterval(async () => {
      try {
        const m = await tlsSource.load();
        httpsServer?.setSecureContext({ key: m.key, cert: m.cert });
      } catch (err) {
        log.warn(`HTTPS certificate check failed: ${err.message}`);
      }
    }, 24 * 3600 * 1000).unref();
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: shutting down`);
    for (const res of clients) res.end();
    for (const s of servers) s.close();
    await host.stop().catch(() => {});
    await vehicles.stopAll();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  if (SUPERVISED) {
    process.on('disconnect', () => shutdown('supervisor gone'));
    // the supervisor renewed the certificate
    process.on('message', (m) => {
      if (m?.type === 'shutdown') return shutdown('supervisor asked');
      if (m?.type !== 'tls-updated' || !tlsSource || !httpsServer) return;
      tlsSource.load().then((x) => httpsServer.setSecureContext({ key: x.key, cert: x.cert }), (err) => log.warn(`Reloading the certificate failed: ${err.message}`));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
