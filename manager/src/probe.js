'use strict';

const { run, tail } = require('./proc');

const MARKER_PREFIX = 'SentryManager';

function parseRate(rate) {
  if (!rate || typeof rate !== 'string') return null;
  const [num, den] = rate.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return null;
  return num / den;
}

/** The tag written into every file we encode, so it is never encoded twice. */
function buildMarker({ codec, encoder, originalSize }) {
  return `${MARKER_PREFIX} v1; codec=${codec}; encoder=${encoder}; orig=${originalSize}`;
}

function parseMarker(comment) {
  if (typeof comment !== 'string' || !comment.startsWith(MARKER_PREFIX)) return null;
  const fields = {};
  for (const part of comment.split(';')) {
    const [k, v] = part.split('=').map((s) => s && s.trim());
    if (k && v !== undefined) fields[k] = v;
  }
  return {
    codec: fields.codec || null,
    encoder: fields.encoder || null,
    originalSize: fields.orig ? Number(fields.orig) : null
  };
}

/** ffprobe a file. Reads only the container header (moov), not the whole file. */
async function probeFile(ffprobePath, file, { timeoutMs = 60000 } = {}) {
  const res = await run(ffprobePath, [
    '-v', 'error',
    '-show_entries',
    'format=duration,size,bit_rate:format_tags=comment:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames',
    '-of', 'json',
    file
  ], { timeoutMs });
  if (res.code !== 0) {
    const err = new Error(`ffprobe failed: ${tail(res.stderr) || res.error?.message || `exit ${res.code}`}`);
    err.stderr = res.stderr;
    err.unreadable = /moov atom not found|Invalid data found|could not find codec parameters/i.test(res.stderr);
    throw err;
  }
  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const tags = data.format?.tags || {};
  const comment = tags.comment ?? tags.COMMENT ?? null;
  return {
    duration: Number(data.format?.duration) || null,
    size: Number(data.format?.size) || null,
    bitRate: Number(data.format?.bit_rate) || null,
    comment,
    marker: parseMarker(comment),
    video: video ? {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
      frames: video.nb_frames ? Number(video.nb_frames) : null
    } : null,
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length
  };
}

/** Exact frame count by demuxing (used when the header has no nb_frames). */
async function countFrames(ffprobePath, file, { timeoutMs = 300000 } = {}) {
  const res = await run(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file
  ], { timeoutMs });
  const n = Number.parseInt(res.stdout.trim(), 10);
  return res.code === 0 && Number.isFinite(n) ? n : null;
}

module.exports = { probeFile, countFrames, buildMarker, parseMarker, parseRate, MARKER_PREFIX };
