'use strict';

// Encode queue. A file is never encoded twice because of three independent
// checks, any one of which is enough:
//   1. the state DB remembers every file it finished (keyed by path + size +
//      mtime), so unchanged files are skipped without touching the share;
//   2. every output carries a "SentryManager" comment tag; if the DB is lost
//      or the file was moved, ffprobe finds the tag and the file is adopted;
//   3. only H.264 sources are encoded, so even an untagged HEVC file is left
//      alone, and an output that would not be meaningfully smaller is
//      recorded as skipped so it is not retried.

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { buildEncodeArgs } = require('./ffmpegArgs');
const { probeFile, countFrames, buildMarker } = require('./probe');
const { detectEncoders } = require('./encoderDetect');
const { encodeState } = require('./scanner');
const { safeJoin } = require('./footage');
const { mtimeKey } = require('./db');
const { head } = require('./proc');

const TRANSIENT_CODES = new Set(['ETIMEDOUT', 'EIO', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENOTCONN', 'ESTALE', 'ECONNRESET', 'ECONNABORTED', 'ENOSPC', 'EBUSY', 'EAGAIN']);

class PermanentError extends Error {}
class TransientError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class EncodeManager extends EventEmitter {
  constructor({ config, db, share, log, detect = detectEncoders }) {
    super();
    this.config = config;
    this.enc = config.encode;
    this.db = db;
    this.share = share;
    this.log = log;
    this.detectFn = detect;
    this.root = config.footagePath;
    this.queue = [];
    this.active = new Map();
    this.detection = null;
    this.detecting = null;
    this.paused = Boolean(db.getSetting('encodePaused', false));
    this.stopped = false;
    this.lastProgressEmit = 0;
  }

  async init() {
    await fsp.mkdir(this.config.scratchPath, { recursive: true });
    // Anything left in scratch is from a run that was killed mid-encode.
    for (const name of await fsp.readdir(this.config.scratchPath)) {
      await fsp.rm(path.join(this.config.scratchPath, name), { recursive: true, force: true });
    }
  }

  detect() {
    if (this.detecting) return this.detecting;
    this.detecting = (async () => {
      this.emit('status');
      try {
        this.detection = await this.detectFn({
          ffmpegPath: this.config.ffmpegPath,
          ffprobePath: this.config.ffprobePath,
          family: this.enc.codec,
          preference: this.enc.encoder,
          device: this.enc.device,
          preserveTelemetry: this.enc.preserveTelemetry,
          quality: this.enc.quality,
          preset: this.enc.preset,
          workDir: path.join(this.config.scratchPath, 'detect'),
          log: this.log
        });
        const sel = this.detection.selected;
        if (sel) this.log.info(`Encoder: ${sel.name} (${sel.codec}${sel.device ? ` on ${sel.device}` : ''}), telemetry ${sel.supportsSei ? 'preserved' : 'not preserved'}`);
        for (const note of this.detection.notes) this.log.warn(note);
      } catch (err) {
        this.log.error(`Encoder detection failed: ${err.message}`);
        this.detection = { selected: null, candidates: [], notes: [`Detection failed: ${err.message}`], detectedAt: Date.now() };
      } finally {
        this.detecting = null;
      }
      this.emit('status');
      this.pump();
      return this.detection;
    })();
    return this.detecting;
  }

  canRun() {
    return this.enc.enabled && !this.paused && !this.stopped && Boolean(this.detection?.selected) && this.share.isWritable();
  }

  state() {
    if (!this.enc.enabled) return 'disabled';
    if (this.detecting && !this.detection) return 'detecting';
    if (this.paused) return 'paused';
    if (this.detection && !this.detection.selected) return 'no-encoder';
    if (!this.share.isWritable()) return 'waiting-share';
    if (this.active.size) return 'encoding';
    return this.queue.length ? 'ready' : 'idle';
  }

  isEligible(file, record, now = Date.now()) {
    if (!file.encodable || !this.enc.types.includes(file.type)) return false;
    if (now - file.mtimeMs < this.enc.minAgeMinutes * 60 * 1000) return false;
    return encodeState(file, record, this.enc.maxAttempts) === 'pending';
  }

  /** Rebuild the queue from a scan. Newest footage first: it is kept longest. */
  plan(files) {
    this.files = files;
    this.totalsCache = null;
    const records = this.db.allFiles();
    const now = Date.now();
    const next = [];
    for (const f of files.values()) {
      if (this.active.has(f.rel)) continue;
      if (this.isEligible(f, records.get(f.rel), now)) next.push(f);
    }
    next.sort((a, b) => b.mtimeMs - a.mtimeMs);
    this.queue = next;
    this.emit('status');
    this.pump();
    return next.length;
  }

  prioritizeDay(day) {
    const hit = this.queue.filter((f) => f.day === day);
    if (!hit.length) return 0;
    this.queue = [...hit, ...this.queue.filter((f) => f.day !== day)];
    this.emit('status');
    this.pump();
    return hit.length;
  }

  pause() {
    this.paused = true;
    this.db.setSetting('encodePaused', true);
    for (const job of this.active.values()) this.killJob(job);
    this.emit('status');
  }

  resume() {
    this.paused = false;
    this.db.setSetting('encodePaused', false);
    // re-plan so files stopped by pause() are picked up again
    if (this.files) this.plan(this.files);
    else this.pump();
    this.emit('status');
  }

  pump() {
    while (this.canRun() && this.active.size < this.enc.concurrency && this.queue.length) {
      const file = this.queue.shift();
      this.process(file);
    }
  }

  /** Stop and forget work on these paths (used before a purge). */
  async cancel(rels) {
    this.queue = this.queue.filter((f) => !rels.has(f.rel));
    const waits = [];
    for (const job of this.active.values()) {
      if (rels.has(job.rel)) {
        this.killJob(job);
        waits.push(job.done);
      }
    }
    await Promise.all(waits);
    this.emit('status');
  }

  killJob(job) {
    job.cancelled = true;
    if (job.child && job.child.exitCode === null) {
      job.child.kill('SIGTERM');
      setTimeout(() => job.child && job.child.exitCode === null && job.child.kill('SIGKILL'), 5000).unref();
    }
  }

  process(file) {
    const job = {
      rel: file.rel, day: file.day, type: file.type, startedAt: Date.now(), phase: 'probing',
      percent: 0, speed: null, sourceSize: file.size, cancelled: false, child: null
    };
    let resolveDone;
    job.done = new Promise((r) => { resolveDone = r; });
    this.active.set(file.rel, job);
    this.emit('status');

    this.encodeOne(file, job)
      .catch((err) => {
        try {
          this.recordFailure(file, job, err);
        } catch (dbErr) {
          this.log.error(`Could not record failure for ${file.rel}: ${dbErr.message}`);
        }
      })
      .finally(async () => {
        if (job.scratch) await fsp.rm(job.scratch, { force: true }).catch(() => {});
        this.active.delete(file.rel);
        this.totalsCache = null;
        resolveDone();
        this.emit('status');
        this.emit('file-updated', file.rel);
        this.pump();
      });
  }

  recordFailure(file, job, err) {
    if (job.cancelled) {
      this.log.info(`Stopped ${file.rel}`);
      return;
    }
    const notCounted = err instanceof TransientError
      || (!(err instanceof PermanentError) && (TRANSIENT_CODES.has(err.code) || !this.share.isHealthy()));
    if (notCounted) {
      // Share hiccups and changed sources don't count against the file; it is re-queued on the next scan.
      this.log.warn(`Will retry ${file.rel} later: ${err.message}`);
      return;
    }
    const prev = this.db.getFile(file.rel);
    const sameFile = prev && prev.size === job.sourceSize && prev.mtimeMs === mtimeKey(job.sourceMtimeMs ?? file.mtimeMs);
    const attempts = err instanceof PermanentError ? this.enc.maxAttempts : (sameFile ? prev.attempts : 0) + 1;
    this.db.upsertFile({
      rel: file.rel, size: job.sourceSize, mtimeMs: job.sourceMtimeMs ?? file.mtimeMs,
      status: 'failed', reason: err.message, attempts
    });
    this.db.addHistory({ rel: file.rel, status: 'failed', message: err.message, originalSize: job.sourceSize, durationMs: Date.now() - job.startedAt });
    this.log.error(`Encode failed for ${file.rel}: ${err.message}`);
  }

  skip(file, st, reason, extra = {}) {
    this.db.upsertFile({ rel: file.rel, size: st.size, mtimeMs: st.mtimeMs, status: 'skipped', reason, ...extra });
  }

  async encodeOne(file, job) {
    const enc = this.enc;
    const selected = this.detection.selected;
    const abs = safeJoin(this.root, file.rel);

    let st;
    try {
      st = await fsp.stat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') { job.cancelled = true; return; }
      throw err;
    }
    job.sourceSize = st.size;
    job.sourceMtimeMs = st.mtimeMs;
    const current = { ...file, size: st.size, mtimeMs: st.mtimeMs };
    if (!this.isEligible(current, this.db.getFile(file.rel))) { job.cancelled = true; return; }

    let src;
    try {
      src = await probeFile(this.config.ffprobePath, abs);
    } catch (err) {
      if (err.unreadable) {
        this.skip(file, st, 'unreadable or incomplete clip');
        this.log.warn(`Skipping ${file.rel}: ${err.message}`);
        return;
      }
      throw err;
    }

    if (src.marker) {
      this.db.upsertFile({
        rel: file.rel, size: st.size, mtimeMs: st.mtimeMs, status: 'encoded', reason: 'already encoded (tag found)',
        originalSize: src.marker.originalSize || null, encodedSize: src.marker.originalSize ? st.size : null,
        codec: src.video?.codec || src.marker.codec, encoder: src.marker.encoder
      });
      this.log.info(`Already encoded (tag found): ${file.rel}`);
      return;
    }
    if (!src.video) {
      this.skip(file, st, 'no video stream');
      return;
    }
    if (src.video.codec !== 'h264') {
      this.skip(file, st, `already ${src.video.codec.toUpperCase()}, not re-encoded`, { codec: src.video.codec });
      return;
    }

    await this.ensureScratchSpace(st.size);
    job.scratch = path.join(this.config.scratchPath, `${crypto.createHash('sha1').update(file.rel).digest('hex')}.mp4`);
    job.phase = 'encoding';
    this.emit('status');
    const args = buildEncodeArgs({
      input: abs,
      output: job.scratch,
      encoder: selected,
      family: enc.codec,
      quality: enc.quality,
      preset: enc.preset,
      fps: src.video.fps,
      preserveTelemetry: enc.preserveTelemetry,
      marker: buildMarker({ codec: enc.codec, encoder: selected.codec, originalSize: st.size }),
      progress: true
    });
    if (job.cancelled) return;
    await this.runFfmpeg(args, job, src.duration);
    if (job.cancelled) return;

    job.phase = 'verifying';
    this.emit('status');
    const out = await probeFile(this.config.ffprobePath, job.scratch).catch((err) => {
      throw new PermanentError(`encoded file is unreadable: ${err.message}`);
    });
    const outSize = (await fsp.stat(job.scratch)).size;
    await this.verify(abs, job.scratch, src, out);

    const minRatio = 1 - enc.minSavingsPercent / 100;
    if (outSize > st.size * minRatio) {
      const pct = Math.round((1 - outSize / st.size) * 100);
      this.skip(file, st, `not worth it: only ${pct}% smaller, original kept`, { originalSize: st.size, encodedSize: outSize });
      this.db.addHistory({ rel: file.rel, status: 'skipped', message: `only ${pct}% smaller, original kept`, originalSize: st.size, encodedSize: outSize, durationMs: Date.now() - job.startedAt });
      return;
    }

    job.phase = 'replacing';
    this.emit('status');
    const before = await fsp.stat(abs);
    if (before.size !== st.size || mtimeKey(before.mtimeMs) !== mtimeKey(st.mtimeMs)) {
      throw new TransientError('source changed while encoding');
    }
    const final = await this.replaceOnShare(abs, job.scratch, before);
    this.db.upsertFile({
      rel: file.rel, size: final.size, mtimeMs: final.mtimeMs, status: 'encoded', reason: null,
      originalSize: st.size, encodedSize: final.size, codec: enc.codec, encoder: selected.codec, attempts: 0
    });
    const pct = Math.round((1 - final.size / st.size) * 100);
    this.db.addHistory({
      rel: file.rel, status: 'encoded', message: `${pct}% smaller with ${selected.codec}`,
      originalSize: st.size, encodedSize: final.size, durationMs: Date.now() - job.startedAt
    });
    this.log.info(`Encoded ${file.rel}: ${(st.size / 1e6).toFixed(1)} MB -> ${(final.size / 1e6).toFixed(1)} MB (${pct}% smaller)`);
  }

  async verify(abs, scratch, src, out) {
    const family = this.enc.codec;
    if (out.video?.codec !== family) throw new PermanentError(`encoded file has codec ${out.video?.codec}, expected ${family}`);
    if (!out.marker) throw new PermanentError('encoded file is missing the SentryManager tag');
    const srcFrames = src.video.frames ?? await countFrames(this.config.ffprobePath, abs);
    const outFrames = out.video.frames ?? await countFrames(this.config.ffprobePath, scratch);
    if (srcFrames && outFrames !== srcFrames) {
      throw new PermanentError(`frame count mismatch (source ${srcFrames}, encoded ${outFrames}); original kept`);
    }
    if (src.duration && out.duration && Math.abs(src.duration - out.duration) > Math.max(0.5, src.duration * 0.02)) {
      throw new PermanentError(`duration mismatch (source ${src.duration.toFixed(2)}s, encoded ${out.duration.toFixed(2)}s); original kept`);
    }
  }

  async ensureScratchSpace(bytes) {
    try {
      const s = await fsp.statfs(this.config.scratchPath);
      const free = Number(s.bavail) * Number(s.bsize);
      if (free < bytes * 1.5 + 256 * 1024 * 1024) {
        throw Object.assign(new TransientError(`scratch disk ${this.config.scratchPath} is nearly full (${(free / 1e9).toFixed(1)} GB free)`), { code: 'ENOSPC' });
      }
    } catch (err) {
      if (err instanceof TransientError) throw err;
    }
  }

  runFfmpeg(args, job, duration) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      job.child = child;
      try {
        os.setPriority(child.pid, 10);
      } catch {
        // not fatal
      }
      let stderr = '';
      let buf = '';
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          const eq = line.indexOf('=');
          if (eq === -1) continue;
          const key = line.slice(0, eq);
          const value = line.slice(eq + 1);
          if (key === 'out_time_us' && duration) {
            const sec = Number(value) / 1e6;
            if (Number.isFinite(sec)) job.percent = Math.max(0, Math.min(99, (sec / duration) * 100));
          } else if (key === 'speed') {
            job.speed = value.trim();
          } else if (key === 'progress') {
            const now = Date.now();
            if (now - this.lastProgressEmit > 1000) {
              this.lastProgressEmit = now;
              this.emit('progress');
            }
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk;
      });
      child.on('error', (err) => reject(new TransientError(`could not start ffmpeg: ${err.message}`)));
      child.on('close', (code) => {
        job.child = null;
        if (job.cancelled) return resolve();
        if (code === 0) {
          job.percent = 100;
          return resolve();
        }
        const msg = head(stderr, 2) || `ffmpeg exited with ${code}`;
        // Decoder errors on the source are permanent; anything else may be the share.
        const permanent = /Invalid data found|corrupt|error while decoding|moov atom/i.test(stderr);
        reject(permanent ? new PermanentError(msg) : new Error(msg));
      });
    });
  }

  /**
   * Put the encoded file in place of the original without ever leaving the
   * share without a good copy: upload as a hidden temp, then rename over the
   * original. Servers that refuse rename-over get original -> .orig, temp ->
   * name, delete .orig, with the original restored if the middle step fails.
   */
  async replaceOnShare(abs, scratch, srcStat) {
    const dir = path.dirname(abs);
    const base = path.basename(abs);
    const tmp = path.join(dir, `.${base}.sentrymgr.tmp`);
    const orig = path.join(dir, `.${base}.sentrymgr.orig`);
    try {
      await pipeline(fs.createReadStream(scratch), fs.createWriteStream(tmp, { flush: true }));
      const [a, b] = await Promise.all([fsp.stat(scratch), fsp.stat(tmp)]);
      if (a.size !== b.size) throw new TransientError(`upload incomplete (${b.size} of ${a.size} bytes)`);

      let replaced = false;
      if (this.share.state.renameOverwrite !== false) {
        for (let i = 0; i < 3 && !replaced; i++) {
          try {
            await fsp.rename(tmp, abs);
            replaced = true;
          } catch (err) {
            if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'ETXTBSY'].includes(err.code)) throw err;
            await sleep(1000 * 2 ** i);
          }
        }
      }
      if (!replaced) {
        await fsp.rename(abs, orig);
        try {
          await fsp.rename(tmp, abs);
        } catch (err) {
          await fsp.rename(orig, abs);
          throw err;
        }
        await fsp.unlink(orig).catch((err) => this.log.warn(`Could not remove ${orig}: ${err.message}`));
      }
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
    // Keep the clip's original timestamps so date-based tools still sort it right.
    await fsp.utimes(abs, srcStat.atime, srcStat.mtime).catch((err) => this.log.warn(`Could not restore mtime on ${abs}: ${err.message}`));
    return fsp.stat(abs);
  }

  /** Clean up temp files a crash left on the share (from scan leftovers). */
  async recoverLeftovers(leftovers) {
    const busy = new Set(this.active.keys());
    const ordered = [...leftovers].sort((a, b) => (a.kind === 'orig' ? -1 : 0) - (b.kind === 'orig' ? -1 : 0));
    for (const left of ordered) {
      const finalRel = left.dir ? `${left.dir}/${left.original}` : left.original;
      if (busy.has(finalRel)) continue;
      try {
        const leftAbs = safeJoin(this.root, left.rel);
        const finalAbs = safeJoin(this.root, finalRel);
        if (left.kind === 'orig' && !fs.existsSync(finalAbs)) {
          await fsp.rename(leftAbs, finalAbs);
          this.log.warn(`Restored original after an interrupted encode: ${finalRel}`);
        } else {
          await fsp.rm(leftAbs, { force: true });
          this.log.info(`Removed leftover temp file ${left.rel}`);
        }
      } catch (err) {
        this.log.warn(`Could not clean up ${left.rel}: ${err.message}`);
      }
    }
  }

  retryFailed() {
    const n = this.db.resetFailed();
    this.totalsCache = null;
    this.emit('status');
    return n;
  }

  status() {
    const det = this.detection;
    return {
      state: this.state(),
      enabled: this.enc.enabled,
      paused: this.paused,
      queued: this.queue.length,
      active: [...this.active.values()].map((j) => ({
        rel: j.rel, day: j.day, type: j.type, phase: j.phase, percent: Math.round(j.percent * 10) / 10,
        speed: j.speed, sourceSize: j.sourceSize, startedAt: j.startedAt
      })),
      detecting: Boolean(this.detecting),
      encoder: det ? {
        selected: det.selected ? {
          name: det.selected.name, codec: det.selected.codec, device: det.selected.device,
          backend: det.selected.backend, supportsSei: det.selected.supportsSei
        } : null,
        candidates: det.candidates.map((c) => ({
          name: c.name, codec: c.codec, device: c.device, backend: c.backend, listed: c.listed,
          works: c.works, supportsSei: c.supportsSei, error: c.error, hint: c.hint
        })),
        notes: det.notes,
        ffmpeg: det.ffmpeg,
        detectedAt: det.detectedAt
      } : null,
      settings: {
        codec: this.enc.codec, quality: this.enc.quality, preset: this.enc.preset,
        preserveTelemetry: this.enc.preserveTelemetry, minAgeMinutes: this.enc.minAgeMinutes,
        minSavingsPercent: this.enc.minSavingsPercent, types: this.enc.types, concurrency: this.enc.concurrency
      },
      totals: this.totals()
    };
  }

  /** DB totals, recomputed only after something changed (status goes out twice a second). */
  totals() {
    if (!this.totalsCache) this.totalsCache = this.db.totals();
    return this.totalsCache;
  }

  async stop() {
    this.stopped = true;
    const waits = [];
    for (const job of this.active.values()) {
      this.killJob(job);
      waits.push(job.done);
    }
    await Promise.race([Promise.all(waits), sleep(8000)]);
  }
}

module.exports = { EncodeManager, PermanentError, TransientError };
