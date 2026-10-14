'use strict';

// Shared set-up for tests that run the real converter runtime with real
// FFmpeg (integrationE2E.test.js). Encoders are pinned to the CPU ones so the
// results do not depend on the test machine's graphics hardware.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createConverterRuntime } = require('../../../src/main/converter/runtime');
const { createEncoderPlanner } = require('../../../src/main/converter/encoderPlanner');
const { createTeslaH264Fixture } = require('./ffmpegFixtures');

// Owned-file removal that proves ownership by deleting only the exact file.
function ownedFileRemover() {
  return { atomicOwnershipCheck: true, guardedRemoval: true, async remove({ target }) {
    try { await fs.promises.unlink(target); return { removed: true, missing: false }; } catch (error) {
      if (error?.code === 'ENOENT') return { removed: false, missing: true };
      throw error;
    }
  } };
}

// No-replace publication through a synced temporary file and a hard link.
function noReplacePromoter() {
  return { atomicNoReplace: true, async promote({ from, to, removeSource }) {
    if (removeSource) throw new Error('The test adapter does not implement replacement');
    const temporary = `${to}.test-promote-${process.pid}-${Date.now()}`;
    await fs.promises.copyFile(from, temporary, fs.constants.COPYFILE_EXCL);
    let handle;
    try {
      handle = await fs.promises.open(temporary, 'r+');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.link(temporary, to);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.unlink(temporary).catch(() => {});
    }
    return { atomicNoReplace: true, sourceRemoved: false };
  } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeRoot(prefix) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `sentry-${prefix}-`));
  await fs.promises.mkdir(path.join(root, 'TeslaCam', 'RecentClips'), { recursive: true });
  await fs.promises.mkdir(path.join(root, 'user'), { recursive: true });
  return root;
}

// Every third frame carries no telemetry, like a car that is parked.
function telemetryPattern(frames) {
  return Array.from({ length: frames }, (_, index) => (index % 3 ? Buffer.from([0x20, index & 0xff]) : null));
}

async function makeClip(tools, outputPath, { seconds = 2, size, frameRate = 12, noise = 12 } = {}) {
  return createTeslaH264Fixture({ ffmpegPath: tools.ffmpegPath, outputPath, durationSeconds: seconds, frameRate,
    ...(size ? { size } : {}), spatialNoise: noise, telemetryPattern: telemetryPattern(seconds * frameRate) });
}

// Clip names follow Tesla's pattern; `index` keeps them unique and ordered.
function clipName(index, minute = 0) {
  const seconds = String(index % 60).padStart(2, '0');
  const minutes = String((minute + Math.floor(index / 60)) % 60).padStart(2, '0');
  return `2026-08-30_12-${minutes}-${seconds}-front.mp4`;
}

async function makeRuntime(tools, root, extra = {}) {
  const runtime = await createConverterRuntime({
    userDataPath: path.join(root, 'user'), tempPath: root,
    ffmpegPath: tools.ffmpegPath, ffprobePath: tools.ffprobePath,
    spawn, processTimeoutMs: 300_000,
    removeOwned: ownedFileRemover(), renameExclusive: noReplacePromoter(),
    factories: { createEncoderPlanner(options) {
      const real = createEncoderPlanner(options);
      return { select: real.selectCpuFallback, selectCpuFallback: real.selectCpuFallback };
    } },
    ...extra
  });
  await runtime.start();
  return runtime;
}

async function waitFor(check, { timeoutMs = 120_000, everyMs = 200, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

module.exports = { clipName, makeClip, makeRoot, makeRuntime, noReplacePromoter, ownedFileRemover, sleep, telemetryPattern, waitFor };
