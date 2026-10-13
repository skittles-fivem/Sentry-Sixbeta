'use strict';
// Turns a jest --json result file into GitHub error annotations so failing
// tests are readable from the checks API/UI without downloading the full log.
const fs = require('fs');
const file = process.argv[2] || 'jest-results.json';
if (!fs.existsSync(file)) {
  console.log(`::error title=jest::No jest result file (${file}); the test run crashed before reporting.`);
  process.exit(1);
}
const results = JSON.parse(fs.readFileSync(file, 'utf8'));
const escape = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const strip = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, '');
let failures = 0;
for (const suite of results.testResults || []) {
  const relative = suite.name.replace(/\\/g, '/').replace(/^.*?(tests\/)/, '$1');
  if (suite.status === 'failed' && (!suite.assertionResults || suite.assertionResults.length === 0)) {
    failures += 1;
    console.log(`::error file=${relative},title=${escape('suite failed to run')}::${escape(strip(suite.message).slice(0, 3000))}`);
  }
  for (const test of suite.assertionResults || []) {
    if (test.status !== 'failed') continue;
    failures += 1;
    const detail = strip((test.failureMessages || []).join('\n')).split('\n').slice(0, 25).join('\n');
    console.log(`::error file=${relative},title=${escape(test.fullName.slice(0, 200))}::${escape(detail.slice(0, 3000))}`);
  }
}
console.log(`${results.numPassedTests} passed, ${results.numFailedTests} failed, ${results.numPendingTests} skipped`);
process.exit(failures ? 1 : 0);
