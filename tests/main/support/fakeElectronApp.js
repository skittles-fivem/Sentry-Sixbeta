'use strict';

// Runs the real src/main.js against a recording stand-in for Electron, so the
// app's start-up, window, tray and single-instance behaviour can be tested
// without a display. Used by appStartup.test.js, one process per scenario.
//
//   node fakeElectronApp.js '<scenario json>'
//
// Prints one "EVENT {json}" line per observable action (window created,
// shown, hidden, closed; tray created; login item set; app quit) and a final
// summary line.

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const childProcess = require('child_process');
const { EventEmitter } = require('events');

const repo = path.resolve(__dirname, '..', '..', '..');
const scenario = JSON.parse(process.argv[2] || '{}');
const log = (event, detail = {}) => process.stdout.write(`EVENT ${JSON.stringify({ event, ...detail })}\n`);

// The converter needs FFmpeg to exist before the first window opens; answer
// its "-version" checks so these tests never depend on the machine's FFmpeg.
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function spawnSync(command, args, options) {
  if (/ff(mpeg|probe)(\.exe)?$/i.test(String(command)) && Array.isArray(args) && args.length === 1 && args[0] === '-version') {
    return { status: 0, stdout: 'ffmpeg version test', stderr: '', error: undefined };
  }
  return realSpawnSync.call(this, command, args, options);
};

const deepNoop = new Proxy(function noop() {}, {
  get: (_target, prop) => (prop === Symbol.toPrimitive ? () => '' : prop === 'then' ? undefined : deepNoop),
  apply: () => deepNoop, construct: () => deepNoop, set: () => true
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-startup-'));
const userData = path.join(root, 'userData');
fs.mkdirSync(userData, { recursive: true });
if (scenario.autoSettings) {
  fs.mkdirSync(path.join(userData, 'converter-auto'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'converter-auto', 'settings.json'), JSON.stringify(scenario.autoSettings));
}

let readyResolve;
const ready = new Promise((resolve) => { readyResolve = resolve; });
const app = new EventEmitter();
Object.assign(app, {
  isPackaged: true,
  whenReady: () => ready,
  isReady: () => true,
  requestSingleInstanceLock: () => scenario.lock !== false,
  getPath: (name) => {
    if (name === 'userData') return userData;
    const target = path.join(root, name);
    fs.mkdirSync(target, { recursive: true });
    return target;
  },
  getAppPath: () => repo,
  getVersion: () => '2026.0.0',
  getName: () => 'Sentry Studio',
  getLocale: () => 'en-US',
  getLoginItemSettings: () => ({ wasOpenedAsHidden: false }),
  setLoginItemSettings: (settings) => log('loginItem', settings),
  quit: () => { log('app.quit'); app.emit('before-quit', { preventDefault() {} }); },
  exit: (code) => log('app.exit', { code }),
  setAppUserModelId: () => {},
  commandLine: deepNoop,
  dock: deepNoop
});
const appProxy = new Proxy(app, { get: (target, prop) => (prop in target ? target[prop] : deepNoop) });

const windows = [];
class BrowserWindow extends EventEmitter {
  constructor(options) {
    super();
    this.id = windows.length + 1;
    this.visible = false;
    this.destroyed = false;
    windows.push(this);
    this.webContents = Object.assign(new EventEmitter(), {
      session: { webRequest: { onBeforeSendHeaders() {}, onHeadersReceived() {} } },
      send() {}, setWindowOpenHandler() {}, openDevTools() {}, isDestroyed: () => false
    });
    log('window.create', { id: this.id, show: options?.show });
  }
  loadFile() { setTimeout(() => this.emit('ready-to-show'), 50); return Promise.resolve(); }
  loadURL() { return this.loadFile(); }
  show() { this.visible = true; log('window.show', { id: this.id }); }
  hide() { this.visible = false; log('window.hide', { id: this.id }); }
  focus() {}
  restore() {}
  isMinimized() { return false; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  setMenuBarVisibility() {}
  setTitle() {}
  setIcon() {}
  maximize() {}
  isMaximized() { return false; }
  getBounds() { return { x: 0, y: 0, width: 1400, height: 900 }; }
  close() {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit('close', event);
    if (event.defaultPrevented) { log('window.close-prevented', { id: this.id }); return; }
    this.destroyed = true;
    log('window.closed', { id: this.id });
    this.emit('closed');
  }
  static getAllWindows() { return windows.filter((window) => !window.destroyed); }
  static getFocusedWindow() { return windows[0] || null; }
}

const trays = [];
const handlers = new Map();
class Tray extends EventEmitter {
  constructor() { super(); trays.push(this); log('tray.create'); }
  setToolTip() {}
  setContextMenu(menu) {
    this.menu = menu;
    if (scenario.trayOpenOnCreate) {
      setTimeout(() => { log('do-early', { step: 'tray-open', windows: windows.length }); menu.template[0].click(); }, 0);
    }
  }
  destroy() { log('tray.destroy'); }
}

const electron = {
  app: appProxy, BrowserWindow, Tray,
  Menu: { buildFromTemplate: (template) => ({ template }), setApplicationMenu() {} },
  nativeImage: { createFromPath: () => ({ resize() { return this; }, isEmpty: () => false }) },
  ipcMain: { handle(channel, fn) { handlers.set(channel, fn); }, on() {}, removeHandler(channel) { handlers.delete(channel); }, once() {} },
  dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: true }) },
  shell: deepNoop, autoUpdater: new EventEmitter(), screen: deepNoop, powerMonitor: new EventEmitter(),
  nativeTheme: deepNoop, session: deepNoop, protocol: deepNoop
};
const electronProxy = new Proxy(electron, { get: (target, prop) => (prop in target ? target[prop] : deepNoop) });
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return electronProxy;
  if (['electron-updater', 'pngjs', 'stream-chain'].includes(request) || request.startsWith('stream-json')) return deepNoop;
  return originalLoad.call(this, request, parent, isMain);
};

