'use strict';

// Start-up, window, tray and single-instance behaviour of the real main
// process (src/main.js), run against a stand-in for Electron. Each scenario
// runs in its own process because main.js keeps app-wide state.

const path = require('path');
const { execFile } = require('child_process');

jest.setTimeout(120_000);

const RUNNER = path.join(__dirname, 'support', 'fakeElectronApp.js');
const CONFIG = {
  sourceRoot: path.join(__dirname, 'no-such-source'), destinationRoot: path.join(__dirname, 'no-such-destination'),
  codec: 'h265', profileId: 'balanced', networkMode: 'auto', outputMode: 'separate',
  includedGroups: ['RecentClips'], replacementConfirmed: false
};
const auto = (overrides) => ({ enabled: true, intervalMinutes: 60, window: null, keepRunning: false, openAtLogin: false, config: CONFIG, ...overrides });

function runScenario(scenario) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [RUNNER, JSON.stringify(scenario)], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const events = String(stdout).split(/\r?\n/).filter((line) => line.startsWith('EVENT '))
        .map((line) => JSON.parse(line.slice(6)));
      const summary = events.find((entry) => entry.event === 'summary');
      if (!summary) {
        reject(new Error(`scenario produced no summary (${error?.message || 'no error'}): ${String(stderr).slice(-2000)}`));
        return;
      }
      resolve({ events, summary, names: events.map((entry) => entry.event) });
    });
  });
}

const scenarios = {
  signInNoBackground: { background: true, autoSettings: auto({ openAtLogin: true }) },
  signInBackground: { background: true, autoSettings: auto({ keepRunning: true, openAtLogin: true }) },
  closeHidesTrayOpens: { autoSettings: auto({ keepRunning: true }), steps: ['close-window', 'tray-open'] },
  secondCopy: { lock: false },
  secondLaunch: { steps: ['second-instance'] },
  updateInstall: { autoSettings: auto({ keepRunning: true }), steps: ['quit-for-update'] },
  dockClick: { autoSettings: auto({ keepRunning: true }), steps: ['close-window', 'activate'] },
  normalLaunchBackground: { autoSettings: auto({ keepRunning: true }) },
  secondLaunchDuringStart: { background: true, autoSettings: auto({ keepRunning: true, openAtLogin: true }), earlySteps: ['second-instance'] },
  trayOpenDuringStart: { background: true, autoSettings: auto({ keepRunning: true, openAtLogin: true }), trayOpenOnCreate: true },
  autoOffLoginItem: { autoSettings: auto({ enabled: false, keepRunning: true, openAtLogin: true }) },
  trayQuit: { autoSettings: auto({ keepRunning: true }), steps: ['tray-quit'] },
  ipc: { steps: ['ipc-checks'] }
};

describe('app start-up and background mode (real main process)', () => {
  const results = {};
  beforeAll(async () => {
    // Run every scenario in parallel: each is its own process.
    const entries = await Promise.all(Object.entries(scenarios).map(async ([name, scenario]) => [name, await runScenario(scenario)]));
    for (const [name, result] of entries) results[name] = result;
  });

  test('no scenario logs a programming error', () => {
    for (const [name, result] of Object.entries(results)) {
      expect({ name, errors: result.summary.errors }).toEqual({ name, errors: [] });
    }
  });

  test('a sign-in launch without background mode opens one window and shows it', () => {
    expect(results.signInNoBackground.summary).toMatchObject({ windows: 1, visible: [1], trays: 0 });
  });

  test('a sign-in launch with background mode stays in the tray with one hidden window', () => {
    expect(results.signInBackground.summary).toMatchObject({ windows: 1, alive: 1, visible: [], trays: 1 });
  });

  test('with background mode, closing hides the window and the tray brings the same window back', () => {
    const { summary, names } = results.closeHidesTrayOpens;
    expect(names).toEqual(expect.arrayContaining(['window.hide', 'window.close-prevented']));
    expect(summary).toMatchObject({ windows: 1, alive: 1, visible: [1], trays: 1 });
  });

  test('a second copy of the app quits without opening a window', () => {
    expect(results.secondCopy.names).toContain('app.quit');
    expect(results.secondCopy.summary).toMatchObject({ windows: 0 });
  });

  test('a second launch brings the existing window forward', () => {
    expect(results.secondLaunch.summary).toMatchObject({ windows: 1, visible: [1] });
  });

  test('installing an update closes a window that background mode would otherwise hide', () => {
    expect(results.updateInstall.names).toContain('window.closed');
    expect(results.updateInstall.summary).toMatchObject({ alive: 0 });
  });

  test('the macOS Dock icon shows a window hidden to the tray', () => {
    expect(results.dockClick.summary).toMatchObject({ windows: 1, visible: [1] });
  });

  test('a normal launch with background mode shows the window and the tray', () => {
    expect(results.normalLaunchBackground.summary).toMatchObject({ windows: 1, visible: [1], trays: 1 });
  });

  test('a second launch while the app is still starting is not lost', () => {
    const { summary, events } = results.secondLaunchDuringStart;
    expect(events.find((entry) => entry.event === 'do-early')).toMatchObject({ windows: 0 });
    expect(summary).toMatchObject({ windows: 1, visible: [1] });
  });

  test('the tray Open item works while the app is still starting', () => {
    expect(results.trayOpenDuringStart.summary).toMatchObject({ windows: 1, visible: [1] });
  });

  test('start at sign-in is only registered while automatic conversion is on, once per change', () => {
    const on = results.signInBackground.events.filter((entry) => entry.event === 'loginItem');
    expect(on).toHaveLength(1);
    expect(on[0]).toMatchObject({ openAtLogin: true, openAsHidden: true, args: ['--background'] });
    const off = results.autoOffLoginItem.events.filter((entry) => entry.event === 'loginItem');
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ openAtLogin: false });
    expect(results.autoOffLoginItem.summary).toMatchObject({ trays: 0, visible: [1] });
  });

  test('Quit in the tray really quits', () => {
    const { names, summary } = results.trayQuit;
    expect(names).toEqual(expect.arrayContaining(['app.quit', 'window.closed']));
    expect(summary).toMatchObject({ alive: 0 });
  });

  test('the converter IPC channels are registered and validate their input', () => {
    const { events } = results.ipc;
    const get = (name) => events.find((entry) => entry.event === name);
    expect(get('ipc.getAuto')).toMatchObject({ ok: true, enabled: false });
    expect(get('ipc.setAuto')).toMatchObject({ ok: true, interval: 180 });
    expect(get('ipc.benchmarkValidation')).toMatchObject({ ok: false });
    expect(get('ipc.thumbnails')).toMatchObject({ relative: null });
    expect(get('ipc.channels').converter).toEqual(expect.arrayContaining([
      'converter:start', 'converter:getCurrent', 'converter:pause', 'converter:resume', 'converter:cancel',
      'converter:runBenchmark', 'converter:cancelBenchmark', 'converter:getAuto', 'converter:setAuto', 'converter:checkAutoNow'
    ]));
  });
});
