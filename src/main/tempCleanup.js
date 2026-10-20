'use strict';

// Removes temporary files that an export left behind when the app crashed or
// was closed mid-export. Runs once at startup, before any export can start,
// and only touches names this app creates that are older than a day.

const fs = require('fs');
const path = require('path');

const LEFTOVER_PATTERNS = [
  /^dashboard(_[a-z_]+)?_.+_\d{10,}\.ass$/,
  /^minimap_.+_\d{10,}\.(ass|mov)$/,
  /^minimap_video_.+_\d{10,}\.mov$/,
  /^map_bg_.+_\d{10,}\.png$/,
  /^map_tiles_.+_\d{10,}$/,
  /^blur_mask_.+_\d{10,}\.png$/,
  /^export_[a-z_]+_\d{10,}\.txt$/,
  /^sentry-export-timing-[0-9a-f-]{36}\.mp4$/
];

const DAY_MS = 24 * 60 * 60 * 1000;

function isLeftoverName(name) {
  return LEFTOVER_PATTERNS.some((pattern) => pattern.test(name));
}

async function removeLeftoverTempFiles({ tempDir, fsApi = fs.promises, now = Date.now(), maxAgeMs = DAY_MS } = {}) {
  if (!tempDir) return { removed: 0, bytes: 0 };
  let names;
  try { names = await fsApi.readdir(tempDir); } catch (_) { return { removed: 0, bytes: 0 }; }
  let removed = 0;
  let bytes = 0;
  for (const name of names) {
    if (!isLeftoverName(name)) continue;
    const target = path.join(tempDir, name);
    try {
      const stat = await fsApi.lstat(target);
      if (stat.isSymbolicLink() || now - stat.mtimeMs < maxAgeMs) continue;
      await fsApi.rm(target, { recursive: stat.isDirectory(), force: true });
      removed += 1;
      bytes += stat.isFile() ? stat.size : 0;
    } catch (_) { /* in use or already gone */ }
  }
  if (removed) console.log(`[CLEANUP] Removed ${removed} leftover export file(s) (${Math.round(bytes / 1048576)} MB)`);
  return { removed, bytes };
}

module.exports = { removeLeftoverTempFiles, isLeftoverName };
