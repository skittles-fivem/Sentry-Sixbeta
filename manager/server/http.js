'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.icns': 'application/octet-stream', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.proto': 'text/plain; charset=utf-8',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.gif': 'image/gif', '.webp': 'image/webp'
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const text = await readBody(req, limit);
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** Minimal router: add('GET', '/api/x/:id', handler). */
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })}$`);
    this.routes.push({ method, re, keys, handler, opts });
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch {
        return null;
      }
      return { route: r, params };
    }
    return null;
  }
}

/**
 * Serve a file below `root`; resolves false if there is none. `rel` is the
 * already decoded and normalized request path below the route prefix.
 */
async function serveFile(req, res, root, rel, { transform, cache = 'no-cache', headers = {} } = {}) {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.split('/').some((seg) => seg === '..')) return false;
  const abs = path.resolve(root, `.${path.sep}${rel}`);
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const type = STATIC_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  if (transform) {
    const body = transform(await fsp.readFile(abs, 'utf8'));
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(abs).pipe(res);
  return true;
}

module.exports = { Router, HttpError, sendJson, readJson, serveFile };
