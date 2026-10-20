import test from 'node:test';
import assert from 'node:assert/strict';
import { seasonForDate, particleSpecs, initSeasonalTheme } from '../../src/renderer/scripts/ui/seasonalTheme.js';

test('maps dates to northern-hemisphere seasons at the solstice and equinox boundaries', () => {
  const at = (m, d) => seasonForDate(new Date(2026, m - 1, d));
  assert.equal(at(3, 19), 'winter');
  assert.equal(at(3, 20), 'spring');
  assert.equal(at(6, 21), 'summer');
  assert.equal(at(9, 22), 'autumn');
  assert.equal(at(10, 19), 'autumn');
  assert.equal(at(12, 21), 'winter');
  assert.equal(at(1, 1), 'winter');
});

test('effect levels cap the particle count and are deterministic', () => {
  assert.equal(particleSpecs('winter', 'full').length, 28);
  assert.equal(particleSpecs('winter', 'calm').length, 12);
  assert.equal(particleSpecs('winter', 'off').length, 0);
  assert.equal(particleSpecs('nonsense', 'full').length, 0);
  assert.deepEqual(particleSpecs('autumn', 'full'), particleSpecs('autumn', 'full'));
  assert.ok(particleSpecs('summer', 'full').every((spec) => spec.kind === 'firefly' && spec.top));
});

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(name) { this.set.add(name); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) { const on = force ?? !this.set.has(name); if (on) this.set.add(name); else this.set.delete(name); return on; }
}
class FakeNode {
  constructor(id) {
    this.id = id; this.children = []; this.classList = new FakeClassList(); this.dataset = {};
    this.listeners = {}; this.attributes = {};
    this.style = { setProperty() {} };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { this.children.push(...(child.isFragment ? child.children : [child])); return child; }
  replaceChildren() { this.children = []; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  dispatch(type) { this.listeners[type]?.(); }
}
function fakeDocument(ids) {
  const nodes = Object.fromEntries(ids.map((id) => [id, new FakeNode(id)]));
  const doc = {
    hidden: false, body: new FakeNode('body'), documentElement: new FakeNode('html'), listeners: {},
    getElementById: (id) => nodes[id] || doc.body.children.find((child) => child.id === id) || null,
    createElement: () => new FakeNode(),
    createDocumentFragment: () => Object.assign(new FakeNode(), { isFragment: true }),
    addEventListener(type, fn) { this.listeners[type] = fn; }
  };
  return { doc, nodes };
}

test('stays off until the user opts in, then follows the chosen season and saves each choice', async () => {
  const { doc, nodes } = fakeDocument(['dropOverlay', 'settingsSeasonalTheme', 'settingsSeasonalSeason', 'settingsSeasonalEffects',
    'settingsSeasonalSeasonRow', 'settingsSeasonalEffectsRow']);
  const saved = {};
  const api = { getSetting: async (key) => saved[key], setSetting: async (key, value) => { saved[key] = value; return true; } };
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try {
    const theme = initSeasonalTheme({ api, doc });
    await theme.ready;
    assert.equal(doc.documentElement.dataset.season, undefined);
    assert.equal(nodes.settingsSeasonalSeasonRow.classList.contains('hidden'), true);
    const layer = doc.getElementById('seasonalFx');
    assert.equal(layer.children.length, 0);

    nodes.settingsSeasonalTheme.checked = true;
    nodes.settingsSeasonalTheme.dispatch('change');
    assert.equal(saved.seasonalTheme, true);
    assert.equal(doc.documentElement.dataset.season, seasonForDate());
    assert.equal(nodes.settingsSeasonalSeasonRow.classList.contains('hidden'), false);

    nodes.settingsSeasonalSeason.value = 'winter';
    nodes.settingsSeasonalSeason.dispatch('change');
    assert.equal(doc.documentElement.dataset.season, 'winter');
    assert.equal(saved.seasonalThemeSeason, 'winter');
    assert.equal(layer.children.length, 28);

    nodes.settingsSeasonalEffects.value = 'off';
    nodes.settingsSeasonalEffects.dispatch('change');
    assert.equal(layer.children.length, 0);
    assert.equal(saved.seasonalThemeEffects, 'off');

    nodes.settingsSeasonalTheme.checked = false;
    nodes.settingsSeasonalTheme.dispatch('change');
    assert.equal(doc.documentElement.dataset.season, undefined);
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});

test('restores saved choices and ignores invalid stored values', async () => {
  const { doc } = fakeDocument([]);
  const stored = { seasonalTheme: true, seasonalThemeSeason: 'monsoon', seasonalThemeEffects: 'max' };
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try {
    const theme = initSeasonalTheme({ api: { getSetting: async (key) => stored[key] }, doc });
    await theme.ready;
    assert.equal(theme.state.season, 'auto');
    assert.equal(theme.state.effects, 'full');
    assert.equal(doc.documentElement.dataset.season, seasonForDate());
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
});
