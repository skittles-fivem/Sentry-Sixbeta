'use strict';

// Runs the Sentry Studio converter (src/main/converter, unchanged) inside the
// server, composed the same way src/main.js does it in the desktop app. The
// only differences: Linux owned-file operations, a wider set of retryable
// network errors (Linux SMB soft mounts also report EHOSTDOWN / ESTALE /
// EAGAIN), and no Electron app/dialog.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createPosixOwnedFs } = require('./posixOwnedFs');

const SRC = path.join(__dirname, '..', '..', 'src');
const { createConverterLifecycle, createConverterRuntime } = require(path.join(SRC, 'main/converter/runtime'));

const RETRYABLE = new Set([
  'ENOENT', 'ENOTCONN', 'ENETDOWN', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EIO',
  'EHOSTDOWN', 'ESTALE', 'EAGAIN', 'ECONNABORTED', 'ENETUNREACH'
]);

function createNetwork() {
  return {
    isRetryable: (error) => RETRYABLE.has(error?.code),
    // Same as the runtime's default: a path counts as reachable when it (or,
    // if allowed, an ancestor) exists.
    checkPath: async (target, options = {}) => {
      let probe = path.resolve(target);
      for (;;) {
        try {
          await fs.promises.access(probe);
          return true;
        } catch (error) {
          if (error?.code !== 'ENOENT' || options.allowAncestor !== true) return false;
          const parent = path.dirname(probe);
          if (parent === probe) return false;
          probe = parent;
        }
      }
    }
  };
}

/**
 * @param {object} o
 * @param {string} o.dataDir   persistent local dir (job store lives here)
 * @param {string} o.tempDir   persistent local dir for staging / verification
 * @param {(runtime) => void} [o.onReady]
 */
function createConverterHost({ dataDir, tempDir, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', log, onClipConverted, owned = createPosixOwnedFs() }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
  let runtime = null;
  let lastError = null;

  const lifecycle = createConverterLifecycle({
    app: { quit() {} },
    initialize: async ({ retainRuntime, runtime: existing, isQuitting }) => {
      const rt = existing || await createConverterRuntime({
        userDataPath: fs.realpathSync(dataDir),
        tempPath: fs.realpathSync(tempDir),
        ffmpegPath,
        ffprobePath,
        spawn,
        fs,
        pathApi: path,
        platform: process.platform,
        removeOwned: owned.removeOwned,
        renameExclusive: owned.renameExclusive,
        network: createNetwork(),
        onClipConverted: (outputPath) => onClipConverted?.(outputPath),
        onError: (error) => log?.error(`Converter recovery failed: ${error?.code || error?.message || 'RECOVERY_FAILED'}`)
      });
      retainRuntime(rt);
      await rt.start();
      if (isQuitting()) throw Object.assign(new Error('Converter shutdown requested'), { code: 'SERVICE_SHUTDOWN' });
      return rt;
    },
    onError: (error) => log?.error(`Converter shutdown failed: ${error?.code || 'SHUTDOWN_FAILED'}`)
  });

  /** Start with retries (the desktop shows a recovery dialog instead). */
  async function start({ attempts = 5, delayMs = 2000 } = {}) {
    for (let i = 1; ; i++) {
      try {
        runtime = await lifecycle.start();
        lastError = null;
        log?.info(`Converter ready (replacement ${runtime.capabilities.replacement}, cleanup ${runtime.capabilities.ownershipCleanup})`);
        return runtime;
      } catch (error) {
        lastError = error;
        log?.error(`Converter start attempt ${i} failed: ${error?.code || error?.message}`);
        if (i >= attempts) throw error;
        await new Promise((r) => setTimeout(r, delayMs * i));
      }
    }
  }

  return {
    start,
    stop: () => lifecycle.beforeQuit({ preventDefault() {} }),
    get runtime() { return runtime; },
    get lastError() { return lastError; },
    helperAvailable: owned.helperAvailable
  };
}

module.exports = { createConverterHost, RETRYABLE };
