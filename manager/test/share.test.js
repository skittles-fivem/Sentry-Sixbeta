'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { ShareManager, findMount, buildMountOptions, credentialsFile, explainMountError } = require('../src/share');
const { loadConfig } = require('../src/config');
const { Logger } = require('../src/log');
const { tmpDir, rmrf } = require('./helpers/fixtures');

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

test('mount options keep the password off the command line and let users override', () => {
  const smb = { username: 'tesla', password: 'p,a=s s', domain: '', version: '3.0', options: '', uid: 1000, gid: 1000 };
  const opts = buildMountOptions(smb, '/run/sentry-manager/smb-credentials');
  assert.equal(opts, 'credentials=/run/sentry-manager/smb-credentials,vers=3.0,uid=1000,gid=1000,file_mode=0664,dir_mode=0775,noserverino');
  assert.ok(!opts.includes('p,a=s s'));
  assert.equal(credentialsFile(smb), 'username=tesla\npassword=p,a=s s\n');

  const guest = buildMountOptions({ ...smb, username: '', version: 'default', options: 'vers=2.1, file_mode=0777,seal' }, '/x');
  assert.equal(guest, 'guest,uid=1000,gid=1000,dir_mode=0775,noserverino,vers=2.1,file_mode=0777,seal');
  assert.equal(credentialsFile({ username: 'a\nb', password: 'c', domain: 'HOME' }), 'username=ab\npassword=c\ndomain=HOME\n');
});

test('mount errors come with actionable hints', () => {
  assert.match(explainMountError('mount error(13): Permission denied'), /SMB_PASSWORD/);
  assert.match(explainMountError('mount error(1): Operation not permitted'), /SYS_ADMIN/);
  assert.match(explainMountError('Unable to apply new capability set.'), /SYS_ADMIN/, 'no cap_add at all');
  assert.match(explainMountError('mount error(112): Host is down'), /SMB_VERSION/);
  assert.match(explainMountError('mount error(2): No such file or directory'), /\/\/server\/share/);
  assert.match(explainMountError('mount: unknown filesystem type \'cifs\''), /modprobe cifs/);
  assert.equal(explainMountError('something new'), null);
});

function makeShare({ root, mountinfo, smbShare = '', runCmd, credDir }) {
  const config = loadConfig({
    FOOTAGE_PATH: root, DATA_PATH: path.join(root, '..', 'data'),
    SMB_SHARE: smbShare, SMB_USERNAME: 'tesla', SMB_PASSWORD: 'secret!', PUID: '1000', PGID: '1000'
  });
  return new ShareManager({
    config, log: new Logger({ silent: true }).scope('share'), runCmd, mountinfoPath: mountinfo, credDir
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
      const credFile = args[args.indexOf('-o') + 1].match(/credentials=([^,]+)/)[1];
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
    assert.equal(fs.existsSync(path.join(dir, 'run', 'smb-credentials')), false, 'credentials removed on stop');
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
    assert.match(st.hint, /SMB_USERNAME/);
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
