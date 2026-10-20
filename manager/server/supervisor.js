'use strict';

// Container entrypoint. Runs the installed version of Sentry Manager:
// the update in /data/app/current.json if there is one, else the copy built
// into the image. Exit code 75 from the server means "an update was
// installed, restart into it". If an updated version crashes within a minute
// of starting, the supervisor goes back to the previous version.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DATA = process.env.DATA_PATH || '/data';
const APP_DIR = path.join(DATA, 'app');
const IMAGE_ROOT = path.resolve(__dirname, '..', '..');
const RESTART_CODE = 75;
const EARLY_CRASH_MS = 60 * 1000;

let child = null;
let stopping = false;

function readPointer() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'current.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writePointer(p) {
  const file = path.join(APP_DIR, 'current.json');
  if (!p) return fs.rmSync(file, { force: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(p, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

function resolveRoot() {
  const p = readPointer();
  if (p && /^[a-f0-9]{40}$/.test(p.sha)) {
    const root = path.join(APP_DIR, 'releases', p.sha);
    if (fs.existsSync(path.join(root, 'manager/server/index.js'))) return { root, pointer: p };
  }
  return { root: IMAGE_ROOT, pointer: null };
}

function launch() {
  const { root, pointer } = resolveRoot();
  const started = Date.now();
  console.log(`[supervisor] starting ${pointer ? `update ${pointer.sha.slice(0, 7)} (${pointer.branch})` : 'built-in version'}`);
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'manager/server/index.js')], {
    stdio: 'inherit',
    env: { ...process.env, APP_ROOT: root }
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) process.exit(code ?? 0);
    if (code === RESTART_CODE) return launch();
    if (pointer && Date.now() - started < EARLY_CRASH_MS) {
      console.error(`[supervisor] update ${pointer.sha.slice(0, 7)} exited (${code ?? signal}) right after starting; going back`);
      const prevRoot = pointer.previous && path.join(APP_DIR, 'releases', pointer.previous);
      writePointer(prevRoot && fs.existsSync(path.join(prevRoot, 'manager/server/index.js'))
        ? { ...pointer, sha: pointer.previous, previous: null, rolledBackFrom: pointer.sha, rolledBackAt: Date.now() }
        : null);
      return launch();
    }
    console.error(`[supervisor] server exited (${code ?? signal}); restarting in 5 s`);
    setTimeout(launch, 5000);
  });
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

launch();
