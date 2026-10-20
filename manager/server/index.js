'use strict';

// Sentry Manager server: the Sentry Studio viewer and converter as a web app,
// plus file management (vehicles, footage, Recycle Bin, policies, jobs,
// notifications, settings, sign-in, GitHub updates).

process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { Logger } = require('./log');
const { ManagerDB } = require('./db');
const { Auth } = require('./auth');
const { VehicleManager } = require('./vehicles');
const { Inventory } = require('./inventory');
const { RecycleBin } = require('./recycleBin');
const { Policies } = require('./policies');
const { Jobs, Notifications } = require('./activity');
const { Updater } = require('./updater');
const { Thumbnails } = require('./thumbnails');
const { detectGpus } = require('./gpu');
const { createConverterHost } = require('./converterHost');
const { createConverterBridge } = require('./converterBridge');
const { createPathGuard, hiddenPath, readDir, stat, sendMedia } = require('./studioApi');
const { Router, HttpError, sendJson, readJson, serveFile } = require('./http');

const APP_ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..', '..'));
const SRC = path.join(APP_ROOT, 'src');
const WEB = path.join(APP_ROOT, 'manager', 'web');
const DATA = path.resolve(process.env.DATA_PATH || '/data');
const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || '0.0.0.0';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const CONVERTER_ACTIVE = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing', 'paused', 'paused_network']);
const ITEM_DONE = new Set(['completed', 'skipped', 'failed']);

function readBuildInfo() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'BUILD_INFO.json'), 'utf8'));
  } catch {
    return {};
  }
}

function studioHtml(html) {
  // Runs before any Studio script: marks web mode and installs window.electronAPI.
  const inject = '<script>window.__SENTRY_WEB__ = true;</script>\n<script src="/web/electronApiShim.js"></script>\n<link rel="stylesheet" href="/web/studioEmbed.css">';
  return html.replace(/<head([^>]*)>/i, (m) => `${m}\n${inject}`);
}

