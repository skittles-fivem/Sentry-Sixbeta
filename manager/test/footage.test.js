'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, isValidDay, safeJoin, shouldSkipDir, leftoverInfo } = require('../src/footage');
const { loadConfig } = require('../src/config');

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

test('skips NAS system folders and recognises our temp files', () => {
  for (const d of ['@eaDir', '#recycle', '$RECYCLE.BIN', '.Trash-1000', 'System Volume Information']) assert.equal(shouldSkipDir(d), true, d);
  assert.equal(shouldSkipDir('SentryClips'), false);
  assert.deepEqual(leftoverInfo('.2026-10-01_08-15-00-front.mp4.sentrymgr.tmp'), { original: '2026-10-01_08-15-00-front.mp4', kind: 'tmp' });
  assert.equal(leftoverInfo('.DS_Store'), null);
});

test('config defaults keep telemetry and use H.264', () => {
  const c = loadConfig({});
  assert.equal(c.port, 9000);
  assert.equal(c.encode.codec, 'h264');
  assert.equal(c.encode.preserveTelemetry, true);
  assert.equal(c.encode.encoder, 'auto');
  assert.deepEqual(c.encode.types, ['RecentClips', 'SentryClips', 'SavedClips', 'Other']);
  const h = loadConfig({ ENCODE_CODEC: 'HEVC', ENCODE_TYPES: 'sentryclips, savedclips,bogus', ENCODER: 'vaapi', PORT: '9100' });
  assert.equal(h.encode.codec, 'hevc');
  assert.equal(h.encode.quality, 28);
  assert.deepEqual(h.encode.types, ['SentryClips', 'SavedClips']);
  assert.equal(h.encode.encoder, 'vaapi');
  assert.equal(h.port, 9100);
});
