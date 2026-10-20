# Sentry Manager

Sentry Studio as a self-hosted web app, plus a manager for your TeslaCam
archive. It runs in Docker and serves a web UI on port **9000**.

- **Viewer.** The Sentry Studio viewer, unchanged, in the browser. It plays
  H.264, H.265 and AV1 clips with the telemetry dashboard.
- **Encoder.** The Sentry Studio converter from the `ai-testing` branch,
  unchanged: H.265 / AV1 conversion with telemetry transplant and
  verification, auto-convert, benchmark, and GPU encoding (NVIDIA, AMD
  including APUs, Intel).
- **Footage.** Recordings per vehicle, filtered by category and capture date,
  with Play, Show files, Protect and Move to trash. **Select shown** selects up
  to 100 recordings at once.
- **Recycle Bin.** Trashed recordings stay on the share until you restore them
  or delete them for good. Nothing is ever deleted automatically.
- **Policies.** Each vehicle can move recordings older than N days to the
  Recycle Bin, per category. Protected recordings are never touched.
- **Jobs, Notifications, Settings.** Every conversion, trash run and policy
  run is listed under Jobs. Notifications covers shares that are offline,
  read-only or almost full, and failed jobs. Settings holds vehicles, the
  account and updates.

## Quick start

```bash
git clone -b claude/sentry-manager-docker-ui-q31i6f https://github.com/skittles-fivem/Sentry-Sixbeta
cd Sentry-Sixbeta/manager
docker compose up -d --build
```

Open `http://<docker-host>:9000`. On the first visit you create the account.
Then go to **Settings → Add vehicle**.

The image is built from the repository root (`context: ..` in the compose
file), so it ships the same `src/` the desktop app uses.

Everything else is configured in the UI. `.env` (see `.env.example`) is
optional. Use it to create the account or a first vehicle without the UI, or
to set the time zone.

## Vehicles and SMB

Each vehicle is one footage source:

- **SMB share** (`//nas/TeslaCam`, username and password). The container
  mounts it at `/footage/<vehicle-id>` itself. The password is stored in a
  `0600` credentials file, never on a command line.
- **Folder** inside the container, for footage you mount yourself: a bind
  mount on the NAS, or a Docker CIFS volume.

For SMB shares the manager:

- checks the mount every 30 s and remounts with backoff if the NAS drops;
- every 10 minutes, runs a write test that does what a conversion does
  (create, rename, set mtime, delete);
- shows mount errors with a hint (wrong password, SMB version, missing
  capability, host kernel without CIFS). **Reconnect** retries at once.

The compose file grants `SYS_ADMIN` / `DAC_READ_SEARCH` and
`apparmor:unconfined`, which `mount.cifs` needs. The Docker host kernel needs
CIFS (`sudo modprobe cifs`). It is built in on Synology, Unraid, TrueNAS and
most distros. Shares are mounted with `serverino`, so the converter's file
identity checks stay valid on CIFS.

If you only use folder vehicles, you can remove `cap_add` and `security_opt`.

## Encoder

The Encoder tab is the desktop converter's own UI and code. The manager
connects it to the server over HTTP and server-sent events.

- **Telemetry is always kept.** The converter writes Tesla's per-frame
  telemetry (speed, GPS, gear, Autopilot) into the H.265 / AV1 output and
  verifies it. Verification **Off** is removed. Quick is the minimum, and the
  server enforces that too (insurance requirement). The benchmark still
  compares Off, Quick and Full encode times.
- **Never converted twice.** Clips that are already H.265 or AV1 are skipped
  as `already-converted`, which covers replaced files and re-runs.
  Auto-convert only picks up clips it hasn't seen. Trashed clips are renamed
  to `.binned`, so the converter ignores them.
- **Safe replacement on Linux and SMB.** The desktop app's replace mode uses
  Windows-only file operations. In the container they are replaced by
  `server/posixOwnedFs.js`:
  - the file's identity (device, inode, size, sha256) is checked before it is
    removed or replaced;
  - removal goes through a quarantine rename;
  - the new file is promoted with `renameat2(RENAME_NOREPLACE)` (native
    helper `native/noreplace-rename.c`). On CIFS this rename is no-replace on
    the server side.
- **Output.** Converted copies go next to the originals (replace mode), or
  to any folder under a vehicle. The **Converted copies** folder is
  `/data/converted`, or set `EXTRA_ROOTS`.

### GPU

The converter tries every encoder ffmpeg offers with a real test encode and
uses the fastest one that works. In the compose file, uncomment:

