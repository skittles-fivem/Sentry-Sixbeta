'use strict';

// What graphics hardware the container can see, for the Settings / Encoder
// pages. The converter's own planner decides which encoder is used (it test-
// encodes each candidate); this only explains what is there and why a GPU
// might not be used.

const fs = require('fs');
const path = require('path');
const { run } = require('./proc');

const VENDORS = { '0x1002': 'amd', '0x10de': 'nvidia', '0x8086': 'intel' };
const VENDOR_NAMES = { amd: 'AMD', nvidia: 'NVIDIA', intel: 'Intel' };

function readSys(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

/** Parse `vainfo` output into a driver name and the codecs it can encode. */
function parseVainfo(text) {
  const driver = (text.match(/Driver version:\s*(.+)/) || [])[1]?.trim() || null;
  const enc = (profile) => new RegExp(`${profile}\\s*:\\s*VAEntrypointEncSlice(LP)?\\b`).test(text);
  const lpOnly = (profile) => new RegExp(`${profile}\\s*:\\s*VAEntrypointEncSliceLP`).test(text)
    && !new RegExp(`${profile}\\s*:\\s*VAEntrypointEncSlice\\b(?!LP)`).test(text);
  return {
    driver,
    encodes: {
      h264: enc('VAProfileH264(High|Main|ConstrainedBaseline)'),
      hevc: enc('VAProfileHEVCMain'),
      av1: enc('VAProfileAV1Profile0')
    },
    lowPowerOnly: lpOnly('VAProfileHEVCMain')
  };
}

/** A friendly GPU name out of the VA driver string, e.g. "AMD Radeon Graphics (renoir)". */
function nameFromDriver(driver) {
  if (!driver) return null;
  const m = driver.match(/for (AMD [^(]+)\(radeonsi, ([a-z0-9_]+)/i);
  if (m) return `${m[1].trim()} (${m[2]})`;
  if (/Intel iHD driver/i.test(driver)) return 'Intel graphics (iHD)';
  return driver.slice(0, 80);
}

async function detectGpus({ driDir = '/dev/dri', sysDrm = '/sys/class/drm' } = {}) {
  const gpus = [];
  let passed = [];
  try {
    passed = fs.readdirSync(driDir).filter((n) => /^renderD\d+$/.test(n)).sort();
  } catch {
    passed = [];
  }
  // sysfs is not namespaced: it lists the host's GPUs even when /dev/dri is not passed in.
  let hostNodes = [];
  try {
    hostNodes = fs.readdirSync(sysDrm).filter((n) => /^renderD\d+$/.test(n)).sort();
  } catch {
    hostNodes = [];
  }
  for (const node of [...new Set([...hostNodes, ...passed])]) {
    const vendorId = readSys(path.join(sysDrm, node, 'device', 'vendor'));
    const vendor = VENDORS[vendorId] || null;
    let driverName = null;
    try {
      driverName = path.basename(fs.readlinkSync(path.join(sysDrm, node, 'device', 'driver')));
    } catch {
      driverName = null;
    }
    const entry = {
      node: `/dev/dri/${node}`, vendor, vendorName: VENDOR_NAMES[vendor] || vendorId || 'unknown', driver: driverName,
      name: null, passedThrough: passed.includes(node), encodes: null, lowPowerOnly: false
    };
    if (entry.passedThrough && vendor !== 'nvidia') {
      const va = await run('vainfo', ['--display', 'drm', '--device', entry.node], { timeoutMs: 10000 });
      if (va.code === 0 || va.stdout) {
        const info = parseVainfo(`${va.stdout}\n${va.stderr}`);
        entry.name = nameFromDriver(info.driver);
        entry.encodes = info.encodes;
        entry.lowPowerOnly = info.lowPowerOnly;
      }
    }
    gpus.push(entry);
  }
  const smi = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { timeoutMs: 10000 });
  const nvidia = smi.code === 0
    ? smi.stdout.trim().split('\n').filter(Boolean).map((l) => {
      const [name, driver] = l.split(',').map((s) => s.trim());
      return { name, driver };
    })
    : [];
  const hints = [];
  for (const g of gpus) {
    if (!g.passedThrough && g.vendor !== 'nvidia') hints.push(`${g.vendorName} GPU found on the host but /dev/dri is not passed into the container (add devices: - /dev/dri:/dev/dri).`);
    if (g.passedThrough && g.encodes && !g.encodes.hevc) hints.push(`${g.name || g.node}: the VA-API driver reports no H.265 encoder.`);
  }
  if (gpus.some((g) => g.vendor === 'nvidia') && !nvidia.length) {
    hints.push('An NVIDIA GPU is on the host but not available in the container. Use the NVIDIA Container Toolkit (gpus: all) with NVIDIA_DRIVER_CAPABILITIES=compute,video,utility.');
  }
  return { gpus, nvidia, hints };
}

module.exports = { detectGpus, parseVainfo, nameFromDriver };
