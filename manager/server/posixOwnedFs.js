'use strict';

// Linux stand-in for the converter's Windows-only owned-file operations
// (src/main/converter/windowsOwnedCleanup.*). Same contract as that module:
// a file is only removed or renamed after its device, inode, size and
// SHA-256 match what the converter recorded, so a clip that was replaced or
// edited in the meantime is never touched.
//
// Linux has no "unlink if this is still the same file" call, so removal
// first renames the verified file to a private quarantine name and checks
// the inode again there before unlinking (and puts it back on a mismatch).
// Promotion uses renameat2(RENAME_NOREPLACE) via a tiny native helper; on SMB
// the CIFS client sends that as a server-side rename that never replaces.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_HELPER = '/usr/local/bin/noreplace-rename';
const HASH_CHUNK = 4 * 1024 * 1024;

function validPath(p) {
  return typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0');
}

function validExpected(expected) {
  return Boolean(expected) && /^\d+$/.test(String(expected.device)) && /^\d+$/.test(String(expected.inode))
    && Number.isSafeInteger(expected.size) && expected.size >= 0
    && /^[a-f0-9]{64}$/.test(String(expected.sha256));
}

function sameIdentity(st, expected) {
  return String(st.dev) === String(expected.device) && String(st.ino) === String(expected.inode);
}

function errorWithCode(message, code) {
  return Object.assign(new Error(message), { code });
}

async function hashHandle(fh, size) {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(Math.min(HASH_CHUNK, Math.max(1, size)));
  let position = 0;
  for (;;) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, position);
    if (bytesRead === 0) break;
    hash.update(buf.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { digest: hash.digest('hex'), bytes: position };
}

/**
 * Open without following links and prove it is the expected file.
 * Resolves { status: 'verified', fh, stat } | { status: 'missing' } | { status: 'mismatch' }.
 */
