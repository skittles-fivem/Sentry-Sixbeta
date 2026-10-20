'use strict';

// Classifies files under the footage root the same way Sentry Studio groups
// them: Tesla names clips YYYY-MM-DD_HH-MM-SS-<camera>.mp4 (vehicle-local
// time), and Sentry/Saved events live in YYYY-MM-DD_HH-MM-SS folders next to
// event.json / thumb.png.

const path = require('path');

const CLIP_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-([a-z0-9_]+)\.mp4$/i;
const EVENT_DIR_RE = /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})$/;
const DATE_DIR_RE = /^(\d{4}-\d{2}-\d{2})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const TYPE_BY_FOLDER = {
  recentclips: 'RecentClips',
  sentryclips: 'SentryClips',
  savedclips: 'SavedClips'
};

// Folders that are never descended into (NAS recycle bins, metadata, ours).
const SKIP_DIRS = new Set(['#recycle', '#snapshot', '$recycle.bin', 'system volume information', 'lost+found']);

// Files the converter owns while it works (src/main/converter/staging.js):
// never list, trash or delete them from the manager.
const CONVERTER_ARTIFACT_RE = /^(TEMP-H265-|TEMP-AV1-|BACKUP-)|\.sentry-six-[^/]*\.(partial|candidate|backup)$|^\.sentry-owned-remove-/;

function isValidDay(day) {
  if (!DAY_RE.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function shouldSkipDir(name) {
  if (!name || name.startsWith('.') || name.startsWith('@')) return true;
  return SKIP_DIRS.has(name.toLowerCase());
}

function clipTypeFor(segments) {
  for (const seg of segments) {
    const hit = TYPE_BY_FOLDER[seg.toLowerCase()];
    if (hit) return hit;
  }
  return 'Other';
}

function localDay(mtimeMs) {
  const d = new Date(mtimeMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Classify a path relative to the footage root.
 * Returns null for files the manager should ignore entirely, otherwise
 * { kind: 'clip' | 'asset', type, day, camera, eventId, encodable }.
 * `day` may be null when it can only come from the file's mtime.
 */
function classify(relPath) {
  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  const name = segments[segments.length - 1];
  if (!name || name.startsWith('.')) return null;
  const dirs = segments.slice(0, -1);
  const type = clipTypeFor(dirs);
  const parent = dirs[dirs.length - 1] || '';
  const eventMatch = parent.match(EVENT_DIR_RE);
  const eventId = eventMatch && isValidDay(eventMatch[1]) ? parent : null;
  const lower = name.toLowerCase();

  const clip = name.match(CLIP_RE);
  if (clip && isValidDay(clip[1])) {
    return { kind: 'clip', type, day: clip[1], camera: clip[3].toLowerCase(), eventId, encodable: true };
  }

  // Event assets (event.json, thumb.png, event.mp4) belong to their event's day.
  if (eventId && type !== 'Other') {
    return { kind: 'asset', type, day: eventId.slice(0, 10), camera: null, eventId, encodable: false };
  }

  if (!lower.endsWith('.mp4') || type === 'Other') return null;

  // Non-Tesla-named MP4 inside a Tesla clip folder: date folder, else mtime.
  const dateDir = [...dirs].reverse().find((d) => DATE_DIR_RE.test(d) && isValidDay(d));
  return { kind: 'clip', type, day: dateDir || null, camera: null, eventId, encodable: true };
}

/** Resolve a root-relative path and refuse anything that escapes the root. */
function safeJoin(root, relPath) {
  const abs = path.resolve(root, relPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error(`Path escapes footage root: ${relPath}`);
  }
  return abs;
}

function isConverterArtifact(name) {
  return CONVERTER_ARTIFACT_RE.test(name);
}

module.exports = {
  classify,
  clipTypeFor,
  isValidDay,
  localDay,
  safeJoin,
  shouldSkipDir,
  isConverterArtifact,
  EVENT_DIR_RE,
  TYPE_BY_FOLDER
};
