import test from 'node:test';
import assert from 'node:assert/strict';
import { initViewerLayout } from '../../src/renderer/scripts/ui/viewerLayout.js';

function classList() {
  const set = new Set();
  return { set, contains: (n) => set.has(n), toggle(n, force) { const on = force ?? !set.has(n); if (on) set.add(n); else set.delete(n); return on; } };
}
function fakeEnv() {
  const props = {};
  const toggle = { checked: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  const doc = {
    body: { classList: classList() },
    documentElement: { style: { setProperty: (k, v) => { props[k] = v; } } },
    getElementById: (id) => (id === 'settingsTelemetryRail' ? toggle : null)
  };
  let resizes = 0;
  const win = { dispatchEvent: () => { resizes++; } };
  return { doc, win, toggle, props, resizes: () => resizes };
}

test('telemetry rail is on by default and turns off from the setting, saving the choice', async () => {
  const env = fakeEnv();
  const saved = {};
  const api = { getSetting: async (k) => saved[k], setSetting: async (k, v) => { saved[k] = v; return true; } };
  const layout = initViewerLayout({ api, doc: env.doc, win: env.win });
  await layout.ready;
  assert.equal(env.doc.body.classList.contains('fd-rail'), true);
  assert.equal(env.toggle.checked, true);
  assert.equal(env.resizes(), 0, 'nothing re-measures until the layout actually switches');

  env.toggle.checked = false;
  env.toggle.listeners.change();
  assert.equal(env.doc.body.classList.contains('fd-rail'), false);
  assert.equal(saved.telemetryRail, false);
  assert.equal(env.resizes(), 1, 'switching the rail asks the camera grid and map to re-measure');
});

test('a saved "off" choice is restored', async () => {
  const env = fakeEnv();
  const layout = initViewerLayout({ api: { getSetting: async () => false }, doc: env.doc, win: env.win });
  await layout.ready;
  assert.equal(env.doc.body.classList.contains('fd-rail'), false);
  assert.equal(layout.isEnabled(), false);
});
