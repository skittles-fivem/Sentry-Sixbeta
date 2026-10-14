'use strict';

// Launches the real app (Electron from node_modules, or a packaged build with
// --app <executable>) with the automated launch check switched on, then
// reports what it found. Used by the GitHub test workflow.
//
//   node tests/smoke/launchApp.js                         # this checkout
//   node tests/smoke/launchApp.js --app "release/win-unpacked/Sentry Studio.exe"
//   node tests/smoke/launchApp.js --no-convert            # skip the conversion
//
// On Linux it needs a display (run it under xvfb-run). Exits non-zero on any
// failure and prints GitHub annotations for each problem.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createTeslaH264Fixture, locateBundledTools } = require('../main/converter/ffmpegFixtures');

const repo = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const appIndex = args.indexOf('--app');
const packagedApp = appIndex >= 0 ? path.resolve(args[appIndex + 1]) : null;
const convert = !args.includes('--no-convert');
const label = `App launch (${process.platform}${packagedApp ? ', packaged' : ''})`;
const annotate = (kind, message) => console.log(`::${kind} title=${label}::${String(message).replace(/\r?\n/g, ' ')}`);

async function makeFixtures(root) {
  const tools = await locateBundledTools();
  const folder = path.join(root, 'TeslaCam', 'RecentClips');
  await fs.promises.mkdir(folder, { recursive: true });
  await fs.promises.mkdir(path.join(root, 'out'), { recursive: true });
  for (const minute of ['00', '01']) {
    await createTeslaH264Fixture({
      ffmpegPath: tools.ffmpegPath, outputPath: path.join(folder, `2026-08-30_12-${minute}-00-front.mp4`),
      durationSeconds: 4, spatialNoise: 12,
      telemetryPattern: Array.from({ length: 48 }, (_, index) => (index % 3 ? Buffer.from([0x20, index]) : null))
    });
  }
  return { source: path.join(root, 'TeslaCam'), destination: path.join(root, 'out') };
}

function electronCommand() {
  if (packagedApp) return { command: packagedApp, commandArgs: [] };
  // In Node, the electron package exports the path of its binary.
  const binary = require('electron');
  return { command: binary, commandArgs: [repo] };
}

(async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sentry-launch-'));
  const resultPath = path.join(root, 'result.json');
  const logPath = path.join(root, 'app.log');
  let exitCode = 1;
  try {
    const fixtures = convert ? await makeFixtures(root) : null;
    const { command, commandArgs } = electronCommand();
    const extra = process.platform === 'linux' ? ['--no-sandbox'] : [];
    const env = {
      ...process.env,
      SENTRY_STUDIO_SMOKE_TEST: resultPath,
      ...(fixtures ? { SENTRY_STUDIO_SMOKE_SOURCE: fixtures.source, SENTRY_STUDIO_SMOKE_DESTINATION: fixtures.destination } : {}),
      ELECTRON_ENABLE_LOGGING: '1'
    };
    delete env.ELECTRON_RUN_AS_NODE;
    console.log(`Launching ${command} ${[...commandArgs, ...extra].join(' ')}`);
    const log = fs.createWriteStream(logPath);
    const child = spawn(command, [...commandArgs, ...extra], { env, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, timedOut: true }); }, 420_000);
      child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, error }); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    await new Promise((resolve) => log.end(resolve));
    console.log(`App exited: ${JSON.stringify({ code: exited.code, signal: exited.signal || null, timedOut: exited.timedOut || false })}`);

    let result = null;
    try { result = JSON.parse(await fs.promises.readFile(resultPath, 'utf8')); } catch (_) { /* reported below */ }
    const problems = [];
    if (exited.error) problems.push(`could not start the app: ${exited.error.message}`);
    if (exited.timedOut) problems.push('the app did not finish within 7 minutes');
    if (!result) problems.push('the app wrote no launch-check result');
    else {
      console.log(JSON.stringify({ reason: result.reason, quit: result.quit, checks: result.checks }, null, 2));
      problems.push(...result.errors);
      if (result.reason !== 'checked') problems.push(`the check ended early: ${result.reason}`);
      if (result.quit !== 'clean') problems.push(`the app did not quit cleanly (${result.quit || 'no quit recorded'})`);
      for (const message of result.consoleErrors || []) annotate('warning', `console error: ${message}`);
      if (fixtures && result.checks?.job?.items) {
        for (const item of result.checks.job.items) {
          if (item.outputPath && !fs.existsSync(item.outputPath)) problems.push(`converted file missing: ${item.outputPath}`);
        }
      }
    }
    if (problems.length) {
      for (const problem of problems) annotate('error', problem);
      const tail = (await fs.promises.readFile(logPath, 'utf8').catch(() => '')).split(/\r?\n/).slice(-80).join('\n');
      console.log(`--- last app output ---\n${tail}`);
    } else {
      console.log(`${label}: OK`);
      exitCode = 0;
    }
  } catch (error) {
    annotate('error', `launch check failed: ${error?.stack || error}`);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  process.exit(exitCode);
})();
