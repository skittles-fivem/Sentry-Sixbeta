'use strict';

// Builds the one ffmpeg command line used for real encodes. Encoder
// detection runs its test encodes through this same function, so a passing
// detection means the production arguments work on this hardware.

/** Encoder families per backend, in auto-detect priority order. */
const BACKENDS = {
  nvenc: { name: 'NVIDIA NVENC', codecs: { h264: 'h264_nvenc', hevc: 'hevc_nvenc' }, needsDevice: false },
  qsv: { name: 'Intel Quick Sync', codecs: { h264: 'h264_qsv', hevc: 'hevc_qsv' }, needsDevice: true },
  vaapi: { name: 'VAAPI (Intel/AMD)', codecs: { h264: 'h264_vaapi', hevc: 'hevc_vaapi' }, needsDevice: true },
  software: { name: 'CPU (x264/x265)', codecs: { h264: 'libx264', hevc: 'libx265' }, needsDevice: false }
};
const BACKEND_ORDER = ['nvenc', 'qsv', 'vaapi', 'software'];

function hwInitArgs(backend, device) {
  if (backend === 'vaapi') return ['-vaapi_device', device];
  if (backend === 'qsv') {
    // Derive QSV from an explicit VAAPI node so multi-GPU hosts use the right card.
    return ['-init_hw_device', `vaapi=va:${device}`, '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', 'qs'];
  }
  return [];
}

function qualityArgs(backend, family, { quality, preset }) {
  const q = String(quality);
  switch (backend) {
    case 'nvenc':
      return ['-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', q, '-b:v', '0'];
    case 'qsv':
      return ['-preset', 'medium', '-global_quality', q];
    case 'vaapi':
      return ['-rc_mode', 'CQP', '-qp', q];
    default: {
      const args = ['-preset', preset || 'faster', '-crf', q];
      if (family === 'hevc') args.push('-x265-params', 'log-level=error');
      else args.push('-profile:v', 'high');
      return args;
    }
  }
}

function pixelArgs(backend) {
  if (backend === 'vaapi') return ['-vf', 'format=nv12,hwupload'];
  if (backend === 'qsv') return ['-vf', 'format=nv12,hwupload=extra_hw_frames=64'];
  return ['-pix_fmt', 'yuv420p'];
}

/**
 * @param {object} o
 * @param {string} o.input
 * @param {string} o.output
 * @param {{backend: string, codec: string, device?: string, supportsSei?: boolean}} o.encoder
 * @param {'h264'|'hevc'} o.family
 * @param {number} o.quality
 * @param {string} [o.preset]
 * @param {number} [o.fps] source frame rate, used for a ~1 s keyframe interval
 * @param {boolean} [o.preserveTelemetry]
 * @param {string} [o.marker] comment tag that marks the output as ours
 * @param {boolean} [o.progress] emit -progress key=value lines on stdout
 * @param {string[]} [o.inputArgs] extra args before -i (tests use lavfi)
 */
function buildEncodeArgs(o) {
  const { backend, codec, device } = o.encoder;
  const gop = Math.max(1, Math.round(o.fps || 36));
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
  args.push(...hwInitArgs(backend, device));
  if (o.inputArgs) args.push(...o.inputArgs);
  args.push('-i', o.input);
  args.push('-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0');
  args.push('-c:v', codec);
  args.push(...qualityArgs(backend, o.family, o));
  if (o.preserveTelemetry && o.encoder.supportsSei) {
    // Tesla stores telemetry (speed, GPS, Autopilot) as per-frame
    // user-data-unregistered SEI; this copies it into the new stream.
    args.push('-udu_sei', '1');
  }
  if (o.family === 'h264') {
    // Sentry Studio walks NAL units in decode order and treats each slice
    // as a frame: no B-frames and one slice per frame keeps it in sync.
    args.push('-bf', '0', '-slices', '1');
  } else {
    args.push('-tag:v', 'hvc1');
  }
  args.push('-g', String(gop));
  args.push(...pixelArgs(backend));
  // Tesla clips have uneven frame timing; keep every frame and timestamp.
  args.push('-fps_mode', 'passthrough');
  args.push('-c:a', 'copy');
  if (o.marker) args.push('-metadata', `comment=${o.marker}`);
  args.push('-movflags', '+faststart');
  if (o.progress) args.push('-progress', 'pipe:1', '-nostats');
  args.push('-f', 'mp4', o.output);
  return args;
}

module.exports = { buildEncodeArgs, BACKENDS, BACKEND_ORDER };
