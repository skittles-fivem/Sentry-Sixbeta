'use strict';

// Hardware encoder auto-detection. "Listed in ffmpeg -encoders" is not proof
// an encoder works (NVENC is compiled into most builds whether or not a GPU
// is present), so every candidate does a real test encode with the exact
// production arguments, and its output is checked for codec, frame count and
// whether Tesla's per-frame telemetry SEI survived.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { run, head } = require('./proc');
const { buildEncodeArgs, BACKENDS, BACKEND_ORDER } = require('./ffmpegArgs');
const { probeFile } = require('./probe');
const { makeSeiFixture, countMarkers, FIXTURE_FPS } = require('./seiFixture');

async function listEncoders(ffmpegPath) {
  const res = await run(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 15000 });
  const names = new Set();
  for (const line of res.stdout.split('\n')) {
    const m = line.match(/^\s*V[.A-Z]{5}\s+(\S+)/);
    if (m) names.add(m[1]);
  }
  return names;
}

async function ffmpegVersion(ffmpegPath) {
  const res = await run(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 15000 });
  if (res.code !== 0) return null;
  return res.stdout.split('\n')[0].trim();
}

function renderNodes(driDir = '/dev/dri') {
  try {
    return fs.readdirSync(driDir)
      .filter((n) => /^renderD\d+$/.test(n))
      .sort()
      .map((n) => path.join(driDir, n));
  } catch {
    return [];
  }
}

/** Turn ffmpeg's failure output into a hint about the container setup. */
function hintFor(backend, stderr) {
  const s = String(stderr || '');
  if (backend === 'nvenc') {
    if (/libcuda|libnvidia-encode|Cannot load|CUDA_ERROR_NO_DEVICE|no CUDA-capable/i.test(s)) {
      return 'No NVIDIA GPU visible in the container. Install the NVIDIA Container Toolkit, give the service the GPU (gpus: all) and set NVIDIA_DRIVER_CAPABILITIES=compute,video,utility.';
    }
    if (/OpenEncodeSessionEx failed|out of memory|incompatible client key/i.test(s)) {
      return 'The NVIDIA driver refused an encode session (too many sessions, or the driver is too old for this ffmpeg).';
    }
  }
  if (backend === 'vaapi' || backend === 'qsv') {
    if (/vaInitialize|Failed to initialise VAAPI|No VA display|libva/i.test(s)) {
      return 'VA-API could not start on this device. Pass /dev/dri into the container and make sure the host GPU driver is loaded.';
    }
    if (/Permission denied/i.test(s)) return 'No permission to open the render node. Add the render/video group or run the container as root.';
    if (/MFX|mfx|vpl/i.test(s)) return 'Quick Sync runtime failed to start (needs an Intel iGPU/Arc and the Intel media driver).';
  }
  return null;
}

/**
 * @returns {Promise<{selected: object|null, candidates: object[], notes: string[], ffmpeg: string|null,
 *   fixture: boolean, family: string, detectedAt: number, durationMs: number}>}
 */
