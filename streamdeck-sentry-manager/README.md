# Sentry Manager Downloads — Stream Deck plugin

A Stream Deck key that shows how many times
[Sentry Six Manager](https://github.com/skittles-fivem/Sentry-Manager)'s Docker image has been downloaded,
checked **every 30 seconds**.

| Key | Meaning |
|---|---|
| big number | total downloads (`1,234`, then `123k`, `1.2M`) |
| `live` (grey) | up to date, no new downloads since the plugin started |
| `+N new` (green) | downloads gained since the plugin started (resets when Stream Deck restarts) |
| `offline` / `HTTP 503` / `rate limited` / `no count` (amber) | the last check failed; the number shown is the last good one |

- **Press** the key: check now (a checkmark when it worked, a warning triangle when it did not).
- **Hold** it for a second: open the package page in the browser.

## Where the number comes from

GitHub shows the container image's "Total downloads" on
[the package page](https://github.com/skittles-fivem/Sentry-Manager/pkgs/container/sentry-manager) but has no API
for it, so the plugin reads that page, the same way the Sentry-Manager README badge does
(`tools/downloadsBadge.js` there). It is the same number as the badge, but live rather than once a day. The plugin
only polls while a key is on screen.

## Install

Needs **Stream Deck 7.1 or newer** (Windows 10+ or macOS 12+); it runs on Stream Deck's built-in Node.js, nothing else
to install.

- Double-click `com.sentrysix.manager-downloads.streamDeckPlugin` (build it with `npm run pack`, below), then drag
  **Sentry Manager Downloads → Download count** from the action list onto a key.
- Or, for development, link the folder: `npx streamdeck link com.sentrysix.manager-downloads.sdPlugin`.

## Build

```sh
npm install
npm test          # parser and key image tests
npm run build     # bundles src/ into com.sentrysix.manager-downloads.sdPlugin/bin/plugin.js
npm run pack      # build + com.sentrysix.manager-downloads.streamDeckPlugin
```

The bundled `bin/plugin.js` is committed, so the `.sdPlugin` folder works as-is without building.

To change the interval, edit `INTERVAL_MS` in `src/plugin.js` and rebuild. GitHub may answer `429` if the page is read
much more often than every 30 seconds.
