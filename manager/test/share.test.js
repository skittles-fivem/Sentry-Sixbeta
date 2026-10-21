'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { ShareManager, findMount, explainMountError } = require('../server/share');
const { createLocalMounter } = require('../server/mounter');
const os = require('os');
const { Logger } = require('../server/log');

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'share-test-'));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

const MOUNTINFO = [
  '22 1 0:21 / / rw,relatime - overlay overlay rw',
  '30 22 8:1 /srv/data /data rw,relatime - ext4 /dev/sda1 rw',
  '41 22 0:45 / /footage rw,relatime - cifs //192.168.1.50/TeslaCam rw,vers=3.0,cache=strict',
  '42 22 0:46 / /mnt/with\\040space rw - nfs4 nas:/export rw'
].join('\n');

test('findMount reads /proc/self/mountinfo', () => {
  assert.deepEqual(findMount(MOUNTINFO, '/footage'), {
    mountPoint: '/footage', fsType: 'cifs', source: '//192.168.1.50/TeslaCam', options: 'rw,vers=3.0,cache=strict'
  });
  assert.equal(findMount(MOUNTINFO, '/mnt/with space').fsType, 'nfs4');
  assert.equal(findMount(MOUNTINFO, '/nope'), null);
});

test('mount errors come with actionable hints', () => {
  assert.match(explainMountError('mount error(13): Permission denied'), /user name or password/);
  assert.match(explainMountError('mount error(1): Operation not permitted'), /SYS_ADMIN/);
  assert.match(explainMountError('Unable to apply new capability set.'), /SYS_ADMIN/, 'no cap_add at all');
  assert.match(explainMountError('mount error(112): Host is down'), /SMB 3/);
  assert.match(explainMountError('mount error(95): Operation not supported'), /encryption/);
  assert.match(explainMountError('mount error(2): No such file or directory'), /\/\/server\/share/);
  assert.match(explainMountError('mount: unknown filesystem type \'cifs\''), /modprobe cifs/);
  assert.equal(explainMountError('something new'), null);
});

function makeShare({ root, mountinfo, smbShare = '', runCmd, credDir }) {
  const config = {
    footagePath: root,
    smb: { share: smbShare, username: 'tesla', password: 'secret!', domain: '', version: '3.1.1', encrypt: true }
  };
  // the same mounter the root supervisor uses, with mount/umount faked
  const mounter = createLocalMounter({ footageRoot: path.dirname(root), credDir, uid: 1000, gid: 1000, runCmd });
  return new ShareManager({
    config, log: new Logger({ silent: true }).scope('share'), mounter: smbShare ? mounter : null, mountinfoPath: mountinfo, id: path.basename(root)
  });
}

test('SMB mode mounts the share, writes a 0600 credentials file and passes the write test', async () => {
  const dir = await tmpDir();
  const root = path.join(dir, 'footage');
  const mountinfo = path.join(dir, 'mountinfo');
  await fsp.writeFile(mountinfo, '22 1 0:21 / / rw - overlay overlay rw\n');
  const calls = [];
  const runCmd = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'mount') {
      const opts = args[args.indexOf('-o') + 1].split(',');
      for (const o of ['vers=3.1.1', 'sec=ntlmssp', 'seal', 'nosuid', 'nodev', 'noexec', 'uid=1000', 'gid=1000', 'forceuid', 'forcegid']) assert.ok(opts.includes(o), `mount option ${o}`);
      assert.ok(!opts.includes('guest') && !opts.some((o) => /^(exec|suid|dev)$/.test(o)));
      const credFile = opts.find((o) => o.startsWith('credentials=')).slice('credentials='.length);
      const st = fs.statSync(credFile);
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(credFile, 'utf8'), 'username=tesla\npassword=secret!\n');
      await fsp.appendFile(mountinfo, `41 22 0:45 / ${root} rw - cifs //nas/TeslaCam rw\n`);
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const share = makeShare({ root, mountinfo, smbShare: '//nas/TeslaCam', runCmd, credDir: path.join(dir, 'run') });
  try {
    const st = await share.ensure({ forceWriteCheck: true });
    assert.equal(calls[0][0], 'mount');
    assert.deepEqual(calls[0].slice(1, 5), ['-t', 'cifs', '//nas/TeslaCam', root]);
    assert.ok(!calls[0].join(' ').includes('secret!'), 'password never on the command line');
    assert.equal(st.healthy, true);
    assert.equal(st.mounted, true);
    assert.equal(st.fsType, 'cifs');
    assert.equal(st.writable, true);
    assert.equal(st.renameOverwrite, true);
    assert.deepEqual(fs.readdirSync(root), [], 'write test cleans up after itself');

    // second check does not remount
    await share.ensure();
    assert.equal(calls.filter((c) => c[0] === 'mount').length, 1);

    await share.stop();
    assert.equal(calls[calls.length - 1][0], 'umount');
    assert.equal(fs.existsSync(path.join(dir, 'run', 'footage.cred')), false, 'credentials removed on stop');
  } finally {
    rmrf(dir);
  }
});

test('SMB mount failure reports the error, a hint, and backs off', async () => {
  const dir = await tmpDir();
  const root = path.join(dir, 'footage');
  const mountinfo = path.join(dir, 'mountinfo');
  await fsp.writeFile(mountinfo, '');
  let mounts = 0;
  const runCmd = async () => {
    mounts++;
    return { code: 32, stdout: '', stderr: 'mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page' };
  };
  const share = makeShare({ root, mountinfo, smbShare: '//nas/TeslaCam', runCmd, credDir: path.join(dir, 'run') });
  try {
    const st = await share.ensure();
    assert.equal(st.healthy, false);
    assert.match(st.lastError, /Permission denied/);
    assert.match(st.hint, /user name or password/);
    await share.ensure();
    assert.equal(mounts, 1, 'does not hammer the server while backing off');
    await share.reconnect();
    assert.equal(mounts, 2, 'Reconnect retries immediately');
  } finally {
    rmrf(dir);
  }
});

test('local mode health-checks a plain folder and warns when nothing is mounted', async () => {
  const dir = await tmpDir();
  const root = path.join(dir, 'footage');
  const mountinfo = path.join(dir, 'mountinfo');
  await fsp.writeFile(mountinfo, '');
  const share = makeShare({ root, mountinfo, runCmd: async () => assert.fail('no mount in local mode'), credDir: path.join(dir, 'run') });
  try {
    let st = await share.ensure();
    assert.equal(st.healthy, false);
    assert.match(st.lastError, /does not exist/);
    fs.mkdirSync(root);
    st = await share.ensure({ forceWriteCheck: true });
    assert.equal(st.healthy, true);
    assert.equal(st.writable, true);
    assert.match(st.warning, /Nothing is mounted/);
    assert.ok(st.freeBytes > 0);
  } finally {
    rmrf(dir);
  }
});
