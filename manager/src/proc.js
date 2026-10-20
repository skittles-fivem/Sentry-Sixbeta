'use strict';

const { spawn } = require('child_process');

/**
 * Run a command without a shell and collect its output.
 * Resolves (never rejects) with { code, stdout, stderr, timedOut, error }.
 */
function run(cmd, args, { timeoutMs = 60000, maxOutput = 4 * 1024 * 1024, input } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, ...result });
    };

    let child;
    try {
      child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout, stderr, timedOut, error });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxOutput) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxOutput) stderr += chunk;
    });
    child.on('error', (error) => finish({ code: -1, error }));
    child.on('close', (code, signal) => finish({ code: code === null ? -1 : code, signal }));
    if (input !== undefined) child.stdin.end(input);
  });
}

function cleanLines(text) {
  return String(text || '')
    .split('\n')
    // drop ffmpeg's "[h264_nvenc @ 0x55bc...]" context prefixes
    .map((l) => l.replace(/\[[^\]]* @ 0x[0-9a-f]+\]\s*/gi, '').trim())
    .filter(Boolean);
}

/** Last few meaningful lines of ffmpeg/mount stderr, for error messages. */
function tail(text, lines = 4) {
  return cleanLines(text).slice(-lines).join(' | ');
}

/** First few lines; ffmpeg prints the root cause first and fallout after. */
function head(text, lines = 2) {
  return cleanLines(text).slice(0, lines).join(' | ');
}

module.exports = { run, tail, head };
