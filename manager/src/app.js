'use strict';

// Wires the share, scanner, encoder and purge together. index.js runs it;
// tests run it against a temp folder.

const { EventEmitter } = require('events');
const path = require('path');
const { StateDB } = require('./db');
const { ShareManager } = require('./share');
const { EncodeManager } = require('./encoder');
const { scanFootage, summarizeDays } = require('./scanner');
const { purgeDays } = require('./purge');
const { publicConfig, CLIP_TYPES } = require('./config');

class App extends EventEmitter {
  constructor(config, { logger, shareOptions = {}, detect } = {}) {
    super();
    this.config = config;
    this.logger = logger;
    this.log = logger.scope('app');
    this.db = new StateDB(path.join(config.dataPath, 'sentry-manager.db'));
    this.share = new ShareManager({ config, log: logger.scope('share'), ...shareOptions });
    this.encoder = new EncodeManager({ config, db: this.db, share: this.share, log: logger.scope('encode'), ...(detect ? { detect } : {}) });
    this.index = null;
    this.scanning = null;
    this.scanInfo = { lastScanAt: null, durationMs: null, files: 0, errors: [], running: false };
    this.daysCache = null;
    this.purging = false;

    const changed = () => {
      this.daysCache = null;
      this.emit('days');
    };
    this.encoder.on('file-updated', changed);
    this.encoder.on('status', () => this.emit('status'));
    this.encoder.on('progress', () => this.emit('status'));
    this.share.on('status', () => this.emit('status'));
    this.share.on('health', (healthy) => {
      if (healthy) {
        this.scan().catch(() => {});
        this.encoder.pump();
      }
    });
  }

  async start() {
    await this.encoder.init();
    await this.share.start();
    this.encoder.detect();
    if (this.share.isHealthy()) this.scan().catch(() => {});
    this.scanTimer = setInterval(() => this.scan().catch(() => {}), this.config.scanIntervalMinutes * 60 * 1000);
    this.scanTimer.unref?.();
  }

  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      if (!this.share.isHealthy()) {
        this.log.warn('Share is not available; scan skipped.');
        return this.index;
      }
      this.scanInfo.running = true;
      this.emit('status');
      try {
        const result = await scanFootage(this.config.footagePath, {
          onProgress: (n) => {
            this.scanInfo.progress = n;
            this.emit('status');
          }
        });
        this.index = result;
        this.daysCache = null;
        this.scanInfo = {
          lastScanAt: result.scannedAt, durationMs: result.durationMs, files: result.files.size,
          errors: result.errors.slice(0, 20), errorCount: result.errors.length, running: false
        };
        if (result.errors.length) {
          this.log.warn(`Scan finished with ${result.errors.length} error(s), first: ${result.errors[0].rel}: ${result.errors[0].message}`);
        } else {
          this.db.pruneMissing(new Set(result.files.keys()));
        }
        this.log.info(`Scanned ${result.files.size} files in ${(result.durationMs / 1000).toFixed(1)}s`);
        if (result.leftovers.length && this.share.isWritable()) await this.encoder.recoverLeftovers(result.leftovers);
        this.encoder.plan(result.files);
        this.emit('days');
        return result;
      } catch (err) {
        this.log.error(`Scan failed: ${err.message}`);
        throw err;
      } finally {
        this.scanInfo.running = false;
        this.scanning = null;
        this.emit('status');
      }
    })();
    return this.scanning;
  }

  days() {
    if (!this.index) return [];
    if (!this.daysCache) this.daysCache = summarizeDays(this.index.files, this.db.allFiles(), this.config.encode.maxAttempts);
    return this.daysCache;
  }

  async purge(days, types = CLIP_TYPES) {
    if (this.purging) throw Object.assign(new Error('A purge is already running.'), { status: 409 });
    if (!this.index) throw Object.assign(new Error('Footage has not been scanned yet.'), { status: 409 });
    if (!this.share.isWritable()) throw Object.assign(new Error('The share is not writable right now.'), { status: 503 });
    this.purging = true;
    this.emit('status');
    try {
      if (this.scanning) await this.scanning.catch(() => {});
      const result = await purgeDays({
        root: this.config.footagePath, files: this.index.files, days, types,
        encoder: this.encoder, db: this.db, log: this.logger.scope('purge')
      });
      this.daysCache = null;
      this.encoder.plan(this.index.files);
      this.emit('days');
      this.share.ensure().catch(() => {});
      return result;
    } finally {
      this.purging = false;
      this.emit('status');
    }
  }

  status() {
    const days = this.days();
    const totals = days.reduce((acc, d) => {
      acc.bytes += d.bytes;
      acc.files += d.files;
      acc.savedBytes += d.encode.savedBytes;
      acc.pending += d.encode.pending;
      acc.encoded += d.encode.encoded;
      return acc;
    }, { bytes: 0, files: 0, savedBytes: 0, pending: 0, encoded: 0 });
    return {
      version: require('../package.json').version,
      share: this.share.status(),
      encoder: this.encoder.status(),
      scan: { ...this.scanInfo, intervalMinutes: this.config.scanIntervalMinutes },
      purging: this.purging,
      footage: { ...totals, days: days.length, oldest: days[0]?.day || null, newest: days[days.length - 1]?.day || null },
      config: publicConfig(this.config)
    };
  }

  async stop() {
    clearInterval(this.scanTimer);
    await this.encoder.stop();
    await this.share.stop();
    this.db.close();
  }
}

module.exports = { App };
