'use strict';

// Server side of the web viewer's window.electronAPI shim: the same file
// operations the desktop preload exposes (readDir, stat, ...), confined to
// the vehicle shares and the manager's own data folders, plus HTTP Range
// streaming of footage for <video> elements.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8'
};

function createPathGuard(getRoots) {
  return function resolveAllowed(p) {
    if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) return null;
    const abs = path.resolve(p);
    for (const root of getRoots()) {
      if (!root) continue;
      const r = path.resolve(root);
      if (abs === r || abs.startsWith(r + path.sep)) return abs;
    }
    return null;
  };
}

/** Paths that must never be read through the viewer: our bin and converter work files. */
function hiddenPath(abs) {
  return /[\\/]\.sentry-recycle-bin([\\/]|$)/.test(abs) || /\.binned$/.test(abs);
}

async function readDir(dirPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => !hiddenPath(path.join(dirPath, e.name)) && !/^(TEMP-H265-|TEMP-AV1-|BACKUP-)/.test(e.name) && !/\.sentry-six-.*\.partial$/.test(e.name))
    .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), path: path.join(dirPath, e.name) }));
}

async function stat(p) {
  try {
    const s = await fsp.stat(p);
    return { size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile(), mtime: s.mtime.toISOString() };
  } catch {
    return null;
  }
}

/** Stream a file with Range support. Converted files are replaced in place, so never cache. */
async function sendMedia(req, res, abs) {
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    res.writeHead(404);
    return res.end();
  }
  if (!st.isFile()) {
    res.writeHead(404);
    return res.end();
  }
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}-${st.ino.toString(36)}"`;
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ETag: etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = req.headers.range;
  const ifRange = req.headers['if-range'];
  if (range && (!ifRange || ifRange === etag)) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    if (m[1] === '') {
      start = Math.max(0, st.size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

module.exports = { createPathGuard, hiddenPath, readDir, stat, sendMedia, MIME };
