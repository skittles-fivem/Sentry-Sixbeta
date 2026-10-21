'use strict';

// Every path that comes from the browser, or that points into a share, is
// checked against the real (symlink-free) location of the allowed roots. A
// share is not trusted: its owner, or anyone who can tamper with it, could
// plant a symlink to /etc or /data. The scanner already skips symlinks; these
// helpers make sure no file API follows one out of its root either.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

function isInside(abs, root) {
  if (abs === root) return true;
  return abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** realpath(abs), or the realpath of its nearest existing ancestor plus the rest. */
async function realOrNearest(abs) {
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await fsp.realpath(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Real path of the file behind an open descriptor (Linux), or null when unknown. */
function fdPath(fd) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/**
 * Guard for a set of roots. resolve(p) answers the real path of p when it is
 * inside one of the roots after following every symlink, else null.
 * { mustExist: false } allows a path whose last parts do not exist yet.
 *
 * getRoots() lists strings or { path, within }: such a root only counts when
 * its real location is inside one of `within` (so a vehicle folder that is
 * itself a symlink to /etc allows nothing). `deny` lists folders that a path
 * may only reach through a root that itself lies inside them (the data dir
 * can be read through /data/converted, never through a root like /).
 */
function createRealGuard(getRoots, { deny = () => [] } = {}) {
  async function realOrNull(p) {
    try {
      return await fsp.realpath(p);
    } catch {
      return null;
    }
  }

  async function realRoots(abs) {
    const out = [];
    for (const entry of getRoots()) {
      if (!entry) continue;
      const r = path.resolve(typeof entry === 'string' ? entry : entry.path);
      const real = await realOrNull(r);
      if (!real) continue; // a root that does not exist allows nothing
      if (typeof entry === 'object' && Array.isArray(entry.within)) {
        const homes = (await Promise.all(entry.within.map((w) => realOrNull(path.resolve(w))))).filter(Boolean);
        if (!homes.some((h) => isInside(real, h))) continue;
      }
      if (abs === undefined || isInside(abs, r) || isInside(abs, real)) out.push(real);
    }
    return out;
  }

  async function allowedIn(real, roots) {
    const denied = (await Promise.all(deny().map(async (d) => (await realOrNull(d)) || path.resolve(d))));
    return roots.some((root) => isInside(real, root)
      && denied.every((d) => !isInside(real, d) || isInside(root, d)));
  }

  async function resolve(p, { mustExist = true } = {}) {
    if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) return null;
    const abs = path.resolve(p);
    const roots = await realRoots(abs);
    if (!roots.length) return null;
    let real;
    try {
      real = mustExist ? await fsp.realpath(abs) : await realOrNearest(abs);
    } catch {
      return null;
    }
    return (await allowedIn(real, roots)) ? real : null;
  }

  /** Is an already-open descriptor still inside a root? (catches a swap after resolve) */
  async function fdInside(fd) {
    const real = fdPath(fd);
    if (real === null) return true; // no /proc: resolve() already checked the path
    return allowedIn(real, await realRoots());
  }

  return { resolve, fdInside };
}

/**
 * Throws unless the parent folder of `target` really is inside `root` (both
 * after symlinks). Used right before a rename, unlink or mkdir on a share.
 */
async function assertParentInside(root, target) {
  const realRoot = await fsp.realpath(root);
  const parent = await realOrNearest(path.dirname(target));
  if (!isInside(parent, realRoot)) {
    throw Object.assign(new Error(`Refusing to follow a link out of the share: ${target}`), { code: 'ELINKESCAPE', status: 403 });
  }
}

module.exports = { createRealGuard, assertParentInside, isInside, realOrNearest, fdPath };
