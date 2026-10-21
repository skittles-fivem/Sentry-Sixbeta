'use strict';

// Settings > Updates: asks the registry whether a newer image is out, the way
// GHCR answers (anonymous token, multi-arch index, config labels).

const test = require('node:test');
const assert = require('node:assert/strict');
const { ImageUpdates, parseChallenge } = require('../server/imageUpdates');

const IMAGE = 'ghcr.io/owner/sentry-six-manager';
const SHA = 'b'.repeat(40);
const ARCH = { x64: 'amd64', arm64: 'arm64' }[process.arch] || process.arch;
const digest = (c) => `sha256:${c.repeat(64)}`;

function fakeDb() {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) };
}

function fakeNotes() {
  const open = new Map();
  return { open, raise: (n) => open.set(n.dedupeKey, n), resolve: (k) => open.delete(k) };
}

/** A registry that wants a token first and serves one tag for two architectures. */
function fakeRegistry({ revision = 'c'.repeat(40), created = '2026-10-20T04:00:00Z', tokenStatus = 200, realm = 'https://ghcr.io/token' } = {}) {
  const calls = [];
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetchImpl = async (url, opts = {}) => {
    calls.push(url);
    const authed = opts.headers?.Authorization === 'Bearer t0k3n';
    const u = new URL(url);
    if (u.origin + u.pathname === realm) {
      assert.equal(u.searchParams.get('scope'), 'repository:owner/sentry-six-manager:pull');
      return json(tokenStatus, tokenStatus === 200 ? { token: 't0k3n' } : { errors: [{ code: 'DENIED' }] });
    }
    if (!authed) return json(401, {}, { 'www-authenticate': `Bearer realm="${realm}",service="ghcr.io",scope="repository:owner/sentry-six-manager:pull"` });
    if (u.pathname === '/v2/owner/sentry-six-manager/manifests/latest') {
      return json(200, { mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [
        { digest: digest('1'), platform: { os: 'linux', architecture: 'amd64' } },
        { digest: digest('2'), platform: { os: 'linux', architecture: 'arm64' } },
        { digest: digest('3'), platform: { os: 'unknown', architecture: 'unknown' } }
      ] }, { 'docker-content-digest': digest('9') });
    }
    if (u.pathname === `/v2/owner/sentry-six-manager/manifests/${digest(ARCH === 'amd64' ? '1' : '2')}`) {
      return json(200, { config: { digest: digest('c') } });
    }
    if (u.pathname === `/v2/owner/sentry-six-manager/blobs/${digest('c')}`) {
      return json(200, { created, config: { Labels: { 'org.opencontainers.image.revision': revision, 'org.opencontainers.image.created': created } } });
    }
    return json(404, {});
  };
  return { fetchImpl, calls };
}

const build = (over = {}) => ({ sha: SHA, builtAt: '2026-10-13T04:00:00Z', image: IMAGE, tag: 'latest', ...over });

test('a newer commit on the tag is an update, and the notification says how to install it', async () => {
  const notes = fakeNotes();
  const reg = fakeRegistry();
  const u = new ImageUpdates({ db: fakeDb(), notes, buildInfo: build(), fetchImpl: reg.fetchImpl });
  const st = await u.check();
  assert.equal(st.error, null);
  assert.equal(st.updateAvailable, true);
  assert.equal(st.latest.revision, 'c'.repeat(40));
  assert.equal(st.latest.digest, digest(ARCH === 'amd64' ? '1' : '2'));
  assert.match(notes.open.get('image-update').message, /docker compose pull && docker compose up -d/);
});

test('the weekly rebuild of the same commit (security fixes) is an update too', async () => {
  const reg = fakeRegistry({ revision: SHA, created: '2026-10-20T04:00:00Z' });
  const u = new ImageUpdates({ db: fakeDb(), buildInfo: build(), fetchImpl: reg.fetchImpl });
  assert.equal((await u.check()).updateAvailable, true);
});

test('the running image itself is not an update, and an old notice is cleared', async () => {
  const notes = fakeNotes();
  notes.raise({ dedupeKey: 'image-update', title: 'old' });
  const reg = fakeRegistry({ revision: SHA, created: '2026-10-13T04:00:00Z' });
  const u = new ImageUpdates({ db: fakeDb(), notes, buildInfo: build(), fetchImpl: reg.fetchImpl });
  assert.equal((await u.check()).updateAvailable, false);
  assert.equal(notes.open.size, 0);
});

test('a build without an image, or with a strange one, never contacts anything', async () => {
  for (const over of [{ image: '', tag: '' }, { image: 'http://evil/x' }, { tag: '../../x' }, { image: 'ghcr.io/Owner/X' }]) {
    const reg = fakeRegistry();
    const u = new ImageUpdates({ db: fakeDb(), buildInfo: build(over), fetchImpl: reg.fetchImpl });
    const st = await u.check();
    assert.equal(st.enabled, false, JSON.stringify(over));
    assert.equal(reg.calls.length, 0);
  }
  const off = new ImageUpdates({ db: fakeDb(), buildInfo: build(), enabled: false, fetchImpl: fakeRegistry().fetchImpl });
  assert.equal((await off.check()).enabled, false);
});

test('registry problems are reported, never shown as an update', async () => {
  const priv = new ImageUpdates({ db: fakeDb(), buildInfo: build(), fetchImpl: fakeRegistry({ tokenStatus: 403 }).fetchImpl });
  const st = await priv.check();
  assert.match(st.error, /is the image public/);
  assert.equal(st.updateAvailable, false);

  const plain = new ImageUpdates({ db: fakeDb(), buildInfo: build(), fetchImpl: fakeRegistry({ realm: 'http://ghcr.io/token' }).fetchImpl });
  assert.match((await plain.check()).error, /without HTTPS/);

  const missing = new ImageUpdates({ db: fakeDb(), buildInfo: build({ tag: 'nope' }), fetchImpl: fakeRegistry().fetchImpl });
  assert.match((await missing.check()).error, /no image tagged nope/);
});

test('checks are spaced out, and the result survives a restart', async () => {
  const db = fakeDb();
  const reg = fakeRegistry();
  const u = new ImageUpdates({ db, buildInfo: build(), fetchImpl: reg.fetchImpl });
  await u.check();
  const n = reg.calls.length;
  await u.check(); // a second click right away does not ask again
  assert.equal(reg.calls.length, n);
  const after = new ImageUpdates({ db, buildInfo: build(), fetchImpl: reg.fetchImpl });
  assert.equal(after.status().updateAvailable, true);
  await after.tick(); // checked less than 12 hours ago
  assert.equal(reg.calls.length, n);
});

test('parseChallenge reads Bearer challenges only', () => {
  assert.deepEqual(parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:a/b:pull"'), { realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'repository:a/b:pull' });
  assert.equal(parseChallenge('Basic realm="x"'), null);
  assert.equal(parseChallenge(''), null);
});
