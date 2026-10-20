'use strict';

const { EventEmitter } = require('events');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Console logger that also keeps the last N lines for the web UI. */
class Logger extends EventEmitter {
  constructor({ level = 'info', keep = 300, silent = false } = {}) {
    super();
    this.min = LEVELS[level] || LEVELS.info;
    this.keep = keep;
    this.silent = silent;
    this.lines = [];
  }

  write(level, scope, message) {
    if (LEVELS[level] < this.min) return;
    const entry = { at: Date.now(), level, scope, message: String(message) };
    this.lines.push(entry);
    if (this.lines.length > this.keep) this.lines.splice(0, this.lines.length - this.keep);
    if (!this.silent) {
      const line = `${new Date(entry.at).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${entry.message}`;
      (level === 'error' || level === 'warn' ? console.error : console.log)(line);
    }
    this.emit('line', entry);
  }

  scope(name) {
    return {
      debug: (m) => this.write('debug', name, m),
      info: (m) => this.write('info', name, m),
      warn: (m) => this.write('warn', name, m),
      error: (m) => this.write('error', name, m)
    };
  }

  recent(limit = 100) {
    return this.lines.slice(-limit);
  }
}

module.exports = { Logger };
