'use strict';

// Keeps a vehicle's footage share available. For an SMB vehicle the
// container mounts the share itself (through a mounter: the root supervisor
// does the actual mount.cifs, see mounter.js and mountSpec.js), watches it,
// and remounts if the NAS drops. A folder vehicle is whatever the user
// mounted into the container and is only health-checked.

const { EventEmitter } = require('events');
const fsp = require('fs/promises');
const path = require('path');
const { tail } = require('./proc');

const CHECK_INTERVAL_MS = 30 * 1000;
const WRITE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const FS_TIMEOUT_MS = 15 * 1000;
const NETWORK_FS = new Set(['cifs', 'smb3', 'smbfs', 'nfs', 'nfs4', 'fuse.sshfs']);

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms / 1000}s (share not responding)`), { code: 'ETIMEDOUT' })), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function unescapeMountPath(p) {
  return p.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/** Topmost mount at exactly `mountPoint`, from /proc/self/mountinfo text. */
function findMount(mountinfo, mountPoint) {
  let found = null;
  for (const line of String(mountinfo).split('\n')) {
    if (!line.trim()) continue;
    const sep = line.indexOf(' - ');
    if (sep === -1) continue;
    const left = line.slice(0, sep).split(' ');
    const right = line.slice(sep + 3).split(' ');
    if (unescapeMountPath(left[4] || '') !== mountPoint) continue;
    found = { mountPoint, fsType: right[0], source: unescapeMountPath(right[1] || ''), options: right[2] || '' };
  }
  return found;
}

/** Map mount.cifs errors to something a person can act on. */
function explainMountError(output) {
  const s = String(output || '');
  const code = Number((s.match(/mount error\((\d+)\)/) || [])[1]);
  if (/unknown filesystem type|No such device|cifs filesystem not supported/i.test(s) || code === 19) {
    return 'The Docker host kernel has no CIFS support. On the host run: sudo modprobe cifs (and install cifs-utils).';
  }
  if (code === 1 || /Operation not permitted|only root|Unable to apply new capability set/i.test(s)) {
    return 'The container is not allowed to mount. Add cap_add: [SYS_ADMIN, DAC_READ_SEARCH] (see docker-compose.yml).';
  }
  if (code === 13 || /Permission denied/i.test(s)) {
    return 'Permission denied: the server rejected the user name or password (check them and the Domain field), or on AppArmor hosts (Ubuntu) the container needs security_opt: apparmor:unconfined.';
  }
  if (code === 2) return 'The share was not found on the server. It must look like //server/share (optionally //server/share/folder).';
  if (code === 112) return 'Server unreachable, or it does not speak SMB 3. Check the address; on the NAS, set the minimum SMB version to SMB 3 (SMB 1/2 are not allowed here).';
  if (code === 95 || code === 5) return 'The server refused an encrypted SMB 3 session. On the NAS turn on SMB 3 encryption (Synology: Control Panel > File Services > SMB > Advanced; Samba: server smb encrypt = desired), or pick SMB 3.0 if it does not offer 3.1.1. Turning encryption off for this vehicle keeps signing, but lets others on the network see the footage.';
  if (code === 22) return 'The server rejected a mount option. If the NAS does not support SMB 3.1.1, choose SMB 3.0 for this vehicle.';
  if (code === 113 || code === 111 || code === 110 || /timed out|No route|refused/i.test(s)) {
    return 'Could not reach the SMB server. Check the IP/hostname and that port 445 is open from the Docker host.';
  }
  if (/resolve|bad UNC|could not resolve/i.test(s)) {
    return 'Could not resolve the server name. Use the NAS IP address in SMB_SHARE (//192.168.1.10/share).';
  }
  if (code === 16) return 'Mount point is busy (something is already mounted there).';
  return null;
}

class ShareManager extends EventEmitter {
  constructor({ config, log, mounter = null, mountinfoPath = '/proc/self/mountinfo', id = 'default' }) {
    super();
    this.config = config;
    this.id = id;
    this.root = config.footagePath;
    this.smb = config.smb || { share: '' };
    this.log = log;
    this.mounter = mounter;
    this.mountinfoPath = mountinfoPath;
    this.mode = this.smb.share ? 'smb' : 'local';
    if (this.mode === 'smb' && !mounter) throw new Error('An SMB vehicle needs a mounter.');
    this.mountedByUs = false;
    this.failures = 0;
    this.nextMountAt = 0;
    this.backoffMs = CHECK_INTERVAL_MS;
    this.chain = Promise.resolve();
    this.state = {
      mode: this.mode,
      share: this.smb.share || null,
      path: this.root,
      healthy: false,
      mounted: false,
      fsType: null,
      source: null,
      readable: false,
      writable: null,
      renameOverwrite: null,
      totalBytes: null,
      freeBytes: null,
      lastError: null,
      hint: null,
      warning: null,
      checkedAt: null,
      writeCheckedAt: null,
      mountedAt: null
    };
  }

  /** Serialize all mount/check work. */
  queue(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  async start() {
    await this.ensure({ forceWriteCheck: true });
    this.timer = setInterval(() => this.ensure().catch(() => {}), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  ensure({ forceWriteCheck = false } = {}) {
    return this.queue(async () => {
      const mount = await this.currentMount();
      if (this.mode === 'smb') {
        const isSmb = mount && /^(cifs|smb3)$/.test(mount.fsType);
        if (!isSmb) {
          if (Date.now() >= this.nextMountAt) {
            const ok = await this.mount();
            forceWriteCheck = forceWriteCheck || ok;
          }
        }
      }
      await this.checkHealth({ forceWriteCheck });
      if (this.mode === 'smb' && this.state.mounted && !this.state.readable) {
        this.failures++;
        if (this.failures >= 2 && Date.now() >= this.nextMountAt) {
          this.log.warn('Share stopped responding; remounting.');
          await this.unmount({ lazy: true });
          if (await this.mount()) await this.checkHealth({ forceWriteCheck: true });
        }
      } else if (this.state.readable) {
        this.failures = 0;
      }
      return this.status();
    });
  }

  reconnect() {
    return this.queue(async () => {
      this.nextMountAt = 0;
      this.backoffMs = CHECK_INTERVAL_MS;
      if (this.mode === 'smb') {
        await this.unmount({ lazy: true });
        await this.mount();
      }
      await this.checkHealth({ forceWriteCheck: true });
      return this.status();
    });
  }

  async currentMount() {
    try {
      return findMount(await fsp.readFile(this.mountinfoPath, 'utf8'), this.root);
    } catch {
      return null;
    }
  }

  async mount() {
    const smb = this.smb;
    this.log.info(`Mounting ${smb.share} at ${this.root} (SMB ${smb.version}, ${smb.encrypt === false ? 'signed' : 'encrypted'}, user ${smb.username})`);
    let res;
    try {
      res = await this.mounter.mount(this.id, smb);
    } catch (err) {
      res = { code: -1, output: err.message };
    }
    if (res.code === 0) {
      this.mountedByUs = true;
      this.backoffMs = CHECK_INTERVAL_MS;
      this.nextMountAt = 0;
      this.state.mountedAt = Date.now();
      this.state.lastError = null;
      this.state.hint = null;
      this.log.info(`Mounted ${smb.share}`);
      return true;
    }
    const output = String(res.output || '');
    const message = res.notFound
      ? 'mount command not found (cifs-utils is missing from the image).'
      : res.timedOut ? 'mount timed out (server not answering on port 445?)' : tail(output, 3) || `mount exited with ${res.code}`;
    this.fail(`Mount failed: ${message}`, explainMountError(output));
    this.nextMountAt = Date.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 10 * 60 * 1000);
    return false;
  }

  async unmount({ lazy = false } = {}) {
    if (this.mode !== 'smb') return;
    const mount = await this.currentMount();
    if (!mount) return;
    const res = await this.mounter.unmount(this.id, { lazy });
    if (res.code !== 0) this.log.warn(`umount failed: ${res.output || res.code}`);
    this.mountedByUs = false;
  }

  fail(message, hint) {
    if (this.state.lastError !== message) this.log.error(message + (hint ? ` Hint: ${hint}` : ''));
    this.state.lastError = message;
    this.state.hint = hint;
  }

  async checkHealth({ forceWriteCheck = false } = {}) {
    const st = this.state;
    const mount = await this.currentMount();
    st.mounted = Boolean(mount);
    st.fsType = mount?.fsType || null;
    st.source = mount?.source || null;
    st.checkedAt = Date.now();
    st.warning = null;

    try {
      await withTimeout(fsp.readdir(this.root), FS_TIMEOUT_MS, 'Listing the share');
      st.readable = true;
    } catch (err) {
      st.readable = false;
      st.writable = null;
      if (this.mode === 'local' && err.code === 'ENOENT') {
        this.fail(`${this.root} does not exist.`, 'Mount your footage at this path (volumes: - /path/to/TeslaCam:/footage) or set SMB_SHARE.');
      } else if (this.mode === 'local' || st.mounted) {
        this.fail(`Cannot read ${this.root}: ${err.message}`, null);
      }
      this.updateHealthy();
      return;
    }

    if (this.mode === 'local' && !st.mounted) {
      st.warning = `Nothing is mounted at ${this.root}, so the manager is looking at the container's own disk. Set SMB_SHARE or add a volume for ${this.root}.`;
    }
    if (this.mode === 'smb' && !st.mounted) {
      // readable but our mount is gone: don't touch the container's empty dir
      st.readable = false;
      this.updateHealthy();
      return;
    }

    try {
      const sfs = await withTimeout(fsp.statfs(this.root), FS_TIMEOUT_MS, 'Reading free space');
      st.totalBytes = Number(sfs.blocks) * Number(sfs.bsize);
      st.freeBytes = Number(sfs.bavail) * Number(sfs.bsize);
    } catch {
      st.totalBytes = st.freeBytes = null;
    }

    if (forceWriteCheck || st.writable === null || Date.now() - (st.writeCheckedAt || 0) > WRITE_CHECK_INTERVAL_MS) {
      await this.writeCheck();
    }
    if (st.writable !== false) {
      st.lastError = null;
      st.hint = null;
    }
    this.updateHealthy();
  }

  /**
   * Proves the share takes the exact operations an encode needs: create,
   * write, flush, rename onto an existing file, set mtime, delete.
   */
  async writeCheck() {
    const st = this.state;
    const a = path.join(this.root, '.sentry-six-manager-check-a');
    const b = path.join(this.root, '.sentry-six-manager-check-b');
    st.writeCheckedAt = Date.now();
    try {
      await withTimeout((async () => {
        await fsp.writeFile(a, 'old');
        const fh = await fsp.open(b, 'w');
        await fh.writeFile('new');
        await fh.sync();
        await fh.close();
        try {
          await fsp.rename(b, a);
          st.renameOverwrite = true;
        } catch {
          st.renameOverwrite = false;
          await fsp.unlink(a);
          await fsp.rename(b, a);
        }
        const when = new Date(Date.UTC(2020, 0, 1));
        await fsp.utimes(a, when, when);
        if ((await fsp.readFile(a, 'utf8')) !== 'new') throw new Error('read-back mismatch');
        await fsp.unlink(a);
      })(), FS_TIMEOUT_MS, 'Write test');
      if (st.writable === false) this.log.info('Share is writable again.');
      st.writable = true;
    } catch (err) {
      st.writable = false;
      await Promise.all([fsp.rm(a, { force: true }), fsp.rm(b, { force: true })]).catch(() => {});
      this.fail(`Share is not writable: ${err.message}`,
        err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS'
          ? 'The SMB user needs write access, and PUID/PGID (or the uid/gid mount options) must allow writing.'
          : null);
    }
  }

  updateHealthy() {
    const st = this.state;
    const prev = st.healthy;
    st.healthy = st.readable && (this.mode === 'local' || st.mounted);
    if (prev !== st.healthy) this.emit('health', st.healthy);
    this.emit('status', this.status());
  }

  isHealthy() {
    return this.state.healthy;
  }

  isWritable() {
    return this.state.healthy && this.state.writable === true;
  }

  status() {
    const st = this.state;
    return { ...st, network: NETWORK_FS.has(st.fsType || '') };
  }

  async stop() {
    clearInterval(this.timer);
    if (this.mountedByUs) await this.unmount();
    if (this.mode === 'smb') await this.mounter.forget(this.id).catch(() => {});
  }
}

module.exports = { ShareManager, findMount, explainMountError, withTimeout };