async function openVerified(target, expected) {
  let fh;
  try {
    fh = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing' };
    if (err.code === 'ELOOP') return { status: 'mismatch' };
    throw err;
  }
  try {
    const stat = await fh.stat({ bigint: true });
    if (!stat.isFile() || !sameIdentity(stat, expected) || Number(stat.size) !== expected.size) {
      await fh.close();
      return { status: 'mismatch' };
    }
    const { digest, bytes } = await hashHandle(fh, expected.size);
    if (bytes !== expected.size || digest !== expected.sha256) {
      await fh.close();
      return { status: 'mismatch' };
    }
    return { status: 'verified', fh, stat };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

function createNoReplaceRename({ helperPath = process.env.SENTRY_NOREPLACE_RENAME || DEFAULT_HELPER, timeoutMs = 60000 } = {}) {
  const available = fs.existsSync(helperPath);
  /** Resolves on success; rejects with err.code = the errno name. */
  async function rename(from, to) {
    if (!available) throw errorWithCode('noreplace-rename helper is not installed', 'ENOSYS');
    await new Promise((resolve, reject) => {
      execFile(helperPath, [from, to], { timeout: timeoutMs }, (err, stdout) => {
        if (!err) return resolve();
        const code = String(stdout || '').trim() || (err.killed ? 'ETIMEDOUT' : 'EIO');
        reject(errorWithCode(`rename ${from} -> ${to} failed: ${code}`, code));
      });
    });
  }
  return { rename, available };
}

function createPosixOwnedFs(options = {}) {
  const noReplace = options.noReplace || createNoReplaceRename(options);

  /** Move a file to `to` only if nothing exists there; falls back to link+unlink. */
  async function moveNoReplace(from, to) {
    try {
      await noReplace.rename(from, to);
      return;
    } catch (err) {
      // Filesystems without RENAME_NOREPLACE support report EINVAL / ENOSYS.
      if (!['EINVAL', 'ENOSYS', 'EOPNOTSUPP'].includes(err.code)) throw err;
    }
    await fsp.link(from, to); // EEXIST if taken: never replaces
    await fsp.unlink(from);
  }

  const removeOwned = Object.freeze({
    atomicOwnershipCheck: true,
    guardedRemoval: true,
    async remove({ target, expected, guard } = {}) {
      if (!validPath(target) || !validExpected(expected)
          || (guard !== undefined && (!guard || !validPath(guard.target) || !validExpected(guard.expected)))) {
        return { removed: false, ownershipMismatch: true };
      }
      let guarded = null;
      let victim = null;
      try {
        if (guard) {
          guarded = await openVerified(guard.target, guard.expected);
          if (guarded.status !== 'verified') return { removed: false, ownershipMismatch: true, guardMismatch: true };
          await guarded.fh.sync();
        }
        victim = await openVerified(target, expected);
        if (victim.status === 'missing') return { removed: false, missing: true };
        if (victim.status !== 'verified') return { removed: false, ownershipMismatch: true };

        const quarantine = path.join(path.dirname(target), `.sentry-owned-remove-${crypto.randomBytes(8).toString('hex')}`);
        await moveNoReplace(target, quarantine);
        const moved = await fsp.lstat(quarantine, { bigint: true });
        if (!moved.isFile() || moved.dev !== victim.stat.dev || moved.ino !== victim.stat.ino) {
          // Something replaced the path between the check and the rename: put it back.
          await moveNoReplace(quarantine, target).catch(() => {});
          return { removed: false, ownershipMismatch: true };
        }
        if (guarded) {
          const finalNow = await fsp.lstat(guard.target, { bigint: true }).catch(() => null);
          if (!finalNow || finalNow.dev !== guarded.stat.dev || finalNow.ino !== guarded.stat.ino) {
            await moveNoReplace(quarantine, target).catch(() => {});
            return { removed: false, ownershipMismatch: true, guardMismatch: true };
          }
        }
        await fsp.unlink(quarantine);
        return { removed: true };
      } finally {
        await victim?.fh?.close().catch(() => {});
        await guarded?.fh?.close().catch(() => {});
      }
    }
  });

  const renameExclusive = Object.freeze({
    atomicNoReplace: true,
    atomicExpectedOwnership: true,
    async promote({ from, to, expectedSource, removeSource = false } = {}) {
      if (!validPath(from) || !validPath(to) || path.resolve(from) === path.resolve(to)) {
        throw errorWithCode('Promotion requires two distinct absolute paths.', 'ENOTSUP');
      }
      if (!removeSource) {
        // Keep the source: publish a hard link, exactly like the desktop default.
        const st = await fsp.lstat(from, { bigint: true });
        if (!st.isFile() || !expectedSource || !sameIdentity(st, expectedSource) || Number(st.size) !== expectedSource.size) {
          return { atomicNoReplace: true, sourceRemoved: false, ownershipMismatch: true };
        }
        await fsp.link(from, to);
        return { atomicNoReplace: true, sourceRemoved: false };
      }
      if (!validExpected(expectedSource)) return { atomicNoReplace: true, sourceRemoved: false, ownershipMismatch: true };
      const source = await openVerified(from, expectedSource);
      if (source.status === 'missing') throw errorWithCode('Source is missing.', 'ENOENT');
      if (source.status !== 'verified') return { atomicNoReplace: true, sourceRemoved: false, ownershipMismatch: true };
      try {
        await moveNoReplace(from, to);
        const landed = await fsp.lstat(to, { bigint: true });
        if (landed.dev !== source.stat.dev || landed.ino !== source.stat.ino) {
          await moveNoReplace(to, from).catch(() => {});
          return { atomicNoReplace: true, sourceRemoved: false, ownershipMismatch: true };
        }
        return { atomicNoReplace: true, sourceRemoved: true };
      } finally {
        await source.fh.close().catch(() => {});
      }
    }
  });

  return { removeOwned, renameExclusive, helperAvailable: noReplace.available !== false };
}

module.exports = { createPosixOwnedFs, createNoReplaceRename, openVerified };
