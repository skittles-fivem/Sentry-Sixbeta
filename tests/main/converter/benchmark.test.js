'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runConverterBenchmark } = require('../../../src/main/converter/benchmark');

// Fake process runner: "encodes" take time proportional to how many run at once
// beyond a given capacity, so total throughput saturates like real hardware.

describe('converter encoding benchmark', () => {
  let tempRoot;
  beforeEach(async () => { tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-bench-')); });
  afterEach(async () => { await fs.promises.rm(tempRoot, { recursive: true, force: true }); });

  function harness({ hardwareCapacity = 3, hardwareSessionLimit = Infinity, cpu = true } = {}) {
    const planner = {
      select: jest.fn(async () => ({ family: 'h265', codec: 'hevc_nvenc', hardware: true })),
      selectCpuFallback: jest.fn(async () => (cpu ? { family: 'h265', codec: 'libx265', hardware: false } : null))
    };
    // Simulated wall clock: each level of N parallel runs takes
    // ceil(N / capacity) "rounds" of 1 second for its encoder.
    let now = 0;
    let pendingLevel = null;
    const runProcess = jest.fn(async (_command, args) => {
      if (args.includes('-count_packets')) return { status: 0, stdout: '360\n', stderr: '' };
      const index = args.indexOf('-c:v');
      if (index >= 0 && !args.includes('lavfi')) {
        const encoder = args[index + 1];
        const level = Number(/bench-[^-]+-(\d+)-/.exec(args[args.length - 1])?.[1] || 1);
        if (encoder === 'hevc_nvenc' && level > hardwareSessionLimit) return { status: 1, stdout: '', stderr: 'OpenEncodeSessionEx failed' };
        const capacity = encoder === 'hevc_nvenc' ? hardwareCapacity : 1;
        pendingLevel = { level, capacity };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const clock = () => {
      // Called before and after each level; the "after" call accounts for the
      // level's simulated duration.
      if (pendingLevel) { now += Math.ceil(pendingLevel.level / pendingLevel.capacity) * 1000; pendingLevel = null; }
      return now;
    };
    return { planner, runProcess, now: clock };
  }

  test('measures each encoder, stops when more parallel runs stop helping, and recommends the lightest near-best level', async () => {
    const h = harness({ hardwareCapacity: 4 });
    const progress = [];
    const result = await runConverterBenchmark({
      runProcess: h.runProcess, planner: h.planner, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
      tempRoot, codec: 'h265', now: h.now, onProgress: (entry) => progress.push(entry)
    });

    expect(result.preferredEncoder).toBe('hevc_nvenc');
    const nvenc = result.results.filter((entry) => entry.encoder === 'hevc_nvenc').map((entry) => entry.level);
    expect(nvenc[0]).toBe(1);
    expect(nvenc).toContain(4);
    expect(result.best).toMatchObject({ encoder: 'hevc_nvenc', level: 4, ok: true });
    expect(result.results.some((entry) => entry.encoder === 'libx265')).toBe(true);
    expect(progress[0]).toEqual({ step: 'sample' });
    expect(await fs.promises.readdir(tempRoot)).toEqual([]);
  });

  test('stops raising concurrency when the hardware refuses another session', async () => {
    const h = harness({ hardwareCapacity: 8, hardwareSessionLimit: 3 });
    const result = await runConverterBenchmark({
      runProcess: h.runProcess, planner: h.planner, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', tempRoot, codec: 'h265', now: h.now
    });
    const nvenc = result.results.filter((entry) => entry.encoder === 'hevc_nvenc');
    expect(nvenc.map((entry) => [entry.level, entry.ok])).toEqual([[1, true], [2, true], [4, false]]);
    expect(result.best).toMatchObject({ encoder: 'hevc_nvenc', level: 2 });
  });

  test('can be cancelled and rejects unknown codecs', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(runConverterBenchmark({
      runProcess: h.runProcess, planner: h.planner, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', tempRoot, codec: 'h265', signal: controller.signal, now: h.now
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(runConverterBenchmark({
      runProcess: h.runProcess, planner: h.planner, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', tempRoot, codec: 'vp9', now: h.now
    })).rejects.toMatchObject({ code: 'INVALID_CODEC' });
  });
});
