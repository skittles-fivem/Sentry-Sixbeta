'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVerificationSnapshot } = require('../../../src/main/converter/verificationSnapshot');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('verification snapshot', () => {
  let root;
  beforeEach(async () => { root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'snap-test-')); });
  afterEach(async () => {
    await fs.promises.chmod(root, 0o700).catch(() => {});
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  async function candidate(bytes) {
    const file = path.join(root, 'candidate.mp4');
    await fs.promises.writeFile(file, bytes);
    return file;
  }

  test('moves the candidate into the snapshot instead of writing a copy', async () => {
    const bytes = crypto.randomBytes(4096);
    const file = await candidate(bytes);
    const { ino } = await fs.promises.stat(file);
    const snapshot = await createVerificationSnapshot({ bytes, sha256: digest(bytes), tempRoot: root, adoptPath: file });
    expect(fs.existsSync(file)).toBe(false);
    expect((await fs.promises.stat(snapshot.path)).ino).toBe(ino);
    expect(Buffer.compare(await snapshot.read(), bytes)).toBe(0);
    await snapshot.cleanup();
  });

  test('copies instead when the candidate has another hard link', async () => {
    const bytes = crypto.randomBytes(4096);
    const file = await candidate(bytes);
    await fs.promises.link(file, path.join(root, 'alias.mp4'));
    const snapshot = await createVerificationSnapshot({ bytes, sha256: digest(bytes), tempRoot: root, adoptPath: file });
    expect(fs.existsSync(file)).toBe(true);
    expect((await fs.promises.stat(snapshot.path)).ino).not.toBe((await fs.promises.stat(file)).ino);
    await snapshot.cleanup();
  });

  test('copies instead when the candidate size no longer matches what was read', async () => {
    const bytes = crypto.randomBytes(4096);
    const file = await candidate(Buffer.concat([bytes, Buffer.from([1])]));
    const snapshot = await createVerificationSnapshot({ bytes, sha256: digest(bytes), tempRoot: root, adoptPath: file });
    expect(fs.existsSync(file)).toBe(true);
    expect(Buffer.compare(await snapshot.read(), bytes)).toBe(0);
    await snapshot.cleanup();
  });

  test('a moved candidate whose content changed is caught by the integrity read', async () => {
    const bytes = crypto.randomBytes(4096);
    const tampered = Buffer.from(bytes);
    tampered[0] ^= 0xff;
    const file = await candidate(tampered);
    const snapshot = await createVerificationSnapshot({ bytes, sha256: digest(bytes), tempRoot: root, adoptPath: file });
    await expect(snapshot.read()).rejects.toThrow('Snapshot integrity check failed');
    await snapshot.cleanup();
  });

  test('without adoptPath it writes a private copy as before', async () => {
    const bytes = crypto.randomBytes(1024);
    const snapshot = await createVerificationSnapshot({ bytes, sha256: digest(bytes), tempRoot: root });
    expect(Buffer.compare(await snapshot.read(), bytes)).toBe(0);
    await snapshot.cleanup();
  });
});
