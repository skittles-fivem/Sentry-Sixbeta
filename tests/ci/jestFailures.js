'use strict';

// Prints one GitHub annotation listing every failed Jest test (from
// `jest --json --outputFile=<file>`), so the full list is visible on the run
// page even when there are more failures than per-test annotations allow.
//   node tests/ci/jestFailures.js jest-results.json "Unit tests (windows)"

const fs = require('fs');

const [file, label = 'Jest'] = process.argv.slice(2);
let results;
try {
  results = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.log(`::error title=${label}::No Jest results were written (${error.message})`);
  process.exit(0);
}
const failed = [];
for (const suite of results.testResults || []) {
  const suiteName = suite.name.replace(/\\/g, '/').replace(/^.*\/tests\//, 'tests/');
  if (suite.status === 'failed' && (!suite.assertionResults || suite.assertionResults.length === 0)) {
    failed.push(`${suiteName}: ${String(suite.message || 'failed to run').split('\n').find((line) => line.trim()) || ''}`);
  }
  for (const test of suite.assertionResults || []) {
    if (test.status === 'failed') failed.push(`${suiteName} › ${test.fullName}`);
  }
}
const summary = `${results.numPassedTests} passed, ${results.numFailedTests} failed, ${results.numPendingTests} skipped`;
console.log(`${label}: ${summary}`);
if (failed.length) {
  const lines = failed.slice(0, 60).join('\n') + (failed.length > 60 ? `\n… and ${failed.length - 60} more` : '');
  console.log(`::error title=${label} - ${failed.length} failed::${lines.replace(/%/g, '%25').replace(/\r?\n/g, '%0A')}`);
}