async function main() {
  const logger = new Logger({ level: process.env.LOG_LEVEL || 'info' });
  const log = logger.scope('server');
  fs.mkdirSync(DATA, { recursive: true });
  const buildInfo = readBuildInfo();
  const db = new ManagerDB(path.join(DATA, 'manager.db'));
  const auth = new Auth({ db, log: logger.scope('auth'), secureCookies: process.env.SECURE_COOKIES === 'true' });
  auth.bootstrap();
  const jobs = new Jobs({ db });
  const notes = new Notifications({ db });
  const vehicles = new VehicleManager({ db, footageRoot: process.env.FOOTAGE_ROOT || '/footage', logger, credDir: path.join(process.env.RUN_DIR || '/run/sentry-manager') });
  vehicles.bootstrapFromEnv();
  const inventory = new Inventory({ vehicles, db, log: logger.scope('inventory') });
  const thumbs = new Thumbnails({ dir: path.join(DATA, 'thumbnails'), ffmpegPath: FFMPEG });

  // ---- converter
  let converterSnapshot = null;
  const isBusy = (abs) => {
    const s = converterSnapshot;
    if (!s || !CONVERTER_ACTIVE.has(s.state) || !s.config?.sourceRoot) return false;
    return (s.items || []).some((i) => !ITEM_DONE.has(i.state) && i.relativePath && path.join(s.config.sourceRoot, i.relativePath) === abs);
  };
  const bin = new RecycleBin({ db, vehicles, inventory, jobs, log: logger.scope('bin'), isBusy });
  const policies = new Policies({ db, vehicles, inventory, bin, log: logger.scope('policies') });

  const host = createConverterHost({
    dataDir: path.join(DATA, 'converter'),
    tempDir: path.join(DATA, 'converter-temp'),
    ffmpegPath: FFMPEG,
    ffprobePath: FFPROBE,
    log: logger.scope('converter')
  });
  const outputRoots = () => [path.join(DATA, 'converted'), ...(process.env.EXTRA_ROOTS || '').split(':').filter(Boolean)];
  const allowedRoots = () => [...vehicles.roots(), ...outputRoots()];
  const allowed = createPathGuard(allowedRoots);
  const studioReadable = createPathGuard(() => [...allowedRoots(), path.join(DATA, 'thumbnails'), path.join(DATA, 'clip-thumbnails'), path.join(DATA, 'exports')]);
  let bridge = null;
  let clipThumbs = null;

  const updater = new Updater({
    db, log: logger.scope('updater'), dataDir: DATA, appRoot: APP_ROOT, buildInfo,
    isIdle: () => !converterSnapshot || !CONVERTER_ACTIVE.has(converterSnapshot.state)
  });

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
    if (healthy) inventory.scan(id).then(() => announce('inventory')).catch(() => {});
  });

  // ---- routes
  const r = new Router();
  const vehicleOr404 = (id) => {
    const v = vehicles.get(id);
    if (!v) throw new HttpError(404, 'No such vehicle.');
    return v;
  };
  const vehicleSummary = (v) => ({
    ...vehicles.publicView(v),
    inventory: inventory.totals(v.id),
    scanning: Boolean(inventory.get(v.id)?.scanning),
    binBytes: bin.binBytes(v.id),
    binItems: db.binItems(v.id).length,
    policy: policies.get(v.id)
  });

  r.add('GET', '/api/auth/me', (req) => ({ user: auth.user(req), needsSetup: auth.needsSetup() }), { public: true });
  r.add('POST', '/api/auth/login', async (req, res, { body }) => {
    const ip = req.socket.remoteAddress || '?';
    const wait = auth.throttled(ip);
    if (wait) throw new HttpError(429, `Too many attempts. Try again in ${wait} s.`);
    if (!auth.check(body?.username, body?.password)) {
      auth.noteFailure(ip);
      throw new HttpError(401, 'Wrong user name or password.');
    }
    auth.login(res, body.username);
    return { ok: true };
  }, { public: true });
  r.add('POST', '/api/auth/setup', async (req, res, { body }) => {
    if (!auth.needsSetup()) throw new HttpError(409, 'An account already exists.');
    auth.setPassword(String(body?.username || ''), String(body?.password || ''));
    auth.login(res, body.username);
    return { ok: true };
  }, { public: true });
  r.add('POST', '/api/auth/logout', (req, res) => {
    auth.logout(req, res);
    return { ok: true };
  });
  r.add('POST', '/api/auth/password', (req, res, { body, user }) => {
    if (!auth.check(user, body?.current)) throw new HttpError(401, 'The current password is wrong.');
    auth.setPassword(user, String(body?.next || ''));
    db.deleteSessionsFor(user);
    auth.login(res, user);
    return { ok: true };
  });

  r.add('GET', '/api/system', async () => ({
    version: { ...buildInfo, ...updater.current() },
    converter: host.runtime ? { ready: true, capabilities: host.runtime.capabilities } : { ready: false, error: host.lastError?.code || null },
    nativeHelper: host.helperAvailable,
    gpu: await detectGpus(),
    dataFree: await fs.promises.statfs(DATA).then((s) => Number(s.bavail) * Number(s.bsize)).catch(() => null),
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone
  }));

  r.add('GET', '/api/vehicles', () => ({ vehicles: vehicles.list().map(vehicleSummary) }));
  r.add('POST', '/api/vehicles', (req, res, { body }) => vehicleSummary(vehicles.add(body || {})));
  r.add('PUT', '/api/vehicles/:id', async (req, res, { params, body }) => vehicleSummary(await vehicles.update(params.id, body || {})));
  r.add('DELETE', '/api/vehicles/:id', async (req, res, { params }) => {
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
    const file = rec.thumbRel ? path.join(root, rec.thumbRel) : rec.frontRel ? await thumbs.forClip(path.join(root, rec.frontRel)) : null;
    if (!file) throw new HttpError(404, 'No thumbnail');
    await sendMedia(req, res, file);
    return undefined;
  });
  r.add('POST', '/api/vehicles/:id/protect', (req, res, { params, body }) => {
    const v = vehicleOr404(params.id);
    const on = body?.protected !== false;
    const recs = (body?.ids || []).map((id) => inventory.recording(v.id, id)).filter(Boolean);
    db.setProtected(v.id, recs.flatMap((x) => x.files), on);
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
    const out = await bin.deleteForever(params.item);
    announce('bin');
    return out;
  });
  r.add('POST', '/api/bin/empty', async (req, res, { body }) => {
    if (body?.confirm !== true) throw new HttpError(400, 'Confirm emptying the Recycle Bin.');
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
    notes.markRead((body?.ids || []).map(Number).filter(Number.isFinite));
    return { ok: true };
  });

  r.add('GET', '/api/settings', () => ({ appearance: db.get('appearance', { reduceEffects: false }), updater: updater.publicSettings() }));
  r.add('PUT', '/api/settings/appearance', (req, res, { body }) => {
    const next = { reduceEffects: Boolean(body?.reduceEffects) };
    db.set('appearance', next);
    return next;
  });
  r.add('GET', '/api/updater', () => updater.status());
  r.add('PUT', '/api/updater/settings', (req, res, { body }) => updater.setSettings(body || {}));
  r.add('GET', '/api/updater/branches', async () => ({ branches: await updater.branches() }));
  r.add('POST', '/api/updater/check', async () => updater.check());
  r.add('POST', '/api/updater/install', async () => {
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
  const confined = (p, guard = studioReadable) => {
    const abs = guard(p);
    if (!abs || hiddenPath(abs)) throw new HttpError(403, 'That path is outside the vehicle shares.');
    return abs;
  };
  r.add('POST', '/api/studio/readDir', async (req, res, { body }) => {
    try {
      return await readDir(confined(body?.path));
    } catch (err) {
      if (err.status) throw err;
      return [];
    }
  });
  r.add('POST', '/api/studio/readFile', async (req, res, { body }) => {
    const abs = confined(body?.path);
    const st = await fs.promises.stat(abs).catch(() => null);
    if (!st || st.size > 8 * 1024 * 1024) throw new HttpError(404, 'Not readable');
    return { text: await fs.promises.readFile(abs, 'utf8') };
  });
  r.add('POST', '/api/studio/exists', async (req, res, { body }) => {
    const abs = studioReadable(body?.path);
    if (!abs || hiddenPath(abs)) return false;
    return fs.promises.access(abs).then(() => true, () => false);
  });
  r.add('POST', '/api/studio/stat', async (req, res, { body }) => {
    const abs = studioReadable(body?.path);
    return abs && !hiddenPath(abs) ? stat(abs) : null;
  });
  r.add('POST', '/api/studio/thumbnail', async (req, res, { body }) => {
    const abs = studioReadable(body?.path);
    if (!abs || !clipThumbs) return null;
    try {
      return await clipThumbs.get(abs);
    } catch {
      return null;
    }
  });
  r.add('POST', '/api/studio/trashFolder', async (req, res, { body }) => {
    // Studio's "delete folder" (trash icon on an event): goes to the Recycle Bin.
    const abs = confined(body?.path, allowed);
    const v = vehicles.vehicleForPath(abs);
    if (!v) throw new HttpError(403, 'Not inside a vehicle share.');
    if (!inventory.get(v.id)?.recordings) await inventory.scan(v.id);
    const rel = path.relative(vehicles.rootOf(v), abs).split(path.sep).join('/');
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
    const roots = allowedRoots();
    if (!body?.path) return { path: null, parent: null, entries: roots.map((p) => ({ name: vehicles.vehicleForPath(p)?.name || p, path: p, isDirectory: true })) };
    const abs = confined(body.path, allowed);
    const entries = (await readDir(abs).catch(() => [])).filter((e) => e.isDirectory && !e.name.startsWith('.'));
    const atRoot = roots.some((p) => path.resolve(p) === abs);
    return { path: abs, parent: atRoot ? null : path.dirname(abs), entries };
  });

  // ---- HTTP server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      const user = auth.user(req);
      const isApi = p.startsWith('/api/');
      const publicStatic = p === '/login' || p.startsWith('/web/login') || p.startsWith('/web/fonts/') || p === '/web/icon.png' || p === '/web/shell.css';

      if (isApi) {
        const m = r.match(req.method, p);
        if (!m && p !== '/api/events' && p !== '/api/converter/events' && p !== '/api/media') return sendJson(res, 404, { error: 'Not found' });
        if (!user && !(m && m.route.opts.public)) return sendJson(res, 401, { error: 'Sign in first.' });
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'sentry-manager') {
          return sendJson(res, 403, { error: 'Missing X-Requested-With header.' });
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
          const abs = studioReadable(url.searchParams.get('path') || '');
          if (!abs || hiddenPath(abs)) return sendJson(res, 403, { error: 'Outside the vehicle shares.' });
          return sendMedia(req, res, abs);
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
      if (status >= 500) log.error(`${req.method} ${p}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: err.message || 'Error' });
      else res.end();
      return undefined;
    }
  });
  function notFound(res) {
    sendJson(res, 404, { error: 'Not found' });
  }

  server.listen(PORT, HOST, () => log.info(`Sentry Manager on http://${HOST}:${PORT} (${buildInfo.sha ? buildInfo.sha.slice(0, 7) : 'dev'})`));
  vehicles.startAll();

  // Converter starts in the background; the Encoder tab shows "starting" until ready.
  host.start().then((runtime) => {
    bridge = createConverterBridge({ runtime, isAllowedPath: (p) => Boolean(allowed(p)), log: logger.scope('converter') });
    const { createClipThumbnails } = require(path.join(SRC, 'main/clipThumbnails'));
    clipThumbs = createClipThumbnails({ directory: path.join(DATA, 'clip-thumbnails'), ffmpegPath: FFMPEG, ffprobePath: FFPROBE, spawn });
    runtime.service.subscribe((event) => {
      if (event?.type !== 'snapshot' || !event.snapshot) return;
      converterSnapshot = event.snapshot;
      mirrorConverterJob(event.snapshot);
    });
  }).catch((err) => log.error(`Converter unavailable: ${err.code || err.message}`));

  function mirrorConverterJob(s) {
    const externalId = `converter:${s.id}`;
    const src = s.config?.sourceRoot || '';
    const v = vehicles.vehicleForPath(src);
    const c = s.counters || {};
    const detail = [`${c.completed ?? 0} converted`, `${c.skipped ?? 0} skipped`, `${c.failed ?? 0} failed`].join(', ');
    let jobId = db.jobByExternal(externalId)?.id;
    if (!jobId) jobId = jobs.start({ type: 'conversion', vehicleId: v?.id || null, title: `Convert ${v ? v.name : src} to ${String(s.config?.codec || '').toUpperCase()}`, externalId });
    const terminal = !CONVERTER_ACTIVE.has(s.state);
    const existing = db.jobByExternal(externalId);
    if (terminal && existing?.status === 'running') {
      jobs.finish(jobId, { status: (c.failed ?? 0) > 0 || s.state === 'failed' ? 'failed' : s.state === 'cancelled' ? 'cancelled' : 'done', detail });
      if ((c.failed ?? 0) > 0) {
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

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: shutting down`);
    for (const res of clients) res.end();
    server.close();
    await host.stop().catch(() => {});
    await vehicles.stopAll();
    db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