if (scenario.background) process.argv.push('--background');
console.log = () => {};
console.warn = () => {};
const errors = [];
console.error = (...parts) => errors.push(parts.map(String).join(' '));

require(path.join(repo, 'src', 'main.js'));
readyResolve();
for (const step of scenario.earlySteps || []) {
  setTimeout(() => {
    log('do-early', { step, windows: windows.length });
    if (step === 'second-instance') app.emit('second-instance', {}, [], repo);
  }, 0);
}

(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Wait until start-up has made its window (or decided not to).
  const deadline = Date.now() + (scenario.waitMs || 15_000);
  while (Date.now() < deadline && windows.length === 0 && scenario.lock !== false) await sleep(50);
  await sleep(scenario.settleMs || 1500);
  for (const step of scenario.steps || []) {
    log('do', { step });
    if (step === 'second-instance') app.emit('second-instance', {}, [], repo);
    if (step === 'close-window') windows.filter((window) => !window.destroyed).at(-1)?.close();
    if (step === 'activate') app.emit('activate');
    if (step === 'tray-open') trays.at(-1)?.menu?.template?.[0]?.click?.();
    if (step === 'tray-quit') {
      trays.at(-1)?.menu?.template?.find((entry) => entry.label === 'Quit')?.click?.();
      windows.filter((window) => !window.destroyed).forEach((window) => window.close());
    }
    if (step === 'quit-for-update') {
      electron.autoUpdater.emit('before-quit-for-update');
      windows.filter((window) => !window.destroyed).forEach((window) => window.close());
    }
    if (step === 'ipc-checks') {
      const sender = Object.assign(new EventEmitter(), { send() {}, isDestroyed: () => false });
      const call = async (channel, payload) => {
        try { return await handlers.get(channel)({ sender }, payload); } catch (error) { return { threw: error.code || String(error) }; }
      };
      const auto = await call('converter:getAuto');
      log('ipc.getAuto', { ok: auto?.ok, enabled: auto?.value?.settings?.enabled });
      const set = await call('converter:setAuto', { enabled: false, intervalMinutes: 180, window: { startHour: 22, endHour: 6 },
        keepRunning: true, openAtLogin: true, config: null });
      log('ipc.setAuto', { ok: set?.ok, interval: set?.value?.settings?.intervalMinutes, error: set?.error?.code });
      const bench = await call('converter:runBenchmark', { codecs: ['h265', 'vp9'] });
      log('ipc.benchmarkValidation', { ok: bench?.ok, error: bench?.error?.code });
      const badThumb = await call('thumbnails:get', 'relative.mp4');
      log('ipc.thumbnails', { relative: badThumb });
      log('ipc.channels', { converter: [...handlers.keys()].filter((channel) => channel.startsWith('converter:')).sort() });
    }
    await sleep(300);
  }
  log('summary', {
    windows: windows.length,
    alive: windows.filter((window) => !window.destroyed).length,
    visible: windows.filter((window) => window.visible && !window.destroyed).map((window) => window.id),
    trays: trays.length,
    errors: errors.filter((entry) => /AUTO|TypeError|ReferenceError|SyntaxError/.test(entry)).slice(0, 5)
  });
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
})();
