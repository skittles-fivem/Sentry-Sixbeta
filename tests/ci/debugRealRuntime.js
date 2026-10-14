'use strict';
// TEMPORARY CI diagnostics: one real conversion, job details as annotations.
const fs = require('fs');
const path = require('path');
const { locateBundledTools } = require('../main/converter/ffmpegFixtures');
const { clipName, makeClip, makeRoot, makeRuntime } = require('../main/converter/realRuntime');

async function run(label) {
  const out = (text) => process.stdout.write(`::error title=debug ${label}::${String(text).replace(/\r?\n/g, '%0A').slice(0, 6000)}\n`);
  try {
    const tools = await locateBundledTools();
    const root = await makeRoot('debug');
    await makeClip(tools, path.join(root, 'TeslaCam', 'RecentClips', clipName(0)), { seconds: 2 });
    const errors = [];
    const runtime = await makeRuntime(tools, root, { autoConvert: false, onError: (error) => errors.push(String(error?.code || error)) });
    const events = [];
    runtime.service.subscribe((event) => { if (events.length < 40) events.push({ type: event.type, state: event.snapshot?.state, items: event.snapshot?.items?.length, failure: event.snapshot?.failure }); });
    const id = await runtime.service.start({ sourceRoot: path.join(root, 'TeslaCam'), destinationRoot: path.join(root, 'out'), codec: 'h265', profileId: 'balanced',
      networkMode: 'direct', outputMode: 'separate', includedGroups: ['RecentClips'], replacementConfirmed: false });
    const job = await runtime.service.whenIdle(id);
    out(JSON.stringify({ state: job.state, failure: job.failure, recovery: job.recovery, discoveryComplete: job.discoveryComplete,
      items: job.items.map((item) => ({ state: item.state, resultCode: item.resultCode, failure: item.failure })), errors, events: events.slice(0, 15),
      listing: fs.readdirSync(path.join(root, 'TeslaCam', 'RecentClips')) }, null, 1));
    await runtime.shutdown();
  } catch (error) {
    out(`threw: ${error?.stack || error}`);
  }
}
module.exports = { run };
if (require.main === module) run('node');
