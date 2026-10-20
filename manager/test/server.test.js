'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { App } = require('../src/app');
const { Logger } = require('../src/log');
const { createServer } = require('../src/server');
const { tmpDir, makeTeslaTree, testConfig, rmrf } = require('./helpers/fixtures');

// No ffmpeg needed: detection is stubbed to "no encoder".
const noEncoder = async () => ({ selected: null, candidates: [], notes: ['stub'], detectedAt: Date.now() });

async function boot(env = {}) {
  const dir = await tmpDir();
  const root = path.join(dir, 'footage');
  await makeTeslaTree(root, ['2026-10-01', '2026-10-02'], { size: 2048 });
  const config = testConfig(root, path.join(dir, 'data'), env);
  const logger = new Logger({ silent: true });
  const app = new App(config, { logger, detect: noEncoder });
  await app.start();
  await app.scanning;
  const server = createServer(app, { config, logger });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    server.closeAll();
    await new Promise((r) => server.close(r));
    await app.stop();
    rmrf(dir);
  };
  return { app, base, root, close };
}

const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

test('status, days, static files and purge over HTTP', async () => {
  const { base, root, close } = await boot();
  try {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.share.healthy, true);
    assert.equal(status.footage.days, 2);
    assert.equal(status.encoder.state, 'no-encoder');
    assert.equal(status.config.smb.password, undefined, 'no secrets in status');

    const { days } = await (await fetch(`${base}/api/days`)).json();
    assert.deepEqual(days.map((d) => d.day), ['2026-10-01', '2026-10-02']);

    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Sentry Manager/);
    assert.equal((await fetch(`${base}/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await fetch(`${base}/..%2fsrc%2findex.js`)).status, 404, 'no path traversal');
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    assert.equal((await post(`${base}/api/purge`, { days: ['nope'] })).status, 400);
    assert.equal((await fetch(`${base}/api/purge`, { method: 'POST', body: '{"days":["2026-10-01"]}' })).status, 415, 'form-style posts refused');
    assert.equal((await post(`${base}/api/purge`, { days: ['2026-10-01'] }, { Origin: 'http://evil.example' })).status, 403, 'cross-site refused');
    assert.ok(fs.existsSync(path.join(root, 'TeslaCam/RecentClips/2026-10-01_08-00-00-front.mp4')));

    const res = await post(`${base}/api/purge`, { days: ['2026-10-01'] });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.deletedFiles, 12);
    assert.ok(!fs.existsSync(path.join(root, 'TeslaCam/RecentClips/2026-10-01_08-00-00-front.mp4')));
    const after = await (await fetch(`${base}/api/days`)).json();
    assert.deepEqual(after.days.map((d) => d.day), ['2026-10-02']);
  } finally {
    await close();
  }
});

test('basic auth protects everything except the health check', async () => {
  const { base, close } = await boot({ UI_PASSWORD: 's3cret' });
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const bad = Buffer.from('admin:wrong').toString('base64');
    assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: `Basic ${bad}` } })).status, 401);
    const good = Buffer.from('admin:s3cret').toString('base64');
    assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: `Basic ${good}` } })).status, 200);
  } finally {
    await close();
  }
});

test('live events stream sends status immediately', async () => {
  const { base, close } = await boot();
  const ctrl = new AbortController();
  try {
    const res = await fetch(`${base}/api/events`, { signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assert.match(Buffer.from(value).toString(), /^event: status\ndata: \{/);
  } finally {
    ctrl.abort();
    await close();
  }
});
