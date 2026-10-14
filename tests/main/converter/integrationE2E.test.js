'use strict';

// End-to-end runs of the real converter runtime with real FFmpeg: automatic
// conversion, the time window across an app restart, verification modes,
// keeping an original that would not shrink, the two-codec benchmark, and a
// long job's live updates through the window's IPC channel.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { registerConverterIpc } = require('../../../src/main/converter/ipc');
const { isWithinProfile } = require('../../../src/main/converter/contracts');
const { locateBundledTools, probeRequiredEncodersSync } = require('./ffmpegFixtures');
const { clipName, makeClip, makeRoot, makeRuntime, sleep, waitFor } = require('./realRuntime');

jest.setTimeout(600_000);
// Tiny fixture clips make encoder output sizes slightly variable; a failing
// case is re-run before it counts.
jest.retryTimes(1, { logErrorsBeforeRetry: true });
const encoderGate = probeRequiredEncodersSync();
const describeReal = encoderGate.available ? describe : describe.skip;
const TERMINAL = ['completed', 'failed', 'cancelled'];

const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

describe('real converter end-to-end gate', () => {
  test('the required encoders are available or the reason is reported', () => {
    if (!encoderGate.available) console.warn(`SKIP converter end-to-end: ${encoderGate.reason}`);
    expect(encoderGate.reason === null || encoderGate.reason.startsWith('required encoder probe failed')).toBe(true);
  });
});

