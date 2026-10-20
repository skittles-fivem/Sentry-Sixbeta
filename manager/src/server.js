'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { isValidDay } = require('./footage');
const { CLIP_TYPES } = require('./config');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authorized(req, auth) {
  if (!auth.password) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  // compare both halves every time so timing doesn't reveal which was wrong
  const userOk = safeEqual(decoded.slice(0, idx), auth.username);
  const passOk = safeEqual(decoded.slice(idx + 1), auth.password);
  return userOk && passOk;
}

/** Block cross-site requests to mutating endpoints (no CORS is ever granted). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR + path.sep)) return false;
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': rel.startsWith('fonts/') ? 'public, max-age=604800' : 'no-cache',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(abs).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function createServer(app, { config, logger }) {
  const log = logger.scope('http');
  const clients = new Set();

  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };

  // Status changes can fire many times a second while encoding; coalesce.
  let statusTimer = null;
  app.on('status', () => {
    if (statusTimer || !clients.size) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      broadcast('status', app.status());
    }, 500);
  });
  let daysTimer = null;
  app.on('days', () => {
    if (daysTimer || !clients.size) return;
    daysTimer = setTimeout(() => {
      daysTimer = null;
      broadcast('days', { at: Date.now() });
    }, 1000);
  });
  logger.on('line', (line) => {
    if (clients.size) broadcast('log', line);
  });
  const keepAlive = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  keepAlive.unref();

  const routes = {
    'GET /api/status': () => app.status(),
    'GET /api/days': () => ({ days: app.days(), scannedAt: app.scanInfo.lastScanAt }),
    'GET /api/history': () => ({ history: app.db.recentHistory(100) }),
    'GET /api/logs': () => ({ lines: logger.recent(200) }),
    'POST /api/scan': () => {
      app.scan().catch(() => {});
      return { ok: true };
    },
    'POST /api/purge': async (body) => {
      const days = Array.isArray(body.days) ? body.days.filter((d) => typeof d === 'string' && isValidDay(d)) : [];
      if (!days.length) throw Object.assign(new Error('Pick at least one day.'), { status: 400 });
      const types = Array.isArray(body.types) && body.types.length ? body.types.filter((t) => CLIP_TYPES.includes(t)) : CLIP_TYPES;
      return app.purge(days, types);
    },
    'POST /api/encoding/pause': () => {
      app.encoder.pause();
      return { ok: true };
    },
    'POST /api/encoding/resume': () => {
      app.encoder.resume();
      return { ok: true };
    },
    'POST /api/encoding/retry-failed': () => {
      const reset = app.encoder.retryFailed();
      app.scan().catch(() => {});
      return { ok: true, reset };
    },
    'POST /api/encoding/prioritize': (body) => {
      if (!isValidDay(body.day)) throw Object.assign(new Error('Invalid day.'), { status: 400 });
      return { ok: true, queued: app.encoder.prioritizeDay(body.day) };
    },
    'POST /api/encoder/detect': () => {
      app.encoder.detect();
      return { ok: true };
    },
    'POST /api/share/reconnect': async () => {
      const share = await app.share.reconnect();
      if (share.healthy) app.scan().catch(() => {});
      return { ok: true, share };
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      if (!authorized(req, config.auth)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Sentry Manager", charset="UTF-8"' });
        return res.end('Authentication required');
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write(`event: status\ndata: ${JSON.stringify(app.status())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      const handler = routes[`${req.method} ${url.pathname}`];
      if (handler) {
        let body = {};
        if (req.method === 'POST') {
          if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request refused.' });
          if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
            return sendJson(res, 415, { error: 'Send JSON (Content-Type: application/json).' });
          }
          body = await readJson(req);
        }
        return sendJson(res, 200, await handler(body));
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        if (await serveStatic(req, res, url.pathname)) return;
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname}: ${err.stack || err.message}`);
      if (!res.headersSent) sendJson(res, status, { error: err.message });
      else res.end();
    }
  });

  server.closeAll = () => {
    for (const res of clients) res.end();
    clients.clear();
    clearInterval(keepAlive);
  };
  return server;
}

module.exports = { createServer, authorized, sameOrigin };
