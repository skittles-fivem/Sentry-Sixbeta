'use strict';

// Automated launch check, used only by the GitHub test workflow.
//
// Enabled when SENTRY_STUDIO_SMOKE_TEST names a result file. The real window
// loads; then a check runs inside it: the main screens and the preload API are
// there, the converter answers, and (when SENTRY_STUDIO_SMOKE_SOURCE is set) a
// real conversion runs through the app's own converter API while the window
// shows its progress. The result is written as JSON and the app quits the way
// a user would, so shutdown is exercised too. Without the variable this module
// does nothing.

const fs = require('fs');

// Runs inside the window (serialised with toString, so it must not use
// anything from this file).
async function rendererChecks({ source, destination }) {
  const failures = [];
  const out = { failures };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const need = (condition, what) => { if (!condition) failures.push(what); };
  const api = window.electronAPI;
  need(document.title === 'Sentry Studio', `window title (${document.title})`);
  need(api && typeof api === 'object', 'preload API');
  need(document.getElementById('clipList'), 'clip list');
  const tab = document.getElementById('converterTabBtn');
  need(tab, 'converter tab');
  tab?.click();
  await sleep(1500);
  const workspace = document.getElementById('converterWorkspace');
  need(workspace && !workspace.hidden, 'converter opens');
  out.status = document.getElementById('converterStatus')?.textContent?.trim() || null;
  const calls = [
    ['capabilities', () => api.getConverterCapabilities()],
    ['current job', () => api.getCurrentConverterJob()],
    ['automatic conversion', () => api.getConverterAuto()]
  ];
  for (const [name, call] of calls) {
    try {
      const reply = await call();
      need(reply?.ok === true, `converter ${name} (${reply?.error?.code || 'no reply'})`);
    } catch (error) {
      failures.push(`converter ${name}: ${error?.message || error}`);
    }
  }
  if (source && api) {
    const started = await api.startConverter({
      sourceRoot: source, destinationRoot: destination, codec: 'h265', profileId: 'balanced', networkMode: 'auto',
      outputMode: 'separate', includedGroups: ['RecentClips'], replacementConfirmed: false, concurrency: 2, verifyMode: 'full'
    });
    need(started?.ok === true, `start a conversion (${started?.error?.code || 'no reply'})`);
    if (started?.ok) {
      const end = Date.now() + 240_000;
      let job = null;
      while (Date.now() < end) {
        job = (await api.getCurrentConverterJob())?.value || null;
        if (job && ['completed', 'failed', 'cancelled'].includes(job.state)) break;
        await sleep(1000);
      }
      const items = Array.isArray(job?.items) ? job.items : [];
      out.job = job && { state: job.state, items: items.map((item) => ({
        state: item.state, resultCode: item.resultCode, encoder: item.encoder, outputPath: item.outputPath,
        failure: item.failure?.code
      })) };
      need(job?.state === 'completed', `conversion finishes (${job?.state || 'no job'})`);
      need(items.length > 0 && items.every((item) => item.state === 'completed'), 'every clip converts');
      await sleep(2000); // the window's last live update
      out.completedShown = document.getElementById('converterCountCompleted')?.textContent?.trim() || null;
      need(out.completedShown === String(items.length), `window shows ${items.length} completed (shows ${out.completedShown})`);
      const converted = items.find((item) => item.outputPath);
      if (converted && typeof api.getClipThumbnail === 'function') {
        out.filmstrip = await api.getClipThumbnail(converted.outputPath);
        need(typeof out.filmstrip === 'string', 'preview filmstrip for a converted clip');
      }
    }
  }
  return out;
}

function createSmokeTest({ app, env = process.env, writeFile = fs.writeFileSync } = {}) {
  const resultPath = env.SENTRY_STUDIO_SMOKE_TEST;
  if (!resultPath) return null;
  const params = {
    source: env.SENTRY_STUDIO_SMOKE_SOURCE || null,
    destination: env.SENTRY_STUDIO_SMOKE_DESTINATION || null
  };
  const result = {
    ok: false, startedAt: Date.now(), platform: process.platform, packaged: app.isPackaged === true,
    errors: [], consoleErrors: [], checks: null, reason: null, quit: null
  };
  let finished = false;
  const write = () => { try { writeFile(resultPath, JSON.stringify(result, null, 2)); } catch (_) { /* runner reports a missing file */ } };

  function finish(reason) {
    if (finished) return;
    finished = true;
    result.reason = reason;
    result.finishedAt = Date.now();
    result.ok = reason === 'checked' && result.errors.length === 0;
    write();
    // Quit like a user would (this runs the converter's shutdown); force it
    // only if that hangs.
    const force = setTimeout(() => { result.quit = 'forced'; write(); app.exit(3); }, 45_000);
    force.unref?.();
    app.quit();
  }

  app.on('will-quit', () => {
    if (!finished || result.quit) return;
    result.quit = 'clean';
    write();
  });
  const overall = setTimeout(() => { result.errors.push('timed out'); finish('timeout'); },
    Number(env.SENTRY_STUDIO_SMOKE_TIMEOUT_MS) || 300_000);
  overall.unref?.();

  return Object.freeze({
    // Stands in for the converter's recovery dialog: a failure is reported
    // instead of waiting for a click that never comes.
    dialog: Object.freeze({
      async showMessageBox(options) {
        result.errors.push(`dialog: ${options?.title || ''}: ${options?.message || ''}`);
        finish('dialog');
        return { response: Number.isInteger(options?.cancelId) ? options.cancelId : 1 };
      }
    }),
    attachWindow(window) {
      const contents = window.webContents;
      contents.on('console-message', (...args) => {
        // Electron passes one details object (newer) or positional values.
        const details = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null;
        const level = details ? details.level : args[1];
        const message = String(details ? details.message : args[2]);
        const where = `${details ? details.sourceId : args[4]}:${details ? details.lineNumber : args[3]}`;
        if (level !== 'error' && level !== 3) return;
        // Uncaught exceptions are failures; other console errors (e.g. a map
        // tile that could not load) are reported but do not fail the check.
        if (/^Uncaught\b|Unhandled/i.test(message)) result.errors.push(`renderer: ${message} (${where})`);
        else if (result.consoleErrors.length < 50) result.consoleErrors.push(`${message} (${where})`);
      });
      contents.on('preload-error', (_event, preloadPath, error) => {
        result.errors.push(`preload ${preloadPath}: ${error?.message || error}`);
      });
      contents.on('render-process-gone', (_event, details) => {
        result.errors.push(`renderer stopped: ${details?.reason || 'unknown'}`);
        finish('renderer-gone');
      });
      contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
        if (isMainFrame !== false) result.errors.push(`page failed to load: ${description} (${code}) ${url}`);
      });
      contents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            result.checks = await contents.executeJavaScript(`(${rendererChecks.toString()})(${JSON.stringify(params)})`, true);
            for (const failure of result.checks?.failures || []) result.errors.push(`check: ${failure}`);
          } catch (error) {
            result.errors.push(`check script: ${error?.message || error}`);
          }
          finish('checked');
        }, 3000);
      });
    }
  });
}

module.exports = { createSmokeTest, rendererChecks };
