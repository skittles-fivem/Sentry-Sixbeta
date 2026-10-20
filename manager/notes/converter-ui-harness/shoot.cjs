// Screenshots every converter state at 1440x900 against the harness server.
// PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node shoot.cjs
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright');
const BASE = process.env.HARNESS_URL || 'http://127.0.0.1:9310';
const OUT = __dirname;
const report = [];

const harness = (p) => fetch(`${BASE}${p}`).then((r) => r.json());

async function openConverter(browser, { scenario = 'none', layout = 'classic', benchmark, clickTab = true } = {}) {
  await harness(`/__harness/scenario?name=${scenario}${benchmark ? `&benchmark=${benchmark}` : ''}`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('dialog', async (d) => { page.lastDialog = d.message(); await d.dismiss(); });
  await page.goto(`${BASE}/src/renderer/index.html${layout && layout !== 'modern' ? `?layout=${layout}` : ''}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700); // let the viewer's map-tile fallback toast appear, then clear it
  await clearToasts(page);
  if (clickTab) {
    await page.click('#converterTabBtn');
    await page.waitForFunction(() => document.querySelector('#converterReplaceCapability')?.textContent !== 'Checking system capability…');
    await page.waitForTimeout(300);
  }
  return { page, context };
}

async function clearToasts(page) {
  await page.evaluate(() => document.querySelectorAll('.toast-container .toast').forEach((t) => t.remove()));
}

async function scrollTo(page, selector, offset = 24) {
  await page.evaluate(([sel, off]) => {
    const ws = document.querySelector('#converterWorkspace');
    const el = document.querySelector(sel);
    ws.scrollTop = el.getBoundingClientRect().top - ws.getBoundingClientRect().top + ws.scrollTop - off;
  }, [selector, offset]);
  await page.waitForTimeout(150);
}

async function state(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const txt = (s) => q(s)?.textContent?.trim();
    return {
      status: txt('#converterStatus'), currentFile: txt('#converterCurrentFile'), progress: txt('#converterCurrentProgress'),
      phase: q('#converterPipeline')?.dataset.currentPhase,
      stages: [...document.querySelectorAll('[data-converter-phase]')].map((s) => `${s.dataset.converterPhase}:${[...s.classList].filter((c) => c.startsWith('is-')).join('+') || '-'}`).join(' '),
      speed: txt('#converterSpeed'), eta: txt('#converterEta'), fps: txt('#converterFps'), elapsed: txt('#converterElapsed'),
      buttons: ['Start', 'Pause', 'Resume', 'Cancel', 'Retry'].map((b) => `${b}:${q(`#converter${b}`).disabled ? 'off' : 'ON'}`).join(' '),
      auto: txt('#converterAutoStatus')
    };
  });
}

async function shot(page, name, note, { keepToasts = false } = {}) {
  if (!keepToasts) await clearToasts(page);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  const s = await state(page).catch(() => ({}));
  report.push({ file, note, ...s, errors: page.errors.filter((e) => !/hasPending|version/.test(e)) });
  console.log(`saved ${name}.png — ${note}`);
}

(async () => {
  const browser = await chromium.launch();

  // 01 shell before opening the converter (tab bar lives in the Clips panel)
  {
    const { page, context } = await openConverter(browser, { clickTab: false, layout: 'modern' });
    await shot(page, '01-shell-before-converter-tab', 'Viewer shell (default layoutStyle=modern): Clips | Drives | Converter tab bar inside the floating Clips panel');
    // icon subset check: "speed" ligature width vs a known icon
    const glyphs = await page.evaluate(() => ['speed', 'tune', 'play_arrow', 'folder_open', 'expand_more'].map((name) => {
      const span = document.createElement('span'); span.className = 'material-symbols-outlined'; span.style.fontSize = '20px'; span.textContent = name;
      document.body.append(span); const w = span.getBoundingClientRect().width; span.remove(); return `${name}=${Math.round(w)}px`;
    }));
    report.push({ file: 'glyph-check', note: `Material Symbols subset widths (20px icon = 20px wide): ${glyphs.join(', ')}` });
    await context.close();
  }

  // 02 first open, nothing configured
  {
    const { page, context } = await openConverter(browser);
    await shot(page, '02-idle-first-open', 'No job: "Ready to configure", empty paths, defaults (H.265, Balanced, 5 at once, Quick)');
    // 03 web folder picker (web-only addition replacing dialog.showOpenDialog)
    await page.click('#converterChooseSource');
    await page.waitForSelector('.web-folder-picker [data-list] button');
    await page.click('.web-folder-picker [data-list] button:has-text("footage")');
    await page.waitForTimeout(200);
    await shot(page, '03-web-folder-picker', 'WEB-ONLY addition: in-page folder picker (stand-in for Electron dialog.showOpenDialog) listing server mounts');
    await page.click('.web-folder-picker [data-list] button:has-text("TeslaCam")');
    await page.waitForTimeout(150);
    await page.click('.web-folder-picker [data-choose]');
    await page.waitForFunction(() => document.querySelector('#converterSourcePath').value === '/footage/TeslaCam');
    await page.click('#converterChooseDestination');
    await page.waitForSelector('.web-folder-picker [data-list] button');
    await page.click('.web-folder-picker [data-list] button:has-text("converted")');
    await page.waitForTimeout(150);
    await page.click('.web-folder-picker [data-list] button:has-text("TeslaCam")');
    await page.waitForTimeout(150);
    await page.click('.web-folder-picker [data-choose]');
    await page.waitForFunction(() => document.querySelector('#converterDestinationPath').value === '/converted/TeslaCam');
    await shot(page, '04-idle-configured', 'Source/destination chosen through converter:chooseFolder (real ipc.js validation)');
    await scrollTo(page, '#converterProfileSelect', 60);
    await shot(page, '05-idle-lower-settings', 'Compression profile, Parallel conversions (1-10 + Custom…), Verification Off/Quick/Full, Output');
    await page.evaluate(() => { const ws = document.querySelector('#converterWorkspace'); ws.scrollTop = ws.scrollHeight; });
    await shot(page, '06-idle-auto-and-actions', 'Automatic conversion fieldset (off) and Start / Pause / Resume / Cancel / Retry failed');
    // 07 custom bitrate + custom concurrency
    await scrollTo(page, '#converterProfileSelect', 120);
    await page.selectOption('#converterProfileSelect', 'custom');
    await page.selectOption('#converterConcurrency', 'custom');
    await page.fill('#converterConcurrencyCustom', '16');
    await page.waitForTimeout(150);
    await shot(page, '07-custom-bitrate-and-custom-parallel', 'Compression "Custom bitrate…" shows Mbps box; Parallel "Custom…" shows 1-64 box');
    // 08 constant quality
    await page.selectOption('#converterProfileSelect', 'quality');
    await page.selectOption('#converterConcurrency', '8');
    await page.waitForTimeout(150);
    await shot(page, '08-constant-quality', 'Compression "Constant quality" shows High / Balanced / Small level');
    // 09 replace originals
    await page.selectOption('#converterProfileSelect', 'balanced');
    await page.click('#converterReplaceOption');
    await page.waitForTimeout(150);
    await scrollTo(page, '#converterVerifyMode', 120);
    await shot(page, '09-replace-originals-mode', 'Replace originals: destination disabled, Off verification disabled + note, backup acknowledgement row');
    // 10 start without acknowledgement -> error toast
    await clearToasts(page);
    await page.click('#converterStart');
    await page.waitForSelector('.toast');
    await page.waitForTimeout(250);
    await shot(page, '10-error-toast-replacement-ack', 'Start refused client-side: toast "Acknowledge and confirm replacement before starting."', { keepToasts: true });
    await context.close();
  }

  // 11 automatic conversion on
  {
    const { page, context } = await openConverter(browser, { scenario: 'auto' });
    await scrollTo(page, '.converter-auto-fieldset', 24);
    await shot(page, '11-auto-conversion-enabled', 'converter:getAuto enabled, window 01:00-06:00, status line "18 new clips found at … · Next check …"');
    await context.close();
  }

  // 12 discovering
  {
    const { page, context } = await openConverter(browser, { scenario: 'discovering' });
    await shot(page, '12-discovering', 'state=discovering: pipeline at Discover, counts growing, ETA "—" while discovery incomplete');
    await context.close();
  }

  // 13-15 encoding (5 at once) with live FPS
  {
    const { page, context } = await openConverter(browser, { scenario: 'encoding' });
    await harness('/__harness/progress?fps=238.4&outTimeUs=41200000');
    await page.waitForFunction(() => document.querySelector('#converterFps').textContent !== '—');
    await shot(page, '13-encoding-live', 'state=encoding, 1284 files (truncated snapshot), 5 at once, live FPS from progress event, speed + ETA');
    await scrollTo(page, '#converterTimings', 300);
    await shot(page, '14-encoding-timings-and-errors', '"Where the time goes" bars + failed-file rows (path — failure code)');
    await context.close();
  }
  {
    const { page, context } = await openConverter(browser, { scenario: 'encoding', layout: 'modern' });
    await harness('/__harness/progress?fps=241.7&outTimeUs=12800000');
    await page.waitForFunction(() => document.querySelector('#converterFps').textContent !== '—');
    await shot(page, '15-encoding-default-floating-layout', 'Same job in the DEFAULT layoutStyle=modern: the floating Clips panel (with the tab bar) overlaps the converter header/Discover stage');
    await context.close();
  }

  // 16 verifying single file (AV1, constant quality, full verify)
  {
    const { page, context } = await openConverter(browser, { scenario: 'verifying' });
    await harness('/__harness/progress?fps=61.3&outTimeUs=41200000');
    await page.waitForFunction(() => document.querySelector('#converterFps').textContent !== '—');
    await shot(page, '16-verifying-single-file-av1', 'concurrency 1: current file path shown, "00:41 encoded"; AV1 + Constant quality + Full synced from job config');
    await context.close();
  }

  // 17 paused, 18 paused_network
  {
    const { page, context } = await openConverter(browser, { scenario: 'paused' });
    await shot(page, '17-paused', 'state=paused: "Paused at a safe boundary", Resume + Cancel enabled, FPS/speed/ETA "—"');
    await context.close();
  }
  {
    const { page, context } = await openConverter(browser, { scenario: 'paused_network' });
    await shot(page, '18-paused-network-reconnect', 'state=paused_network: "Waiting for connection" + reconnect banner (SMB share dropped)');
    await context.close();
  }

  // 19-20 completed with summary
  {
    const { page, context } = await openConverter(browser, { scenario: 'completed' });
    await shot(page, '19-completed', 'state=completed: Retry failed enabled, cleanup-pending banner, overall average speed kept');
    await scrollTo(page, '#converterErrorRows', 40);
    await shot(page, '20-completed-summary', 'Verified result: totals grid, per-group rows, retention note, Dismiss');
    await context.close();
  }

  // 21 cancelled
  {
    const { page, context } = await openConverter(browser, { scenario: 'cancelled' });
    await shot(page, '21-cancelled', 'state=cancelled: "Conversion cancelled", Start enabled again');
    await context.close();
  }

  // 22 paused mid-replacement (recovery)
  {
    const { page, context } = await openConverter(browser, { scenario: 'replace-recovery' });
    await shot(page, '22-paused-mid-replacement', 'Replace-mode job paused from "replacing" (pipeline at Save); Resume finishes the backup/replace transaction');
    await context.close();
  }

  // 23-26 benchmark dialog
  for (const variant of ['both', 'av1-unsupported']) {
    const { page, context } = await openConverter(browser, { scenario: 'completed', benchmark: variant });
    await page.click('#converterBenchmarkBtn');
    await page.waitForTimeout(200);
    if (variant === 'both') await shot(page, '23-benchmark-dialog', 'Benchmark dialog before running');
    await page.click('#converterBenchmarkRun');
    await page.waitForFunction(() => /converting with/.test(document.querySelector('#converterBenchmarkStatus').textContent));
    if (variant === 'both') await shot(page, '24-benchmark-running', 'Benchmark progress text from converter:benchmarkProgress events (SSE)');
    await harness('/__harness/benchmark-finish');
    await page.waitForFunction(() => /Done/.test(document.querySelector('#converterBenchmarkStatus').textContent));
    await page.waitForTimeout(150);
    await shot(page, variant === 'both' ? '25-benchmark-results' : '26-benchmark-av1-unsupported',
      variant === 'both' ? 'H.265 vs AV1 side by side, verification Off/Quick/Full comparison, two "Use …" buttons'
        : 'AV1 not encodable here (e.g. VAAPI box without AV1): one Use button, "AV1: not supported on this computer"');
    if (variant === 'both') {
      await clearToasts(page);
      await page.click('#converterBenchmarkApplyAlt');
      await page.waitForSelector('.toast');
      await scrollTo(page, '.converter-segments', 160);
      await page.waitForTimeout(250);
      await shot(page, '27-benchmark-applied', 'After "Use AV1 · 4 at once": codec AV1 + Parallel 4 applied, info toast', { keepToasts: true });
    }
    await context.close();
  }

  // 28 full-length reference capture (taller viewport, not 900px)
  {
    const { page, context } = await openConverter(browser, { scenario: 'completed' });
    const height = await page.evaluate(() => document.querySelector('.converter-bay').scrollHeight + 10);
    await page.setViewportSize({ width: 1440, height });
    await page.waitForTimeout(300);
    await shot(page, '28-reference-full-length-1440w', `Reference only: whole workspace at 1440x${height} (completed job)`);
    await context.close();
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1));
})().catch((error) => { console.error(error); process.exit(1); });
