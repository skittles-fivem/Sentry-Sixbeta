'use strict';

// Clip filmstrips: six small frames spread across a clip, in one JPEG.
// FFmpeg jumps straight to six points in the clip and decodes one keyframe at
// each, so only small parts of the file are read (about a tenth of a full
// read) — this matters for clips on network shares. Strips live in the app's cache folder, named by a hash of the clip's
// path, size and modification time, so a changed clip never shows a stale
// strip. Converted clips get one right after they are saved; any other clip
// gets one the first time it is previewed.

const crypto = require('crypto');
const nodeFs = require('fs');
const nodePath = require('path');

const FRAMES = 6;
const FRAME_WIDTH = 160;
const MAX_CACHED = 20_000;
const MAX_QUEUED = 2_000;

function createClipThumbnails(options = {}) {
  const fs = options.fs || nodeFs.promises;
  const pathApi = options.pathApi || nodePath;
  const { directory, ffmpegPath, ffprobePath, spawn } = options;
  if (typeof directory !== 'string' || !ffmpegPath || !ffprobePath || typeof spawn !== 'function') {
    throw new TypeError('directory, ffmpegPath, ffprobePath and spawn are required');
  }
  const timeoutMs = options.timeoutMs || 30_000;
  const inFlight = new Map();
  const queue = [];
  let running = 0;
  const maxRunning = options.concurrency || 2;
  let prepared = null;

  function run(command, args) {
    return new Promise((resolve) => {
      let stdout = '';
      let child;
      try {
        child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (_) {
        resolve({ status: -1, stdout: '' });
        return;
      }
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, timeoutMs);
      child.stdout?.on('data', (chunk) => { if (stdout.length < 4096) stdout += chunk; });
      child.once('error', () => { clearTimeout(timer); resolve({ status: -1, stdout }); });
      child.once('close', (status) => { clearTimeout(timer); resolve({ status, stdout }); });
    });
  }

  async function prepareDirectory() {
    if (!prepared) {
      prepared = (async () => {
        await fs.mkdir(directory, { recursive: true });
        // Keep the cache bounded: drop the oldest strips past the limit.
        try {
          const names = (await fs.readdir(directory)).filter((name) => name.endsWith('.jpg'));
          if (names.length > MAX_CACHED) {
            const stats = await Promise.all(names.map(async (name) => {
              try { return { name, at: (await fs.stat(pathApi.join(directory, name))).mtimeMs }; } catch (_) { return null; }
            }));
            const oldest = stats.filter(Boolean).sort((a, b) => a.at - b.at).slice(0, names.length - MAX_CACHED);
            await Promise.all(oldest.map(({ name }) => fs.unlink(pathApi.join(directory, name)).catch(() => {})));
          }
        } catch (_) { /* pruning is best effort */ }
      })();
    }
    return prepared;
  }

  async function cachePathFor(videoPath) {
    const stat = await fs.stat(videoPath);
    if (!stat.isFile() || stat.size === 0) return null;
    const key = crypto.createHash('sha1')
      .update(`${pathApi.resolve(videoPath)}\0${stat.size}\0${Math.round(Number(stat.mtimeMs))}`)
      .digest('hex');
    return pathApi.join(directory, `${key}.jpg`);
  }

  async function exists(target) {
    try { return (await fs.stat(target)).size > 0; } catch (_) { return false; }
  }

  async function generate(videoPath, target) {
    const probe = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath]);
    const duration = Number(String(probe.stdout).trim());
    if (probe.status !== 0 || !Number.isFinite(duration) || duration <= 0) return null;
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.jpg`;
    const made = async (args) => {
      const result = await run(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args, '-q:v', '5', '-y', temporary]);
      return result.status === 0 && await exists(temporary);
    };
    // Seek to 0, 1/6, 2/6 ... of the clip (each input jumps to its point and
    // yields its nearest earlier keyframe), then place the six side by side.
    const seekInputs = [];
    const filters = [];
    for (let index = 0; index < FRAMES; index += 1) {
      seekInputs.push('-threads', '1', '-ss', ((duration * index) / FRAMES).toFixed(3), '-noaccurate_seek', '-i', videoPath);
      filters.push(`[${index}:v:0]trim=end_frame=1,scale=${FRAME_WIDTH}:-2,setsar=1[f${index}]`);
    }
    const stack = `${filters.join(';')};${Array.from({ length: FRAMES }, (_, index) => `[f${index}]`).join('')}hstack=inputs=${FRAMES}[strip]`;
    let ok = await made([...seekInputs, '-filter_complex', stack, '-map', '[strip]', '-frames:v', '1']);
    if (!ok) {
      // Fallback: scan the keyframes (reads the whole file).
      const step = Math.max(0.05, duration / FRAMES).toFixed(3);
      ok = await made(['-skip_frame', 'nokey', '-i', videoPath, '-an', '-sn', '-dn',
        '-vf', `select='gte(t\\,selected_n*${step})',scale=${FRAME_WIDTH}:-2,tile=${FRAMES}x1`,
        '-fps_mode', 'passthrough', '-frames:v', '1']);
    }
    try {
      if (!ok) return null;
      await fs.rename(temporary, target);
      return target;
    } finally {
      await fs.unlink(temporary).catch(() => {}); // gone after a successful rename
    }
  }

  function pump() {
    while (running < maxRunning && queue.length > 0) {
      const job = queue.shift();
      running += 1;
      job().finally(() => { running -= 1; pump(); });
    }
  }

  function schedule(task, { urgent = false } = {}) {
    return new Promise((resolve) => {
      const job = () => task().then(resolve, () => resolve(null));
      if (urgent) queue.unshift(job);
      else if (queue.length < MAX_QUEUED) queue.push(job);
      else { resolve(null); return; }
      pump();
    });
  }

  // Returns the cached strip's path, making it first when needed (null when
  // the clip cannot be read or decoded).
  async function get(videoPath, { create = true, urgent = true } = {}) {
    if (typeof videoPath !== 'string' || !pathApi.isAbsolute(videoPath) || !/\.mp4$/i.test(videoPath)) return null;
    let target;
    try {
      await prepareDirectory();
      target = await cachePathFor(videoPath);
    } catch (_) {
      return null;
    }
    if (!target) return null;
    if (await exists(target)) return target;
    if (!create) return null;
    if (!inFlight.has(target)) {
      const pending = schedule(() => generate(videoPath, target), { urgent })
        .finally(() => inFlight.delete(target));
      inFlight.set(target, pending);
    }
    return inFlight.get(target);
  }

  return Object.freeze({
    get,
    // Background pre-warm (e.g. right after a clip is converted).
    prewarm(videoPath) { void get(videoPath, { urgent: false }); }
  });
}

module.exports = { createClipThumbnails, FRAMES };