| GPU | Encoders | What to uncomment in `docker-compose.yml` |
| --- | --- | --- |
| NVIDIA | `hevc_nvenc`, `av1_nvenc` | the `deploy:` block (needs the NVIDIA Container Toolkit) |
| AMD dGPU or APU | `hevc_vaapi`, `av1_vaapi` (mesa radeonsi) | `devices: - /dev/dri:/dev/dri` |
| Intel iGPU / Arc | `hevc_qsv`, `av1_qsv`, VA-API | `devices: - /dev/dri:/dev/dri` |
| none | `libx265`, `libsvtav1` | nothing |

AMD's Windows encoder (AMF) does not exist on Linux, so AMD cards and APUs
encode through VA-API. AV1 encoding needs RDNA3 or newer.

VA-API uses `/dev/dri/renderD128`. On a host with several GPUs, map the
one you want to that name:

```yaml
    devices:
      - /dev/dri/renderD129:/dev/dri/renderD128
```

**Settings → System** lists the GPUs the container can see, what VA-API
reports for each, and hints when a device is missing.

## Recycle Bin and policies

**Move to trash** moves a recording's files into
`.sentry-recycle-bin/<item>/` on the same share. It is a rename, not a copy,
so it is instant and needs no space. Protected recordings, and recordings the
converter is working on, can't be trashed.

From the Recycle Bin you can restore a recording to where it was, or delete it
for good. Deleting always needs a confirmation. A restore that would
overwrite a file is refused, and the recording stays in the bin.

A policy picks a run time and a number of days to keep for each category
(Recent, Sentry, Saved, Other). Recordings older than that, by capture day in
the vehicle's time zone, are moved to the Recycle Bin. The policy page
previews what the next run would move.

## Updates from GitHub

**Settings → Updates** checks a repository and branch on GitHub (pick from
the list) and installs that commit. For a private repository, add a token
with read access. With **automatic updates** on, it checks every 1–24 hours
and installs when nothing is converting.

An update is downloaded to `/data/app/releases/<commit>`. It is checked
(required files, syntax), and the app restarts into it. If the new version
crashes within 60 seconds, the container goes back to the previous version,
or the one built into the image. Updates replace the app's code. ffmpeg,
drivers and the native rename helper come with the image, so rebuild the image
(`docker compose up -d --build`) to update those.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `TZ` | `UTC` | Server time zone (logs, default vehicle time zone) |
| `UI_USERNAME` / `UI_PASSWORD` | | Create the account on first start |
| `VEHICLE_NAME`, `SMB_SHARE`, `SMB_USERNAME`, `SMB_PASSWORD`, `SMB_DOMAIN`, `SMB_VERSION`, `SMB_OPTIONS` | | Create a first SMB vehicle on first start |
| `FOOTAGE_PATH` | | Create a first folder vehicle instead |
| `PUID` / `PGID` | `0` | Owner of files written on SMB shares |
| `UPDATE_REPO` / `UPDATE_BRANCH` | this repo / the built branch | Update defaults |
| `EXTRA_ROOTS` | | More container folders the converter may write to (`:`-separated) |
| `SCAN_INTERVAL_MINUTES` | `15` | Re-scan every vehicle |
| `SECURE_COOKIES` | `false` | Send the session cookie only over HTTPS |
| `PORT`, `DATA_PATH`, `LOG_LEVEL` | `9000`, `/data`, `info` | |

`/data` holds the account, settings, job history, thumbnails, converter
staging and installed updates. Keep it on local disk, not on a share.

Sign-in is required. Five failed sign-ins slow down further attempts. If the
port is reachable from outside your network, put it behind a TLS reverse proxy
and set `SECURE_COOKIES=true`.

## Not in the web version (yet)

- Export, clip sharing and the SentryUSB drive tools from the desktop app.
  They show "not available" in the web viewer.
- Desktop-only converter options (keep running when closed, start with
  Windows) are hidden.

## Development

Node.js 22.13+ (it uses the built-in `node:sqlite`; there are no npm
packages) and ffmpeg.

```bash
cd manager
gcc -O2 -o build/noreplace-rename native/noreplace-rename.c
npm test
DATA_PATH=./data FOOTAGE_PATH=/path/to/TeslaCam SENTRY_NOREPLACE_RENAME=build/noreplace-rename npm start
```

The converter's own tests are the repository's Jest suites
(`tests/main/converter`). `manager/test/server.test.js` starts the server and
tests it over HTTP, including an update install and a rollback.
