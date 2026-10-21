'use strict';

// HTTPS for the web UI, so nobody on the network can read the password or
// the session cookie, or change the page on its way to the browser.
//
// By default Sentry Six Manager is its own small certificate authority (CA):
//   /data/tls/ca.crt + ca.key       the CA, created once (10 years)
//   /data/tls/server.crt + .key     the web server's certificate, signed by
//                                   the CA, renewed before it expires
// Install ca.crt on your phone and computers once (Settings > Security has
// the download and the fingerprint to compare) and browsers trust the page
// without warnings. The CA is name-constrained: it can only vouch for local
// names (.local, .lan, .home.arpa, ...), private IP addresses and the names in
// TLS_HOSTNAMES, so even its key could not be used to impersonate other
// websites to a device that trusts it.
//
// TLS_CERT_FILE / TLS_KEY_FILE use your own certificate instead (for example
// from Let's Encrypt). TLS_MODE=off serves plain HTTP, only for running
// behind a reverse proxy that does HTTPS (set TRUST_PROXY=true there).

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { run, tail } = require('./proc');

const LEAF_DAYS = 397; // browsers refuse longer-lived server certificates
const RENEW_BEFORE_MS = 30 * 24 * 3600 * 1000;
const LOCAL_DNS = ['localhost', 'local', 'lan', 'home', 'home.arpa', 'internal', 'localdomain'];
const PRIVATE_V4 = [
  ['10.0.0.0', '255.0.0.0'], ['172.16.0.0', '255.240.0.0'], ['192.168.0.0', '255.255.0.0'],
  ['127.0.0.0', '255.0.0.0'], ['100.64.0.0', '255.192.0.0'], ['169.254.0.0', '255.255.0.0']
];
const PRIVATE_V6 = [
  ['fc00:0:0:0:0:0:0:0', 'fe00:0:0:0:0:0:0:0'], ['fe80:0:0:0:0:0:0:0', 'ffc0:0:0:0:0:0:0:0'],
  ['0:0:0:0:0:0:0:1', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']
];
const DNS_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** One spelling per name: lower-case host names, canonical IPs (0:0:0:0:0:0:0:1 is ::1). */
function canonicalName(n) {
  const h = String(n).trim().replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return new net.SocketAddress({ address: h, family: net.isIPv6(h) ? 'ipv6' : 'ipv4' }).address;
  return h.toLowerCase();
}

/** Split and validate a list of host names / IP addresses. */
function parseHostnames(value) {
  const out = [];
  for (const raw of String(value || '').split(/[\s,]+/)) {
    const h = raw.trim().replace(/^\[|\]$/g, '').toLowerCase();
    if (!h) continue;
    if (net.isIP(h) || DNS_RE.test(h)) {
      if (!out.includes(h)) out.push(h);
    } else {
      throw Object.assign(new Error(`"${raw}" is not a host name or IP address.`), { status: 400 });
    }
  }
  return out;
}

function ipPermitted(ip) {
  if (net.isIPv4(ip)) {
    const n = (a) => a.split('.').reduce((x, o) => (x << 8n) + BigInt(Number(o)), 0n);
    return PRIVATE_V4.some(([base, mask]) => (n(ip) & n(mask)) === (n(base) & n(mask)));
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

function dnsPermitted(name, extra) {
  const parts = name.toLowerCase();
  return [...LOCAL_DNS, ...extra].some((c) => parts === c || parts.endsWith(`.${c}`));
}

async function openssl(args, input) {
  const res = await run('openssl', args, { timeoutMs: 60000, input });
  if (res.code !== 0) throw new Error(`openssl ${args[0]} failed: ${tail(res.stderr, 3) || res.code}`);
  return res;
}

function fingerprint(pem) {
  try {
    return new crypto.X509Certificate(pem).fingerprint256;
  } catch {
    return null;
  }
}

function certInfo(pem) {
  try {
    const c = new crypto.X509Certificate(pem);
    const names = String(c.subjectAltName || '').split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.replace(/^DNS:/, '').replace(/^IP Address:/, ''));
    return { fingerprint: c.fingerprint256, validFrom: c.validFrom, validTo: c.validTo, expiresAt: Date.parse(c.validTo), subject: c.subject, issuer: c.issuer, names };
  } catch {
    return null;
  }
}

class TlsManager {
  constructor({ dir, log, hostnames = [], certFile = null, keyFile = null }) {
    this.dir = dir;
    this.log = log;
    this.extraHostnames = hostnames;
    this.ownCert = certFile && keyFile ? { certFile, keyFile } : null;
    this.files = {
      caKey: path.join(dir, 'ca.key'), caCrt: path.join(dir, 'ca.crt'),
      key: path.join(dir, 'server.key'), crt: path.join(dir, 'server.crt'), names: path.join(dir, 'hostnames.json')
    };
  }

  storedHostnames() {
    try {
      return parseHostnames(JSON.parse(fs.readFileSync(this.files.names, 'utf8')).join(','));
    } catch {
      return [];
    }
  }

  /** Every name the server certificate covers. */
  hostnames() {
    const names = ['localhost', '127.0.0.1', '::1', ...this.extraHostnames, ...this.storedHostnames()];
    return [...new Set(names.map(canonicalName))];
  }

  /** Make sure CA and server certificate exist and fit; returns { key, cert }. */
  async ensure() {
    if (this.ownCert) {
      return { key: await fsp.readFile(this.ownCert.keyFile), cert: await fsp.readFile(this.ownCert.certFile), own: true };
    }
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.dir, 0o700).catch(() => {});
    if (!fs.existsSync(this.files.caKey) || !fs.existsSync(this.files.caCrt) || !this.caCovers(this.hostnames())) await this.createCa();
    const leaf = certInfo(await fsp.readFile(this.files.crt, 'utf8').catch(() => ''));
    const want = this.hostnames();
    const stale = !leaf || leaf.expiresAt - Date.now() < RENEW_BEFORE_MS
      || want.some((n) => !leaf.names.map(canonicalName).includes(n))
      || !this.signedByCa();
    if (stale) await this.issueLeaf(want);
    const caPem = await fsp.readFile(this.files.caCrt, 'utf8');
    this.log?.info(`HTTPS certificate authority fingerprint (SHA-256): ${fingerprint(caPem)}`);
    return { key: await fsp.readFile(this.files.key), cert: await fsp.readFile(this.files.crt), own: false };
  }

  caCovers(names) {
    const extra = this.caPermittedDns();
    if (!extra) return false;
    return names.every((n) => (net.isIP(n) ? ipPermitted(n) : dnsPermitted(n, extra)));
  }

  caPermittedDns() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'ca-names.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  signedByCa() {
    try {
      const ca = new crypto.X509Certificate(fs.readFileSync(this.files.caCrt));
      const leaf = new crypto.X509Certificate(fs.readFileSync(this.files.crt));
      return leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
    } catch {
      return false;
    }
  }

  async createCa() {
    const names = this.hostnames();
    for (const ip of names.filter((n) => net.isIP(n))) {
      if (!ipPermitted(ip)) throw new Error(`${ip} is a public IP address; use TLS_CERT_FILE/TLS_KEY_FILE with a real certificate for it.`);
    }
    // DNS names beyond the local ones become their own permitted subtrees
    const extraDns = [...new Set(names.filter((n) => !net.isIP(n) && !dnsPermitted(n, [])).map((n) => n.toLowerCase()))];
    const constraints = [
      ...[...LOCAL_DNS, ...extraDns].map((d) => `permitted;DNS:${d}`),
      ...PRIVATE_V4.map(([b, m]) => `permitted;IP:${b}/${m}`),
      ...PRIVATE_V6.map(([b, m]) => `permitted;IP:${b}/${m}`)
    ].join(',');
    const id = crypto.randomBytes(4).toString('hex');
    const tmpKey = `${this.files.caKey}.tmp`;
    await openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', tmpKey]);
    await fsp.chmod(tmpKey, 0o600);
    await openssl(['req', '-x509', '-new', '-key', tmpKey, '-sha256', '-days', '3650',
      '-subj', `/O=Sentry Six Manager/CN=Sentry Six Manager local CA ${id}`,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-addext', `nameConstraints=critical,${constraints}`,
      '-out', `${this.files.caCrt}.tmp`]);
    await fsp.rename(tmpKey, this.files.caKey);
    await fsp.rename(`${this.files.caCrt}.tmp`, this.files.caCrt);
    await fsp.writeFile(path.join(this.dir, 'ca-names.json'), JSON.stringify(extraDns));
    await fsp.rm(this.files.crt, { force: true });
    this.log?.warn('Created a new HTTPS certificate authority. Install /data/tls/ca.crt on your devices (Settings > Security) to trust the page.');
  }

  async issueLeaf(names) {
    const san = names.map((n) => (net.isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(',');
    const ext = path.join(this.dir, 'server.ext');
    await fsp.writeFile(ext, [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${san}`
    ].join('\n'));
    const tmpKey = `${this.files.key}.tmp`;
    const csr = path.join(this.dir, 'server.csr');
    await openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', tmpKey]);
    await fsp.chmod(tmpKey, 0o600);
    await openssl(['req', '-new', '-key', tmpKey, '-subj', `/O=Sentry Six Manager/CN=${names.find((n) => !net.isIP(n)) || 'localhost'}`, '-out', csr]);
    await openssl(['x509', '-req', '-in', csr, '-CA', this.files.caCrt, '-CAkey', this.files.caKey,
      '-set_serial', `0x${crypto.randomBytes(16).toString('hex')}`, '-days', String(LEAF_DAYS), '-sha256',
      '-extfile', ext, '-out', `${this.files.crt}.tmp`]);
    await fsp.rename(tmpKey, this.files.key);
    await fsp.rename(`${this.files.crt}.tmp`, this.files.crt);
    await Promise.all([fsp.rm(csr, { force: true }), fsp.rm(ext, { force: true })]);
    this.log?.info(`Issued the HTTPS certificate for ${names.join(', ')}`);
  }

  /** Change the extra names (from the UI); returns whether the CA had to be replaced. */
  async setHostnames(list) {
    const names = parseHostnames(list.join(','));
    if (names.length > 20) throw Object.assign(new Error('At most 20 names.'), { status: 400 });
    for (const ip of names.filter((n) => net.isIP(n))) {
      if (!ipPermitted(ip)) throw Object.assign(new Error(`${ip} is a public IP address. Use your own certificate (TLS_CERT_FILE) for public addresses.`), { status: 400 });
    }
    const before = fingerprint(await fsp.readFile(this.files.caCrt, 'utf8').catch(() => ''));
    await fsp.writeFile(this.files.names, JSON.stringify(names));
    const out = await this.ensure();
    const after = fingerprint(await fsp.readFile(this.files.caCrt, 'utf8').catch(() => ''));
    return { ...out, caReplaced: before !== after };
  }

  status() {
    if (this.ownCert) {
      const cert = certInfo(fs.readFileSync(this.ownCert.certFile, 'utf8'));
      return { mode: 'own', certificate: cert, ca: null, hostnames: cert?.names || [] };
    }
    const ca = certInfo(fs.readFileSync(this.files.caCrt, 'utf8'));
    return {
      mode: 'local-ca', ca, certificate: certInfo(fs.readFileSync(this.files.crt, 'utf8')),
      hostnames: this.hostnames(), editable: this.storedHostnames(), fromEnv: this.extraHostnames,
      containerHostname: os.hostname()
    };
  }

  caPem() {
    return this.ownCert ? null : fs.readFileSync(this.files.caCrt);
  }
}

/** The app manages its own CA (standalone runs and tests). */
function localTlsSource(manager) {
  return {
    load: () => manager.ensure(),
    status: () => manager.status(),
    caPem: () => manager.caPem(),
    setHostnames: (list) => manager.setHostnames(list)
  };
}

/**
 * Supervisor side: write what the unprivileged app may have (the server key
 * and certificate, the public CA certificate and a status summary) into
 * `outDir`, owned by the app user. The CA key never leaves /data/tls.
 */
async function exportForApp(manager, outDir, { uid, gid } = {}) {
  const material = await manager.ensure();
  await fsp.mkdir(outDir, { recursive: true, mode: 0o700 });
  const files = [
    ['server.key', material.key, 0o600],
    ['server.crt', material.cert, 0o644],
    ['status.json', JSON.stringify(manager.status()), 0o644]
  ];
  const ca = manager.caPem();
  if (ca) files.push(['ca.crt', ca, 0o644]);
  for (const [name, data, mode] of files) {
    // a fresh temp file, never through an existing link
    const file = path.join(outDir, name);
    const tmpFile = `${file}.${process.pid}.tmp`;
    await fsp.rm(tmpFile, { force: true });
    const fh = await fsp.open(tmpFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    try {
      await fh.writeFile(data);
      if (uid !== undefined) await fh.chown(uid, gid);
      await fh.chmod(mode);
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpFile, file);
  }
  return material;
}

/** App side when supervised: read the exported files; name changes go through the supervisor. */
function supervisorTlsSource({ dir, channel = process, timeoutMs = 120000 }) {
  const read = async () => ({ key: await fsp.readFile(path.join(dir, 'server.key')), cert: await fsp.readFile(path.join(dir, 'server.crt')) });
  return {
    load: read,
    status: () => JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')),
    caPem: () => {
      try {
        return fs.readFileSync(path.join(dir, 'ca.crt'));
      } catch {
        return null;
      }
    },
    setHostnames: (list) => new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const done = (fn) => {
        clearTimeout(timer);
        channel.off('message', onMessage);
        fn();
      };
      const onMessage = (m) => {
        if (!m || m.type !== 'tls-result' || m.requestId !== requestId) return;
        done(() => (m.error
          ? reject(Object.assign(new Error(m.error), { status: 400 }))
          : read().then((x) => resolve({ ...x, caReplaced: Boolean(m.caReplaced) }), reject)));
      };
      const timer = setTimeout(() => done(() => reject(new Error('The supervisor did not answer.'))), timeoutMs);
      channel.on('message', onMessage);
      channel.send({ type: 'tls-hostnames', requestId, hostnames: Array.isArray(list) ? list.map(String).slice(0, 20) : [] });
    })
  };
}

module.exports = { TlsManager, canonicalName, parseHostnames, ipPermitted, dnsPermitted, certInfo, fingerprint, localTlsSource, exportForApp, supervisorTlsSource };
