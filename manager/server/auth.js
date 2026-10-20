'use strict';

// Sign-in with a local account and a cookie session. The password is stored
// as a scrypt hash in the DB; the cookie holds a random token whose SHA-256
// is stored server-side. On first start the account comes from
// UI_USERNAME / UI_PASSWORD, or the sign-in page offers to create it.

const crypto = require('crypto');

const COOKIE = 'sm_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

class Auth {
  constructor({ db, log, secureCookies = false }) {
    this.db = db;
    this.log = log;
    this.secure = secureCookies;
    this.failures = new Map(); // ip -> { count, until }
  }

  bootstrap(env = process.env) {
    if (this.db.userCount() === 0 && env.UI_PASSWORD) {
      this.setPassword(env.UI_USERNAME || 'admin', env.UI_PASSWORD);
      this.log.info(`Created account "${env.UI_USERNAME || 'admin'}" from UI_PASSWORD`);
    }
  }

  needsSetup() {
    return this.db.userCount() === 0;
  }

  setPassword(username, password) {
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) throw Object.assign(new Error('User names may use letters, numbers and . _ @ -'), { status: 400 });
    if (String(password).length < 8) throw Object.assign(new Error('Use a password of at least 8 characters.'), { status: 400 });
    const { salt, hash } = hashPassword(password);
    this.db.putUser(username, salt, hash);
  }

  check(username, password) {
    const user = this.db.getUser(String(username || ''));
    // hash anyway so timing does not reveal whether the user exists
    const { hash } = hashPassword(password, user?.salt || 'x'.repeat(32));
    return Boolean(user) && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
  }

  throttled(ip) {
    const f = this.failures.get(ip);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }

  noteFailure(ip) {
    const f = this.failures.get(ip) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60, 2 ** (f.count - 5) * 30) * 1000;
    this.failures.set(ip, f);
  }

  login(res, username) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db.addSession(sha256(token), username, Date.now() + SESSION_MS);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${this.secure ? '; Secure' : ''}`);
  }

  logout(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) this.db.deleteSession(sha256(token));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  /** The signed-in user name, or null. */
  user(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    return this.db.getSession(sha256(token))?.username || null;
  }
}

module.exports = { Auth, parseCookies, hashPassword };
