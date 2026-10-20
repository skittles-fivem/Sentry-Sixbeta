'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, isValidDay, safeJoin, shouldSkipDir, isConverterArtifact } = require('../server/footage');

test('classifies RecentClips by the Tesla filename date', () => {
  const c = classify('TeslaCam/RecentClips/2026-10-01_08-15-00-front.mp4');
  assert.deepEqual(c, { kind: 'clip', type: 'RecentClips', day: '2026-10-01', camera: 'front', eventId: null, encodable: true });
});

test('classifies Sentry event clips and their assets to the event day', () => {
  const clip = classify('TeslaCam/SentryClips/2026-10-01_23-59-30/2026-10-02_00-00-10-left_repeater.mp4');
  assert.equal(clip.type, 'SentryClips');
  assert.equal(clip.day, '2026-10-02', 'clips use their own filename date');
  assert.equal(clip.eventId, '2026-10-01_23-59-30');
  const json = classify('TeslaCam/SentryClips/2026-10-01_23-59-30/event.json');
  assert.equal(json.kind, 'asset');
  assert.equal(json.day, '2026-10-01');
  assert.equal(json.encodable, false);
  const preview = classify('SavedClips/2026-10-03_10-00-00/event.mp4');
  assert.equal(preview.kind, 'asset', 'event.mp4 is never re-encoded');
});

test('works without a TeslaCam root and with archive date folders', () => {
  assert.equal(classify('RecentClips/2026-09-30_10-00-00-back.mp4').type, 'RecentClips');
  const odd = classify('archive/RecentClips/2026-09-29/clip0001.mp4');
  assert.equal(odd.type, 'RecentClips');
  assert.equal(odd.day, '2026-09-29');
  assert.equal(classify('archive/RecentClips/clip.mp4').day, null, 'falls back to mtime later');
});

test('ignores files that are not Tesla footage', () => {
  assert.equal(classify('Music/song.mp3'), null);
  assert.equal(classify('Movies/holiday.mp4'), null, 'untagged mp4 outside clip folders is left alone');
  assert.equal(classify('TeslaCam/RecentClips/._2026-10-01_08-15-00-front.mp4'), null, 'AppleDouble files');
  assert.equal(classify('TeslaCam/notes.txt'), null);
  assert.equal(classify('TeslaCam/RecentClips/2026-13-01_08-15-00-front.mp4')?.day ?? null, null, 'invalid month');
  const other = classify('Exports/2026-10-01_08-15-00-front.mp4');
  assert.equal(other.type, 'Other', 'Tesla-named clips elsewhere still count');
});

test('validates days', () => {
  assert.equal(isValidDay('2026-02-28'), true);
  assert.equal(isValidDay('2026-02-30'), false);
  assert.equal(isValidDay('2026-1-01'), false);
  assert.equal(isValidDay('../../etc'), false);
});

test('safeJoin refuses to leave the root', () => {
  assert.equal(safeJoin('/footage', 'TeslaCam/a.mp4'), '/footage/TeslaCam/a.mp4');
  assert.throws(() => safeJoin('/footage', '../etc/passwd'));
  assert.throws(() => safeJoin('/footage', '/etc/passwd'));
  assert.throws(() => safeJoin('/footage', 'x/../../footage2/a'));
});

test('skips NAS system folders and hides converter work files', () => {
  for (const d of ['@eaDir', '#recycle', '$RECYCLE.BIN', '.Trash-1000', 'System Volume Information']) assert.equal(shouldSkipDir(d), true, d);
  assert.equal(shouldSkipDir('SentryClips'), false);
  for (const n of ['TEMP-H265-2026-10-01_08-15-00-front.mp4', 'TEMP-AV1-x.mp4', 'BACKUP-2026-10-01_08-15-00-front.mp4',
    '2026-10-01_08-15-00-front.mp4.sentry-six-job-item-abc.partial', '.sentry-owned-remove-0123']) assert.equal(isConverterArtifact(n), true, n);
  assert.equal(isConverterArtifact('2026-10-01_08-15-00-front.mp4'), false);
});

