'use strict';

// Updates from GitHub. Settings pick a repository and a branch; "check"
// compares the branch head with the running version, "install" downloads
// that commit's tarball into /data/app/releases/<sha>, checks it, points
// /data/app/current.json at it and exits with code 75 so the supervisor
// restarts into it (and rolls back if the new version will not start).
//
// Updates run code, so they are locked down: the repository is fixed (set
// UPDATE_REPO, and UPDATE_ALLOW_REPO_CHANGE=true only if it must be editable
// in the UI), downloads are HTTPS from api.github.com with certificate checks,
// and changing the branch or installing needs the password again (index.js).
// The installed code runs as the unprivileged app user, never as root.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { run, tail } = require('./proc');

const RESTART_CODE = 75;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// a conservative subset of git's ref rules: no "..", "//", "@{", leading "-" or "/",
// trailing "/", "." or ".lock", and only plain characters
const BRANCH_RE = /^(?![-/])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,200}(?<![/.])(?<!\.lock)$/;

function defaults(env = process.env, buildInfo = {}) {
  return {
    enabled: false,
    autoInstall: true,
    repo: env.UPDATE_REPO || 'skittles-fivem/Sentry-Sixbeta',
    // follow the branch this image was built from unless told otherwise
    branch: env.UPDATE_BRANCH || buildInfo.branch || env.BUILD_BRANCH || 'main',
    token: '',
    intervalHours: 6
  };
}

class Updater {
  constructor({ db, log, dataDir, appRoot, buildInfo = {}, isIdle = () => true, fetchImpl = globalThis.fetch, exit = (c) => process.exit(c), allowRepoChange = process.env.UPDATE_ALLOW_REPO_CHANGE === 'true' }) {
    Object.assign(this, { db, log, dataDir, appRoot, buildInfo, isIdle, fetch: fetchImpl, exit, allowRepoChange });
    this.appDir = path.join(dataDir, 'app');
    // tests point this at a local fake of the GitHub API
    this.apiBase = (process.env.UPDATE_API_BASE || 'https://api.github.com').replace(/\/$/, '');
    this.state = { checkedAt: null, latest: null, error: null, installing: false, progress: null };
  }

  settings() {
    const s = { ...defaults(process.env, this.buildInfo), ...(this.db.get('updater') || {}) };
    if (!this.allowRepoChange) s.repo = defaults().repo;
    return s;
  }

  setSettings(input) {
    const s = this.settings();
    if (input.repo !== undefined && String(input.repo) !== s.repo) {
      if (!this.allowRepoChange) throw Object.assign(new Error('The update repository is fixed. Set UPDATE_REPO (and UPDATE_ALLOW_REPO_CHANGE=true) in the container environment to change it.'), { status: 403 });
      if (!REPO_RE.test(String(input.repo))) throw Object.assign(new Error('Repository must look like owner/name.'), { status: 400 });
      s.repo = String(input.repo);
    }
    if (input.branch !== undefined) {
      const b = String(input.branch).trim();
      if (!BRANCH_RE.test(b)) throw Object.assign(new Error('That is not a valid branch name.'), { status: 400 });
      s.branch = b;
    }
    if (input.enabled !== undefined) s.enabled = Boolean(input.enabled);
    if (input.autoInstall !== undefined) s.autoInstall = Boolean(input.autoInstall);
    if (input.intervalHours !== undefined) {
      const n = Number(input.intervalHours);
      if (![1, 3, 6, 12, 24].includes(n)) throw Object.assign(new Error('Check every 1, 3, 6, 12 or 24 hours.'), { status: 400 });
      s.intervalHours = n;
    }
    if (input.token !== undefined && input.token !== null) s.token = String(input.token).trim();
    this.db.set('updater', s);
    return this.publicSettings();
  }

  publicSettings() {
    const { token, ...rest } = this.settings();
    return { ...rest, tokenSet: Boolean(token), repoLocked: !this.allowRepoChange };
  }

