'use strict';

// Mounting and unmounting SMB shares. Two implementations with the same
// interface:
//   createLocalMounter  runs mount.cifs itself; used by the root supervisor
//                       (and by the app when it runs as root, e.g. in tests)
//   createIpcMounter    used by the unprivileged app: asks the supervisor over
//                       the Node IPC channel
// The mount point is always <footageRoot>/<vehicle id> and is derived here,
// never taken from the caller, so a request cannot mount over /etc or /data.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { run, tail } = require('./proc');
const { mountArgs, credentialsText } = require('./mountSpec');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function checkId(id) {
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('Invalid vehicle id.'), { code: 'INVALID_ID' });
  return String(id);
}

function createLocalMounter({ footageRoot = '/footage', credDir = '/run/sentry-six-manager', uid = 0, gid = 0, runCmd = run } = {}) {
  const target = (id) => path.join(footageRoot, checkId(id));
  const credFile = (id) => path.join(credDir, `${checkId(id)}.cred`);

  async function mount(id, smb) {
    const dir = target(id);
    const file = credFile(id);
    const { args } = mountArgs(smb, { target: dir, credFile: file, uid, gid });
    await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
    // mount(2) follows symlinks: the mount point must be a plain directory where we expect it
    const st = await fsp.lstat(dir);
    if (!st.isDirectory() || (await fsp.realpath(dir)) !== path.resolve(dir)) throw Object.assign(new Error(`${dir} is not a plain directory.`), { code: 'BAD_MOUNTPOINT' });
    await fsp.mkdir(credDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(credDir, 0o700);
    await fsp.writeFile(file, credentialsText(smb), { mode: 0o600 });
    await fsp.chmod(file, 0o600);
    const res = await runCmd('mount', args, { timeoutMs: 60000 });
    return {
      code: res.code,
      timedOut: Boolean(res.timedOut),
      notFound: res.error?.code === 'ENOENT',
      output: `${res.stderr || ''}\n${res.stdout || ''}`.split('\n').filter((l) => !/^Refer to the mount\.cifs/.test(l)).join('\n').trim()
    };
  }

  async function unmount(id, { lazy = false } = {}) {
    const dir = target(id);
    const res = await runCmd('umount', lazy ? ['-l', dir] : [dir], { timeoutMs: 30000 });
    return { code: res.code, output: tail(res.stderr, 2) };
  }

  async function forget(id) {
    await fsp.rm(credFile(id), { force: true });
  }

  return { mount, unmount, forget, target };
}

/**
 * Mounter for the unprivileged app. `channel` is process (with an IPC
 * channel to the supervisor) or anything with send() and on('message').
 */
function createIpcMounter({ channel = process, footageRoot = '/footage', timeoutMs = 90000 } = {}) {
  const waiting = new Map();
  channel.on('message', (msg) => {
    if (!msg || msg.type !== 'mount-result' || !waiting.has(msg.requestId)) return;
    const { resolve, timer } = waiting.get(msg.requestId);
    clearTimeout(timer);
    waiting.delete(msg.requestId);
    resolve(msg.result);
  });

  function ask(op, payload) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        resolve({ code: -1, timedOut: true, output: 'The supervisor did not answer.' });
      }, timeoutMs);
      waiting.set(requestId, { resolve, timer });
      try {
        channel.send({ type: 'mount-request', requestId, op, ...payload });
      } catch (err) {
        clearTimeout(timer);
        waiting.delete(requestId);
        resolve({ code: -1, output: `No connection to the supervisor: ${err.message}` });
      }
    });
  }

  return {
    mount: (id, smb) => ask('mount', { id: checkId(id), smb }),
    unmount: (id, { lazy = false } = {}) => ask('unmount', { id: checkId(id), lazy: Boolean(lazy) }),
    forget: (id) => ask('forget', { id: checkId(id) }),
    target: (id) => path.join(footageRoot, checkId(id))
  };
}

/**
 * Supervisor side: answer mount requests from the app with a local mounter.
 * Requests are rebuilt from known fields only; mountSpec validates them again.
 */
function serveMountRequests(child, mounter, log = console) {
  const busy = new Map(); // id -> promise, so one vehicle is never mounted twice at once
  child.on('message', (msg) => {
    if (!msg || msg.type !== 'mount-request' || typeof msg.requestId !== 'string' || msg.requestId.length > 64) return;
    const reply = (result) => {
      try {
        if (child.connected) child.send({ type: 'mount-result', requestId: msg.requestId, result });
      } catch {
        // the app went away; it will ask again after a restart
      }
    };
    let work;
    try {
      const id = checkId(msg.id);
      const op = msg.op;
      if (op === 'mount') {
        const s = msg.smb || {};
        const smb = { share: s.share, username: s.username, password: s.password, domain: s.domain, version: s.version, encrypt: s.encrypt, port: s.port };
        work = () => mounter.mount(id, smb);
      } else if (op === 'unmount') {
        work = () => mounter.unmount(id, { lazy: msg.lazy === true });
      } else if (op === 'forget') {
        work = () => mounter.forget(id).then(() => ({ code: 0 }));
      } else {
        return reply({ code: -1, output: 'Unknown request.' });
      }
      const prev = busy.get(id) || Promise.resolve();
      const next = prev.catch(() => {}).then(work).then(reply, (err) => {
        log.error?.(`[supervisor] ${op} ${id}: ${err.message}`);
        reply({ code: -1, output: err.code === 'INVALID_SMB' ? err.message : 'The mount request was refused.' });
      });
      busy.set(id, next);
      next.finally(() => { if (busy.get(id) === next) busy.delete(id); });
    } catch (err) {
      reply({ code: -1, output: err.message });
    }
  });
}

module.exports = { createLocalMounter, createIpcMounter, serveMountRequests, checkId };
