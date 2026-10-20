# Sentry Manager web version: decisions and plan

Saved so the work can resume without re-asking or re-mapping.

## Direction (from the user)

- Build on the **`ai-testing`** branch (merged into this branch in 3108d3d). Reuse its
  converter (`src/main/converter/*`, verified H.265 / AV1 with telemetry) and its viewer
  (`src/renderer`, which plays H.265/AV1). Do not write a separate encoder.
- Docker web clone of Sentry Studio: viewer + encoding + a manager for file management.
- UI like the user's screenshots: a rounded left sidebar ("Sentry Manager" + shield logo)
  with Overview, Footage, Policies, Jobs, Recycle Bin, Notifications, Settings and a
  Collapse button; top bar with a breadcrumb and a "Reduce visual effects" checkbox; page
  header ("Your archive workspace" / big title) with Sign out; vehicle pills
  ("Daily Driver", "Weekend Car" with recording counts). Add an **Encoder** tab that looks
  **exactly** like the ai-testing converter (see `converter-ui-screens/`).
- Footage page (from screenshot): Category + Capture date filters; "N recordings shown ·
  capture times use the vehicle timezone"; selection panel (N selected, Move to trash,
  Review conversion, Conversion options); Select shown (up to 100) / Clear selection;
  recording cards with thumbnail, timestamp, type chip, files, size, original capture,
  Play recording, Show files, Protect recording.
- Overview (from screenshot): Management ready badge, timezone, Vehicle settings, Refresh
  inventory, "Last discovered inventory" and "Last observed free" cards, Browse your
  archive (Open footage), Current archive alerts (Refresh current alerts, Open notifications).

## Answers to scope questions

- Vehicles: **several, one share per vehicle**.
- Deleting: **Recycle Bin, manual only**. Move to trash is a move inside the same share;
  nothing is ever deleted automatically; restore or delete forever from the bin.
- Tabs: Overview, Footage, Encoder, **Policies, Jobs, Notifications, Settings + login**.
  Policies may only move clips to the Recycle Bin; protected recordings are never touched.
- Settings must include **auto-update from GitHub with branch selection**.
- Earlier requirements still hold: GPU encoding for **NVIDIA and AMD including APUs**
  (VA-API via mesa radeonsi; Ubuntu ffmpeg 6.1 has no AMF) plus Intel; **telemetry can
  never be lost** (insurance) and there is no setting to turn preservation off.

## Facts established

- `notes/ai-testing-port-map.md`: full map of converter backend, encoders/telemetry and
  viewer (IPC surface, Electron dependencies, Linux/Docker gaps, port plans, risks).
- `notes/ai-testing-test-run.md`: the ai-testing converter tests pass on Linux with
  Ubuntu ffmpeg 6.1 (869 unit, 60 studio telemetry, 6 integration; 0 failures).
- `notes/converter-ui-screens/`: 28 screenshots of the real ai-testing converter UI in a
  browser with a mocked `electronAPI`; `notes/converter-ui-harness/` regenerates them
  (`server.cjs`, `scenarios.cjs`, `harness/electron-api-shim.js`). The shim is the starting
  point for running `footageConverter.js` unchanged in the web app.
- Ubuntu 24.04 mesa is built with `video-codecs=all` (AMD VA-API H.264/H.265 encode works).
- ffmpeg: `-fps_mode passthrough` without `-enc_time_base demux` shifts VFR frame times by
  up to ~11 ms; with it the times are exact. Check the ai-testing pipeline uses it.
- The first manager version (bacc554, `manager/src`, `manager/public`) has reusable parts:
  SMB mount manager (`share.js`, tested against real Samba), scanner, purge safety, SSE
  server, Dockerfile (Ubuntu 24.04 + Node 24 + ffmpeg + VA drivers). Its own encoder
  (`encoder.js`, `ffmpegArgs.js`, `encoderDetect.js`) is superseded by ai-testing's.

## Plan

1. Backend: host the ai-testing converter headless in the manager server (thin adapter for
   the Electron bits, IPC replaced by HTTP + SSE), vehicles (one share each, reuse
   `share.js`), footage inventory + thumbnails, protect, trash/Recycle Bin (manual), policies
   (move to bin only), jobs, notifications, login sessions, GitHub updater with branch choice.
2. UI: screenshot-style shell; Encoder tab = ai-testing `footageConverter.js` + CSS via an
   `electronAPI` shim; viewer = `src/renderer` served with footage over HTTP (Range).
3. Verify: converter tests in the image, Samba end-to-end, every tab at desktop and phone
   widths, adversarial review, then push.

## Status

- Done: merge of ai-testing, mapping (3 of 5 areas complete, converter-UI screenshots and
  test run saved from the 2 interrupted agents).
- Next: step 1.
