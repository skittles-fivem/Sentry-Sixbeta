'use strict';

// Exposes the converter's IPC handlers (src/main/converter/ipc.js, unchanged)
// over HTTP so the Studio converter UI runs in a browser:
//   POST /api/converter/invoke/<name>   body = the IPC payload (or empty)
//   GET  /api/converter/events?client=  SSE stream for converter:progress /
//                                       converter:benchmarkProgress pushes
// Two server-side rules on top of the desktop behaviour:
//   - verification is never Off for a real conversion: telemetry checks are
//     an insurance requirement, so 'off' becomes 'quick' (the benchmark, which
//     only works on copies, keeps its Off/Quick/Full comparison);
//   - folders must be inside the allowed roots (vehicle shares, output dirs)
//     after following symlinks; the converter is handed the real path, so a
//     symlink on a share can never point it at a folder outside them.

const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');
const { registerConverterIpc, CHANNELS } = require(path.join(SRC, 'main/converter/ipc'));

const PATH_KEYS = ['sourceRoot', 'destinationRoot', 'defaultPath'];

function clampVerify(obj) {
  if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, 'verifyMode') && obj.verifyMode === 'off') {
    obj.verifyMode = 'quick';
  }
}

/**
 * resolvePath(p, { mustExist }) answers the real path of an allowed folder,
 * or null (see safePath.createRealGuard).
 */
function createConverterBridge({ runtime, resolvePath, log }) {
  const vetted = new Map(); // real path -> number of running invokes that checked it
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel)
  };
  // The browser picks the folder in its own dialog and sends it as defaultPath.
  const dialog = {
    showOpenDialog: async ({ defaultPath } = {}) => (defaultPath && vetted.has(defaultPath)
      ? { canceled: false, filePaths: [defaultPath] }
      : { canceled: true, filePaths: [] })
  };
  registerConverterIpc({
    ipcMain,
    dialog,
    service: runtime.service,
    capabilities: runtime.capabilities,
    benchmark: { run: (request) => runtime.runBenchmark(request), cancel: () => runtime.cancelBenchmark() },
    auto: runtime.auto
  });

  const channels = new Set(CHANNELS || [...handlers.keys()]);
  const clients = new Map(); // client id -> sender

  const inertSender = { send() {}, once() {}, removeListener() {}, isDestroyed: () => true };

  function senderFor(clientId) {
    return (clientId && clients.get(clientId)) || inertSender;
  }

  /** Replace every folder in the payload by its checked real path, or throw. */
  async function checkPaths(payload, added) {
    for (const o of [payload, payload?.config]) {
      if (!o || typeof o !== 'object') continue;
      for (const k of PATH_KEYS) {
        if (typeof o[k] !== 'string') continue;
        // an output folder may not exist yet; a source must
        const real = await resolvePath(o[k], { mustExist: k !== 'destinationRoot' });
        if (!real) {
          const err = new Error('That folder is outside the vehicle shares and output folders.');
          err.code = 'PATH_NOT_ALLOWED';
          throw err;
        }
        o[k] = real;
        vetted.set(real, (vetted.get(real) || 0) + 1);
        added.push(real);
      }
    }
  }

  function release(paths) {
    for (const p of paths) {
      const n = (vetted.get(p) || 1) - 1;
      if (n > 0) vetted.set(p, n);
      else vetted.delete(p);
    }
  }

  /** Invoke one channel; always resolves with the IPC envelope. */
  async function invoke(name, payload, clientId) {
    const channel = `converter:${name}`;
    const fn = handlers.get(channel);
    if (!channels.has(channel) || !fn) return { ok: false, error: { code: 'UNKNOWN_CHANNEL' } };
    if (name === 'start' || name === 'setAuto') {
      clampVerify(payload);
      clampVerify(payload?.config);
    }
    const added = [];
    try {
      await checkPaths(payload, added);
    } catch (err) {
      release(added);
      return { ok: false, error: { code: err.code || 'PATH_NOT_ALLOWED' } };
    }
    try {
      return await fn({ sender: senderFor(clientId) }, payload);
    } catch (err) {
      log?.error(`Converter ${channel} failed: ${err?.code || err?.message}`);
      return { ok: false, error: { code: err?.code || 'INTERNAL_ERROR' } };
    } finally {
      release(added);
    }
  }

  /** Attach an SSE response as an IPC sender for converter pushes. */
  function attachEvents(clientId, res) {
    const destroyed = [];
    const sender = {
      send(channel, payload) {
        if (!res.writableEnded) res.write(`event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`);
      },
      once(event, fn) {
        if (event === 'destroyed') destroyed.push(fn);
      },
      removeListener(event, fn) {
        const i = destroyed.indexOf(fn);
        if (i !== -1) destroyed.splice(i, 1);
      },
      isDestroyed: () => res.writableEnded || res.destroyed
    };
    clients.set(clientId, sender);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => {
      clearInterval(ping);
      if (clients.get(clientId) === sender) clients.delete(clientId);
      for (const fn of destroyed.splice(0)) {
        try { fn(); } catch { /* ignore */ }
      }
    });
    return sender;
  }

  return { invoke, attachEvents, channels: [...channels] };
}

module.exports = { createConverterBridge, clampVerify };