  current() {
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(this.appDir, 'current.json'), 'utf8'));
      if (path.resolve(this.appRoot) === path.resolve(this.appDir, 'releases', cur.sha)) return { ...cur, source: 'update' };
    } catch {
      // running the image's own copy
    }
    return { sha: this.buildInfo.sha || null, branch: this.buildInfo.branch || null, source: 'image', builtAt: this.buildInfo.builtAt || null };
  }

  status() {
    const cur = this.current();
    const latest = this.state.latest;
    return {
      settings: this.publicSettings(),
      current: cur,
      latest,
      updateAvailable: Boolean(latest?.sha && latest.sha !== cur.sha),
      checkedAt: this.state.checkedAt,
      error: this.state.error,
      installing: this.state.installing,
      progress: this.state.progress
    };
  }

  async gh(pathname, { raw = false } = {}) {
    const { token } = this.settings();
    const res = await this.fetch(`${this.apiBase}${pathname}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'sentry-manager',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      redirect: 'follow'
    });
    if (!res.ok) {
      const hint = res.status === 404 ? ' (private repository? add a token with read access)' : res.status === 403 ? ' (rate limited, or the token lacks access)' : '';
      throw Object.assign(new Error(`GitHub answered ${res.status}${hint}`), { status: 502 });
    }
    return raw ? res : res.json();
  }

  async branches() {
    const { repo } = this.settings();
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const list = await this.gh(`/repos/${repo}/branches?per_page=100&page=${page}`);
      out.push(...list.map((b) => ({ name: b.name, sha: b.commit?.sha })));
      if (list.length < 100) break;
    }
    return out;
  }

  async check() {
    const { repo, branch } = this.settings();
    try {
      const c = await this.gh(`/repos/${repo}/commits/${encodeURIComponent(branch)}`);
      this.state.latest = {
        sha: c.sha, branch, message: String(c.commit?.message || '').split('\n')[0].slice(0, 200),
        date: c.commit?.committer?.date || null, author: c.commit?.author?.name || null
      };
      this.state.error = null;
    } catch (err) {
      this.state.error = err.message;
    }
    this.state.checkedAt = Date.now();
    return this.status();
  }

  /** Download, verify and switch to the latest commit, then restart. */
  async install() {
    if (this.state.installing) throw Object.assign(new Error('An update is already being installed.'), { status: 409 });
    const st = this.state.latest ? this.status() : await this.check();
    if (!st.latest?.sha) throw Object.assign(new Error(st.error || 'Could not find the branch on GitHub.'), { status: 502 });
    const { repo, branch } = this.settings();
    const sha = st.latest.sha;
    if (!/^[a-f0-9]{40}$/.test(sha)) throw Object.assign(new Error('Unexpected commit id from GitHub.'), { status: 502 });
    this.state.installing = true;
    this.state.progress = 'downloading';
    this.log.info(`Downloading ${repo}@${branch} ${sha.slice(0, 7)} from GitHub`);
    const releases = path.join(this.appDir, 'releases');
    const target = path.join(releases, sha);
    const tmpDir = `${target}.partial`;
    const tarball = path.join(this.appDir, `${sha}.tar.gz`);
    try {
      await fsp.mkdir(releases, { recursive: true });
      await fsp.rm(tmpDir, { recursive: true, force: true });
      await fsp.mkdir(tmpDir, { recursive: true });
      const res = await this.gh(`/repos/${repo}/tarball/${sha}`, { raw: true });
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tarball));
      this.state.progress = 'unpacking';
      this.log.info(`Downloaded ${(fs.statSync(tarball).size / 1048576).toFixed(1)} MiB; unpacking into ${path.relative(this.dataDir, tmpDir)}`);
      const x = await run('tar', ['-xzf', tarball, '--strip-components=1', '-C', tmpDir, '--no-same-owner', '--exclude=ffmpeg_bin'], { timeoutMs: 10 * 60 * 1000 });
      if (x.code !== 0) throw new Error(`Could not unpack the update: ${tail(x.stderr, 2)}`);
      this.state.progress = 'checking';
      this.log.info('Checking the new version (required files, syntax)');
      for (const must of ['manager/server/index.js', 'manager/server/supervisor.js', 'src/main/converter/runtime.js', 'src/renderer/index.html']) {
        if (!fs.existsSync(path.join(tmpDir, must))) throw new Error(`This branch has no ${must}; it is not a Sentry Manager version.`);
      }
      const syntax = await run(process.execPath, ['--check', path.join(tmpDir, 'manager/server/index.js')], { timeoutMs: 60000 });
      if (syntax.code !== 0) throw new Error(`The new version does not start: ${tail(syntax.stderr, 2)}`);
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.rename(tmpDir, target);
      const prev = this.current();
      const pointer = { sha, branch, repo, installedAt: Date.now(), previous: prev.source === 'update' ? prev.sha : null };
      await fsp.writeFile(path.join(this.appDir, 'current.json.tmp'), JSON.stringify(pointer, null, 2));
      await fsp.rename(path.join(this.appDir, 'current.json.tmp'), path.join(this.appDir, 'current.json'));
      await this.pruneReleases([sha, pointer.previous]);
      this.state.progress = 'restarting';
      this.log.info(`Installed ${repo}@${branch} ${sha.slice(0, 7)}; restarting`);
      setTimeout(() => this.exit(RESTART_CODE), 500);
      return { sha, restarting: true };
    } catch (err) {
      this.state.installing = false;
      this.state.progress = null;
      this.state.error = err.message;
      this.log.warn(`Update not installed: ${err.message}`);
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      throw Object.assign(err, { status: err.status || 500 });
    } finally {
      await fsp.rm(tarball, { force: true }).catch(() => {});
    }
  }

  async pruneReleases(keep) {
    const releases = path.join(this.appDir, 'releases');
    for (const name of await fsp.readdir(releases).catch(() => [])) {
      if (!keep.includes(name)) await fsp.rm(path.join(releases, name), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Periodic check; installs on its own only when enabled and nothing is converting. */
  async tick() {
    const s = this.settings();
    if (!s.enabled) return;
    if (this.state.checkedAt && Date.now() - this.state.checkedAt < s.intervalHours * 3600 * 1000) return;
    const st = await this.check();
    if (st.updateAvailable && s.autoInstall && this.isIdle()) await this.install().catch((err) => this.log.warn(`Update failed: ${err.message}`));
  }
}

module.exports = { Updater, RESTART_CODE, BRANCH_RE };
