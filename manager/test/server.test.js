'use strict';

// The real server, started as a child process against a temporary
// TeslaCam tree, exercised over HTTP like the browser does.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'manager', 'server', 'index.js');
const SUPERVISOR = path.join(REPO, 'manager', 'server', 'supervisor.js');
const HELPER = path.join(__dirname, '..', 'build', 'noreplace-rename');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function writeClip(file, real) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (real && hasFfmpeg) {
    const { createTeslaH264Fixture } = require(path.join(REPO, 'tests/main/converter/ffmpegFixtures'));
    await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: file, durationSeconds: 2, frameRate: 12, size: '320x240', spatialNoise: 4,
      telemetryPattern: Array.from({ length: 24 }, (_, i) => Buffer.from([0x20, i])) });
  } else {
    await fsp.writeFile(file, crypto.randomBytes(2048));
  }
}

async function makeFootage(root) {
  const T = path.join(root, 'TeslaCam');
  await writeClip(path.join(T, 'RecentClips/2020-01-01_08-00-00-front.mp4'), true);
  await writeClip(path.join(T, 'RecentClips/2020-01-01_08-00-00-back.mp4'));
  await writeClip(path.join(T, 'RecentClips/2020-01-01_08-01-00-front.mp4'));
  await writeClip(path.join(T, 'RecentClips/2020-01-01_09-30-00-front.mp4'));
  await writeClip(path.join(T, 'SentryClips/2020-01-02_12-30-00/2020-01-02_12-29-00-front.mp4'));
  await fsp.writeFile(path.join(T, 'SentryClips/2020-01-02_12-30-00/event.json'), JSON.stringify({ city: 'Austin', reason: 'sentry_aware_object_detection' }));
  await writeClip(path.join(T, 'SavedClips/2020-01-03_10-00-00/2020-01-03_09-59-00-front.mp4'));
  await fsp.writeFile(path.join(root, 'notes.txt'), 'not footage');
}

async function startServer(dir, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'warn', TLS_MODE: 'off', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  let cookie = '';
  const call = async (method, p, body, { raw = false, headers = {} } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data };
  };
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
  return { base, call, child, stop, output: () => output, setCookie: (c) => { cookie = c; }, getCookie: () => cookie };
}

