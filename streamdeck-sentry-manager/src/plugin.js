// Stream Deck plugin: shows Sentry Six Manager's download count on a key and
// checks it every 30 seconds while the key is visible. Pressing the key checks
// at once; a long press (over a second) opens the package page.

import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { PACKAGE_URL, fetchDownloads, keyCount } from './downloads.js';
import { keyImage } from './key-image.js';

const ACTION_ID = 'com.sentrysix.manager-downloads.count';
const INTERVAL_MS = 30_000;
const LONG_PRESS_MS = 1000;

class DownloadCount extends SingletonAction {
  manifestId = ACTION_ID;

  /** The last count read, the first one since the plugin started (for the "+N new" line) and the last error, shared by every key. */
  count = null;
  firstCount = null;
  error = null;
  timer = null;
  checking = null;
  pressedAt = new Map();
  visible = new Set();

  onWillAppear(ev) {
    this.visible.add(ev.action.id);
    this.draw(ev.action);
    // One timer for all visible keys: started by the first, stopped with the last
    if (!this.timer) {
      this.check();
      this.timer = setInterval(() => this.check(), INTERVAL_MS);
    }
  }

  onWillDisappear(ev) {
    this.visible.delete(ev.action.id);
    if (this.visible.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onKeyDown(ev) {
    this.pressedAt.set(ev.action.id, Date.now());
  }

  async onKeyUp(ev) {
    const held = Date.now() - (this.pressedAt.get(ev.action.id) ?? Date.now());
    this.pressedAt.delete(ev.action.id);
    if (held >= LONG_PRESS_MS) {
      await streamDeck.system.openUrl(PACKAGE_URL);
      return;
    }
    await this.check();
    if (this.error) await ev.action.showAlert();
    else await ev.action.showOk();
  }

  /** Reads the count once (a check already running is shared, not doubled) and redraws every key. */
  check() {
    this.checking ??= fetchDownloads()
      .then((total) => {
        this.count = total;
        this.firstCount ??= total;
        this.error = null;
      })
      .catch((err) => {
        this.error = err.message;
        streamDeck.logger.warn(`download count: ${err.message}`);
      })
      .finally(() => {
        this.checking = null;
        for (const action of this.actions) this.draw(action);
      });
    return this.checking;
  }

  draw(action) {
    let status = 'checking…';
    let statusColor = '#9aa4ae';
    if (this.error) {
      status = this.error;
      statusColor = '#ffb300';
    } else if (this.count !== null) {
      const gain = this.count - this.firstCount;
      status = gain > 0 ? `+${gain.toLocaleString('en-US')} new` : 'live';
      statusColor = gain > 0 ? '#43a047' : '#9aa4ae';
    }
    const count = this.count === null ? null : keyCount(this.count);
    return action.setImage(keyImage({ count, status, statusColor }));
  }
}

streamDeck.actions.registerAction(new DownloadCount());
streamDeck.connect();
