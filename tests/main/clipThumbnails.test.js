'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createClipThumbnails } = require('../../src/main/clipThumbnails');

function tool(name) {
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : null;
}
const ffmpegPath = tool('ffmpeg');
const ffprobePath = tool('ffprobe');
const maybe = ffmpegPath && ffprobePath ? describe : describe.skip;

maybe('clip filmstrips (real FFmpeg)', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-thumbs-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function makeClip(name, seconds = 12) {
    const target = path.join(root, name);
    const result = spawnSync(ffmpegPath, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
      '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-y', target]);
    if (result.status !== 0) throw new Error('fixture failed');
    return target;
  }

  test('makes a six-frame strip once and reuses it', async () => {
    const thumbs = createClipThumbnails({ directory: path.join(root, 'cache'), ffmpegPath, ffprobePath, spawn });
    const clip = makeClip('2026-08-30_12-00-00-front.mp4');
    const strip = await thumbs.get(clip);
    expect(strip).toMatch(/\.jpg$/);
    const bytes = fs.readFileSync(strip);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG
    // SOF0 dimensions: six 160px frames side by side
    const sof = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    expect(bytes.readUInt16BE(sof + 7)).toBe(960);
    const firstTime = fs.statSync(strip).mtimeMs;
    expect(await thumbs.get(clip)).toBe(strip);
    expect(fs.statSync(strip).mtimeMs).toBe(firstTime);
    expect(await thumbs.get(clip, { create: false })).toBe(strip);
  }, 60_000);

  test('a changed clip gets a fresh strip; unreadable and non-video paths give none', async () => {
    const thumbs = createClipThumbnails({ directory: path.join(root, 'cache'), ffmpegPath, ffprobePath, spawn });
    const clip = makeClip('clip.mp4');
    const first = await thumbs.get(clip);
    makeClip('clip.mp4', 6);
    const second = await thumbs.get(clip);
    expect(second).not.toBe(first);
    fs.writeFileSync(path.join(root, 'broken.mp4'), 'not a video');
    expect(await thumbs.get(path.join(root, 'broken.mp4'))).toBeNull();
    expect(await thumbs.get(path.join(root, 'missing.mp4'))).toBeNull();
    expect(await thumbs.get('relative.mp4')).toBeNull();
    expect(await thumbs.get(path.join(root, 'notes.txt'))).toBeNull();
    expect(fs.readdirSync(path.join(root, 'cache')).filter((name) => name.includes('.tmp'))).toEqual([]);
  }, 60_000);

  test('concurrent requests for the same clip share one generation', async () => {
    let spawned = 0;
    const counting = (...args) => { spawned += 1; return spawn(...args); };
    const thumbs = createClipThumbnails({ directory: path.join(root, 'cache'), ffmpegPath, ffprobePath, spawn: counting });
    const clip = makeClip('shared.mp4');
    const results = await Promise.all([thumbs.get(clip), thumbs.get(clip), thumbs.get(clip)]);
    expect(new Set(results).size).toBe(1);
    expect(spawned).toBe(2); // one ffprobe + one ffmpeg
  }, 60_000);
});
