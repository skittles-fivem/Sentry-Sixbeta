'use strict';

const fs = require('fs');
const path = require('path');

const CLIP_TYPES = ['RecentClips', 'SentryClips', 'SavedClips', 'Other'];
const ENCODER_IDS = ['auto', 'nvenc', 'qsv', 'vaapi', 'software'];

function str(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed === '' ? fallback : trimmed;
}

function bool(value, fallback) {
  const v = str(value).toLowerCase();
  if (!v) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function int(value, fallback, min = -Infinity, max = Infinity) {
  const n = Number.parseInt(str(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function list(value, fallback, allowed) {
  const raw = str(value);
  if (!raw) return fallback.slice();
  const byLower = new Map(allowed.map((a) => [a.toLowerCase(), a]));
  const out = [];
  for (const part of raw.split(',')) {
    const hit = byLower.get(part.trim().toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out.length ? out : fallback.slice();
}

/** Read a secret from VAR or VAR_FILE (docker secrets style). */
function secret(env, name) {
  const file = str(env[`${name}_FILE`]);
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new Error(`Could not read ${name}_FILE (${file}): ${err.message}`);
    }
  }
  return env[name] === undefined ? '' : String(env[name]);
}

function loadConfig(env = process.env) {
  const dataPath = path.resolve(str(env.DATA_PATH, '/data'));
  const codec = str(env.ENCODE_CODEC, 'h264').toLowerCase() === 'hevc' ? 'hevc' : 'h264';
  const encoder = str(env.ENCODER, 'auto').toLowerCase();

  return {
    port: int(env.PORT, 9000, 1, 65535),
    host: str(env.HOST, '0.0.0.0'),
    footagePath: path.resolve(str(env.FOOTAGE_PATH, '/footage')),
    dataPath,
    scratchPath: path.resolve(str(env.SCRATCH_PATH, path.join(dataPath, 'scratch'))),
    scanIntervalMinutes: int(env.SCAN_INTERVAL_MINUTES, 15, 1, 24 * 60),
    smb: {
      share: str(env.SMB_SHARE).replace(/\\/g, '/'),
      username: str(env.SMB_USERNAME),
      password: secret(env, 'SMB_PASSWORD'),
      domain: str(env.SMB_DOMAIN),
      version: str(env.SMB_VERSION, '3.0'),
      options: str(env.SMB_OPTIONS),
      uid: int(env.PUID, 0, 0),
      gid: int(env.PGID, 0, 0)
    },
    encode: {
      enabled: bool(env.AUTO_ENCODE, true),
      codec,
      encoder: ENCODER_IDS.includes(encoder) ? encoder : 'auto',
      device: str(env.ENCODER_DEVICE),
      quality: int(env.ENCODE_QUALITY, codec === 'hevc' ? 28 : 26, 1, 51),
      preset: str(env.ENCODE_PRESET, 'faster'),
      preserveTelemetry: bool(env.PRESERVE_TELEMETRY, true),
      minAgeMinutes: int(env.ENCODE_MIN_AGE_MINUTES, 30, 0),
      minSavingsPercent: int(env.ENCODE_MIN_SAVINGS_PERCENT, 10, 0, 90),
      concurrency: int(env.ENCODE_CONCURRENCY, 1, 1, 8),
      types: list(env.ENCODE_TYPES, CLIP_TYPES, CLIP_TYPES),
      maxAttempts: 3
    },
    auth: {
      username: str(env.UI_USERNAME, 'admin'),
      password: secret(env, 'UI_PASSWORD')
    },
    ffmpegPath: str(env.FFMPEG_PATH, 'ffmpeg'),
    ffprobePath: str(env.FFPROBE_PATH, 'ffprobe')
  };
}

/** Config with secrets removed, safe to send to the browser. */
function publicConfig(config) {
  return {
    footagePath: config.footagePath,
    scanIntervalMinutes: config.scanIntervalMinutes,
    smb: {
      share: config.smb.share,
      username: config.smb.username,
      version: config.smb.version
    },
    encode: { ...config.encode },
    authEnabled: Boolean(config.auth.password)
  };
}

module.exports = { loadConfig, publicConfig, CLIP_TYPES };
