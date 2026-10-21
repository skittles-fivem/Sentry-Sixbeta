'use strict';

// The one place that turns a vehicle's SMB settings into a mount.cifs call.
// Everything is rebuilt from validated fields; nothing the user typed reaches
// the -o string as free text, so no setting can add options like exec, suid,
// sec=none, vers=1.0 or credentials=/etc/shadow.
//
// Security of every mount:
//   - SMB 3 only (3.1.1, or 3.0/3.02 for older servers). SMB 1/2 have no
//     encryption and weaker downgrade protection.
//   - Encrypted (seal) by default. With encryption turned off, signing is
//     still required. Either way a man in the middle who does not know the
//     password can neither read nor change what is sent, nor pose as the NAS.
//   - An account is required: a guest session has no keys to sign or encrypt.
//   - nosuid,nodev,noexec: nothing on a share can become a setuid program,
//     a device node or an executable inside the container.
//   - The password goes in a 0600 credentials file, never on a command line.

const VERSIONS = Object.freeze({
  '3.1.1': 'SMB 3.1.1 (recommended)',
  '3.02': 'SMB 3.02',
  '3.0': 'SMB 3.0',
  '3': 'SMB 3.0 or newer (best the server offers)'
});
const DEFAULT_VERSION = '3.1.1';

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9A-Fa-f:.]+\])$/;
// share and folder names: no separators, commas (mount.cifs passes the UNC as
// a mount option), quotes or control characters
const SEGMENT_RE = /^[^\\/,"\x00-\x1f\x7f]{1,80}$/;
const USER_RE = /^[^\s\\/,%:"\x00-\x1f\x7f]{1,104}$/;
const DOMAIN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function bad(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_SMB' });
}

/** Parse //host/share[/folder...] strictly. */
function parseShare(value) {
  const s = String(value || '').trim().replace(/\\/g, '/');
  const m = s.match(/^\/\/([^/]+)\/(.+?)\/?$/);
  if (!m) throw bad('The SMB share must look like //192.168.1.50/TeslaCam (optionally //server/share/folder).');
  const [, host, rest] = m;
  if (!HOST_RE.test(host)) throw bad('The server in the share must be an IP address or a host name.');
  const segments = rest.split('/');
  if (segments.some((seg) => !SEGMENT_RE.test(seg) || seg === '.' || seg === '..' || seg.trim() !== seg)) {
    throw bad('The share or folder name has characters a share cannot use (commas, quotes, \\ or control characters).');
  }
  return { host, share: segments[0], folder: segments.slice(1), unc: `//${host}/${segments.join('/')}` };
}

/** Validate and normalize the SMB part of a vehicle. `prev` keeps a stored password. */
function normalizeSmb(input, prev = null) {
  const parsed = parseShare(input.share);
  const username = String(input.username ?? '').trim();
  if (!username) throw bad('Enter the SMB user name. Guest access cannot be encrypted or signed, so it is not allowed.');
  if (!USER_RE.test(username)) throw bad('The user name may not contain spaces, \\ / , % : or quotes. Put a Windows domain in the Domain field.');
  const password = input.password === undefined || input.password === null
    ? String(prev?.password || '')
    : String(input.password);
  if (!password) throw bad('Enter the SMB password.');
  if (password.length > 256 || /[\r\n\0]/.test(password)) throw bad('The password may not contain line breaks and must be at most 256 characters.');
  const domain = String(input.domain ?? '').trim();
  if (domain && !DOMAIN_RE.test(domain)) throw bad('The domain may use letters, numbers, . _ and - only.');
  const version = String(input.version ?? prev?.version ?? DEFAULT_VERSION).trim();
  if (!VERSIONS[version]) throw bad('Choose SMB 3.1.1, 3.02 or 3.0. Older SMB versions are not secure against a man in the middle.');
  const encrypt = input.encrypt === undefined ? (prev ? prev.encrypt !== false : true) : input.encrypt !== false;
  let port = null;
  if (input.port !== undefined && input.port !== null && input.port !== '') {
    port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('The port must be a number from 1 to 65535.');
  }
  return { type: 'smb', share: parsed.unc, username, password, domain, version, encrypt, port };
}

function credentialsText(smb) {
  for (const v of [smb.username, smb.password, smb.domain]) {
    if (/[\r\n\0]/.test(String(v || ''))) throw bad('Line breaks are not allowed in SMB credentials.');
  }
  let text = `username=${smb.username}\npassword=${smb.password}\n`;
  if (smb.domain) text += `domain=${smb.domain}\n`;
  return text;
}

/**
 * Arguments for `mount` (mount.cifs) for a validated SMB source.
 * uid/gid own every file on the mount (the unprivileged app user).
 */
function mountArgs(smbInput, { target, credFile, uid, gid }) {
  const smb = normalizeSmb(smbInput, smbInput);
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) throw bad('Invalid uid/gid for the mount.');
  if (typeof target !== 'string' || !target.startsWith('/') || /[,\s\0]/.test(target)) throw bad('Invalid mount point.');
  if (typeof credFile !== 'string' || !credFile.startsWith('/') || /[,\s\0]/.test(credFile)) throw bad('Invalid credentials file.');
  const opts = [
    `credentials=${credFile}`,
    `vers=${smb.version}`,
    'sec=ntlmssp',
    smb.encrypt ? 'seal' : 'sign',
    'nosuid', 'nodev', 'noexec',
    `uid=${uid}`, `gid=${gid}`, 'forceuid', 'forcegid',
    'file_mode=0660', 'dir_mode=0770',
    // serverino (the default) keeps inode numbers stable, which the
    // converter's identity checks rely on
    'serverino'
  ];
  if (smb.port) opts.push(`port=${smb.port}`);
  return { smb, args: ['-t', 'cifs', smb.share, target, '-o', opts.join(',')] };
}

/** Short description of how a vehicle's share is protected, for the UI. */
function securitySummary(smb) {
  return smb.encrypt
    ? `${VERSIONS[smb.version] || smb.version}, encrypted and signed`
    : `${VERSIONS[smb.version] || smb.version}, signed (not encrypted: someone on the network could see the footage, but not change it)`;
}

module.exports = { VERSIONS, DEFAULT_VERSION, parseShare, normalizeSmb, credentialsText, mountArgs, securitySummary };
