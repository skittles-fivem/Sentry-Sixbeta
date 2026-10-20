'use strict';

// A hung SMB call parks a libuv worker thread; give the pool headroom so one
// stuck share request can't stall every other file operation.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const fs = require('fs');
const { loadConfig } = require('./config');
const { Logger } = require('./log');
const { App } = require('./app');
const { createServer } = require('./server');
const { findMount } = require('./share');

async function main() {
  const logger = new Logger({ level: process.env.LOG_LEVEL || 'info' });
  const log = logger.scope('main');
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  try {
    const dataMount = findMount(fs.readFileSync('/proc/self/mountinfo', 'utf8'), config.dataPath);
    if (dataMount && /^(cifs|smb3|nfs4?)$/.test(dataMount.fsType)) {
      log.warn(`${config.dataPath} is on a network share (${dataMount.fsType}). Keep DATA_PATH on local disk; SQLite is unreliable over SMB/NFS.`);
    }
  } catch {
    // not Linux / no procfs
  }

  const app = new App(config, { logger });
  const server = createServer(app, { config, logger });
  server.listen(config.port, config.host, () => {
    log.info(`Sentry Manager listening on http://${config.host}:${config.port}`);
  });
  await app.start();

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    server.closeAll();
    server.close();
    try {
      await app.stop();
    } catch (err) {
      log.error(`Shutdown error: ${err.message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