describeReal('real converter end-to-end', () => {
  let tools;
  const roots = [];
  const runtimes = new Set();
  beforeAll(async () => { tools = await locateBundledTools(); });
  afterEach(async () => {
    for (const runtime of runtimes) await runtime.shutdown().catch(() => {});
    runtimes.clear();
  });
  afterAll(async () => {
    for (const root of roots) await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  async function newRoot(name) {
    const root = await makeRoot(name);
    roots.push(root);
    return root;
  }
  async function start(root, extra) {
    const runtime = await makeRuntime(tools, root, extra);
    runtimes.add(runtime);
    return runtime;
  }
  async function stop(runtime) {
    runtimes.delete(runtime);
    await runtime.shutdown();
  }
  const baseConfig = (root, overrides = {}) => ({
    sourceRoot: path.join(root, 'TeslaCam'), destinationRoot: path.join(root, 'out'), codec: 'h265', profileId: 'balanced',
    networkMode: 'direct', outputMode: 'separate', includedGroups: ['RecentClips'], replacementConfirmed: false, ...overrides
  });

  test('automatic conversion converts new clips once, then only clips added later', async () => {
    const root = await newRoot('auto');
    const folder = path.join(root, 'TeslaCam', 'RecentClips');
    const seed = path.join(root, 'seed.mp4');
    await makeClip(tools, seed, { seconds: 2 });
    for (let index = 0; index < 4; index += 1) await fs.promises.copyFile(seed, path.join(folder, clipName(index)));
    const prewarmed = [];
    const runtime = await start(root, { onClipConverted: (outputPath) => prewarmed.push(outputPath) });
    const config = baseConfig(root, { profileId: 'quality', qualityLevel: 'balanced', concurrency: 2 });
    await runtime.auto.configure({ enabled: true, intervalMinutes: 60, window: null, keepRunning: false, openAtLogin: false, config });

    const first = await waitFor(() => runtime.auto.get().status.lastJobId, { what: 'the first automatic job' });
    expect(runtime.auto.get().status.lastNewFiles).toBe(4);
    const firstJob = await runtime.service.whenIdle(first);
    expect(firstJob.state).toBe('completed');
    expect(firstJob.config.autoConvert).toBe(true);
    expect(firstJob.items).toHaveLength(4);
    for (const item of firstJob.items) expect(['converted', 'no-savings']).toContain(item.resultCode);
    await waitFor(() => !runtime.auto.get().status.activeJobId, { what: 'the finished job to be recorded' });

    // Nothing new: no second job.
    await runtime.auto.checkNow();
    expect(runtime.auto.get().status).toMatchObject({ lastNewFiles: 0, error: null });
    expect(await runtime.service.list()).toHaveLength(1);

    // One clip added: only it is converted.
    await fs.promises.copyFile(seed, path.join(folder, clipName(10)));
    await runtime.auto.checkNow();
    const second = runtime.auto.get().status.lastJobId;
    expect(second).not.toBe(first);
    expect(runtime.auto.get().status.lastNewFiles).toBe(1);
    const secondJob = await runtime.service.whenIdle(second);
    expect(secondJob.items.map((item) => item.relativePath)).toEqual([`RecentClips/${clipName(10)}`]);

    // Every converted clip asked for a preview filmstrip, and each exists.
    const converted = [...firstJob.items, ...secondJob.items].filter((item) => item.resultCode === 'converted');
    await waitFor(() => prewarmed.length >= converted.length, { what: 'filmstrip requests' });
    expect(prewarmed.every((file) => fs.existsSync(file))).toBe(true);
  });

  test('the time window pauses a job, a restart inside the window resumes it, and paused time is left out', async () => {
    const root = await newRoot('window');
    const folder = path.join(root, 'TeslaCam', 'RecentClips');
    const seed = path.join(root, 'seed.mp4');
    await makeClip(tools, seed, { seconds: 6, size: '640x360' });
    for (let index = 0; index < 5; index += 1) await fs.promises.copyFile(seed, path.join(folder, clipName(index)));
    let hour = 2;
    const autoClock = { now: Date.now, hourOf: () => hour };
    const config = baseConfig(root, { concurrency: 1, verifyMode: 'quick' });

    let runtime = await start(root, { autoClock });
    await runtime.auto.configure({ enabled: true, intervalMinutes: 60, window: { startHour: 1, endHour: 6 }, keepRunning: false, openAtLogin: false, config });
    const jobId = await waitFor(() => runtime.auto.get().status.activeJobId, { what: 'the automatic job' });
    await sleep(1500);
    hour = 8; // the window has ended
    await runtime.auto.checkNow();
    const paused = await waitFor(async () => { const job = await runtime.service.get(jobId); return job.state === 'paused' && job; }, { what: 'the window pause' });
    expect(runtime.auto.get().status.pausedForWindow).toBe(true);
    expect(paused.items.some((item) => item.state === 'queued')).toBe(true);
    await stop(runtime);

    await sleep(3000); // the app stays closed for a while
    hour = 2;
    runtime = await start(root, { autoClock });
    await runtime.auto.checkNow();
    const finished = await waitFor(async () => { const job = await runtime.service.get(jobId); return TERMINAL.includes(job.state) && job; },
      { timeoutMs: 300_000, what: 'the resumed job' });
    expect(finished.state).toBe('completed');
    expect(finished.items.every((item) => item.state === 'completed')).toBe(true);
    expect(finished.pausedMs).toBeGreaterThanOrEqual(2500);
    expect(finished.updatedAt - finished.createdAt - finished.pausedMs).toBeLessThan(finished.updatedAt - finished.createdAt);
    await stop(runtime);

    // A job the user paused stays paused across a restart inside the window.
    for (let index = 0; index < 3; index += 1) await fs.promises.copyFile(seed, path.join(folder, clipName(index, 30)));
    runtime = await start(root, { autoClock });
    await runtime.auto.checkNow();
    const userJob = await waitFor(() => { const id = runtime.auto.get().status.activeJobId; return id && id !== jobId && id; }, { what: 'the second automatic job' });
    await sleep(1000);
    await runtime.service.pause(userJob);
    await waitFor(async () => (await runtime.service.get(userJob)).state === 'paused', { what: 'the user pause' });
    await stop(runtime);
    runtime = await start(root, { autoClock });
    await runtime.auto.checkNow();
    await sleep(3000);
    expect((await runtime.service.get(userJob)).state).toBe('paused');
    expect(runtime.auto.get().status.error).toBeNull();
  });

  test('verification Off, Quick and Full all convert; only Full decodes the result, and Off keeps the size window', async () => {
    const root = await newRoot('verify');
    const folder = path.join(root, 'TeslaCam', 'RecentClips');
    for (let index = 0; index < 2; index += 1) await makeClip(tools, path.join(folder, clipName(index)), { seconds: 8, noise: 16 });
    const calls = [];
    const recordingSpawn = (command, args, options) => { calls.push(args); return spawn(command, args, options); };
    const runtime = await start(root, { spawn: recordingSpawn, autoConvert: false });
    for (const verifyMode of ['off', 'quick', 'full']) {
      const destinationRoot = path.join(root, `out-${verifyMode}`);
      const before = calls.length;
      const id = await runtime.service.start(baseConfig(root, { destinationRoot, verifyMode, concurrency: 2 }));
      const job = await runtime.service.whenIdle(id);
      expect(job.state).toBe('completed');
      expect(job.items.map((item) => item.state)).toEqual(['completed', 'completed']);
      for (const item of job.items) {
        expect(fs.existsSync(item.outputPath)).toBe(true);
        expect(isWithinProfile(item.sourceBytes, item.outputBytes, 'balanced')).toBe(true);
      }
      // A full decode reads the saved candidate to the end and discards it.
      const decodes = calls.slice(before).filter((args) => args.includes('null') && args.includes('-f') && !args.includes('-c:v'));
      if (verifyMode === 'full') expect(decodes.length).toBeGreaterThanOrEqual(2);
      else expect(decodes).toHaveLength(0);
      expect(job.timings.files).toBe(2);
    }
  });

  test('without a size target, an original that would not get smaller is kept unchanged with nothing left behind', async () => {
    const root = await newRoot('keep');
    const clip = path.join(root, 'TeslaCam', 'RecentClips', clipName(0));
    await makeClip(tools, clip, { seconds: 4, noise: 12 });
    const runtime = await start(root, { autoConvert: false });
    // 100 Mbps for a small 1.2 Mbps clip: the result is always larger.
    const id = await runtime.service.start(baseConfig(root, { profileId: 'custom', bitrateKbps: 100_000 }));
    const job = await runtime.service.whenIdle(id);
    expect(job.items).toEqual([expect.objectContaining({ resultCode: 'no-savings' })]);
    const copy = path.join(root, 'out', 'RecentClips', clipName(0));
    expect(sha1(copy)).toBe(sha1(clip));
    await sleep(1500); // empty verification folders are swept shortly after a job
    const leftovers = fs.readdirSync(root).filter((name) => name.startsWith('sentry-six-verification-'))
      .filter((name) => fs.readdirSync(path.join(root, name)).length > 0);
    expect(leftovers).toEqual([]);
  });

  test('the benchmark measures H.265 and AV1 side by side with every verification mode, leaving nothing behind', async () => {
    const root = await newRoot('bench');
    const folder = path.join(root, 'TeslaCam', 'RecentClips');
    for (let index = 0; index < 2; index += 1) await makeClip(tools, path.join(folder, clipName(index)), { seconds: 4, noise: 16 });
    const runtime = await start(root, { autoConvert: false });
    const steps = [];
    const result = await runtime.runBenchmark({ codecs: ['h265', 'av1'], profileId: 'balanced', verifyMode: 'quick',
      sourceRoot: path.join(root, 'TeslaCam'), onProgress: (progress) => steps.push(progress) });
    expect(result.codecs.map((run) => run.codec)).toEqual(['h265', 'av1']);
    for (const run of result.codecs) {
      expect(run.error || null).toBeNull();
      expect(run.results.length).toBeGreaterThan(0);
      expect(run.results.every((entry) => entry.ok)).toBe(true);
      expect(run.best).toEqual(expect.objectContaining({ ok: true }));
      expect(run.verifyComparison.map((entry) => entry.verifyMode)).toEqual(['off', 'quick', 'full']);
      for (const entry of run.verifyComparison) {
        expect(entry.ok).toBe(true);
        expect(entry.clips).toBe(run.clips);
        expect(entry.filesPerMinute).toBeGreaterThan(0);
      }
      const verifySeconds = Object.fromEntries(run.verifyComparison.map((entry) => [entry.verifyMode, entry.verifySecondsPerClip]));
      expect(verifySeconds.full).toBeGreaterThan(verifySeconds.off);
    }
    const verifySteps = steps.filter((step) => step.step === 'verify');
    expect(verifySteps.map((step) => `${step.index}/${step.total}`)).toEqual(['1/3', '2/3', '3/3', '1/3', '2/3', '3/3']);
    expect(await runtime.service.list()).toEqual([]); // the user's job list is untouched
    const work = path.join(root, 'sentry-six-converter');
    const left = fs.existsSync(work) ? fs.readdirSync(work).filter((name) => name.startsWith('benchmark-')) : [];
    expect(left).toEqual([]);
  });

  test('a long job keeps the window updated to the end (fractional file times, many clips)', async () => {
    const root = await newRoot('ipc');
    const folder = path.join(root, 'TeslaCam', 'RecentClips');
    const seed = path.join(root, 'seed.mp4');
    await makeClip(tools, seed, { seconds: 1, noise: 8 });
    const count = 30;
    for (let index = 0; index < count; index += 1) {
      const file = path.join(folder, clipName(index));
      await fs.promises.copyFile(seed, file);
      // Windows reports modification times with fractions of a millisecond.
      const when = new Date(Date.now() - (count - index) * 61_123.4567);
      await fs.promises.utimes(file, when, when);
    }
    const runtime = await start(root, { autoConvert: false });
    const handlers = {};
    registerConverterIpc({
      ipcMain: { handle: (channel, handler) => { handlers[channel] = handler; }, removeHandler: () => {} },
      dialog: { showOpenDialog: async () => ({ canceled: true }) },
      service: runtime.service, capabilities: runtime.capabilities, auto: runtime.auto
    });
    const received = [];
    const sender = { send: (channel, payload) => received.push(payload), once: () => {}, isDestroyed: () => false };
    expect((await handlers['converter:subscribeProgress']({ sender })).ok).toBe(true);
    const started = await handlers['converter:start']({ sender }, baseConfig(root, { networkMode: 'auto', concurrency: 4 }));
    expect(started.ok).toBe(true);
    const job = await runtime.service.whenIdle(started.value.jobId);
    expect(job.items.filter((item) => item.state === 'completed')).toHaveLength(count);
    await sleep(500);
    const snapshots = received.filter((payload) => payload.snapshot?.state);
    const last = snapshots.at(-1).snapshot;
    expect(last.state).toBe('completed');
    const completed = last.itemStateCounts?.completed ?? last.items.filter((item) => item.state === 'completed').length;
    expect(completed).toBe(count);
    const current = await handlers['converter:getCurrent']({ sender });
    expect(current.ok).toBe(true);
    expect(current.value.state).toBe('completed');
  });
});
