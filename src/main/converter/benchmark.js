'use strict';

// Encoding benchmark: measures how fast this machine converts footage with each
// available encoder at several parallel-conversion levels, so users can pick the
// fastest settings. Each run does what a real conversion spends its time on:
// encode a sample clip, then fully decode the result (the verify step).

const nodeFs = require('fs');
const nodePath = require('path');
const { buildEncodeArgs } = require('./encoderPlanner');
const { CONCURRENCY } = require('./contracts');

const SAMPLE_SECONDS = 10;
const BENCHMARK_BITRATE = 2_000_000;
const HARDWARE_LEVELS = Object.freeze([1, 2, 4, 6, 8]);
const CPU_LEVELS = Object.freeze([1, 2, 4]);
// Stop raising concurrency once another step adds less than this much speed.
const MIN_GAIN = 1.05;

function benchmarkError(code) {
  return Object.assign(new Error(code), { code });
}

function failed(result) {
  return !result || result.status !== 0 || result.timedOut || result.aborted;
}

async function createSample({ runProcess, ffmpegPath, sourcePath, samplePath, signal }) {
  if (sourcePath) {
    const copied = await runProcess(ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-t', String(SAMPLE_SECONDS), '-i', sourcePath, '-map', '0:v:0', '-c', 'copy', '-an', samplePath
    ], { signal, timeoutMs: 120_000 });
    if (!failed(copied)) return 'clip';
  }
  // No usable clip: generate a Tesla-sized (1448x938, 36 fps) H.264 test source.
  const generated = await runProcess(ffmpegPath, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=1448x938:rate=36:duration=${SAMPLE_SECONDS}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', samplePath
  ], { signal, timeoutMs: 300_000 });
  if (failed(generated)) throw benchmarkError('BENCHMARK_SAMPLE_FAILED');
  return 'generated';
}

async function countFrames({ runProcess, ffprobePath, samplePath, signal }) {
  const result = await runProcess(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', samplePath
  ], { signal, timeoutMs: 60_000 });
  const frames = Number.parseInt(String(result?.stdout || '').trim(), 10);
  if (failed(result) || !Number.isSafeInteger(frames) || frames <= 0) throw benchmarkError('BENCHMARK_SAMPLE_FAILED');
  return frames;
}

async function runLevel({ runProcess, ffmpegPath, codec, encoder, level, samplePath, workDir, pathApi, signal, now }) {
  const started = now();
  const runs = Array.from({ length: level }, async (_unused, index) => {
    const output = pathApi.join(workDir, `bench-${encoder.codec}-${level}-${index}.mp4`);
    const encoded = await runProcess(ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', samplePath,
      ...buildEncodeArgs({ codec, encoder: encoder.codec, bitrate: BENCHMARK_BITRATE }),
      '-an', '-sn', '-dn', '-f', 'mp4', output
    ], { signal, timeoutMs: 600_000 });
    if (failed(encoded)) return false;
    const decoded = await runProcess(ffmpegPath, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-i', output,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-f', 'null', '-'
    ], { signal, timeoutMs: 600_000 });
    return !failed(decoded);
  });
  const outcomes = await Promise.all(runs);
  return { seconds: Math.max(0.001, (now() - started) / 1000), ok: outcomes.every(Boolean) };
}

/**
 * Runs the benchmark. Returns
 *   { sample, frames, results: [{ encoder, hardware, level, ok, fps, seconds }], best }
 * where fps is total frames per second across all parallel conversions
 * (encode + verify decode) and best is the fastest successful result.
 */
async function runConverterBenchmark(options = {}) {
  const {
    runProcess, planner, ffmpegPath, ffprobePath, tempRoot, codec,
    sourcePath = null, signal, onProgress = () => {}, now = Date.now
  } = options;
  const fs = options.fs || nodeFs.promises;
  const pathApi = options.pathApi || nodePath;
  if (typeof runProcess !== 'function' || !planner || !ffmpegPath || !ffprobePath || !tempRoot) {
    throw new TypeError('benchmark dependencies are required');
  }
  if (!['h265', 'av1'].includes(codec)) throw benchmarkError('INVALID_CODEC');
  const checkAborted = () => { if (signal?.aborted) throw benchmarkError('CANCELLED'); };

  const workDir = await fs.mkdtemp(pathApi.join(tempRoot, 'benchmark-'));
  try {
    onProgress({ step: 'sample' });
    const samplePath = pathApi.join(workDir, 'sample.mp4');
    const sample = await createSample({ runProcess, ffmpegPath, sourcePath, samplePath, signal });
    checkAborted();
    const frames = await countFrames({ runProcess, ffprobePath, samplePath, signal });

    const encoders = [];
    const add = (encoder) => {
      if (encoder && !encoders.some((entry) => entry.codec === encoder.codec)) encoders.push(encoder);
    };
    try { add(await planner.select(codec)); } catch (_) { /* no proven preferred encoder */ }
    try { add(await planner.selectCpuFallback(codec)); } catch (_) { /* no proven CPU encoder */ }
    if (encoders.length === 0) throw benchmarkError('NO_ENCODER_AVAILABLE');

    const plan = encoders.map((encoder) => ({
      encoder,
      levels: (encoder.hardware ? HARDWARE_LEVELS : CPU_LEVELS).filter((level) => level <= CONCURRENCY.max)
    }));
    const totalSteps = plan.reduce((sum, entry) => sum + entry.levels.length, 0);
    const results = [];
    let step = 0;
    for (const { encoder, levels } of plan) {
      let previousFps = 0;
      for (const level of levels) {
        checkAborted();
        step += 1;
        onProgress({ step: 'run', encoder: encoder.codec, hardware: encoder.hardware === true, level, index: step, total: totalSteps });
        const run = await runLevel({ runProcess, ffmpegPath, codec, encoder, level, samplePath, workDir, pathApi, signal, now });
        checkAborted();
        const fps = run.ok ? Math.round((frames * level / run.seconds) * 10) / 10 : 0;
        results.push({ encoder: encoder.codec, hardware: encoder.hardware === true, level, ok: run.ok, fps, seconds: run.seconds });
        // A failed level usually means the hardware refused another session;
        // a level that barely helps means the machine is saturated.
        if (!run.ok || (previousFps > 0 && fps < previousFps * MIN_GAIN)) break;
        previousFps = fps;
      }
    }
    // Recommend the lightest setting within 5% of the fastest: near-equal speed
    // with fewer parallel conversions uses less CPU, memory and encoder sessions.
    // Conversions always use the preferred (first proven) encoder, so the
    // recommendation is the parallel setting for that encoder.
    const preferredEncoder = encoders[0].codec;
    const successful = results.filter((entry) => entry.ok && entry.encoder === preferredEncoder);
    const top = Math.max(0, ...successful.map((entry) => entry.fps));
    const best = successful.filter((entry) => entry.fps >= top * 0.95)
      .sort((left, right) => left.level - right.level || right.fps - left.fps)[0] || null;
    return { codec, sample, frames, sampleSeconds: SAMPLE_SECONDS, preferredEncoder, results, best };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runConverterBenchmark, HARDWARE_LEVELS, CPU_LEVELS };
