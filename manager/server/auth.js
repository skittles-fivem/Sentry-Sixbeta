'use strict';

// Sign-in with a local account and a cookie session. The password is stored
// as a scrypt hash in the DB; the cookie holds a random token whose SHA-256
// is stored server-side.
//
// - First start: the account comes from UI_USERNAME / UI_PASSWORD, or the
//   sign-in page creates it, which needs the one-time setup code printed in
//   the container log. Whoever reaches the page first cannot claim it.
// - Cookies are HttpOnly and SameSite=Strict; over HTTPS they are Secure and
//   use the __Host- prefix, so another site or a plain-HTTP page cannot set
//   or read them.
// - Changes that could hand someone the shares or the server (vehicle
//   sources, updates, the account) need the password again: confirming it
//   opens a short "recently confirmed" window for that session.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'sm_session';
const SECURE_COOKIE = `__Host-${COOKIE}`;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const CONFIRM_MS = 10 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // someone else's cookie with stray % signs: keep it as is
    }
    if (!(name in out)) out[name] = value;
  }
  return out;
}

function setupCode() {
  // 15 random characters from an alphabet without look-alikes, shown as XXXXX-XXXXX-XXXXX
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(15);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10)}`;
}

class Auth {
  /**
   * isSecure(req): whether this request reached us over HTTPS.
   * setupFile: where the one-time setup code is written (besides the log).
   */
  constructor({ db, log, isSecure = () => false, setupFile = null }) {
    this.db = db;
    this.log = log;
    this.isSecure = isSecure;
    this.setupFile = setupFile;
    this.failures = new Map(); // key -> { count, until }
    this.confirmed = new Map(); // session hash -> confirmed until
    this.code = null;
  }

  bootstrap(env = process.env) {
    if (this.db.userCount() === 0 && env.UI_PASSWORD) {
      this.setPassword(env.UI_USERNAME || 'admin', env.UI_PASSWORD);
      this.log.info(`Created account "${env.UI_USERNAME || 'admin'}" from UI_PASSWORD`);
    }
    if (this.needsSetup()) {
      this.code = setupCode();
      this.log.warn(`No account yet. To create it, open the web UI and enter the setup code ${this.code}`);
      if (this.setupFile) {
        try {
          fs.mkdirSync(path.dirname(this.setupFile), { recursive: true });
          fs.writeFileSync(this.setupFile, `${this.code}\n`, { mode: 0o600 });
        } catch (err) {
          this.log.warn(`Could not write ${this.setupFile}: ${err.message}`);
        }
      }
    }
  }

  needsSetup() {
    return this.db.userCount() === 0;
  }

  /** Create the first account; needs the setup code from the log. */
  setup(username, password, code) {
    if (!this.needsSetup()) throw Object.assign(new Error('An account already exists.'), { status: 409 });
    const given = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const want = String(this.code || '').replace(/-/g, '');
    if (!want || given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) {
      throw Object.assign(new Error('That setup code is not right. It is printed in the container log (docker logs sentry-six-manager).'), { status: 403 });
    }
    this.setPassword(username, password);
    this.code = null;
    if (this.setupFile) fs.rmSync(this.setupFile, { force: true });
  }

  setPassword(username, password) {
    if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) throw Object.assign(new Error('User names may use letters, numbers and . _ @ -'), { status: 400 });
    if (String(password).length < 8) throw Object.assign(new Error('Use a password of at least 8 characters.'), { status: 400 });
    if (String(password).length > 1024) throw Object.assign(new Error('That password is too long.'), { status: 400 });
    const { salt, hash } = hashPassword(password);
    this.db.putUser(username, salt, hash);
  }

  check(username, password) {
    if (typeof password !== 'string' || password.length > 1024) return false;
    const user = this.db.getUser(String(username || ''));
    // hash anyway so timing does not reveal whether the user exists
    const { hash } = hashPassword(password, user?.salt || 'x'.repeat(32));
    return Boolean(user) && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
  }

  throttled(key) {
    const f = this.failures.get(key);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  }

  noteFailure(key) {
    const f = this.failures.get(key) || { count: 0, until: 0 };
    f.count++;
    if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60, 2 ** (f.count - 5) * 30) * 1000;
    this.failures.set(key, f);
    if (this.failures.size > 10000) this.failures.delete(this.failures.keys().next().value);
  }

  noteSuccess(key) {
    this.failures.delete(key);
  }

  cookieName(req) {
    return this.isSecure(req) ? SECURE_COOKIE : COOKIE;
  }

  cookieAttrs(req, maxAge) {
    return `HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${this.isSecure(req) ? '; Secure' : ''}`;
  }

  login(req, res, username) {
    // a fresh token every sign-in, so a token set before sign-in is never reused
    const old = this.token(req);
    if (old) this.db.deleteSession(sha256(old));
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    this.db.addSession(tokenHash, username, Date.now() + SESSION_MS);
    this.confirmed.set(tokenHash, Date.now() + CONFIRM_MS); // just typed the password
    res.setHeader('Set-Cookie', `${this.cookieName(req)}=${token}; ${this.cookieAttrs(req, SESSION_MS / 1000)}`);
  }

  logout(req, res) {
    const token = this.token(req);
    if (token) {
      this.db.deleteSession(sha256(token));
      this.confirmed.delete(sha256(token));
    }
    res.setHeader('Set-Cookie', `${this.cookieName(req)}=; ${this.cookieAttrs(req, 0)}`);
  }

  token(req) {
    const cookies = parseCookies(req.headers.cookie);
    // over HTTPS only the __Host- cookie counts: a plain-HTTP cookie could have been planted
    const token = this.isSecure(req) ? cookies[SECURE_COOKIE] : cookies[COOKIE];
    return typeof token === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(token) ? token : null;
  }

  /** The signed-in user name, or null. */
  user(req) {
    const token = this.token(req);
    if (!token) return null;
    return this.db.getSession(sha256(token))?.username || null;
  }

  /** Confirm the password again; opens the short window for sensitive changes. */
  confirm(req, username, password) {
    if (!this.check(username, password)) return false;
    const token = this.token(req);
    if (token) this.confirmed.set(sha256(token), Date.now() + CONFIRM_MS);
    return true;
  }

  recentlyConfirmed(req) {
    const token = this.token(req);
    if (!token) return false;
    const until = this.confirmed.get(sha256(token)) || 0;
    if (until > Date.now()) return true;
    this.confirmed.delete(sha256(token));
    return false;
  }

  forgetConfirmations() {
    this.confirmed.clear();
  }
}

module.exports = { Auth, parseCookies, hashPassword, setupCode, COOKIE, SECURE_COOKIE, CONFIRM_MS };
