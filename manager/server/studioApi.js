'use strict';

// Server side of the web viewer's window.electronAPI shim: the same file
// operations the desktop preload exposes (readDir, stat, ...), confined to
// the vehicle shares and the manager's own data folders, plus HTTP Range
// streaming of footage for <video> elements. Callers resolve paths with
// safePath's real-path guard first; files are opened without following a
// final symlink and checked again through the open descriptor.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MIME = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8'
};

/** Paths that must never be read through the viewer: our bin and converter work files. */
function hiddenPath(abs) {
  return /[\\/]\.sentry-recycle-bin([\\/]|$)/.test(abs) || /\.binned$/.test(abs);
}

async function readDir(dirPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  return entries
    // symlinks are left out: they could point anywhere in the container
    .filter((e) => !e.isSymbolicLink() && !hiddenPath(path.join(dirPath, e.name)) && !/^(TEMP-H265-|TEMP-AV1-|BACKUP-)/.test(e.name) && !/\.sentry-six-.*\.partial$/.test(e.name))
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

/**
 * Open a regular file for reading without following a symlink at the last
 * step, and make sure the descriptor is still inside the roots.
 */
async function openConfined(abs, fdInside) {
  let fh;
  try {
    fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || !(await fdInside(fh.fd))) {
      await fh.close();
      return null;
    }
    return { fh, st };
  } catch {
    await fh.close().catch(() => {});
    return null;
  }
}

async function readTextConfined(abs, fdInside, maxBytes) {
  const opened = await openConfined(abs, fdInside);
  if (!opened) return null;
  try {
    if (opened.st.size > maxBytes) return null;
    return await opened.fh.readFile('utf8');
  } finally {
    await opened.fh.close().catch(() => {});
  }
}

/** Stream a file with Range support. Converted files are replaced in place, so never cache. */
async function sendMedia(req, res, abs, fdInside = async () => true) {
  const opened = await openConfined(abs, fdInside);
  if (!opened) {
    res.writeHead(404);
    return res.end();
  }
  const { fh, st } = opened;
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
      await fh.close().catch(() => {});
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
      await fh.close().catch(() => {});
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) {
    await fh.close().catch(() => {});
    return res.end();
  }
  // the stream reads from the descriptor that was checked, never the path again
  const stream = fh.createReadStream({ start, end, autoClose: true });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
  return undefined;
}

module.exports = { hiddenPath, readDir, stat, sendMedia, openConfined, readTextConfined, MIME };
