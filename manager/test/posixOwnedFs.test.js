'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { createPosixOwnedFs, createNoReplaceRename } = require('../server/posixOwnedFs');

const REPO = path.join(__dirname, '..', '..');
const HELPER_SRC = path.join(__dirname, '..', 'native', 'noreplace-rename.c');
const HELPER = path.join(__dirname, '..', 'build', 'noreplace-rename');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function buildHelper() {
  if (fs.existsSync(HELPER)) return true;
  fs.mkdirSync(path.dirname(HELPER), { recursive: true });
  return spawnSync('cc', ['-O2', '-o', HELPER, HELPER_SRC]).status === 0;
}
const helperBuilt = buildHelper();

async function tmp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'posix-owned-'));
}

async function identity(file) {
  const st = await fsp.lstat(file, { bigint: true });
  const sha256 = crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');
  return { device: String(st.dev), inode: String(st.ino), size: Number(st.size), sha256 };
}

const adapters = () => createPosixOwnedFs({ helperPath: HELPER });

test('remove deletes only the exact recorded file', { skip: !helperBuilt && 'no C compiler' }, async () => {
  const dir = await tmp();
  try {
    const { removeOwned } = adapters();
    const f = path.join(dir, 'clip.mp4');
    await fsp.writeFile(f, 'original');
    const expected = await identity(f);

    // same name, different content (e.g. the clip was replaced)
    await fsp.writeFile(f, 'replaced');
    assert.deepEqual(await removeOwned.remove({ target: f, expected }), { removed: false, ownershipMismatch: true });
    assert.equal(fs.readFileSync(f, 'utf8'), 'replaced', 'a mismatching file is never deleted');

    const now = await identity(f);
    assert.deepEqual(await removeOwned.remove({ target: f, expected: now }), { removed: true });
    assert.equal(fs.existsSync(f), false);
    assert.deepEqual(await removeOwned.remove({ target: f, expected: now }), { removed: false, missing: true });
    assert.deepEqual(fs.readdirSync(dir), [], 'no quarantine file left behind');

    assert.deepEqual(await removeOwned.remove({ target: 'relative.mp4', expected: now }), { removed: false, ownershipMismatch: true });
    assert.deepEqual(await removeOwned.remove({ target: f, expected: { ...now, sha256: 'x' } }), { removed: false, ownershipMismatch: true });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('remove refuses symlinks and honours the guard', { skip: !helperBuilt && 'no C compiler' }, async () => {
  const dir = await tmp();
  try {
    const { removeOwned } = adapters();
    const real = path.join(dir, 'real.mp4');
    const link = path.join(dir, 'link.mp4');
    await fsp.writeFile(real, 'data');
    await fsp.symlink(real, link);
    const expected = await identity(real);
    assert.deepEqual(await removeOwned.remove({ target: link, expected }), { removed: false, ownershipMismatch: true });
    assert.ok(fs.existsSync(real));

    const backup = path.join(dir, 'BACKUP-clip.mp4');
    const final = path.join(dir, 'clip.mp4');
    await fsp.writeFile(backup, 'old');
    await fsp.writeFile(final, 'new');
    const b = await identity(backup);
    const good = await identity(final);
    await fsp.writeFile(final, 'tampered');
    assert.deepEqual(await removeOwned.remove({ target: backup, expected: b, guard: { target: final, expected: good } }),
      { removed: false, ownershipMismatch: true, guardMismatch: true }, 'backup kept when the final is not the verified one');
    assert.ok(fs.existsSync(backup));
    const fixedFinal = await identity(final);
    assert.deepEqual(await removeOwned.remove({ target: backup, expected: b, guard: { target: final, expected: fixedFinal } }), { removed: true });
    assert.equal(fs.existsSync(backup), false);
    assert.equal(fs.readFileSync(final, 'utf8'), 'tampered');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('promote never replaces and only moves the verified source', { skip: !helperBuilt && 'no C compiler' }, async () => {
  const dir = await tmp();
  try {
    const { renameExclusive } = adapters();
    const from = path.join(dir, 'TEMP-H265-clip.mp4');
    const to = path.join(dir, 'clip.mp4');
    await fsp.writeFile(from, 'candidate');
    await fsp.writeFile(to, 'someone else');
    const expectedSource = await identity(from);
    await assert.rejects(renameExclusive.promote({ from, to, expectedSource, removeSource: true }), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(to, 'utf8'), 'someone else');
    await fsp.unlink(to);

    assert.deepEqual(await renameExclusive.promote({ from, to, expectedSource, removeSource: true }), { atomicNoReplace: true, sourceRemoved: true });
    assert.equal(fs.readFileSync(to, 'utf8'), 'candidate');
    assert.equal(fs.existsSync(from), false);
    await assert.rejects(renameExclusive.promote({ from, to: path.join(dir, 'x.mp4'), expectedSource, removeSource: true }), { code: 'ENOENT' });

    // keep-source promotion is a hard link
    const src = path.join(dir, 'out.partial');
    await fsp.writeFile(src, 'output');
    const id = await identity(src);
    assert.deepEqual(await renameExclusive.promote({ from: src, to: path.join(dir, 'out.mp4'), expectedSource: id }), { atomicNoReplace: true, sourceRemoved: false });
    assert.equal(fs.statSync(src).nlink, 2);

    await fsp.writeFile(src, 'changed!');
    assert.equal((await renameExclusive.promote({ from: src, to: path.join(dir, 'out2.mp4'), expectedSource: { ...id, sha256: id.sha256 }, removeSource: true })).ownershipMismatch, true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('without the helper, promotion falls back to link + unlink', async () => {
  const dir = await tmp();
  try {
    const { renameExclusive } = createPosixOwnedFs({ noReplace: createNoReplaceRename({ helperPath: '/nonexistent' }) });
    const from = path.join(dir, 'a');
    await fsp.writeFile(from, 'x');
    const r = await renameExclusive.promote({ from, to: path.join(dir, 'b'), expectedSource: await identity(from), removeSource: true });
    assert.deepEqual(r, { atomicNoReplace: true, sourceRemoved: true });
    assert.deepEqual(fs.readdirSync(dir), ['b']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the real converter replaces originals in place with telemetry intact', { skip: (!hasFfmpeg && 'ffmpeg missing') || (!helperBuilt && 'no C compiler'), timeout: 600000 }, async () => {
  const { createConverterRuntime } = require(path.join(REPO, 'src/main/converter/runtime'));
  const { createEncoderPlanner } = require(path.join(REPO, 'src/main/converter/encoderPlanner'));
  const { createTeslaH264Fixture } = require(path.join(REPO, 'tests/main/converter/ffmpegFixtures'));
  const { extractH264TelemetryTimeline } = require(path.join(REPO, 'src/main/converter/telemetryTimeline'));
  const { inspectH265Telemetry } = require(path.join(REPO, 'src/main/converter/h265Telemetry'));
  const root = await tmp();
  try {
    const clips = path.join(root, 'footage', 'TeslaCam', 'RecentClips');
    await fsp.mkdir(clips, { recursive: true });
    await fsp.mkdir(path.join(root, 'user'));
    await fsp.mkdir(path.join(root, 'tmp'));
    const pattern = Array.from({ length: 36 }, (_, i) => (i % 3 ? Buffer.from([0x20, i & 0xff]) : null));
    const before = {};
    for (const cam of ['front', 'back']) {
      const p = path.join(clips, `2026-08-30_12-00-00-${cam}.mp4`);
      await createTeslaH264Fixture({ ffmpegPath: 'ffmpeg', outputPath: p, durationSeconds: 3, frameRate: 12, size: '640x360', spatialNoise: 12, telemetryPattern: pattern });
      before[p] = extractH264TelemetryTimeline(await fsp.readFile(p)).samples.flatMap((s) => (s.seiNals || []).map((r) => String(r.fingerprint))).filter((f) => f !== 'undefined');
    }
    const { removeOwned, renameExclusive } = adapters();
    const runtime = await createConverterRuntime({
      userDataPath: path.join(root, 'user'), tempPath: path.join(root, 'tmp'),
      ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', spawn, fs, pathApi: path, platform: 'linux',
      processTimeoutMs: 300000, removeOwned, renameExclusive,
      factories: { createEncoderPlanner(options) {
        const real = createEncoderPlanner(options);
        return { select: real.selectCpuFallback, selectCpuFallback: real.selectCpuFallback };
      } }
    });
    await runtime.start();
    try {
      const { separatePublication, ownershipCleanup, replacement } = runtime.capabilities;
      assert.deepEqual({ separatePublication, ownershipCleanup, replacement }, { separatePublication: 'native-atomic', ownershipCleanup: 'atomic-expected-ownership', replacement: 'available' });
      const jobId = await runtime.service.start({
        sourceRoot: path.join(root, 'footage'), destinationRoot: null, outputMode: 'replace', replacementConfirmed: true,
        codec: 'h265', profileId: 'balanced', networkMode: 'direct', includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
        concurrency: 2, verifyMode: 'full'
      });
      const job = await runtime.service.whenIdle(jobId);
      for (const item of job.items.filter((i) => i.kind !== 'asset')) {
        assert.equal(item.state, 'completed', `${item.relativePath}: ${item.failure?.code || item.resultCode}`);
      }
    } finally {
      await runtime.shutdown();
    }
    for (const [p, fingerprints] of Object.entries(before)) {
      const out = inspectH265Telemetry(await fsp.readFile(p));
      assert.equal(out.layoutValid, true);
      assert.deepEqual(out.telemetryFingerprints.map((f) => String(f.fingerprint || f)), fingerprints, 'telemetry identical and in order');
      const codec = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', p]).toString().trim();
      assert.equal(codec, 'hevc', 'original replaced by the H.265 version');
    }
    const leftovers = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else leftovers.push(path.relative(root, p)); } };
    walk(path.join(root, 'footage'));
    walk(path.join(root, 'tmp'));
    assert.deepEqual(leftovers.sort(), Object.keys(before).map((p) => path.relative(root, p)).sort(), 'no TEMP-/BACKUP-/staging/snapshot files left');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
