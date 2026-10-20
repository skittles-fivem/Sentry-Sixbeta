'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEncodeArgs } = require('../src/ffmpegArgs');

const base = { input: '/footage/a.mp4', output: '/scratch/a.mp4', family: 'h264', quality: 26, preset: 'faster', fps: 36.02, preserveTelemetry: true, marker: 'SentryManager v1' };
const after = (args, flag) => args[args.indexOf(flag) + 1];

test('software H.264 keeps telemetry, no B-frames, one slice, every frame', () => {
  const args = buildEncodeArgs({ ...base, encoder: { backend: 'software', codec: 'libx264', supportsSei: true }, progress: true });
  assert.equal(after(args, '-c:v'), 'libx264');
  assert.equal(after(args, '-crf'), '26');
  assert.equal(after(args, '-udu_sei'), '1');
  assert.equal(after(args, '-bf'), '0');
  assert.equal(after(args, '-slices'), '1');
  assert.equal(after(args, '-g'), '36');
  assert.equal(after(args, '-fps_mode'), 'passthrough');
  assert.equal(after(args, '-metadata'), 'comment=SentryManager v1');
  assert.equal(after(args, '-map_metadata'), '0');
  assert.equal(after(args, '-progress'), 'pipe:1');
  assert.ok(args.indexOf('-i') < args.indexOf('-c:v'));
  assert.equal(args[args.length - 1], '/scratch/a.mp4');
});

test('udu_sei is only passed when the encoder supports it and telemetry is wanted', () => {
  const vaapi = buildEncodeArgs({ ...base, encoder: { backend: 'vaapi', codec: 'h264_vaapi', device: '/dev/dri/renderD129', supportsSei: false } });
  assert.ok(!vaapi.includes('-udu_sei'));
  assert.equal(after(vaapi, '-vaapi_device'), '/dev/dri/renderD129');
  assert.ok(vaapi.indexOf('-vaapi_device') < vaapi.indexOf('-i'), 'device is declared before the input');
  assert.equal(after(vaapi, '-vf'), 'format=nv12,hwupload');
  assert.equal(after(vaapi, '-rc_mode'), 'CQP');

  const off = buildEncodeArgs({ ...base, preserveTelemetry: false, encoder: { backend: 'nvenc', codec: 'h264_nvenc', supportsSei: true } });
  assert.ok(!off.includes('-udu_sei'));
});

test('NVENC and QSV get their own rate control and device setup', () => {
  const nv = buildEncodeArgs({ ...base, encoder: { backend: 'nvenc', codec: 'h264_nvenc', supportsSei: true } });
  assert.equal(after(nv, '-cq'), '26');
  assert.equal(after(nv, '-rc'), 'vbr');
  assert.equal(after(nv, '-udu_sei'), '1');
  assert.equal(after(nv, '-pix_fmt'), 'yuv420p');

  const qsv = buildEncodeArgs({ ...base, encoder: { backend: 'qsv', codec: 'h264_qsv', device: '/dev/dri/renderD128', supportsSei: false } });
  assert.deepEqual(qsv.slice(qsv.indexOf('-init_hw_device'), qsv.indexOf('-i')), [
    '-init_hw_device', 'vaapi=va:/dev/dri/renderD128', '-init_hw_device', 'qsv=qs@va', '-filter_hw_device', 'qs'
  ]);
  assert.equal(after(qsv, '-global_quality'), '26');
});

test('HEVC output is tagged hvc1 and may use B-frames', () => {
  const args = buildEncodeArgs({ ...base, family: 'hevc', quality: 28, encoder: { backend: 'software', codec: 'libx265', supportsSei: true } });
  assert.equal(after(args, '-c:v'), 'libx265');
  assert.equal(after(args, '-tag:v'), 'hvc1');
  assert.ok(!args.includes('-bf'));
});
