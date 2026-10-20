'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeSeiFixture } = require('../../src/seiFixture');

const CAMERAS = ['front', 'back', 'left_repeater', 'right_repeater'];

function hasFfmpeg() {
  const a = spawnSync('ffmpeg', ['-hide_banner', '-version']);
  const b = spawnSync('ffprobe', ['-hide_banner', '-version']);
  return a.status === 0 && b.status === 0;
}

async function tmpDir(prefix = 'sentry-manager-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A short Tesla-like H.264 clip with telemetry SEI on every frame. */
async function makeClip(dir, { frames = 72 } = {}) {
  return makeSeiFixture('ffmpeg', dir, { width: 640, height: 360, frames });
}

async function writeFile(file, { size = 1000, from } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (from) await fsp.copyFile(from, file);
  else await fsp.writeFile(file, Buffer.alloc(size, 7));
  return file;
}

/**
 * TeslaCam/RecentClips, SentryClips/<event>/, SavedClips/<event>/ for each
 * day. Clips are copies of `clip` when given, else dummy bytes.
 * Returns the list of root-relative paths created.
 */
async function makeTeslaTree(root, days, { clip, cameras = CAMERAS, size = 1000 } = {}) {
  const made = [];
  const add = async (rel, opts) => {
    await writeFile(path.join(root, rel), opts);
    made.push(rel);
  };
  for (const day of days) {
    for (const cam of cameras) {
      await add(`TeslaCam/RecentClips/${day}_08-00-00-${cam}.mp4`, { from: clip, size });
    }
    const sentry = `${day}_12-30-00`;
    for (const cam of cameras) {
      await add(`TeslaCam/SentryClips/${sentry}/${day}_12-29-00-${cam}.mp4`, { from: clip, size });
    }
    await add(`TeslaCam/SentryClips/${sentry}/event.json`, { size: 120 });
    await add(`TeslaCam/SentryClips/${sentry}/thumb.png`, { size: 300 });
    const saved = `${day}_18-00-00`;
    await add(`TeslaCam/SavedClips/${saved}/${day}_17-59-00-front.mp4`, { from: clip, size });
    await add(`TeslaCam/SavedClips/${saved}/event.json`, { size: 120 });
  }
  return made;
}

/** Set a file's mtime into the past so it passes the minimum-age rule. */
async function age(root, rels, minutes = 120) {
  const when = new Date(Date.now() - minutes * 60 * 1000);
  for (const rel of rels) await fsp.utimes(path.join(root, rel), when, when);
}

function testConfig(root, dataPath, overrides = {}) {
  const { loadConfig } = require('../../src/config');
  return loadConfig({
    FOOTAGE_PATH: root,
    DATA_PATH: dataPath,
    ENCODE_MIN_AGE_MINUTES: '0',
    ENCODE_PRESET: 'ultrafast',
    ...overrides
  });
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

module.exports = { hasFfmpeg, tmpDir, makeClip, makeTeslaTree, writeFile, age, testConfig, rmrf, CAMERAS };
