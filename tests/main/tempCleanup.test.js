'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { removeLeftoverTempFiles, isLeftoverName } = require('../../src/main/tempCleanup');

describe('startup temp cleanup', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-cleanup-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function make(name, { ageMs, folder = false } = {}) {
    const target = path.join(dir, name);
    if (folder) { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'tile.png'), 'x'); }
    else fs.writeFileSync(target, 'data');
    const when = (Date.now() - ageMs) / 1000;
    fs.utimesSync(target, when, when);
  }

  test('recognises only the export files this app creates', () => {
    expect(isLeftoverName('dashboard_exp1_1760000000000.ass')).toBe(true);
    expect(isLeftoverName('dashboard_tesla_mobile_date_exp1_1760000000000.ass')).toBe(true);
    expect(isLeftoverName('minimap_video_exp1_1760000000000.mov')).toBe(true);
    expect(isLeftoverName('map_tiles_exp1_1760000000000')).toBe(true);
    expect(isLeftoverName('blur_mask_exp1_front_1760000000000.png')).toBe(true);
    expect(isLeftoverName('export_left_repeater_1760000000000.txt')).toBe(true);
    expect(isLeftoverName('export_report.txt')).toBe(false);
    expect(isLeftoverName('dashboard.ass')).toBe(false);
    expect(isLeftoverName('sentry-six-verification-abc')).toBe(false);
  });

  test('removes day-old leftovers and keeps recent files and anything else', async () => {
    const day = 24 * 60 * 60 * 1000;
    make('dashboard_exp1_1760000000000.ass', { ageMs: 2 * day });
    make('map_tiles_exp1_1760000000000', { ageMs: 2 * day, folder: true });
    make('blur_mask_exp2_front_1760000000001.png', { ageMs: 60_000 });
    make('someone-elses-file.txt', { ageMs: 10 * day });

    const result = await removeLeftoverTempFiles({ tempDir: dir });

    expect(result.removed).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(['blur_mask_exp2_front_1760000000001.png', 'someone-elses-file.txt']);
  });

  test('does nothing when the temp folder cannot be read', async () => {
    await expect(removeLeftoverTempFiles({ tempDir: path.join(dir, 'missing') })).resolves.toEqual({ removed: 0, bytes: 0 });
  });
});
