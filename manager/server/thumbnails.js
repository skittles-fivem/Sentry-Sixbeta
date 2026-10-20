'use strict';

// Recording card thumbnails: the event's own thumb.png when Tesla saved one,
// otherwise one frame from the front camera, made once with ffmpeg and cached
// on the local data volume.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { run } = require('./proc');
const { limiter } = require('./scanner');

class Thumbnails {
  constructor({ dir, ffmpegPath = 'ffmpeg', concurrency = 2 }) {
    this.dir = dir;
    this.ffmpegPath = ffmpegPath;
    this.limit = limiter(concurrency);
    this.inFlight = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Path of a JPEG for this clip (generated if needed), or null. */
  async forClip(clipPath) {
    const st = await fsp.stat(clipPath).catch(() => null);
    if (!st) return null;
    const key = crypto.createHash('sha1').update(`${clipPath}|${st.size}|${Math.floor(st.mtimeMs)}`).digest('hex');
    const out = path.join(this.dir, `${key}.jpg`);
    if (fs.existsSync(out)) return out;
    if (this.inFlight.has(out)) return this.inFlight.get(out);
    const p = this.limit(async () => {
      const tmp = `${out}.${process.pid}.tmp.jpg`;
      const r = await run(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', '1', '-i', clipPath,
        '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', tmp], { timeoutMs: 60000 });
      if (r.code !== 0) {
        // very short clip: take the first frame instead
        const r2 = await run(this.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', clipPath,
          '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', tmp], { timeoutMs: 60000 });
        if (r2.code !== 0) {
          await fsp.rm(tmp, { force: true });
          return null;
        }
      }
      await fsp.rename(tmp, out);
      return out;
    }).finally(() => this.inFlight.delete(out));
    this.inFlight.set(out, p);
    return p;
  }
}

module.exports = { Thumbnails };
