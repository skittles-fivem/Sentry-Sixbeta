'use strict';

// Real-pipeline benchmark: runs the actual converter (telemetry extraction and
// injection, full verification, staging and saving) on copies of real clips at
// several parallel-conversion levels, and reports files per minute. The
// user's footage is only read; every run writes into a temporary folder.

const nodeFs = require('fs');
const nodePath = require('path');
const { CONCURRENCY } = require('./contracts');

const LEVELS = Object.freeze([1, 2, 4, 6, 8]);
const MAX_CLIPS = 8;
// Stop raising concurrency once another step adds less than this much speed.
const MIN_GAIN = 1.05;

function benchmarkError(code) {
  return Object.assign(new Error(code), { code });
}

async function placeClip(fs, from, to) {
  try { await fs.link(from, to); } catch (_) { await fs.copyFile(from, to); }
}

/**
 * options:
 *   clips: [{ sourcePath, name }] real Tesla clips (read only)
 *   runLevel({ level, sourceRoot, workRoot, signal }) → job snapshot (runs the real converter)
 *   countFrames(path) → frames in a clip
 *   encoder: { codec, hardware } the converter will use
 * Returns { encoder, clips, results: [{ level, clips, completed, failed, failures, seconds,
 *   filesPerMinute, fps, ok }], best }.
 */
async function runConverterBenchmark(options = {}) {
  const {
    clips, runLevel, countFrames, encoder = null, tempRoot,
    signal, onProgress = () => {}, now = Date.now
  } = options;
  const fs = options.fs || nodeFs.promises;
  const pathApi = options.pathApi || nodePath;
  if (typeof runLevel !== 'function' || typeof countFrames !== 'function' || !tempRoot) {
    throw new TypeError('benchmark dependencies are required');
  }
  if (!Array.isArray(clips) || clips.length === 0) throw benchmarkError('BENCHMARK_SOURCE_REQUIRED');
  const checkAborted = () => { if (signal?.aborted) throw benchmarkError('CANCELLED'); };

  const workRoot = await fs.mkdtemp(pathApi.join(tempRoot, 'benchmark-'));
  try {
    // Copy the sample clips once; every level hard-links (or copies) from here.
    const chosen = clips.slice(0, MAX_CLIPS);
    const library = pathApi.join(workRoot, 'clips');
    await fs.mkdir(library, { recursive: true });
    const samples = [];
    for (const [index, clip] of chosen.entries()) {
      checkAborted();
      onProgress({ step: 'copy', index: index + 1, total: chosen.length });
      const target = pathApi.join(library, clip.name);
      await fs.copyFile(clip.sourcePath, target);
      samples.push({ name: clip.name, path: target, frames: await countFrames(target) });
    }

    // One real conversion run of `batch` at `level` parallel conversions.
    async function measure(level, batch, runKey, variant = {}) {
      const levelRoot = pathApi.join(workRoot, runKey);
      const sourceRoot = pathApi.join(levelRoot, 'source');
      const clipDir = pathApi.join(sourceRoot, 'RecentClips');
      await fs.mkdir(clipDir, { recursive: true });
      for (const sample of batch) await placeClip(fs, sample.path, pathApi.join(clipDir, sample.name));

      const started = now();
      const job = await runLevel({ level, sourceRoot, workRoot: levelRoot, signal, ...variant });
      const seconds = Math.max(0.001, (now() - started) / 1000);
      checkAborted();
      const items = Array.isArray(job?.items) ? job.items : [];
      const completed = items.filter((item) => item.state === 'completed');
      const failures = [...new Set(items.filter((item) => item.state === 'failed')
        .map((item) => item.failure?.code || item.resultCode || 'failed'))];
      const frames = completed.reduce((sum, item) => {
        const sample = batch.find((entry) => item.relativePath?.endsWith(entry.name));
        return sum + (sample?.frames || 0);
      }, 0);
      const filesPerMinute = Math.round((completed.length / seconds) * 600) / 10;
      // Space saved by this codec/profile on these clips (converted ones only).
      const sourceTotal = completed.reduce((sum, item) => sum + (item.sourceBytes || 0), 0);
      const outputTotal = completed.reduce((sum, item) => sum + (item.outputBytes || 0), 0);
      const savedPercent = sourceTotal > 0 && outputTotal > 0 ? Math.round(1000 - (outputTotal / sourceTotal) * 1000) / 10 : null;
      // Average time each clip spent in post-conversion verification.
      const timedFiles = job?.timings?.files;
      const verifyMs = job?.timings?.totalMs?.verify;
      const verifySecondsPerClip = Number.isSafeInteger(timedFiles) && timedFiles > 0 && Number.isFinite(verifyMs)
        ? Math.round(verifyMs / timedFiles / 100) / 10 : null;
      await fs.rm(levelRoot, { recursive: true, force: true }).catch(() => {});
      return {
        level,
        clips: batch.length,
        completed: completed.length,
        failed: items.filter((item) => item.state === 'failed').length,
        failures,
        seconds: Math.round(seconds * 10) / 10,
        filesPerMinute,
        savedPercent,
        verifySecondsPerClip,
        fps: Math.round((frames / seconds) * 10) / 10,
        ok: completed.length === batch.length
      };
    }
    // Give every parallel slot real work: at least two clips, else one per slot.
    const batchFor = (level) => samples.slice(0, Math.min(samples.length, Math.max(level, 2)));

    const levels = LEVELS.filter((level) => level <= CONCURRENCY.max && level <= samples.length);
    const results = [];
    let previous = 0;
    for (const [index, level] of levels.entries()) {
      checkAborted();
      onProgress({ step: 'run', level, index: index + 1, total: levels.length, encoder: encoder?.codec, hardware: encoder?.hardware === true });
      const result = await measure(level, batchFor(level), `level-${level}`);
      results.push(result);
      // A failing level usually means the hardware refused another session;
      // a level that barely helps means the machine is saturated.
      if (!result.ok || (previous > 0 && result.filesPerMinute < previous * MIN_GAIN)) break;
      previous = result.filesPerMinute;
    }
    // Recommend the lightest setting within 5% of the fastest.
    const successful = results.filter((entry) => entry.ok);
    const top = Math.max(0, ...successful.map((entry) => entry.filesPerMinute));
    const best = successful.filter((entry) => entry.filesPerMinute >= top * 0.95)
      .sort((left, right) => left.level - right.level)[0] || null;

    // Verification modes side by side: all modes run back to back at the
    // recommended setting on the full set of sample clips, so the numbers are
    // measured the same way (the sweep's own runs are not reused).
    const verifyComparison = [];
    const compareModes = Array.isArray(options.compareVerifyModes) ? options.compareVerifyModes : [];
    if (best && compareModes.length) {
      for (const [index, mode] of compareModes.entries()) {
        checkAborted();
        onProgress({ step: 'verify', verifyMode: mode, level: best.level, index: index + 1, total: compareModes.length });
        verifyComparison.push({ verifyMode: mode, ...await measure(best.level, samples, `verify-${mode}`, { verifyMode: mode }) });
      }
    }
    return { encoder, clips: samples.length, results, best, verifyComparison };
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { runConverterBenchmark, LEVELS, MAX_CLIPS };
