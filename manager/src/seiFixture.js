'use strict';

// Builds a short H.264 clip that carries a user-data-unregistered SEI NAL in
// front of every frame, laid out like Tesla's telemetry SEI (0x42 run, 0x69,
// then the payload). Encoder detection re-encodes it and counts the markers
// to prove an encoder really carries telemetry through.

const fs = require('fs/promises');
const path = require('path');
const { run, tail } = require('./proc');

const SEI_MARKER = 'SENTRYMGR-SEI-TEST';
const FIXTURE_FPS = 36;
const FIXTURE_FRAMES = 24;

/** Split an Annex B byte stream into NAL unit payloads (start codes removed). */
function splitAnnexB(buf) {
  const starts = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  const nals = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    let e = k + 1 < starts.length ? starts[k + 1] - 3 : buf.length;
    while (e > s && buf[e - 1] === 0) e--;
    nals.push(buf.subarray(s, e));
  }
  return nals;
}

/** Tesla-style SEI NAL. Payload bytes avoid 0x00 so no emulation prevention is needed. */
function teslaStyleSei(frameIndex) {
  const marker = Buffer.from(SEI_MARKER, 'ascii');
  const payload = Buffer.concat([
    Buffer.from([0x42, 0x42, 0x42, 0x69, 0x08, (frameIndex % 127) + 1, 0x12, marker.length]),
    marker
  ]);
  return Buffer.concat([Buffer.from([0x06, 0x05, payload.length]), payload, Buffer.from([0x80])]);
}

/** Insert one SEI before every coded slice (IDR=5, non-IDR=1). */
function injectSei(annexB) {
  const out = [];
  const startCode = Buffer.from([0, 0, 0, 1]);
  let frames = 0;
  for (const nal of splitAnnexB(annexB)) {
    const type = nal[0] & 0x1f;
    if (type === 1 || type === 5) {
      out.push(startCode, teslaStyleSei(frames));
      frames++;
    }
    out.push(startCode, nal);
  }
  return { data: Buffer.concat(out), frames };
}

function countMarkers(buf, marker = SEI_MARKER) {
  const needle = Buffer.from(marker, 'ascii');
  let count = 0;
  let pos = buf.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = buf.indexOf(needle, pos + needle.length);
  }
  return count;
}

/**
 * Write <dir>/sei-fixture.mp4. Returns { file, frames } or throws.
 * Needs an ffmpeg with libx264 (Debian/Ubuntu builds have it).
 */
async function makeSeiFixture(ffmpegPath, dir, { width = 640, height = 360, frames = FIXTURE_FRAMES } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const raw = path.join(dir, 'sei-fixture.h264');
  const withSei = path.join(dir, 'sei-fixture-sei.h264');
  const file = path.join(dir, 'sei-fixture.mp4');
  const gen = await run(ffmpegPath, [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${FIXTURE_FPS}`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'ultrafast',
    '-bf', '0', '-g', String(FIXTURE_FPS), '-pix_fmt', 'yuv420p',
    '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', raw
  ], { timeoutMs: 60000 });
  if (gen.code !== 0) throw new Error(`fixture encode failed: ${tail(gen.stderr) || gen.error?.message}`);
  const injected = injectSei(await fs.readFile(raw));
  await fs.writeFile(withSei, injected.data);
  const mux = await run(ffmpegPath, [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-framerate', String(FIXTURE_FPS), '-f', 'h264', '-i', withSei, '-c', 'copy', file
  ], { timeoutMs: 60000 });
  await Promise.all([fs.rm(raw, { force: true }), fs.rm(withSei, { force: true })]);
  if (mux.code !== 0) throw new Error(`fixture mux failed: ${tail(mux.stderr) || mux.error?.message}`);
  return { file, frames: injected.frames };
}

module.exports = { makeSeiFixture, injectSei, splitAnnexB, countMarkers, teslaStyleSei, SEI_MARKER, FIXTURE_FPS };