async function detectEncoders({
  ffmpegPath = 'ffmpeg',
  ffprobePath = 'ffprobe',
  family = 'h264',
  preference = 'auto',
  device = '',
  preserveTelemetry = true,
  quality = 26,
  preset = 'faster',
  workDir,
  driDir = '/dev/dri',
  log = { info() {}, warn() {} }
}) {
  const started = Date.now();
  const notes = [];
  const version = await ffmpegVersion(ffmpegPath);
  if (!version) {
    return {
      selected: null, candidates: [], notes: [`ffmpeg not found or not runnable at "${ffmpegPath}".`],
      ffmpeg: null, fixture: false, family, detectedAt: Date.now(), durationMs: Date.now() - started
    };
  }

  const listed = await listEncoders(ffmpegPath);
  await fsp.mkdir(workDir, { recursive: true });

  let fixture = null;
  try {
    fixture = await makeSeiFixture(ffmpegPath, workDir);
  } catch (err) {
    notes.push(`Could not build the telemetry test clip (${err.message}); SEI support is taken from encoder options only.`);
  }

  const nodes = device ? [device] : renderNodes(driDir);
  const order = preference !== 'auto' && BACKENDS[preference]
    ? [preference, ...BACKEND_ORDER.filter((b) => b !== preference)]
    : BACKEND_ORDER;

  const candidates = [];
  for (const backend of order) {
    const def = BACKENDS[backend];
    const codec = def.codecs[family];
    const devices = def.needsDevice ? nodes : [null];
    if (def.needsDevice && !devices.length) {
      candidates.push({
        backend, codec, name: def.name, device: null, listed: listed.has(codec), works: false,
        supportsSei: false, seiVerified: false, error: 'No /dev/dri render node in the container.',
        hint: 'Pass the GPU in with devices: - /dev/dri:/dev/dri'
      });
      continue;
    }
    for (const dev of devices) {
      const cand = { backend, codec, name: def.name, device: dev, listed: listed.has(codec), works: false, supportsSei: false, seiVerified: false, error: null, hint: null };
      candidates.push(cand);
      if (!cand.listed) {
        cand.error = `${codec} is not compiled into this ffmpeg build.`;
        continue;
      }
      log.info(`Testing ${def.name} (${codec}${dev ? ` on ${dev}` : ''})...`);
      await testCandidate(cand, { ffmpegPath, ffprobePath, family, quality, preset, workDir, fixture });
      log.info(`  ${codec}: ${cand.works ? 'works' : 'unusable'}${cand.works ? `, telemetry SEI ${cand.supportsSei ? 'preserved' : 'NOT preserved'}` : ` (${cand.error})`}`);
    }
  }

  let selected = null;
  for (const cand of candidates) {
    if (!cand.works) continue;
    if (preserveTelemetry && !cand.supportsSei) {
      notes.push(`${cand.name} (${cand.codec}) works but drops Tesla telemetry, so it is not used. Set PRESERVE_TELEMETRY=false to allow it.`);
      continue;
    }
    selected = cand;
    break;
  }
  if (preference !== 'auto' && selected && selected.backend !== preference) {
    const wanted = candidates.find((c) => c.backend === preference);
    notes.unshift(`ENCODER=${preference} was requested but is not usable${wanted?.error ? ` (${wanted.error})` : ''}; falling back to ${selected.name}.`);
  }
  if (!selected) notes.unshift('No usable encoder found; automatic encoding is disabled until this is fixed.');

  if (fixture) await fsp.rm(fixture.file, { force: true });
  return {
    selected, candidates, notes, ffmpeg: version, fixture: Boolean(fixture), family,
    detectedAt: Date.now(), durationMs: Date.now() - started
  };
}

async function testCandidate(cand, { ffmpegPath, ffprobePath, family, quality, preset, workDir, fixture }) {
  const help = await run(ffmpegPath, ['-hide_banner', '-h', `encoder=${cand.codec}`], { timeoutMs: 15000 });
  const hasSeiOption = /\budu_sei\b/.test(help.stdout + help.stderr);
  const output = path.join(workDir, `detect-${cand.backend}-${path.basename(cand.device || 'default')}.mp4`);
  const encoder = { backend: cand.backend, codec: cand.codec, device: cand.device, supportsSei: hasSeiOption };
  const args = buildEncodeArgs({
    input: fixture ? fixture.file : `testsrc2=size=640x360:rate=${FIXTURE_FPS}`,
    inputArgs: fixture ? undefined : ['-f', 'lavfi', '-t', '1'],
    output, encoder, family, quality, preset, fps: FIXTURE_FPS,
    preserveTelemetry: true, marker: 'SentryManager detect'
  });
  try {
    const res = await run(ffmpegPath, args, { timeoutMs: 90000 });
    if (res.code !== 0) {
      cand.error = head(res.stderr) || res.error?.message || `exit ${res.code}`;
      if (res.timedOut) cand.error = 'test encode timed out';
      cand.hint = hintFor(cand.backend, res.stderr);
      return;
    }
    const info = await probeFile(ffprobePath, output);
    const expectedCodec = family === 'hevc' ? 'hevc' : 'h264';
    if (info.video?.codec !== expectedCodec) {
      cand.error = `test output codec was ${info.video?.codec || 'none'}, expected ${expectedCodec}`;
      return;
    }
    if (fixture && info.video.frames !== null && info.video.frames !== fixture.frames) {
      cand.error = `test output had ${info.video.frames} frames, expected ${fixture.frames}`;
      return;
    }
    cand.works = true;
    if (fixture) {
      const seen = countMarkers(await fsp.readFile(output));
      cand.seiVerified = true;
      cand.supportsSei = hasSeiOption && seen >= fixture.frames;
      cand.seiFrames = seen;
    } else {
      cand.supportsSei = hasSeiOption;
    }
  } catch (err) {
    cand.error = err.message;
  } finally {
    await fsp.rm(output, { force: true });
  }
}

module.exports = { detectEncoders, listEncoders, renderNodes, hintFor };
