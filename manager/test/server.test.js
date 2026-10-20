'use strict';

// The real server, started as a child process against a temporary
// TeslaCam tree, exercised over HTTP like the browser does.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
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
      SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'warn', ...env
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
      headers: { 'X-Requested-With': 'sentry-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
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
  return { base, call, child, stop, output: () => output, setCookie: (c) => { cookie = c; } };
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
    const html = await (await s.call('GET', '/studio/index.html', undefined, { raw: true })).text();
    assert.match(html, /window\.__SENTRY_WEB__ = true;[\s\S]*electronApiShim\.js/);
    assert.equal((await s.call('GET', '/shared/mapProviders.js', undefined, { raw: true })).status, 200);
    assert.equal((await s.call('GET', '/assets/pedal_brake.png', undefined, { raw: true })).headers.get('content-type'), 'image/png');
    assert.equal((await s.call('GET', '/studio/../../manager/server/index.js', undefined, { raw: true })).status, 404);

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

test('GitHub update installs a branch and the supervisor rolls back a broken one', { timeout: 180000 }, async () => {
  const dir = await tmp();
  await makeFootage(path.join(dir, 'footage'));
  // A fake GitHub serving this repository as the branch head.
  const tarball = path.join(dir, 'repo.tar.gz');
  execFileSync('git', ['-C', REPO, 'archive', '--format=tar.gz', '--prefix=owner-repo-abc/', '-o', tarball, 'HEAD']);
  // put the working-tree manager in (tests run before a commit too)
  const fakeSha = 'a'.repeat(40);
  const gh = http.createServer((req, res) => {
    if (req.url.startsWith('/repos/o/r/commits/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ sha: fakeSha, commit: { message: 'Test release\n\nbody', committer: { date: '2026-01-01T00:00:00Z' }, author: { name: 't' } } }));
    }
    if (req.url === `/repos/o/r/tarball/${fakeSha}`) {
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      return fs.createReadStream(tarball).pipe(res);
    }
    if (req.url.startsWith('/repos/o/r/branches')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify([{ name: 'main', commit: { sha: fakeSha } }, { name: 'beta', commit: { sha: fakeSha } }]));
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${gh.address().port}`;
  const s = await startServer(dir, { UPDATE_API_BASE: api });
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    assert.equal((await s.call('PUT', '/api/updater/settings', { repo: 'not a repo' })).status, 400);
    assert.equal((await s.call('PUT', '/api/updater/settings', { repo: 'o/r', branch: 'beta' })).status, 200);
    assert.deepEqual((await s.call('GET', '/api/updater/branches')).data.branches.map((b) => b.name), ['main', 'beta']);
    const st = await s.call('POST', '/api/updater/check', {});
    assert.equal(st.data.updateAvailable, true);
    assert.equal(st.data.latest.message, 'Test release');
    const inst = await s.call('POST', '/api/updater/install', {});
    assert.equal(inst.data.restarting, true);
    const code = await waitFor(() => (s.child.exitCode !== null ? s.child.exitCode : null), 20000);
    assert.equal(code, 75, 'asks the supervisor to restart');
    const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'data/app/current.json'), 'utf8'));
    assert.equal(pointer.sha, fakeSha);
    assert.equal(pointer.branch, 'beta');
    assert.ok(fs.existsSync(path.join(dir, 'data/app/releases', fakeSha, 'manager/server/index.js')));
  } finally {
    await s.stop();
    gh.close();
  }

  // Break the installed release: the supervisor must fall back to the built-in version.
  await fsp.writeFile(path.join(dir, 'data/app/releases', fakeSha, 'manager/server/index.js'), 'process.exit(3);\n');
  const port = await freePort();
  const sup = spawn(process.execPath, [SUPERVISOR], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'), RUN_DIR: path.join(dir, 'run'), SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'warn' },
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
    assert.match(out, /going back/);
    assert.equal(fs.existsSync(path.join(dir, 'data/app/current.json')), false, 'pointer cleared: running the built-in version');
  } finally {
    sup.kill('SIGTERM');
    await new Promise((r) => sup.once('exit', r));
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
