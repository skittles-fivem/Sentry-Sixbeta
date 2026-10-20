'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { scanFootage, summarizeDays, encodeState } = require('../src/scanner');
const { purgeDays } = require('../src/purge');
const { StateDB } = require('../src/db');
const { tmpDir, makeTeslaTree, writeFile, rmrf } = require('./helpers/fixtures');

const DAYS = ['2026-10-01', '2026-10-02', '2026-10-03'];

async function setup() {
  const dir = await tmpDir();
  const root = path.join(dir, 'footage');
  await makeTeslaTree(root, DAYS, { size: 1000 });
  // things the manager must never count or touch
  await writeFile(path.join(root, 'Music/song.mp3'), { size: 50 });
  await writeFile(path.join(root, 'TeslaCam/notes.txt'), { size: 50 });
  await writeFile(path.join(root, '@eaDir/2026-10-01_08-00-00-front.mp4'), { size: 50 });
  await writeFile(path.join(root, 'TeslaCam/RecentClips/._2026-10-01_08-00-00-front.mp4'), { size: 50 });
  await writeFile(path.join(root, 'TeslaCam/RecentClips/.2026-10-01_08-00-00-back.mp4.sentrymgr.tmp'), { size: 50 });
  return { dir, root };
}

test('scan finds Tesla footage only, grouped by day', async () => {
  const { dir, root } = await setup();
  try {
    const res = await scanFootage(root, { concurrency: 4 });
    assert.equal(res.errors.length, 0);
    // per day: 4 recent + 4 sentry + 2 assets + 1 saved + 1 asset
    assert.equal(res.files.size, DAYS.length * 12);
    assert.deepEqual(res.leftovers.map((l) => l.kind), ['tmp']);
    const days = summarizeDays(res.files, new Map());
    assert.deepEqual(days.map((d) => d.day), DAYS, 'oldest first');
    const d = days[0];
    assert.equal(d.files, 12);
    assert.equal(d.clips, 9);
    assert.equal(d.events, 2);
    assert.equal(d.byType.RecentClips.files, 4);
    assert.equal(d.byType.SentryClips.files, 6);
    assert.equal(d.byType.SavedClips.files, 2);
    assert.equal(d.bytes, 9 * 1000 + 120 + 300 + 120);
    assert.equal(d.encode.pending, 9);
  } finally {
    rmrf(dir);
  }
});

test('encodeState trusts the DB only while size and mtime match', () => {
  const file = { rel: 'a.mp4', size: 10, mtimeMs: 1000.7, encodable: true };
  assert.equal(encodeState(file, undefined), 'pending');
  assert.equal(encodeState(file, { size: 10, mtimeMs: 1000, status: 'encoded' }), 'encoded');
  assert.equal(encodeState(file, { size: 11, mtimeMs: 1000, status: 'encoded' }), 'pending');
  assert.equal(encodeState(file, { size: 10, mtimeMs: 1000, status: 'failed', attempts: 1 }, 3), 'pending');
  assert.equal(encodeState(file, { size: 10, mtimeMs: 1000, status: 'failed', attempts: 3 }, 3), 'failed');
  assert.equal(encodeState({ ...file, encodable: false }, undefined), null);
});

test('purge deletes the chosen days, tidies event folders, and nothing else', async () => {
  const { dir, root } = await setup();
  const db = new StateDB(':memory:');
  try {
    const res = await scanFootage(root);
    for (const f of res.files.values()) db.upsertFile({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs, status: 'encoded' });
    // Finder junk inside an event folder should not keep it alive
    await writeFile(path.join(root, 'TeslaCam/SentryClips/2026-10-01_12-30-00/.DS_Store'), { size: 10 });

    const out = await purgeDays({ root, files: res.files, days: ['2026-10-01', '2026-10-02'], db });
    assert.equal(out.deletedFiles, 24);
    assert.equal(out.errors.length, 0);
    assert.equal(out.freedBytes, 2 * (9 * 1000 + 540));
    assert.ok(!fs.existsSync(path.join(root, 'TeslaCam/SentryClips/2026-10-01_12-30-00')), 'event folder removed');
    assert.ok(!fs.existsSync(path.join(root, 'TeslaCam/SavedClips/2026-10-02_18-00-00')));
    for (const keep of ['TeslaCam/RecentClips', 'TeslaCam/SentryClips', 'TeslaCam/SavedClips', 'Music/song.mp3', 'TeslaCam/notes.txt',
      'TeslaCam/RecentClips/2026-10-03_08-00-00-front.mp4', 'TeslaCam/SentryClips/2026-10-03_12-30-00/event.json']) {
      assert.ok(fs.existsSync(path.join(root, keep)), `kept ${keep}`);
    }
    assert.equal(res.files.size, 12, 'index updated in place');
    assert.equal(db.allFiles().size, 12, 'DB records dropped for deleted files');
    assert.equal(db.recentHistory(1)[0].status, 'purged');
  } finally {
    db.close();
    rmrf(dir);
  }
});

test('purge can keep SavedClips', async () => {
  const { dir, root } = await setup();
  try {
    const res = await scanFootage(root);
    const out = await purgeDays({ root, files: res.files, days: ['2026-10-03'], types: ['RecentClips', 'SentryClips'] });
    assert.equal(out.deletedFiles, 10);
    assert.ok(fs.existsSync(path.join(root, 'TeslaCam/SavedClips/2026-10-03_18-00-00/2026-10-03_17-59-00-front.mp4')));
    assert.ok(!fs.existsSync(path.join(root, 'TeslaCam/SentryClips/2026-10-03_12-30-00')));
  } finally {
    rmrf(dir);
  }
});

test('purge rejects bad input', async () => {
  await assert.rejects(purgeDays({ root: '/nonexistent', files: new Map(), days: ['../etc'] }), /No valid days/);
  await assert.rejects(purgeDays({ root: '/nonexistent', files: new Map(), days: ['2026-10-01'], types: ['Nope'] }), /No clip types/);
});

test('state DB round-trips records, totals, settings and history', async () => {
  const dir = await tmpDir();
  const db = new StateDB(path.join(dir, 'state.db'));
  try {
    db.upsertFile({ rel: 'a.mp4', size: 50, mtimeMs: 123.9, status: 'encoded', originalSize: 100, encodedSize: 50, codec: 'h264', encoder: 'libx264' });
    db.upsertFile({ rel: 'b.mp4', size: 10, mtimeMs: 1, status: 'failed', reason: 'x', attempts: 2 });
    assert.equal(db.getFile('a.mp4').mtimeMs, 123);
    assert.deepEqual(db.totals(), { encoded: 1, skipped: 0, failed: 1, originalBytes: 100, encodedBytes: 50 });
    assert.equal(db.resetFailed(), 1);
    assert.equal(db.pruneMissing(new Set()), 1);
    db.setSetting('encodePaused', true);
    assert.equal(db.getSetting('encodePaused'), true);
    for (let i = 0; i < 1005; i++) db.addHistory({ status: 'encoded', rel: `f${i}` });
    assert.equal(db.recentHistory(2000).length, 1000);
    assert.equal(db.recentHistory(1)[0].rel, 'f1004');
  } finally {
    db.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
