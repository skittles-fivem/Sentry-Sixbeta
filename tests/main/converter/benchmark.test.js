'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runConverterBenchmark } = require('../../../src/main/converter/benchmark');

describe('converter real-pipeline benchmark', () => {
  let root;
  let clips;
  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-bench-'));
    const source = path.join(root, 'footage');
    await fs.promises.mkdir(source);
    clips = [];
    for (let index = 0; index < 8; index += 1) {
      const name = `2026-08-30_12-00-0${index}-front.mp4`;
      await fs.promises.writeFile(path.join(source, name), `clip ${index}`);
      clips.push({ sourcePath: path.join(source, name), name });
    }
  });
  afterEach(async () => { await fs.promises.rm(root, { recursive: true, force: true }); });

  // Simulated converter: a level converts every clip in its source folder; the
  // machine handles `capacity` conversions at once, each taking one second.
  function machine({ capacity = 4, sessionLimit = Infinity } = {}) {
    let now = 0;
    const seen = [];
    const runLevel = jest.fn(async ({ level, sourceRoot }) => {
      const names = await fs.promises.readdir(path.join(sourceRoot, 'RecentClips'));
      seen.push({ level, names });
      now += Math.ceil(names.length / Math.min(level, capacity)) * 1000;
      return {
        items: names.map((name) => level > sessionLimit
          ? { relativePath: `RecentClips/${name}`, state: 'failed', failure: { code: 'encoder-failed' } }
          : { relativePath: `RecentClips/${name}`, state: 'completed' })
      };
    });
    return { runLevel, seen, now: () => now };
  }

  const base = () => ({ countFrames: async () => 360, tempRoot: root, encoder: { codec: 'hevc_nvenc', hardware: true } });

  test('runs the real converter per level on copies of real clips and recommends the lightest near-best level', async () => {
    const m = machine({ capacity: 4 });
    const progress = [];
    const result = await runConverterBenchmark({ ...base(), clips, runLevel: m.runLevel, now: m.now, onProgress: (entry) => progress.push(entry) });

    expect(m.seen.map((entry) => [entry.level, entry.names.length])).toEqual([[1, 2], [2, 2], [4, 4], [6, 6]]);
    expect(result.results.map((entry) => [entry.level, entry.filesPerMinute])).toEqual([[1, 60], [2, 120], [4, 240], [6, 180]]);
    expect(result.results[2]).toMatchObject({ completed: 4, ok: true, fps: 1440 });
    expect(result.best).toMatchObject({ level: 4 });
    expect(result.encoder).toEqual({ codec: 'hevc_nvenc', hardware: true });
    expect(progress.filter((entry) => entry.step === 'copy')).toHaveLength(8);
    // Originals untouched; the temporary work folder is removed.
    expect(await fs.promises.readFile(clips[0].sourcePath, 'utf8')).toBe('clip 0');
    expect((await fs.promises.readdir(root)).sort()).toEqual(['footage']);
  });

  test('compares verification modes at the recommended setting, reusing the sweep for the selected mode', async () => {
    let now = 0;
    const verifyCost = { off: 0, quick: 400, full: 4000 }; // ms per clip
    const runLevel = jest.fn(async ({ level, sourceRoot, verifyMode = 'quick' }) => {
      const names = await fs.promises.readdir(path.join(sourceRoot, 'RecentClips'));
      const perClip = 1000 + verifyCost[verifyMode];
      now += Math.ceil(names.length / Math.min(level, 4)) * perClip;
      return {
        items: names.map((name) => ({ relativePath: `RecentClips/${name}`, state: 'completed' })),
        timings: { files: names.length, totalMs: { verify: verifyCost[verifyMode] * names.length } }
      };
    });
    const progress = [];
    const result = await runConverterBenchmark({ ...base(), clips, runLevel, now: () => now, verifyMode: 'quick',
      compareVerifyModes: ['off', 'quick', 'full'], onProgress: (entry) => progress.push(entry) });
    expect(result.best.level).toBe(4);
    const extra = runLevel.mock.calls.filter(([options]) => options.verifyMode);
    expect(extra.map(([options]) => [options.level, options.verifyMode])).toEqual([[4, 'off'], [4, 'full']]);
    expect(result.verifyComparison.map((entry) => [entry.verifyMode, entry.verifySecondsPerClip, entry.ok]))
      .toEqual([['off', 0, true], ['quick', 0.4, true], ['full', 4, true]]);
    const [off, quick, full] = result.verifyComparison.map((entry) => entry.filesPerMinute);
    expect(off).toBeGreaterThan(quick);
    expect(quick).toBeGreaterThan(full);
    expect(progress.filter((entry) => entry.step === 'verify').map((entry) => entry.verifyMode)).toEqual(['off', 'full']);
    expect((await fs.promises.readdir(root)).sort()).toEqual(['footage']);
  });

  test('stops at a failing level and reports its failure codes', async () => {
    const m = machine({ capacity: 8, sessionLimit: 2 });
    const result = await runConverterBenchmark({ ...base(), clips, runLevel: m.runLevel, now: m.now });
    expect(result.results.map((entry) => [entry.level, entry.ok])).toEqual([[1, true], [2, true], [4, false]]);
    expect(result.results[2].failures).toEqual(['encoder-failed']);
    expect(result.best).toMatchObject({ level: 2 });
  });

  test('only tests levels it has clips for, needs clips, and can be cancelled', async () => {
    const m = machine();
    const few = await runConverterBenchmark({ ...base(), clips: clips.slice(0, 3), runLevel: m.runLevel, now: m.now });
    expect(few.results.map((entry) => entry.level)).toEqual([1, 2]);
    await expect(runConverterBenchmark({ ...base(), clips: [], runLevel: m.runLevel }))
      .rejects.toMatchObject({ code: 'BENCHMARK_SOURCE_REQUIRED' });
    const controller = new AbortController();
    controller.abort();
    await expect(runConverterBenchmark({ ...base(), clips, runLevel: m.runLevel, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await fs.promises.readdir(root)).sort()).toEqual(['footage']);
  });
});
