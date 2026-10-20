'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConverterRuntime } = require('../../../src/main/converter/runtime');

const HOUR = 60 * 60 * 1000;

describe('leftover converter work folders after a crash', () => {
  let root;
  let runtime;
  let tempPath;

  beforeEach(async () => {
    root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-six-sweep-')));
    tempPath = path.join(root, 'temp');
    await fs.promises.mkdir(tempPath);
    runtime = await createConverterRuntime({
      userDataPath: path.join(root, 'user-data'), tempPath,
      ffmpegPath: path.join(root, 'ffmpeg'), ffprobePath: path.join(root, 'ffprobe'),
      fs, pathApi: path, platform: process.platform, autoConvert: false, sweepLeftoversOnStart: false,
      spawn: () => { throw new Error('no encoding in this test'); }
    });
  });
  afterEach(async () => {
    await runtime?.shutdown?.();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const workFolders = async () => (await fs.promises.readdir(tempPath))
    .filter((name) => name.startsWith('sentry-six-verification-') || name === 'other-app-folder').sort();

  async function leftover(name, ageMs) {
    const folder = path.join(tempPath, name);
    await fs.promises.mkdir(folder);
    await fs.promises.writeFile(path.join(folder, 'partial.mp4'), 'partial copy');
    const when = (Date.now() - ageMs) / 1000;
    await fs.promises.utimes(folder, when, when);
    return folder;
  }

  const config = (rootDir) => ({ sourceRoot: path.join(rootDir, 'src'), destinationRoot: path.join(rootDir, 'dst'),
    includedGroups: ['RecentClips'], codec: 'h265', profileId: 'balanced', networkMode: 'direct',
    outputMode: 'separate', replacementConfirmed: false });

  test('removes old leftovers when no job is unfinished, but keeps recent ones and unrelated folders', async () => {
    await leftover('sentry-six-verification-old', 3 * HOUR);
    await leftover('sentry-six-verification-new', 60_000);
    await leftover('other-app-folder', 3 * HOUR);
    await runtime.store.create({ id: 'job-done', state: 'completed', summaryDismissed: true, summary: null, config: config(root) });

    expect(await runtime.sweepLeftoverSnapshotFolders()).toBe(1);
    expect(await workFolders()).toEqual(['other-app-folder', 'sentry-six-verification-new']);
  });

  test('leaves everything while a job could still resume into it', async () => {
    await leftover('sentry-six-verification-old', 3 * HOUR);
    await runtime.store.create({ id: 'job-paused', state: 'paused', config: config(root) });

    expect(await runtime.sweepLeftoverSnapshotFolders()).toBe(0);
    expect(await workFolders()).toEqual(['sentry-six-verification-old']);
  });

  test('keeps a folder that a finished job still points into', async () => {
    const kept = await leftover('sentry-six-verification-owned', 3 * HOUR);
    await runtime.store.create({ id: 'job-done', state: 'completed', summaryDismissed: true, summary: null, config: config(root), items: [{
      id: 'item-1', state: 'completed', resultCode: 'completed-cleanup-pending', kind: 'video', group: 'RecentClips',
      eventId: null, relativePath: 'RecentClips/clip.mp4', sourcePath: path.join(root, 'src', 'RecentClips', 'clip.mp4'),
      sourceBytes: 1, mtimeMs: 1, timestampKey: 'clip', camera: 'front',
      outputBytes: 1, outputPath: path.join(root, 'dst', 'RecentClips', 'clip.mp4'),
      ownedPaths: { publicationSnapshot: path.join(kept, 'partial.mp4') }
    }] });

    expect(await runtime.sweepLeftoverSnapshotFolders()).toBe(0);
    expect(await workFolders()).toEqual(['sentry-six-verification-owned']);
  });
});
