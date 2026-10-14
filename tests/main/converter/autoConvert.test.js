'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAutoConverter, inWindow } = require('../../../src/main/converter/autoConvert');

const CONFIG = Object.freeze({
  sourceRoot: '/src', destinationRoot: '/dst', codec: 'h265', profileId: 'balanced', networkMode: 'auto',
  outputMode: 'separate', includedGroups: ['RecentClips'], replacementConfirmed: false
});

function clip(name, size = 1000, mtimeMs = 5000) {
  return { relativePath: `RecentClips/${name}`, sourcePath: `/src/RecentClips/${name}`, sourceBytes: size, mtimeMs, kind: 'video' };
}

function harness({ files = [], destinationFiles = [], busy = false, hour = 12 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-convert-'));
  const state = { files: [...files], jobs: new Map(), hour, time: 1_000_000, busy, started: [] };
  const destination = new Set(destinationFiles.map((name) => path.resolve('/dst', 'RecentClips', name)));
  const fakeFs = {
    ...fs.promises,
    stat: async (target) => {
      if (destination.has(target)) return { isFile: () => true, size: 10, mtimeMs: 1 };
      if (target.startsWith('/')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return fs.promises.stat(target);
    }
  };
  const service = {
    start: jest.fn(async (config) => {
      const id = `job-${state.started.length + 1}`;
      state.started.push(config);
      state.jobs.set(id, { id, state: 'encoding', config, items: [] });
      return id;
    }),
    get: jest.fn(async (id) => state.jobs.get(id)),
    list: jest.fn(async () => [...state.jobs.values()]),
    pause: jest.fn(async (id) => { state.jobs.get(id).state = 'paused'; }),
    resume: jest.fn(async (id) => { state.jobs.get(id).state = 'encoding'; })
  };
  const scanner = async function* scan() { for (const file of state.files) yield file; };
  const auto = createAutoConverter({
    service, scanner, fs: fakeFs, pathApi: path, directory: path.join(root, 'auto'),
    isBusy: async () => state.busy, now: () => state.time, hourOf: () => state.hour,
    timers: { setInterval: () => null, clearInterval: () => {} }
  });
  const finish = (id, items) => { Object.assign(state.jobs.get(id), { state: 'completed', items }); };
  return { auto, service, state, root, finish, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const enabled = (overrides = {}) => ({ enabled: true, intervalMinutes: 60, window: null, config: CONFIG, ...overrides });

describe('automatic conversion', () => {
  test('time window wraps past midnight', () => {
    expect(inWindow({ startHour: 22, endHour: 6 }, 23)).toBe(true);
    expect(inWindow({ startHour: 22, endHour: 6 }, 3)).toBe(true);
    expect(inWindow({ startHour: 22, endHour: 6 }, 12)).toBe(false);
    expect(inWindow({ startHour: 1, endHour: 5 }, 5)).toBe(false);
    expect(inWindow(null, 12)).toBe(true);
  });

  test('does nothing until enabled, then starts an automatic job only when new clips exist', async () => {
    const h = harness({ files: [clip('a.mp4'), clip('b.mp4')] });
    await h.auto.start();
    expect(h.service.start).not.toHaveBeenCalled();
    await h.auto.configure(enabled());
    await h.auto.tick();
    expect(h.service.start).toHaveBeenCalledWith({ ...CONFIG, autoConvert: true });
    expect(h.auto.getState().status).toMatchObject({ lastNewFiles: 2, activeJobId: 'job-1' });
    h.cleanup();
  });

  test('remembers handled clips so the next check finds nothing new, then picks up a new clip', async () => {
    const h = harness({ files: [clip('a.mp4'), clip('b.mp4')] });
    await h.auto.start();
    await h.auto.configure(enabled());
    await h.auto.tick();
    h.finish('job-1', [
      { ...clip('a.mp4'), state: 'completed' },
      { ...clip('b.mp4'), state: 'skipped' }
    ]);
    await h.auto.tick(); // records the finished job
    h.state.time += 61 * 60_000;
    await h.auto.tick();
    expect(h.service.start).toHaveBeenCalledTimes(1);
    expect(h.auto.getState().status.lastNewFiles).toBe(0);
    expect(h.auto.isKnown({ ...CONFIG, autoConvert: true }, clip('a.mp4'))).toBe(true);
    expect(h.auto.isKnown(CONFIG, clip('a.mp4'))).toBe(false); // manual jobs never skip

    h.state.files.push(clip('c.mp4'));
    h.state.time += 61 * 60_000;
    await h.auto.tick();
    expect(h.service.start).toHaveBeenCalledTimes(2);
    h.cleanup();
  });

  test('a changed clip (new size or time) counts as new again', async () => {
    const h = harness({ files: [clip('a.mp4')] });
    await h.auto.start();
    await h.auto.configure(enabled());
    await h.auto.tick();
    h.finish('job-1', [{ ...clip('a.mp4'), state: 'completed' }]);
    await h.auto.tick();
    expect(h.auto.isKnown({ ...CONFIG, autoConvert: true }, clip('a.mp4', 2000))).toBe(false);
    h.cleanup();
  });

  test('clips already converted into the destination are not converted again', async () => {
    const h = harness({ files: [clip('a.mp4'), clip('b.mp4')], destinationFiles: ['a.mp4', 'b.mp4'] });
    await h.auto.start();
    await h.auto.configure(enabled());
    await h.auto.tick();
    expect(h.service.start).not.toHaveBeenCalled();
    expect(h.auto.getState().status.lastNewFiles).toBe(0);
    h.cleanup();
  });

  test('waits while another conversion or benchmark is busy and checks on the interval', async () => {
    const h = harness({ files: [clip('a.mp4')], busy: true });
    await h.auto.start();
    await h.auto.configure(enabled({ intervalMinutes: 15 }));
    await h.auto.tick();
    expect(h.service.start).not.toHaveBeenCalled();
    h.state.busy = false;
    await h.auto.tick();
    expect(h.service.start).toHaveBeenCalledTimes(1);
    h.cleanup();
  });

  test('a manual job that started during a check is not reported as a failure', async () => {
    const h = harness({ files: [clip('a.mp4')] });
    await h.auto.start();
    await h.auto.configure(enabled());
    h.service.start.mockImplementationOnce(async () => { throw Object.assign(new Error('busy'), { code: 'JOB_ACTIVE' }); });
    await h.auto.tick();
    expect(h.auto.getState().status).toMatchObject({ error: null, nextCheckAt: null, activeJobId: null });
    await h.auto.tick();
    expect(h.service.start).toHaveBeenCalledTimes(2);
    h.cleanup();
  });

  test('only checks inside the time window, and pauses / resumes its job at the window edges', async () => {
    const h = harness({ files: [clip('a.mp4')], hour: 12 });
    await h.auto.start();
    await h.auto.configure(enabled({ window: { startHour: 1, endHour: 6 } }));
    await h.auto.tick();
    expect(h.service.start).not.toHaveBeenCalled();
    h.state.hour = 2;
    await h.auto.tick();
    expect(h.service.start).toHaveBeenCalledTimes(1);
    h.state.hour = 7;
    await h.auto.tick();
    expect(h.service.pause).toHaveBeenCalledWith('job-1');
    expect(h.auto.getState().status.pausedForWindow).toBe(true);
    h.state.hour = 1;
    await h.auto.tick();
    expect(h.service.resume).toHaveBeenCalledWith('job-1');
    h.cleanup();
  });

  test('after a restart, resumes only a job it paused itself, never one the user paused', async () => {
    const h = harness({ files: [clip('a.mp4')], hour: 2 });
    await h.auto.start();
    await h.auto.configure(enabled({ window: { startHour: 1, endHour: 6 } }));
    await h.auto.tick();
    h.state.hour = 8;
    await h.auto.tick(); // paused for the window
    expect(h.state.jobs.get('job-1').state).toBe('paused');
    const restart = () => createAutoConverter({ service: h.service, scanner: async function* s() {}, fs: fs.promises, pathApi: path,
      directory: path.join(h.root, 'auto'), now: () => h.state.time, hourOf: () => h.state.hour,
      timers: { setInterval: () => null, clearInterval: () => {} } });
    const again = restart();
    await again.start();
    await again.tick(); // let the start-up check settle
    h.state.hour = 2;
    await again.tick();
    expect(h.service.resume).toHaveBeenCalledWith('job-1');

    // Now the user pauses it themselves, then the app restarts inside the window.
    h.state.jobs.get('job-1').state = 'paused';
    h.service.resume.mockClear();
    const userPaused = restart();
    await userPaused.start();
    await userPaused.tick();
    await userPaused.tick();
    expect(h.service.resume).not.toHaveBeenCalled();
    h.cleanup();
  });

  test('gives up on a clip after it fails three automatic runs', async () => {
    const h = harness({ files: [clip('bad.mp4')] });
    await h.auto.start();
    await h.auto.configure(enabled());
    for (let run = 1; run <= 3; run += 1) {
      await h.auto.tick();
      h.finish(`job-${run}`, [{ ...clip('bad.mp4'), state: 'failed', failure: { code: 'x' } }]);
      await h.auto.tick();
      h.state.time += 61 * 60_000;
    }
    await h.auto.tick();
    expect(h.service.start).toHaveBeenCalledTimes(3);
    h.cleanup();
  });

  test('settings and the index survive a restart', async () => {
    const h = harness({ files: [clip('a.mp4')] });
    await h.auto.start();
    await h.auto.configure(enabled({ intervalMinutes: 180, keepRunning: true }));
    await h.auto.tick();
    h.finish('job-1', [{ ...clip('a.mp4'), state: 'completed' }]);
    await h.auto.tick();
    const again = createAutoConverter({ service: h.service, scanner: async function* s() {}, fs: fs.promises, pathApi: path,
      directory: path.join(h.root, 'auto'), timers: { setInterval: () => null, clearInterval: () => {} } });
    await again.start();
    expect(again.getState().settings).toMatchObject({ enabled: true, intervalMinutes: 180, keepRunning: true });
    expect(again.isKnown({ ...CONFIG, autoConvert: true }, clip('a.mp4'))).toBe(true);
    h.cleanup();
  });

  test('rejects invalid settings', async () => {
    const h = harness();
    await expect(h.auto.configure({ enabled: true, config: null })).rejects.toMatchObject({ code: 'AUTO_CONFIG_REQUIRED' });
    await expect(h.auto.configure(enabled({ window: { startHour: 3, endHour: 3 } }))).rejects.toMatchObject({ code: 'INVALID_AUTO_WINDOW' });
    h.cleanup();
  });
});