async function tmp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sm-server-'));
}

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('sign-in, CSRF header and throttling', async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  try {
    assert.equal((await s.call('GET', '/api/vehicles')).status, 401);
    const page = await s.call('GET', '/', undefined, { raw: true });
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location'), /^\/login/);
    assert.equal((await s.call('GET', '/login', undefined, { raw: true })).status, 200);
    assert.equal((await s.call('POST', '/api/auth/setup', { username: 'x', password: 'whatever123' })).status, 409, 'account came from UI_PASSWORD');
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).status, 401);
    assert.equal((await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 429, 'throttled after repeated failures');
  } finally {
    await s.stop();
  }
  const s2 = await startServer(dir);
  try {
    assert.equal((await s2.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    assert.equal((await s2.call('GET', '/api/vehicles')).status, 200);
    const noHeader = await s2.call('POST', '/api/vehicles/daily-driver/scan', {}, { headers: { 'X-Requested-With': 'x' } });
    assert.equal(noHeader.status, 403, 'mutations need the X-Requested-With header');
    const crossSite = await s2.call('POST', '/api/vehicles/daily-driver/scan', {}, { headers: { Origin: 'http://evil.example' } });
    assert.equal(crossSite.status, 403, 'mutations from another site are refused');
    // a stray cookie with bad %-encoding must not break the session
    const stray = await s2.call('GET', '/api/vehicles', undefined, { headers: { Cookie: `other=100%; ${s2.getCookie()}` } });
    assert.equal(stray.status, 200);
    // static files: one decoded path decides; encoded tricks never reach a file
    s2.setCookie('');
    for (const u of ['/web/login%2F..%2Fapp.js', '/web/fonts/..%2Findex.html', '/web/login%2F..%2FelectronApiShim.js']) {
      assert.equal((await s2.call('GET', u, undefined, { raw: true })).status, 400, u);
    }
    assert.equal((await s2.call('GET', '/web/app.js', undefined, { raw: true })).status, 302, 'the app needs sign-in');
    assert.equal((await s2.call('GET', '/web/login.js', undefined, { raw: true })).status, 200, 'the sign-in script does not');
    const headers = (await s2.call('GET', '/login', undefined, { raw: true })).headers;
    assert.match(headers.get('content-security-policy'), /script-src 'self'(;|$)/);
    assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
    await s2.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal((await s2.call('POST', '/api/auth/logout', {})).status, 200);
    assert.equal((await s2.call('GET', '/api/vehicles')).status, 401);
  } finally {
    await s2.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('footage, protect, Recycle Bin and policies never lose files', { timeout: 120000 }, async () => {
  const dir = await tmp();
  const root = path.join(dir, 'footage');
  await makeFootage(root);
  const before = Object.fromEntries(['RecentClips/2020-01-01_08-00-00-front.mp4', 'SentryClips/2020-01-02_12-30-00/event.json'].map((r) => [r, sha(path.join(root, 'TeslaCam', r))]));
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const { data: { vehicles } } = await s.call('GET', '/api/vehicles');
    assert.equal(vehicles.length, 1);
    assert.equal(vehicles[0].studioRoot, path.join(root, 'TeslaCam'), 'Studio opens the TeslaCam folder');
    const list = await waitFor(async () => {
      const r = await s.call('GET', '/api/vehicles/daily-driver/recordings');
      return r.data.total ? r.data : null;
    });
    const by = Object.fromEntries(list.recordings.map((r) => [`${r.category} ${r.start}`, r]));
    assert.deepEqual(Object.keys(by).sort(), ['Recent 2020-01-01 08:00:00', 'Recent 2020-01-01 09:30:00', 'Saved 2020-01-03 09:59:00', 'Sentry 2020-01-02 12:29:00']);
    assert.equal(by['Recent 2020-01-01 08:00:00'].fileCount, 3, 'one drive = consecutive minutes');
    assert.equal(by['Sentry 2020-01-02 12:29:00'].eventAt, '2020-01-02 12:30:00');
    const detail = await s.call('GET', `/api/vehicles/daily-driver/recordings/${by['Sentry 2020-01-02 12:29:00'].id}`);
    assert.equal(detail.data.event.city, 'Austin');

    if (hasFfmpeg) {
      const thumb = await s.call('GET', `/api/vehicles/daily-driver/recordings/${by['Recent 2020-01-01 08:00:00'].id}/thumbnail`, undefined, { raw: true });
      assert.equal(thumb.status, 200);
      assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
    }

    // media: ranges, and nothing outside the shares
    const clip = path.join(root, 'TeslaCam/RecentClips/2020-01-01_08-00-00-back.mp4');
    const part = await s.call('GET', `/api/media?path=${encodeURIComponent(clip)}`, undefined, { raw: true, headers: { Range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    assert.equal((await s.call('GET', `/api/media?path=${encodeURIComponent('/etc/passwd')}`, undefined, { raw: true })).status, 403);
    assert.equal((await s.call('POST', '/api/studio/readDir', { path: '/etc' })).status, 403);

    // protected recordings are never trashed
    const sentry = by['Sentry 2020-01-02 12:29:00'];
    await s.call('POST', '/api/vehicles/daily-driver/protect', { ids: [sentry.id], protected: true });
    let r = await s.call('POST', '/api/vehicles/daily-driver/trash', { ids: [sentry.id] });
    assert.deepEqual(r.data.moved, []);
    assert.equal(r.data.skipped[0].reason, 'protected');
    await s.call('POST', '/api/vehicles/daily-driver/protect', { ids: [sentry.id], protected: false });

    // trash -> files move inside the share, nothing deleted, hidden from the viewer
    r = await s.call('POST', '/api/vehicles/daily-driver/trash', { ids: [sentry.id, by['Recent 2020-01-01 08:00:00'].id] });
    assert.equal(r.data.moved.length, 2);
    assert.equal(fs.existsSync(path.join(root, 'TeslaCam/SentryClips/2020-01-02_12-30-00')), false, 'empty event folder removed');
    assert.ok(fs.existsSync(path.join(root, 'TeslaCam/SentryClips')), 'clip folders kept');
    const binFiles = execFileSync('find', [path.join(root, '.sentry-recycle-bin'), '-type', 'f']).toString().trim().split('\n');
    assert.equal(binFiles.length, 5);
    assert.ok(binFiles.every((f) => f.endsWith('.binned')), 'binned files are invisible to the converter');
    const rootListing = await s.call('POST', '/api/studio/readDir', { path: root });
    assert.ok(!rootListing.data.some((e) => e.name === '.sentry-recycle-bin'), 'viewer never sees the bin');
    const { data: { items } } = await s.call('GET', '/api/bin?vehicle=daily-driver');
    assert.equal(items.length, 2);

    // restore -> byte-identical
    for (const item of items) assert.equal((await s.call('POST', `/api/bin/${item.id}/restore`, {})).status, 200);
    for (const [rel, h] of Object.entries(before)) assert.equal(sha(path.join(root, 'TeslaCam', rel)), h, `${rel} restored unchanged`);
    assert.equal((await s.call('GET', '/api/bin')).data.items.length, 0);

    // policies only move to the bin, and skip protected
    const all = await waitFor(async () => ((await s.call('GET', '/api/vehicles/daily-driver/recordings')).data.total === 4 ? true : null));
    assert.ok(all);
    const saved = (await s.call('GET', '/api/vehicles/daily-driver/recordings?category=Saved')).data.recordings[0];
    await s.call('POST', '/api/vehicles/daily-driver/protect', { ids: [saved.id], protected: true });
    const pol = await s.call('PUT', '/api/vehicles/daily-driver/policy', { enabled: false, keepDays: { Recent: 30, Sentry: 30, Saved: 30 } });
    assert.equal(pol.data.preview.recordings, 3, 'everything from 2020 except the protected one');
    assert.equal((await s.call('PUT', '/api/vehicles/daily-driver/policy', { keepDays: { Recent: 0 } })).status, 400);
    r = await s.call('POST', '/api/vehicles/daily-driver/policy/run', {});
    assert.equal(r.data.moved.length, 3);
    assert.ok(fs.existsSync(path.join(root, 'TeslaCam/SavedClips/2020-01-03_10-00-00/2020-01-03_09-59-00-front.mp4')), 'protected kept');
    const binned = (await s.call('GET', '/api/bin')).data.items;
    assert.equal(binned.length, 3);
    assert.ok(binned.every((i) => i.reason === 'policy'));

    // permanent deletion only with explicit confirmation
    assert.equal((await s.call('POST', `/api/bin/${binned[0].id}/delete`, {})).status, 400);
    assert.equal((await s.call('POST', '/api/bin/empty', {})).status, 400);
    assert.equal((await s.call('POST', `/api/bin/${binned[0].id}/delete`, { confirm: true })).status, 200);
    const emptied = await s.call('POST', '/api/bin/empty', { confirm: true, vehicle: 'daily-driver' });
    assert.equal(emptied.data.deleted, 2);
    assert.ok(fs.existsSync(path.join(root, 'notes.txt')), 'non-footage files are never touched');
    const jobs = (await s.call('GET', '/api/jobs')).data.jobs.map((j) => j.type);
    for (const t of ['trash', 'restore', 'policy', 'empty-bin']) assert.ok(jobs.includes(t), `job recorded: ${t}`);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Studio is served with the web shim; converter bridge enforces Quick and allowed paths', { timeout: 120000 }, async () => {
  const dir = await tmp();
  const root = path.join(dir, 'footage');
  await makeFootage(root);
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const studioRes = await s.call('GET', '/studio/index.html', undefined, { raw: true });
    assert.match(studioRes.headers.get('content-security-policy'), /script-src 'self' 'unsafe-eval'/, 'Studio needs eval for its protobuf decoder');
    assert.doesNotMatch((await s.call('GET', '/', undefined, { raw: true })).headers.get('content-security-policy'), /unsafe-eval/, 'the shell does not');
    const html = await studioRes.text();
    assert.match(html, /webFlag\.js[\s\S]*electronApiShim\.js/);
    assert.ok(!/<script>/.test(html.split('</head>')[0].split('<head>')[1].split('<title>')[0]), 'nothing inline is injected');
    assert.equal((await s.call('GET', '/shared/mapProviders.js', undefined, { raw: true })).status, 200);
    assert.equal((await s.call('GET', '/assets/pedal_brake.png', undefined, { raw: true })).headers.get('content-type'), 'image/png');
    assert.ok([400, 404].includes((await s.call('GET', '/studio/..%2F..%2Fmanager/server/index.js', undefined, { raw: true })).status));

    await waitFor(async () => (await s.call('POST', '/api/converter/invoke/getCapabilities')).data.ok);
    const outside = await s.call('POST', '/api/converter/invoke/start', {
      sourceRoot: '/etc', destinationRoot: null, outputMode: 'replace', replacementConfirmed: true, codec: 'h265', profileId: 'balanced',
      networkMode: 'direct', includedGroups: ['RecentClips'], verifyMode: 'off'
    });
    assert.deepEqual(outside.data, { ok: false, error: { code: 'PATH_NOT_ALLOWED' } });

    const started = await s.call('POST', '/api/converter/invoke/start', {
      sourceRoot: path.join(root, 'TeslaCam'), destinationRoot: path.join(dir, 'data', 'converted'), outputMode: 'separate', replacementConfirmed: false,
      codec: 'h265', profileId: 'balanced', networkMode: 'direct', includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], verifyMode: 'off'
    }, { headers: { 'X-Client-Id': 'test-client' } });
    assert.equal(started.data.ok, true, JSON.stringify(started.data));
    const cur = await s.call('POST', '/api/converter/invoke/getCurrent');
    assert.equal(cur.data.value.config.verifyMode, 'quick', 'Off is never used for a real conversion');
    await waitFor(async () => {
      const c = await s.call('POST', '/api/converter/invoke/getCurrent');
      return ['completed', 'failed', 'cancelled'].includes(c.data.value?.state);
    }, 120000);
    const jobs = (await s.call('GET', '/api/jobs')).data.jobs;
    assert.ok(jobs.some((j) => j.type === 'conversion' && j.status !== 'running'), 'conversion mirrored into Jobs');
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the supervisor only runs the app from the image, never code left in /data', { timeout: 120000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  // what the old in-app updater left behind, or what anyone who can write /data could plant
  const fakeSha = 'a'.repeat(40);
  const planted = path.join(dir, 'data/app/releases', fakeSha, 'manager/server');
  await fsp.mkdir(planted, { recursive: true });
  await fsp.writeFile(path.join(planted, 'index.js'), "console.log('PLANTED CODE RAN'); setInterval(() => {}, 1000);\n");
  await fsp.writeFile(path.join(dir, 'data/app/current.json'), JSON.stringify({ sha: fakeSha, previous: null, branch: 'x' }));
  const port = await freePort();
  const sup = spawn(process.execPath, [SUPERVISOR], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'), RUN_DIR: path.join(dir, 'run'), SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'warn', TLS_MODE: 'off', PUID: '0', PGID: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  sup.stdout.on('data', (c) => { out += c; });
  sup.stderr.on('data', (c) => { out += c; });
  try {
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
      } catch {
        return false;
      }
    }, 60000);
    assert.match(out, /starting the app/);
    assert.doesNotMatch(out, /PLANTED CODE RAN/);
    // the app clears the old updater's folder
    await waitFor(() => !fs.existsSync(path.join(dir, 'data/app')), 10000);
  } finally {
    sup.kill('SIGTERM');
    await new Promise((r) => sup.once('exit', r));
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Settings > Updates: a build without an image to check says so and checks nothing', async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  const s = await startServer(dir);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const st = (await s.call('GET', '/api/updates')).data;
    assert.equal(st.enabled, false);
    assert.equal(st.updateAvailable, false);
    assert.equal((await s.call('POST', '/api/updates/check', {})).data.enabled, false);
    for (const p of ['/api/updater', '/api/updater/branches']) assert.equal((await s.call('GET', p)).status, 404, `${p} is gone`);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
