'use strict';

// Security properties: HTTPS and sign-in, password confirmation, symlinks on
// shares, folder vehicles, SMB settings that could add mount options, the
// HTTPS certificate authority's name constraints, and Recycle Bin safety
// against crashes and races.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { normalizeSmb, mountArgs, parseShare } = require('../server/mountSpec');
const { createRealGuard } = require('../server/safePath');
const { parseCookies } = require('../server/auth');
const { TlsManager } = require('../server/tls');
const { RecycleBin, BIN_DIR } = require('../server/recycleBin');
const { ManagerDB } = require('../server/db');

const REPO = path.join(__dirname, '..', '..');
const SERVER = path.join(REPO, 'manager', 'server', 'index.js');
const HELPER = path.join(__dirname, '..', 'build', 'noreplace-rename');
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const tmp = (p = 'sm-sec-') => fsp.mkdtemp(path.join(os.tmpdir(), p));
const quiet = { info() {}, warn() {}, error() {} };

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Minimal HTTPS client that trusts only the given CA. */
function httpsCall(port, ca, method, p, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      host: '127.0.0.1', port, path: p, method, ca, servername: 'localhost',
      headers: { 'X-Requested-With': 'sentry-manager', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, text, data: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function startServer(dir, env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), TZ: 'UTC', SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'info', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { port, child, stop, output: () => output };
}

test('HTTPS, the setup code, cookies and password confirmation', { skip: !hasOpenssl, timeout: 120000 }, async () => {
  const dir = await tmp();
  await fsp.mkdir(path.join(dir, 'footage/TeslaCam/RecentClips'), { recursive: true });
  let s = await startServer(dir, {});
  try {
    const ca = fs.readFileSync(path.join(dir, 'data/tls/ca.crt'));
    const code = s.output().match(/setup code ([A-Z0-9-]+)/)?.[1];
    assert.ok(code, 'the setup code is printed in the log');

    // plain HTTP only redirects (health checks still answer)
    const plain = await fetch(`http://127.0.0.1:${s.port}/settings?x=1`, { redirect: 'manual' });
    assert.equal(plain.status, 308);
    assert.equal(plain.headers.get('location'), `https://127.0.0.1:${s.port}/settings?x=1`);

    // the certificate verifies against our CA (no -k anywhere)
    const me = await httpsCall(s.port, ca, 'GET', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.deepEqual([me.data.needsSetup, me.data.secure], [true, true]);
    assert.match(me.headers['strict-transport-security'], /max-age=/);

    // whoever reaches the page first cannot claim it without the code
    assert.equal((await httpsCall(s.port, ca, 'POST', '/api/auth/setup', { body: { username: 'mallory', password: 'attackerpass1' } })).status, 403);
    assert.equal((await httpsCall(s.port, ca, 'POST', '/api/auth/setup', { body: { username: 'mallory', password: 'attackerpass1', code: 'AAAAA-BBBBB-CCCCC' } })).status, 403);
    const setup = await httpsCall(s.port, ca, 'POST', '/api/auth/setup', { body: { username: 'admin', password: 'correct horse', code: code.toLowerCase() } });
    assert.equal(setup.status, 200);
    const setCookie = setup.headers['set-cookie'][0];
    assert.match(setCookie, /^__Host-sm_session=/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(setCookie.includes(flag), flag);
    const cookie = setCookie.split(';')[0];
    assert.equal((await httpsCall(s.port, ca, 'POST', '/api/auth/setup', { body: { username: 'x', password: 'whatever123', code } })).status, 409);
    // a plain cookie of the same name (planted over HTTP) is not accepted over HTTPS
    assert.equal((await httpsCall(s.port, ca, 'GET', '/api/vehicles', { cookie: cookie.replace('__Host-', '') })).status, 401);

    // right after signing in, sensitive changes go through
    assert.equal((await httpsCall(s.port, ca, 'PUT', '/api/updater/settings', { body: { branch: 'main' }, cookie })).status, 200);
    await s.stop();

    // after a restart the session lives on, but the confirmation does not
    s = await startServer(dir, {});
    const again = await httpsCall(s.port, ca, 'PUT', '/api/updater/settings', { body: { branch: 'beta' }, cookie });
    assert.equal(again.status, 403);
    assert.equal(again.data.code, 'CONFIRM_PASSWORD');
    for (const [p, body] of [['/api/vehicles', { name: 'X', source: { type: 'path', path: path.join(dir, 'footage') } }], ['/api/bin/empty', { confirm: true }], ['/api/updater/install', {}]]) {
      assert.equal((await httpsCall(s.port, ca, 'POST', p, { body, cookie })).data.code, 'CONFIRM_PASSWORD', p);
    }
    assert.equal((await httpsCall(s.port, ca, 'PUT', '/api/vehicles/daily-driver', { body: { source: { type: 'path', path: '/' } }, cookie })).data.code, 'CONFIRM_PASSWORD');
    assert.equal((await httpsCall(s.port, ca, 'PUT', '/api/vehicles/daily-driver', { body: { name: 'Renamed' }, cookie })).status, 200, 'a rename needs no password');
    assert.equal((await httpsCall(s.port, ca, 'POST', '/api/auth/confirm', { body: { password: 'wrong password' }, cookie })).status, 401);
    assert.equal((await httpsCall(s.port, ca, 'POST', '/api/auth/confirm', { body: { password: 'correct horse' }, cookie })).status, 200);
    assert.equal((await httpsCall(s.port, ca, 'PUT', '/api/updater/settings', { body: { branch: 'beta' }, cookie })).status, 200);

    // the CA download and the Security status
    const sec = await httpsCall(s.port, ca, 'GET', '/api/security', { cookie });
    assert.equal(sec.data.https, true);
    assert.equal(sec.data.tls.mode, 'local-ca');
    assert.match(sec.data.tls.ca.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const dl = await httpsCall(s.port, ca, 'GET', '/api/security/ca.crt', { cookie });
    assert.equal(dl.text.trim(), ca.toString().trim());
    assert.ok(!dl.text.includes('PRIVATE KEY'));
    const names = await httpsCall(s.port, ca, 'PUT', '/api/security/hostnames', { body: { hostnames: ['192.168.7.7', 'nas.local'] }, cookie });
    assert.equal(names.status, 200);
    assert.equal(names.data.caReplaced, false, 'local names fit the CA');
    assert.ok(names.data.tls.hostnames.includes('192.168.7.7'));
    assert.equal((await httpsCall(s.port, ca, 'PUT', '/api/security/hostnames', { body: { hostnames: ['8.8.8.8'] }, cookie })).status, 400, 'public IPs need a real certificate');
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('symlinks on a share never lead outside it', { timeout: 60000 }, async () => {
  const dir = await tmp();
  const T = path.join(dir, 'footage/TeslaCam');
  await fsp.mkdir(path.join(T, 'RecentClips'), { recursive: true });
  await fsp.writeFile(path.join(T, 'RecentClips/2020-01-01_08-00-00-front.mp4'), 'clip');
  await fsp.mkdir(path.join(dir, 'outside/RecentClips'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'outside/secret.txt'), 'TOP SECRET');
  await fsp.symlink(path.join(dir, 'outside'), path.join(T, 'linkdir'));
  await fsp.symlink('/', path.join(T, 'rootlink'));
  await fsp.symlink(path.join(dir, 'outside/secret.txt'), path.join(T, 'RecentClips/2020-01-01_09-00-00-front.mp4'));
  const s = await startServer(dir, { TLS_MODE: 'off', UI_PASSWORD: 'correct horse' });
  const base = `http://127.0.0.1:${s.port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'X-Requested-With': 'sentry-manager', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    const text = await res.text();
    try {
      return { status: res.status, data: JSON.parse(text) };
    } catch {
      return { status: res.status, data: text };
    }
  };
  try {
    await call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    for (const p of [path.join(T, 'linkdir/secret.txt'), path.join(T, 'rootlink/etc/passwd'), path.join(T, `rootlink${dir}/data/manager.db`), path.join(T, 'RecentClips/2020-01-01_09-00-00-front.mp4')]) {
      assert.equal((await call('POST', '/api/studio/readFile', { path: p })).status, 403, p);
      assert.equal((await call('GET', `/api/media?path=${encodeURIComponent(p)}`)).status, 403, p);
    }
    const listing = (await call('POST', '/api/studio/readDir', { path: T })).data.map((e) => e.name);
    assert.deepEqual(listing, ['RecentClips'], 'links are not listed');
    assert.equal((await call('POST', '/api/studio/readDir', { path: path.join(T, 'linkdir') })).status, 403);
    for (const defaultPath of [path.join(T, 'linkdir'), path.join(T, 'rootlink/etc')]) {
      assert.deepEqual((await call('POST', '/api/converter/invoke/chooseFolder', { purpose: 'source', defaultPath })).data, { ok: false, error: { code: 'PATH_NOT_ALLOWED' } });
    }
    const start = await call('POST', '/api/converter/invoke/start', {
      sourceRoot: path.join(T, `rootlink${dir}/outside`), destinationRoot: null, outputMode: 'replace', replacementConfirmed: true,
      codec: 'h265', profileId: 'balanced', networkMode: 'direct', includedGroups: ['RecentClips'], verifyMode: 'quick'
    });
    assert.deepEqual(start.data, { ok: false, error: { code: 'PATH_NOT_ALLOWED' } });
    // the inventory never counts the linked "clip"
    const recs = await (async () => {
      for (let i = 0; i < 50; i++) {
        const r = await call('GET', '/api/vehicles/daily-driver/recordings');
        if (r.data.total) return r.data.recordings;
        await new Promise((x) => setTimeout(x, 100));
      }
      return [];
    })();
    assert.deepEqual(recs.map((r) => r.start), ['2020-01-01 08:00:00']);
    // folder vehicles may not point at the container's own folders
    for (const p of ['/', '/etc', path.join(dir, 'data'), REPO]) {
      const r = await call('POST', '/api/vehicles', { name: 'Bad', source: { type: 'path', path: p } });
      assert.equal(r.status, 400, `${p}: ${JSON.stringify(r.data)}`);
    }
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('SMB settings can never add mount options or weaken security', () => {
  const ok = { share: '//192.168.1.50/TeslaCam', username: 'tesla', password: 'p,a=s s%x', domain: 'HOME' };
  const smb = normalizeSmb(ok);
  assert.deepEqual([smb.version, smb.encrypt, smb.port], ['3.1.1', true, null]);
  const { args } = mountArgs(smb, { target: '/footage/car', credFile: '/run/sentry-manager/car.cred', uid: 1000, gid: 1000 });
  assert.deepEqual(args.slice(0, 4), ['-t', 'cifs', '//192.168.1.50/TeslaCam', '/footage/car']);
  const opts = args[5].split(',');
  for (const o of ['vers=3.1.1', 'sec=ntlmssp', 'seal', 'nosuid', 'nodev', 'noexec', 'forceuid', 'forcegid', 'serverino']) assert.ok(opts.includes(o), o);
  assert.ok(!args.join(' ').includes('p,a=s s%x'), 'the password is never on the command line');
  const signed = mountArgs({ ...ok, encrypt: false }, { target: '/footage/car', credFile: '/run/x.cred', uid: 1, gid: 1 }).args[5].split(',');
  assert.ok(signed.includes('sign') && !signed.includes('seal'), 'without encryption, signing is required');

  const bad = [
    { share: '//1.2.3.4/s,exec' }, { share: '//1.2.3.4/s/../etc' }, { share: '//h/s\nx' }, { share: '-o exec' }, { share: '//h;rm/s' },
    { username: '' }, { username: 'u,vers=1.0' }, { username: 'u%pass' }, { username: 'DOMAIN\\user' }, { password: '' }, { password: 'a\nusername=root' },
    { domain: 'x,sec=none' }, { version: '1.0' }, { version: '2.1' }, { version: 'default' }, { version: '3.0,sec=none' }, { port: '445,exec' }, { port: 70000 }
  ];
  for (const change of bad) assert.throws(() => normalizeSmb({ ...ok, ...change }), /./, JSON.stringify(change));
  // fields beyond the known ones are ignored, never passed through
  const extra = normalizeSmb({ ...ok, options: 'exec,suid,credentials=/etc/shadow', guest: true });
  assert.ok(!('options' in extra) && !('guest' in extra));
  assert.deepEqual(parseShare('\\\\nas\\TeslaCam\\car').unc, '//nas/TeslaCam/car');
  assert.throws(() => mountArgs(smb, { target: '/footage/car,exec', credFile: '/x', uid: 1, gid: 1 }));
});

test('cookie parsing tolerates stray cookies and ignores duplicates', () => {
  assert.deepEqual(parseCookies('other=100%; sm_session=abc; sm_session=evil'), { other: '100%', sm_session: 'abc' });
});

test('the real-path guard: symlinked roots, the deny list, and a file swapped after the check', async () => {
  const dir = await fsp.realpath(await tmp());
  const footage = path.join(dir, 'footage');
  const data = path.join(dir, 'data');
  await fsp.mkdir(path.join(footage, 'car/RecentClips'), { recursive: true });
  await fsp.mkdir(path.join(data, 'converted'), { recursive: true });
  await fsp.writeFile(path.join(data, 'manager.db'), 'secrets');
  await fsp.writeFile(path.join(footage, 'car/RecentClips/a.mp4'), 'clip');
  await fsp.symlink(data, path.join(footage, 'sneaky')); // a "vehicle folder" that is a link to the data dir
  const guard = createRealGuard(() => [
    { path: path.join(footage, 'car'), within: [footage] },
    { path: path.join(footage, 'sneaky'), within: [footage] },
    path.join(data, 'converted'),
    { path: '/', within: ['/'] } // as if FOLDER_ROOTS=/ had been allowed
  ], { deny: () => [data, '/etc'] });
  try {
    assert.equal(await guard.resolve(path.join(footage, 'car/RecentClips/a.mp4')), path.join(footage, 'car/RecentClips/a.mp4'));
    assert.equal(await guard.resolve(path.join(footage, 'sneaky/manager.db')), null, 'a root that really lives elsewhere allows nothing');
    assert.equal(await guard.resolve(path.join(data, 'manager.db')), null, 'the deny list holds even under a root like /');
    assert.equal(await guard.resolve('/etc/passwd'), null);
    assert.ok(await guard.resolve(path.join(data, 'converted/x/y.mp4'), { mustExist: false }), 'roots inside a denied folder still work');
    assert.equal(await guard.resolve('relative/path'), null);
    assert.equal(await guard.resolve(`${footage}/car/\0x`), null);

    // swap a checked file for a link to the database: the open descriptor gives it away
    const clip = path.join(footage, 'car/RecentClips/a.mp4');
    const real = await guard.resolve(clip);
    const good = await fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    assert.equal(await guard.fdInside(good.fd), true);
    await good.close();
    await fsp.rm(clip);
    await fsp.symlink(path.join(data, 'manager.db'), clip);
    await assert.rejects(fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), /ELOOP/, 'a final symlink is never followed');
    const dirFh = await fsp.open(path.join(data, 'manager.db'), fs.constants.O_RDONLY);
    assert.equal(await guard.fdInside(dirFh.fd), false, 'a descriptor in the data dir is outside every root');
    await dirFh.close();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the HTTPS CA cannot vouch for names outside its constraints', { skip: !hasOpenssl, timeout: 60000 }, async () => {
  const dir = await tmp();
  try {
    const t = new TlsManager({ dir: path.join(dir, 'tls'), log: quiet, hostnames: ['192.168.1.50', 'nas.local'] });
    await t.ensure();
    const ca = path.join(dir, 'tls/ca.crt');
    assert.equal(spawnSync('openssl', ['verify', '-CAfile', ca, path.join(dir, 'tls/server.crt')]).status, 0);
    assert.equal(fs.statSync(path.join(dir, 'tls/ca.key')).mode & 0o777, 0o600);
    // sign a certificate for a public site with the CA key, as a thief would
    const run = (args) => assert.equal(spawnSync('openssl', args, { cwd: dir }).status, 0, args.join(' '));
    run(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'evil.key', '-subj', '/CN=bank.example.com', '-out', 'evil.csr']);
    await fsp.writeFile(path.join(dir, 'evil.ext'), 'subjectAltName=DNS:bank.example.com\nbasicConstraints=critical,CA:FALSE\n');
    run(['x509', '-req', '-in', 'evil.csr', '-CA', ca, '-CAkey', path.join(dir, 'tls/ca.key'), '-set_serial', '7', '-days', '30', '-extfile', 'evil.ext', '-out', 'evil.crt']);
    const verify = spawnSync('openssl', ['verify', '-CAfile', ca, path.join(dir, 'evil.crt')], { encoding: 'utf8' });
    assert.notEqual(verify.status, 0, 'a leaked CA key cannot impersonate other sites');
    assert.match(`${verify.stdout}${verify.stderr}`, /permitted subtree violation|name constraints/i);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

function binFixture(root, recordings) {
  const db = new ManagerDB(':memory:');
  const files = new Map();
  for (const r of recordings) for (const rel of r.files) files.set(rel, { rel, size: 4 });
  const inv = { recordings, files };
  const vehicles = {
    get: (id) => (id === 'car' ? { id: 'car', name: 'Car', source: { type: 'path', path: root } } : null),
    share: () => ({ isWritable: () => true }),
    rootOf: () => root
  };
  const inventory = { get: () => inv, rebuild() {}, scan: async () => inv };
  const jobs = { start: () => 1, finish() {} };
  return { db, bin: new RecycleBin({ db, vehicles, inventory, jobs, log: quiet }) };
}

test('Recycle Bin: an interrupted move is settled after a restart, and unlisted bin folders are recovered', async () => {
  const root = await tmp();
  try {
    const rels = ['TeslaCam/RecentClips/2020-01-01_08-00-00-front.mp4', 'TeslaCam/RecentClips/2020-01-01_08-00-00-back.mp4'];
    for (const rel of rels) {
      await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fsp.writeFile(path.join(root, rel), 'clip');
    }
    const { db, bin } = binFixture(root, []);
    // a crash after the first of two files moved
    const id = 'mvh7aaaa-0badf00d';
    const files = rels.map((rel) => ({ rel, binRel: `${BIN_DIR}/${id}/${rel}.binned`, size: 4, pending: true }));
    db.addBinItem({ id, vehicleId: 'car', label: 'Recent', category: 'Recent', startAt: null, bytes: 8, files, trashedAt: Date.now(), reason: 'manual' });
    await fsp.mkdir(path.dirname(path.join(root, files[0].binRel)), { recursive: true });
    await fsp.rename(path.join(root, rels[0]), path.join(root, files[0].binRel));
    // and a bin folder the database never heard of (an older crash)
    const orphan = `${BIN_DIR}/mvh7bbbb-deadbeef/TeslaCam/SentryClips/2020-01-02_12-30-00/2020-01-02_12-29-00-front.mp4.binned`;
    await fsp.mkdir(path.dirname(path.join(root, orphan)), { recursive: true });
    await fsp.writeFile(path.join(root, orphan), 'clip');

    assert.deepEqual(await bin.reconcile('car'), { fixed: 1, adopted: 1 });
    const items = db.binItems('car');
    const settled = items.find((i) => i.id === id);
    assert.deepEqual(settled.files.map((f) => f.rel), [rels[0]], 'only what really moved stays listed');
    assert.ok(!settled.files.some((f) => f.pending));
    const recovered = items.find((i) => i.id === 'mvh7bbbb-deadbeef');
    assert.equal(recovered.category, 'Sentry');
    assert.equal(recovered.files[0].rel, 'TeslaCam/SentryClips/2020-01-02_12-30-00/2020-01-02_12-29-00-front.mp4');
    // both can be restored like any other item
    await bin.restore(id);
    await bin.restore('mvh7bbbb-deadbeef');
    assert.ok(fs.existsSync(path.join(root, rels[0])) && fs.existsSync(path.join(root, rels[1])));
    assert.ok(fs.existsSync(path.join(root, 'TeslaCam/SentryClips/2020-01-02_12-30-00/2020-01-02_12-29-00-front.mp4')));
    assert.equal(db.binItems('car').length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Recycle Bin: protecting a recording while a trash run is going keeps it', async () => {
  const root = await tmp();
  try {
    const recordings = [];
    for (let i = 0; i < 60; i++) {
      const rel = `TeslaCam/RecentClips/2020-01-01_${String(Math.floor(i / 60)).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-00-front.mp4`;
      await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fsp.writeFile(path.join(root, rel), 'clip');
      recordings.push({ id: `r${i}`, category: 'Recent', start: rel, files: [rel], protected: false });
    }
    const { db, bin } = binFixture(root, recordings);
    const run = bin.trash('car', recordings.map((r) => r.id));
    const last = recordings[recordings.length - 1];
    await bin.setProtected('car', last.files, true); // waits for the recording being moved right now, not the whole run
    const out = await run;
    assert.ok(out.skipped.some((x) => x.id === last.id && x.reason === 'protected'));
    assert.ok(fs.existsSync(path.join(root, last.files[0])), 'the protected recording stayed');
    assert.ok(db.protectedSet('car').has(last.files[0]));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

const canSeparate = process.getuid?.() === 0 && spawnSync('setpriv', ['--version']).status === 0;

test('the supervisor runs the app unprivileged and keeps mounts and the CA to itself', { skip: !canSeparate || !hasOpenssl, timeout: 120000 }, async () => {
  const dir = await tmp();
  await fsp.chmod(dir, 0o755);
  const footage = path.join(dir, 'footage');
  await fsp.mkdir(path.join(footage, 'TeslaCam/RecentClips'), { recursive: true });
  await fsp.writeFile(path.join(footage, 'TeslaCam/RecentClips/2020-01-01_08-00-00-front.mp4'), 'clip');
  spawnSync('chown', ['-R', '1000:1000', footage]);
  // an old root-owned /data with a planted link that must not be followed
  await fsp.mkdir(path.join(dir, 'data'), { recursive: true });
  await fsp.symlink('/etc/hostname', path.join(dir, 'data/evil-link'));
  const hostnameOwner = fs.statSync('/etc/hostname').uid;
  // a fake mount that records how root called it
  const bin = path.join(dir, 'bin');
  await fsp.mkdir(bin);
  await fsp.writeFile(path.join(bin, 'mount'), `#!/bin/sh\necho "uid=$(id -u) $*" >> ${dir}/mount.log\nexit 32\n`, { mode: 0o755 });
  const port = await freePort();
  const sup = spawn(process.execPath, [path.join(REPO, 'manager/server/supervisor.js')], {
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'),
      FOOTAGE_PATH: footage, FOOTAGE_ROOT: path.join(dir, 'mnt'), RUN_DIR: path.join(dir, 'run-root'), SENTRY_APP_TLS_DIR: path.join(dir, 'run-app/tls'),
      PUID: '1000', PGID: '1000', UI_PASSWORD: 'correct horse', SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'info', TZ: 'UTC'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  sup.stdout.on('data', (c) => { out += c; });
  sup.stderr.on('data', (c) => { out += c; });
  try {
    for (let i = 0; i < 200 && !/Sentry Manager on https/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /starting built-in version as 1000:1000/, out);
    // the app: uid 1000, no capabilities, no_new_privs
    const kids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
      try {
        return fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/^PPid:\s*(\d+)/m)[1] === String(sup.pid);
      } catch {
        return false;
      }
    });
    assert.equal(kids.length, 1);
    const status = fs.readFileSync(`/proc/${kids[0]}/status`, 'utf8');
    const field = (k) => status.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))[1].trim();
    assert.match(field('Uid'), /^1000\s+1000\s+1000\s+1000$/);
    for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.equal(field(k), '0000000000000000', k);
    assert.equal(field('NoNewPrivs'), '1');
    // /data: root:1000 sticky; root's folders stay root's
    const data = fs.statSync(path.join(dir, 'data'));
    assert.deepEqual([data.uid, data.gid, data.mode & 0o7777], [0, 1000, 0o1770]);
    const caKey = fs.statSync(path.join(dir, 'data/tls/ca.key'));
    assert.deepEqual([caKey.uid, caKey.mode & 0o777], [0, 0o600]);
    assert.equal(fs.statSync(path.join(dir, 'data/tls')).mode & 0o777, 0o700);
    assert.equal(fs.lstatSync(path.join(dir, 'data/evil-link')).isSymbolicLink(), true);
    assert.equal(fs.statSync('/etc/hostname').uid, hostnameOwner, 'a planted link is never followed');
    assert.equal(fs.statSync(path.join(dir, 'data/manager.db')).mode & 0o007, 0, 'the database is not world-readable');
    // HTTPS with the CA, health over plain HTTP
    const ca = fs.readFileSync(path.join(dir, 'data/tls/ca.crt'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    const login = await httpsCall(port, ca, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'correct horse' } });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const sys = await httpsCall(port, ca, 'GET', '/api/system', { cookie });
    assert.deepEqual([sys.data.security.supervised, sys.data.security.runningAsRoot, sys.data.security.uid], [true, false, 1000]);
    // an SMB vehicle: the app asks, root mounts with the fixed options
    const add = await httpsCall(port, ca, 'POST', '/api/vehicles', { cookie, body: { name: 'Weekend', source: { type: 'smb', share: '//192.0.2.10/TeslaCam', username: 'tesla', password: 'pa,ss' } } });
    assert.equal(add.status, 200, JSON.stringify(add.data));
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'mount.log')); i++) await new Promise((r) => setTimeout(r, 100));
    const call = fs.readFileSync(path.join(dir, 'mount.log'), 'utf8');
    assert.match(call, /^uid=0 -t cifs \/\/192\.0\.2\.10\/TeslaCam /);
    assert.ok(call.includes(`${path.join(dir, 'mnt')}/weekend -o `));
    for (const o of ['vers=3.1.1', 'seal', 'nosuid', 'nodev', 'noexec', 'uid=1000', 'gid=1000']) assert.ok(call.includes(o), o);
    assert.ok(!call.includes('pa,ss'));
    const cred = fs.statSync(path.join(dir, 'run-root/weekend.cred'));
    assert.deepEqual([cred.uid, cred.mode & 0o777], [0, 0o600]);
    // the app cannot read root's secrets
    const peek = spawnSync('setpriv', ['--reuid=1000', '--regid=1000', '--clear-groups', 'cat', path.join(dir, 'data/tls/ca.key'), path.join(dir, 'run-root/weekend.cred')], { encoding: 'utf8' });
    assert.notEqual(peek.status, 0);
    assert.doesNotMatch(peek.stdout, /PRIVATE KEY|password=/);
  } finally {
    sup.kill('SIGTERM');
    await new Promise((r) => sup.once('exit', r));
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
