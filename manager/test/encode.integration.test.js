'use strict';

// End to end against real ffmpeg: Tesla-like clips with per-frame telemetry
// SEI are encoded in place, checked with Sentry Studio's own MP4/SEI parser,
// and proven not to be encoded a second time (DB intact, DB lost, moved file).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { App } = require('../src/app');
const { Logger } = require('../src/log');
const { countMarkers } = require('../src/seiFixture');
const { probeFile } = require('../src/probe');
const { hasFfmpeg, tmpDir, makeClip, makeTeslaTree, age, testConfig, rmrf, writeFile } = require('./helpers/fixtures');

const skip = hasFfmpeg() ? false : 'ffmpeg/ffprobe not installed';
const STUDIO_PARSER = path.join(__dirname, '..', '..', 'src', 'renderer', 'scripts', 'data', 'dashcam-mp4.js');

/** Load Sentry Studio's browser-side DashcamMP4 class into a sandbox. */
function loadStudioParser() {
  if (!fs.existsSync(STUDIO_PARSER)) return null;
  const sandbox = { window: {}, fetch: () => { throw new Error('no fetch'); } };
  vm.runInNewContext(fs.readFileSync(STUDIO_PARSER, 'utf8'), sandbox);
  return sandbox.window.DashcamMP4;
}

function studioParse(DashcamMP4, file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const fakeProto = { decode: (bytes) => ({ len: bytes.length }) };
  const mp4 = new DashcamMP4(ab);
  const cfg = mp4.getConfig();
  const frames = mp4.parseFrames(fakeProto);
  return {
    codec: cfg.codec,
    frames: frames.length,
    keyframes: frames.filter((f) => f.keyframe).length,
    withSei: frames.filter((f) => f.sei).length,
    seiMessages: mp4.extractSeiMessages(fakeProto).length
  };
}

const sha = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

