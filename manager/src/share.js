'use strict';

// Keeps the footage share available. With SMB_SHARE set, the container
// mounts the share itself (mount.cifs, needs CAP_SYS_ADMIN), watches it, and
// remounts if the NAS drops. Without it, FOOTAGE_PATH is whatever the user
// mounted (bind mount or Docker CIFS volume) and is only health-checked.

const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { run, tail } = require('./proc');

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

function optionKey(opt) {
  return opt.split('=')[0].trim().toLowerCase();
}

/** mount.cifs -o string. Secrets go in a credentials file, not on the command line. */
function buildMountOptions(smb, credFile) {
  const user = smb.options ? smb.options.split(',').map((o) => o.trim()).filter(Boolean) : [];
  const userKeys = new Set(user.map(optionKey));
  const defaults = [];
  if (smb.username) defaults.push(`credentials=${credFile}`);
  else defaults.push('guest');
  if (smb.version && smb.version.toLowerCase() !== 'default') defaults.push(`vers=${smb.version}`);
  defaults.push(`uid=${smb.uid}`, `gid=${smb.gid}`, 'file_mode=0664', 'dir_mode=0775', 'noserverino');
  return [...defaults.filter((o) => !userKeys.has(optionKey(o))), ...user].join(',');
}

function credentialsFile(smb) {
  const clean = (v) => String(v || '').replace(/[\r\n]/g, '');
  let text = `username=${clean(smb.username)}\npassword=${clean(smb.password)}\n`;
  if (smb.domain) text += `domain=${clean(smb.domain)}\n`;
  return text;
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
    return 'Permission denied: the server rejected the login (check SMB_USERNAME / SMB_PASSWORD / SMB_DOMAIN), or on AppArmor hosts (Ubuntu) the container needs security_opt: apparmor:unconfined.';
  }
  if (code === 2) return 'The share was not found on the server. SMB_SHARE must look like //server/share (optionally //server/share/folder).';
  if (code === 112) return 'Server unreachable or it refused this SMB version. Check the address, then try SMB_VERSION=3.0, 2.1 or 2.0.';
  if (code === 95) return 'The server does not support this SMB version. Try SMB_VERSION=3.0, 2.1 or 2.0.';
  if (code === 22) return 'A mount option was rejected. Check SMB_VERSION and SMB_OPTIONS.';
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
  constructor({ config, log, runCmd = run, mountinfoPath = '/proc/self/mountinfo', credDir = '/run/sentry-manager' }) {
    super();
    this.config = config;
    this.root = config.footagePath;
    this.smb = config.smb;
    this.log = log;
    this.runCmd = runCmd;
    this.mountinfoPath = mountinfoPath;
    this.credFile = path.join(credDir, 'smb-credentials');
    this.mode = this.smb.share ? 'smb' : 'local';
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
    try {
      await fsp.mkdir(this.root, { recursive: true });
      if (smb.username) {
        await fsp.mkdir(path.dirname(this.credFile), { recursive: true, mode: 0o700 });
        await fsp.writeFile(this.credFile, credentialsFile(smb), { mode: 0o600 });
        await fsp.chmod(this.credFile, 0o600);
      }
    } catch (err) {
      this.fail(`Could not prepare the mount: ${err.message}`, null);
      return false;
    }
    const opts = buildMountOptions(smb, this.credFile);
    this.log.info(`Mounting ${smb.share} at ${this.root} (vers=${smb.version || 'default'}${smb.username ? `, user ${smb.username}` : ', guest'})`);
    const res = await this.runCmd('mount', ['-t', 'cifs', smb.share, this.root, '-o', opts], { timeoutMs: 60000 });
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
    const output = `${res.stderr}\n${res.stdout}`.split('\n').filter((l) => !/^Refer to the mount\.cifs/.test(l)).join('\n');
    const message = res.error?.code === 'ENOENT'
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
    const res = await this.runCmd('umount', lazy ? ['-l', this.root] : [this.root], { timeoutMs: 30000 });
    if (res.code !== 0) this.log.warn(`umount failed: ${tail(res.stderr, 2)}`);
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
    const a = path.join(this.root, '.sentry-manager-check-a');
    const b = path.join(this.root, '.sentry-manager-check-b');
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
    try {
      if (fs.existsSync(this.credFile)) await fsp.rm(this.credFile, { force: true });
    } catch {
      // ignore
    }
  }
}

module.exports = { ShareManager, findMount, buildMountOptions, credentialsFile, explainMountError, withTimeout };
