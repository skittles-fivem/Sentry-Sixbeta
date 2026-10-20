// End-to-end: unmodified footageConverter.js -> shim (fetch/SSE) -> unmodified ipc.js -> fake service.
const { execSync } = require('child_process');
const assert = require('assert/strict');
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright');
const BASE = 'http://127.0.0.1:9310';
(async () => {
  await fetch(`${BASE}/__harness/scenario?name=none`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const ipc = [];
  page.on('request', (r) => { if (r.url().includes('/api/ipc/')) ipc.push(`${decodeURIComponent(r.url().split('/api/ipc/')[1])} ${r.postData()}`); });
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.goto(`${BASE}/src/renderer/index.html?layout=classic`, { waitUntil: 'networkidle' });
  await page.click('#converterTabBtn');
  await page.waitForFunction(() => document.querySelector('#converterReplaceCapability').textContent === 'Available on this filesystem');
  const status = () => page.textContent('#converterStatus');

  // Fill paths the same way chooseFolder would (picker covered by shoot.cjs)
  await page.evaluate(() => { document.querySelector('#converterSourcePath').value = '/footage/TeslaCam'; document.querySelector('#converterDestinationPath').value = '/converted/TeslaCam'; });
  await page.selectOption('#converterProfileSelect', 'custom');
  await page.fill('#converterCustomBitrate', '3.5');
  await page.selectOption('#converterVerifyMode', 'full');
  await page.click('#converterStart');
  await page.waitForFunction(() => document.querySelector('#converterStatus').textContent === 'Discovering footage');
  const startCall = ipc.find((line) => line.startsWith('converter:start '));
  console.log('start payload:', startCall);
  assert.match(startCall, /"bitrateKbps":3500/);
  assert.match(startCall, /"verifyMode":"full"/);
  assert.equal(await page.isDisabled('#converterStart'), true);

  await page.click('#converterPause');
  await page.waitForFunction(() => document.querySelector('#converterStatus').textContent === 'Paused at a safe boundary');
  assert.equal(await page.isEnabled('#converterResume'), true);
  await page.click('#converterResume');
  await page.waitForFunction(() => document.querySelector('#converterStatus').textContent !== 'Paused at a safe boundary');
  await page.click('#converterCancel');
  await page.waitForFunction(() => document.querySelector('#converterStatus').textContent === 'Conversion cancelled');
  console.log('confirm() texts:', dialogs);

  // Automatic conversion: turning it on sends the current job settings
  await page.check('#converterAutoEnabled');
  await page.waitForFunction(() => /Next check/.test(document.querySelector('#converterAutoStatus').textContent));
  const setAuto = ipc.filter((line) => line.startsWith('converter:setAuto ')).pop();
  console.log('setAuto payload:', setAuto.slice(0, 260), '…');
  assert.match(setAuto, /"enabled":true/);
  console.log('auto status:', await page.textContent('#converterAutoStatus'));

  // Server-pushed snapshot reaches the page over SSE (e.g. a job started by the auto converter)
  await fetch(`${BASE}/__harness/scenario?name=encoding`);
  await fetch(`${BASE}/__harness/snapshot`);
  await page.waitForFunction(() => document.querySelector('#converterStatus').textContent === 'Encoding video');
  console.log('after server-pushed new job:', await status(), '|', await page.textContent('#converterCountDiscovered'));
  console.log('IPC channels used:', [...new Set(ipc.map((l) => l.split(' ')[0]))].join(', '));
  await browser.close();
  console.log('FUNCTIONAL PASS');
})().catch((e) => { console.error(e); process.exit(1); });