async function waitFor(fn, { timeoutMs = 120000, what = 'condition' } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function startApp(root, dataPath, env = {}) {
  const logger = new Logger({ silent: true, level: 'debug' });
  const app = new App(testConfig(root, dataPath, env), { logger, shareOptions: { mountinfoPath: '/proc/self/mountinfo' } });
  await app.start();
  await app.encoder.detecting;
  await app.scanning;
  return { app, logger };
}

const settled = (app) => waitFor(() => app.encoder.active.size === 0 && app.encoder.queue.length === 0 && !app.scanning, { what: 'encode queue to drain' });

test('encodes Tesla clips in place, keeps telemetry, and never encodes twice', { skip, timeout: 300000 }, async () => {
  const dir = await tmpDir();
  const root = path.join(dir, 'footage');
  const data = path.join(dir, 'data');
  try {
    const clip = await makeClip(path.join(dir, 'src'), { frames: 72 });
    const rels = (await makeTeslaTree(root, ['2026-10-01'], { clip: clip.file, cameras: ['front', 'back'] }))
      .filter((r) => r.endsWith('.mp4'));
    await age(root, rels);
    const before = Object.fromEntries(rels.map((r) => [r, fs.statSync(path.join(root, r))]));
    const DashcamMP4 = loadStudioParser();
    const original = DashcamMP4 && studioParse(DashcamMP4, path.join(root, rels[0]));

    // --- first run: everything gets encoded
    let { app } = await startApp(root, data);
    assert.equal(app.encoder.detection.selected?.backend, 'software');
    assert.equal(app.encoder.detection.selected.supportsSei, true, 'CPU encoder verified to keep SEI');
    await settled(app);
    for (const rel of rels) {
      const abs = path.join(root, rel);
      const rec = app.db.getFile(rel);
      assert.equal(rec?.status, 'encoded', `${rel}: ${rec?.reason}`);
      const info = await probeFile('ffprobe', abs);
      assert.equal(info.video.codec, 'h264');
      assert.equal(info.video.frames, 72, 'every frame kept');
      assert.ok(info.marker, 'SentryManager tag written');
      assert.equal(info.marker.originalSize, before[rel].size);
      assert.ok(fs.statSync(abs).size < before[rel].size, 'smaller than the original');
      assert.equal(countMarkers(fs.readFileSync(abs)), 72, 'telemetry SEI on every frame');
      assert.ok(Math.abs(fs.statSync(abs).mtimeMs - before[rel].mtimeMs) < 1000, 'mtime preserved');
    }
    if (DashcamMP4) {
      const encoded = studioParse(DashcamMP4, path.join(root, rels[0]));
      assert.match(encoded.codec, /^avc1\./, 'still plays in Sentry Studio (avc1)');
      assert.equal(encoded.frames, original.frames, 'Sentry Studio sees the same frame count');
      assert.equal(encoded.withSei, original.withSei, 'Sentry Studio finds telemetry on every frame');
      assert.equal(encoded.seiMessages, original.seiMessages);
      assert.ok(encoded.keyframes >= 2, 'keyframes for seeking');
    }
    const hashes = Object.fromEntries(rels.map((r) => [r, sha(path.join(root, r))]));
    const encodedCount = app.db.recentHistory(100).filter((h) => h.status === 'encoded').length;
    assert.equal(encodedCount, rels.length);

    // --- rescan with the DB intact: nothing queued
    await app.scan();
    assert.equal(app.encoder.queue.length, 0, 'DB stops re-encoding');
    const day = app.days()[0];
    assert.equal(day.encode.encoded, rels.length);
    assert.equal(day.encode.pending, 0);
    assert.ok(day.encode.savedBytes > 0);
    await app.stop();

    // --- DB lost and a clip moved: the embedded tag stops re-encoding
    rmrf(data);
    const moved = 'TeslaCam/SavedClips/2026-10-01_18-00-00/2026-10-01_17-59-00-front.mp4';
    const movedTo = 'Archive/2026-10-01_17-59-00-front.mp4';
    await fsp.mkdir(path.join(root, 'Archive'), { recursive: true });
    await fsp.rename(path.join(root, moved), path.join(root, movedTo));
    ({ app } = await startApp(root, data));
    await settled(app);
    const history = app.db.recentHistory(100);
    assert.equal(history.filter((h) => h.status === 'encoded').length, 0, 'no second encode after DB loss');
    for (const rel of [...rels.filter((r) => r !== moved), movedTo]) {
      const rec = app.db.getFile(rel);
      assert.equal(rec.status, 'encoded');
      assert.equal(rec.reason, 'already encoded (tag found)');
      assert.equal(sha(path.join(root, rel)), hashes[rel === movedTo ? moved : rel], 'file untouched');
    }
    await app.stop();
  } finally {
    rmrf(dir);
  }
});

test('leaves HEVC, broken and not-worth-it clips alone and remembers that', { skip, timeout: 300000 }, async () => {
  const dir = await tmpDir();
  const root = path.join(dir, 'footage');
  const data = path.join(dir, 'data');
  try {
    const hevc = path.join(root, 'TeslaCam/RecentClips/2026-10-02_09-00-00-front.mp4');
    await fsp.mkdir(path.dirname(hevc), { recursive: true });
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '30', '-c:v', 'libx265', '-x265-params', 'log-level=error', hevc]);
    assert.equal(r.status, 0, String(r.stderr));
    const broken = path.join(root, 'TeslaCam/RecentClips/2026-10-02_09-01-00-front.mp4');
    await writeFile(broken, { size: 5000 });
    const clip = await makeClip(path.join(dir, 'src'), { frames: 36 });
    const keep = path.join(root, 'TeslaCam/RecentClips/2026-10-02_09-02-00-front.mp4');
    await fsp.copyFile(clip.file, keep);
    // crash leftovers: an original parked as .orig with no replacement, and a stray upload
    const parked = path.join(root, 'TeslaCam/RecentClips/2026-10-02_09-03-00-back.mp4');
    await fsp.copyFile(clip.file, path.join(path.dirname(parked), `.${path.basename(parked)}.sentrymgr.orig`));
    await writeFile(path.join(path.dirname(parked), '.2026-10-02_09-04-00-back.mp4.sentrymgr.tmp'), { size: 10 });
    const rels = ['TeslaCam/RecentClips/2026-10-02_09-00-00-front.mp4', 'TeslaCam/RecentClips/2026-10-02_09-01-00-front.mp4', 'TeslaCam/RecentClips/2026-10-02_09-02-00-front.mp4'];
    await age(root, rels);
    const keepHash = sha(keep);

    let { app } = await startApp(root, data, { ENCODE_MIN_SAVINGS_PERCENT: '90' });
    await settled(app);
    assert.match(app.db.getFile(rels[0]).reason, /already HEVC/);
    assert.match(app.db.getFile(rels[1]).reason, /unreadable/);
    assert.match(app.db.getFile(rels[2]).reason, /not worth it/);
    assert.equal(sha(keep), keepHash, 'original kept when savings are too small');
    assert.ok(fs.existsSync(parked), 'interrupted original restored');
    assert.deepEqual(fs.readdirSync(path.dirname(parked)).filter((n) => n.includes('sentrymgr')), [], 'temp files cleaned');

    await app.scan();
    assert.equal(app.encoder.queue.filter((f) => rels.includes(f.rel)).length, 0, 'skips are remembered');
    await app.stop();
  } finally {
    rmrf(dir);
  }
});

test('replace falls back to a safe three-step swap when the server refuses rename-over', { skip, timeout: 60000 }, async () => {
  const dir = await tmpDir();
  try {
    const { EncodeManager } = require('../src/encoder');
    const logger = new Logger({ silent: true });
    const fakeShare = { state: { renameOverwrite: false }, isHealthy: () => true, isWritable: () => true };
    const mgr = new EncodeManager({ config: testConfig(dir, path.join(dir, 'data')), db: { getSetting: () => false }, share: fakeShare, log: logger.scope('t') });
    const target = path.join(dir, 'clip.mp4');
    const scratch = path.join(dir, 'new.mp4');
    await fsp.writeFile(target, 'old-content');
    await fsp.writeFile(scratch, 'new');
    const when = new Date('2026-01-01T00:00:00Z');
    await fsp.utimes(target, when, when);
    const st = await fsp.stat(target);
    const final = await mgr.replaceOnShare(target, scratch, st);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.equal(final.mtimeMs, when.getTime());
    assert.deepEqual(fs.readdirSync(dir).sort(), ['clip.mp4', 'new.mp4']);
  } finally {
    rmrf(dir);
  }
});
