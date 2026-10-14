'use strict';

const { EventEmitter } = require('events');
const { createSmokeTest } = require('../../src/main/smokeTest');

function fakeApp() {
  const app = new EventEmitter();
  app.isPackaged = false;
  let quitted;
  app.quitted = new Promise((resolve) => { quitted = resolve; });
  app.quit = jest.fn(() => { app.emit('will-quit'); quitted(); });
  app.exit = jest.fn();
  return app;
}

function fakeWindow(checks = { failures: [] }) {
  const contents = new EventEmitter();
  contents.executeJavaScript = jest.fn(async () => checks);
  return { webContents: contents };
}

describe('automated launch check', () => {
  test('does nothing unless switched on', () => {
    expect(createSmokeTest({ app: fakeApp(), env: {} })).toBeNull();
  });

  test('runs the in-window checks after the page loads, writes the result and quits cleanly', async () => {
    const app = fakeApp();
    const writes = [];
    const smoke = createSmokeTest({ app, env: { SENTRY_STUDIO_SMOKE_TEST: '/tmp/result.json', SENTRY_STUDIO_SMOKE_SOURCE: '/clips' },
      writeFile: (_path, text) => writes.push(JSON.parse(text)) });
    const window = fakeWindow({ failures: [], status: 'Ready to configure' });
    smoke.attachWindow(window);
    window.webContents.emit('console-message', { level: 'error', message: 'tile failed', sourceId: 'map.js', lineNumber: 3 });
    window.webContents.emit('did-finish-load');
    await app.quitted; // the checks run 3 s after the page loads
    expect(window.webContents.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('"source":"/clips"'), true);
    expect(app.quit).toHaveBeenCalled();
    expect(writes.at(-1)).toMatchObject({ ok: true, reason: 'checked', quit: 'clean', errors: [], consoleErrors: ['tile failed (map.js:3)'] });
  });

  test('an uncaught renderer error or a failed check fails the launch', async () => {
    const app = fakeApp();
    const writes = [];
    const smoke = createSmokeTest({ app, env: { SENTRY_STUDIO_SMOKE_TEST: '/tmp/result.json' }, writeFile: (_path, text) => writes.push(JSON.parse(text)) });
    const window = fakeWindow({ failures: ['converter opens'] });
    smoke.attachWindow(window);
    // Older Electron passes positional values.
    window.webContents.emit('console-message', {}, 3, 'Uncaught ReferenceError: x is not defined', 10, 'app.js');
    window.webContents.emit('did-finish-load');
    await app.quitted; // the checks run 3 s after the page loads
    expect(writes.at(-1).ok).toBe(false);
    expect(writes.at(-1).errors).toEqual([
      'renderer: Uncaught ReferenceError: x is not defined (app.js:10)',
      'check: converter opens'
    ]);
  });

  test('a converter recovery dialog is reported instead of waiting for a click', async () => {
    const app = fakeApp();
    const writes = [];
    const smoke = createSmokeTest({ app, env: { SENTRY_STUDIO_SMOKE_TEST: '/tmp/result.json' }, writeFile: (_path, text) => writes.push(JSON.parse(text)) });
    const reply = await smoke.dialog.showMessageBox({ title: 'Converter recovery failed', message: 'Studio could not recover', cancelId: 1 });
    expect(reply).toEqual({ response: 1 });
    expect(writes.at(-1)).toMatchObject({ ok: false, reason: 'dialog', errors: ['dialog: Converter recovery failed: Studio could not recover'] });
    expect(app.quit).toHaveBeenCalled();
  });
});
