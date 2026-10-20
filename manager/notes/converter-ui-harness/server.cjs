'use strict';
// Harness server for the converter UI.
//  - Serves the ai-testing worktree READ-ONLY (repo root, so ../../assets and
//    ../shared paths in src/renderer/index.html resolve as in Electron).
//  - Injects /__harness/electron-api-shim.js into src/renderer/index.html on
//    the fly (the worktree file itself is never touched).
//  - Runs the REAL src/main/converter/ipc.js handler table behind
//    POST /api/ipc/<channel> (+ SSE /api/events for sender.send), with a
//    fake ipcMain, a fake dialog, a fake fs (container-style /footage paths)
//    and a fake converter service fed by scenarios.cjs.
// Usage: node server.cjs <worktree> [port]

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { snapshotFor, autoStateFor, BENCHMARK_RESULT, BENCHMARK_RESULT_AV1_UNSUPPORTED, baseConfig } = require('./scenarios.cjs');

const WORKTREE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'ai-testing'));
const PORT = Number(process.argv[3] || 9310);
const HARNESS = path.join(__dirname, 'harness');
const { registerConverterIpc } = require(path.join(WORKTREE, 'src/main/converter/ipc.js'));

// ---------------------------------------------------------------- SSE senders
// One stable "sender" per browser client id; an EventSource (re)connection
// attaches to it, so subscriptions survive reconnects. Mirrors the parts of
// Electron's WebContents that ipc.js uses: send, once('destroyed'),
// removeListener, isDestroyed.
const clients = new Map();
function getClient(id) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(String(id || ''))) return null;
  let client = clients.get(id);
  if (!client) {
    const destroyedListeners = new Set();
    client = {
      id, res: null, queue: [], destroyed: false, graceTimer: null,
      send(channel, payload) {
        const frame = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`;
        if (client.res) client.res.write(frame);
        else if (client.queue.length < 200) client.queue.push(frame);
      },
      once(event, fn) { if (event === 'destroyed') destroyedListeners.add(fn); },
      removeListener(event, fn) { if (event === 'destroyed') destroyedListeners.delete(fn); },
      isDestroyed() { return client.destroyed; },
      destroy() { client.destroyed = true; clients.delete(id); for (const fn of destroyedListeners) fn(); }
    };
    clients.set(id, client);
  }
  return client;
}

// ------------------------------------------------------------ fake service
const harness = { scenario: 'none', snapshot: null, auto: autoStateFor('none'), benchmarkMode: 'both', benchmarkGate: null };
const listeners = new Set();
function emit(event) { for (const fn of listeners) fn(event); }
function publish() {
  if (harness.snapshot) emit({ type: 'snapshot', jobId: harness.snapshot.id, revision: harness.snapshot.revision, snapshot: harness.snapshot });
}
function setScenario(name) {
  harness.scenario = name;
  harness.snapshot = snapshotFor(name);
  harness.auto = autoStateFor(name);
}
function bump(mutate) {
  const snap = harness.snapshot;
  if (!snap) throw Object.assign(new Error('JOB_NOT_FOUND'), { code: 'JOB_NOT_FOUND' });
  mutate(snap);
  snap.revision += 1;
  snap.updatedAt = Date.now();
  publish();
  return snap;
}
const service = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async list() { return harness.snapshot ? [harness.snapshot] : []; },
  async get() { return harness.snapshot; },
  async start(config) {
    const now = Date.now();
    harness.snapshot = { schemaVersion: 1, id: `job-${now}`, state: 'discovering', revision: 1, config, items: [],
      counters: snapshotFor('discovering').counters, summary: null, discoveryComplete: false, createdAt: now, updatedAt: now, pausedMs: 0 };
    setTimeout(publish, 50);
    return harness.snapshot.id;
  },
  async pause() { return bump((s) => { s.recovery = { fromState: s.state === 'paused' ? 'waiting' : s.state, action: 'resume-queue' }; s.state = 'paused'; }); },
  async resume() { return bump((s) => { s.state = s.recovery?.fromState || 'waiting'; delete s.recovery; }); },
  async cancel() { return bump((s) => { s.state = 'cancelled'; delete s.activeItemId; }); },
  async discard() { harness.snapshot = null; },
  async retryFailed() { return bump((s) => { s.items.forEach((i) => { if (i.state === 'failed') { i.state = 'queued'; delete i.failure; } }); s.state = 'waiting'; delete s.summary; s.summary = null; }); },
  async dismissSummary() { return bump((s) => { s.summaryDismissed = true; s.summary = null; }); }
};

// --------------------------------------------- fake fs / dialog / benchmark
const ALLOWED_ROOTS = ['/footage', '/converted'];
const allowed = (p) => ALLOWED_ROOTS.some((root) => p === root || p.startsWith(`${root}/`));
const KNOWN_DIRS = new Set(['/footage', '/footage/TeslaCam', '/footage/TeslaCam/RecentClips', '/footage/TeslaCam/SavedClips',
  '/footage/TeslaCam/SentryClips', '/footage/ModelY-2024', '/converted', '/converted/TeslaCam']);
const fakeFs = {
  async lstat(p) {
    if (!KNOWN_DIRS.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isDirectory: () => true };
  },
  async realpath(p) { return p; }
};
// Web "dialog": the browser already picked the folder and passes it as
// defaultPath; ipc.js then validates + canonicalizes exactly as on desktop.
const webDialog = {
  async showOpenDialog(options) {
    const picked = options?.defaultPath;
    if (!picked || !allowed(picked)) return { canceled: true, filePaths: [] };
    return { canceled: false, filePaths: [picked] };
  }
};
const benchmark = {
  async run(request) {
    const step = (p) => request.onProgress?.(p);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    step({ step: 'scan' });
    await wait(150);
    for (let i = 1; i <= 8; i += 1) { step({ step: 'copy', index: i, total: 8 }); await wait(30); }
    step({ step: 'run', level: 4, index: 3, total: 5, encoder: 'hevc_nvenc', hardware: true, codec: 'h265', codecIndex: 1, codecTotal: 2 });
    await new Promise((resolve, reject) => { harness.benchmarkGate = { resolve, reject }; });
    harness.benchmarkGate = null;
    return harness.benchmarkMode === 'av1-unsupported' ? BENCHMARK_RESULT_AV1_UNSUPPORTED : BENCHMARK_RESULT;
  },
  cancel() { harness.benchmarkGate?.reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' })); }
};
const auto = {
  get() { return harness.auto; },
  async configure(settings) {
    harness.auto = { settings, status: { ...harness.auto.status, nextCheckAt: settings.enabled ? Date.now() + settings.intervalMinutes * 60_000 : null } };
    return harness.auto;
  },
  async checkNow() { harness.auto = { ...harness.auto, status: { ...harness.auto.status, checking: true } }; return harness.auto; }
};

// --------------------------------------------- the real ipc.js, unmodified
const handlers = new Map();
const fakeIpcMain = { handle(channel, fn) { handlers.set(channel, fn); }, removeHandler(channel) { handlers.delete(channel); } };
registerConverterIpc({
  ipcMain: fakeIpcMain, dialog: webDialog, service, benchmark, auto, fs: fakeFs, pathApi: path.posix, platform: 'linux',
  capabilities: { separatePublication: 'hardlink-cleanup-pending', ownershipCleanup: 'atomic-expected-ownership', replacement: 'available', destinationContainment: 'pathname-revalidated-non-atomic' }
});

// ------------------------------------------------------------- http server
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // ---- the IPC bridge (what the web build would ship)
    if (url.pathname.startsWith('/api/ipc/') && req.method === 'POST') {
      const channel = decodeURIComponent(url.pathname.slice('/api/ipc/'.length));
      const handler = handlers.get(channel);
      if (!handler) return json(res, 404, { ok: false, error: { code: 'UNKNOWN_CHANNEL', retryable: false } });
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      const sender = getClient(req.headers['x-sentry-client']);
      const result = await handler({ sender }, Object.prototype.hasOwnProperty.call(body, 'payload') ? body.payload : undefined);
      return json(res, 200, result);
    }
    if (url.pathname === '/api/events') {
      const client = getClient(url.searchParams.get('client'));
      if (!client) return json(res, 400, { error: 'client id required' });
      clearTimeout(client.graceTimer);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      client.res = res;
      for (const frame of client.queue.splice(0)) res.write(frame);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        if (client.res === res) client.res = null;
        client.graceTimer = setTimeout(() => client.destroy(), 60_000);
      });
      return;
    }
    // Directory listing for the web folder picker (stand-in for dialog.showOpenDialog).
    if (url.pathname === '/api/fs/dirs') {
      const at = url.searchParams.get('path') || '/';
      const children = at === '/' ? ALLOWED_ROOTS : [...KNOWN_DIRS].filter((d) => path.posix.dirname(d) === at && d !== at);
      return json(res, 200, { ok: true, value: { path: at, parent: at === '/' ? null : (ALLOWED_ROOTS.includes(at) ? '/' : path.posix.dirname(at)), dirs: children.sort() } });
    }
    // ---- harness controls (test only)
    if (url.pathname === '/__harness/scenario') {
      setScenario(url.searchParams.get('name') || 'none');
      harness.benchmarkMode = url.searchParams.get('benchmark') || 'both';
      return json(res, 200, { ok: true, scenario: harness.scenario });
    }
    if (url.pathname === '/__harness/progress') {
      const snap = harness.snapshot;
      if (!snap) return json(res, 409, { ok: false });
      snap.revision += 1;
      emit({ type: 'progress', jobId: snap.id, revision: snap.revision,
        progress: { phase: 'continue', outTimeUs: Number(url.searchParams.get('outTimeUs') || 41_200_000), fps: Number(url.searchParams.get('fps') || 238.4) } });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__harness/snapshot') { publish(); return json(res, 200, { ok: true }); }
    if (url.pathname === '/__harness/benchmark-finish') { harness.benchmarkGate?.resolve(); return json(res, 200, { ok: true }); }
    if (url.pathname.startsWith('/__harness/')) {
      const file = path.join(HARNESS, path.basename(url.pathname));
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    // ---- read-only static worktree
    const rel = decodeURIComponent(url.pathname === '/' ? '/src/renderer/index.html' : url.pathname);
    const file = path.join(WORKTREE, path.normalize(rel));
    if (!file.startsWith(WORKTREE)) return json(res, 403, {});
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    if (file === path.join(WORKTREE, 'src/renderer/index.html')) {
      const html = fs.readFileSync(file, 'utf8').replace('<head>', '<head>\n    <script src="/__harness/electron-api-shim.js"></script>');
      res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    json(res, 500, { ok: false, error: { code: 'HARNESS_ERROR' } });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`harness on http://127.0.0.1:${PORT}/src/renderer/index.html (worktree ${WORKTREE})`));
module.exports = { baseConfig };
