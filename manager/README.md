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
SENTRY_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
docker logs sentry-manager
```

(`SENTRY_COMMIT` tells the image which commit it was built from, so Settings
shows the exact version and the updater knows when it is already current.)

The log shows two things you need once:

- the **setup code**. Open `https://<docker-host>:9000`, enter the code and
  choose the account's user name and password. Without the code nobody, not
  even someone who reaches the page before you, can create the account.
- the **HTTPS fingerprint** of Sentry Manager's certificate authority. See
  [Security](#security) for installing it on your devices, so browsers trust
  the page and nobody can pose as it.

Then go to **Settings → Add vehicle**.

The image is built from the repository root (`context: ..` in the compose
file), so it ships the same `src/` the desktop app uses.

Everything else is configured in the UI. `.env` (see `.env.example`) is
optional. Use it to create the account or a first vehicle without the UI, to
set the time zone, or the names the HTTPS certificate covers.

## Vehicles and SMB

Each vehicle is one footage source:

- **SMB share** (`//nas/TeslaCam`, user name and password). The container
  mounts it at `/footage/<vehicle-id>` itself.
- **Folder** inside the container, for footage you mount yourself (a bind
  mount on the NAS, or a Docker CIFS volume). It must be below `/footage`
  (for example `- /volume1/TeslaCam:/footage/car` in the compose file), or
  below a folder listed in `FOLDER_ROOTS`.

Every SMB mount is protected against a man in the middle, with no settings
that can weaken it:

- **SMB 3 only**: 3.1.1 by default, or 3.02 / 3.0 for older servers. SMB 1
  and 2 cannot encrypt and are easier to downgrade, so they are refused.
- **Encrypted and signed.** Encryption is on by default. If your NAS cannot
  encrypt, you can turn encryption off for that vehicle; signing then stays
  required. Either way, someone on the network who does not know the password
  cannot change the footage or pose as your NAS. Without encryption they could
  watch it.
- **A real account**: guest access has no keys to sign or encrypt with, so it
  is not allowed. Use a dedicated NAS user with access to the TeslaCam share
  only, and a long random password.
- **Nothing on a share can run**: shares are mounted `nosuid,nodev,noexec`,
  and symlinks on a share are never followed outside it.
- **Credentials stay with root**: the password goes in a `0600` file only the
  root supervisor can read, never on a command line. Mount options are built
  from the fields above; there is no free-form options field.

For SMB shares the manager also:

- checks the mount every 30 s and remounts with backoff if the NAS drops;
- every 10 minutes, runs a write test that does what a conversion does
  (create, rename, set mtime, delete);
- shows mount errors with a hint (wrong password, no SMB 3 encryption on the
  NAS, missing capability, host kernel without CIFS). **Reconnect** retries
  at once.

To turn on SMB 3 encryption on the NAS: Synology: *Control Panel > File
Services > SMB > Advanced* (minimum SMB 3, encryption on); Samba / TrueNAS /
Unraid: `server min protocol = SMB3` and `server smb encrypt = desired`;
Windows: `Set-SmbServerConfiguration -EncryptData $true`.

The Docker host kernel needs CIFS (`sudo modprobe cifs`). It is built in on
Synology, Unraid, TrueNAS and most distros. Shares are mounted with
`serverino`, so the converter's file identity checks stay valid on CIFS.

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
| `UI_USERNAME` / `UI_PASSWORD` | | Create the account on first start (instead of the setup code) |
| `VEHICLE_NAME`, `SMB_SHARE`, `SMB_USERNAME`, `SMB_PASSWORD`, `SMB_DOMAIN`, `SMB_VERSION`, `SMB_ENCRYPT`, `SMB_PORT` | | Create a first SMB vehicle on first start |
| `FOOTAGE_PATH` | | Create a first folder vehicle instead |
| `FOLDER_ROOTS` | | More folders (`:`-separated) folder vehicles may be in, besides `/footage` |
| `PUID` / `PGID` | `1000` | The unprivileged user the app runs as; it owns `/data` and the files on the shares |
| `TLS_HOSTNAMES` | | Names / IP addresses the HTTPS certificate covers (more in Settings > Security) |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | | Use your own certificate instead of the local CA |
| `TLS_MODE` | `auto` | `off` = plain HTTP, only behind a reverse proxy that does HTTPS |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-Proto` / `-Host` from that reverse proxy |
| `TRUSTED_HOSTS` | | If set, refuse requests for any other host name |
| `UPDATE_REPO` / `UPDATE_BRANCH` | this repo / the built branch | Update source |
| `UPDATE_ALLOW_REPO_CHANGE` | `false` | Allow changing the update repository in the UI |
| `EXTRA_ROOTS` | | More container folders the converter may write to (`:`-separated) |
| `SCAN_INTERVAL_MINUTES` | `15` | Re-scan every vehicle |
| `PORT`, `DATA_PATH`, `LOG_LEVEL` | `9000`, `/data`, `info` | |

`/data` holds the account, settings, job history, thumbnails, converter
staging, installed updates and the HTTPS certificate authority. Keep it on
local disk, not on a share.

## Security

What protects what, if someone is on your network (a man in the middle) or
gets into the web UI:

**The page (HTTPS).** Port 9000 speaks HTTPS; plain HTTP there only redirects
to it. Sentry Manager is its own small certificate authority (CA): install
it once on each phone and computer and browsers trust the page, so nobody
can read your password or session, change the page, or pose as the server.

1. Download it in *Settings > Security* (or copy `/data/tls/ca.crt` from the
   host).
2. Compare its SHA-256 fingerprint with the one in `docker logs sentry-manager`
   before you trust it.
3. Install it (the steps for iPhone, Android, Windows, macOS and Firefox are
   on that page).
4. Add the IP address or name you type in the browser under *Settings >
   Security* (or `TLS_HOSTNAMES`), so the certificate covers it.

The CA is name-constrained: it can only vouch for local names (`.local`,
`.lan`, `.home.arpa`, ...), private IP addresses and the names you add. Even
if its key were stolen, it could not be used to impersonate other websites
to your devices. Its key never leaves root's folder `/data/tls`. With your own
certificate (`TLS_CERT_FILE`), none of this applies. Bookmark the `https://`
address: the very first plain-HTTP request is the one a man in the middle
could still intercept.

**Signing in.** The first account needs the one-time setup code from the log.
Five wrong passwords slow down further attempts. Session cookies are
HttpOnly, SameSite=Strict, Secure and `__Host-` prefixed. Requests that
change something must come from the page itself (a custom header plus an
`Origin` check), and every page runs under a Content-Security-Policy with no
inline scripts.

**Changes that could hand someone your shares or the server** need your
password again, even in a signed-in session:

- adding a vehicle, or changing where its footage comes from;
- update settings, and installing an update;
- the HTTPS certificate names;
- deleting from the Recycle Bin for good.

The update repository is fixed (`UPDATE_REPO`), so nobody can point updates
at their own code. Only the branch can be picked in the UI.

**No root for the web app.** Only a small supervisor runs as root. It is
image code and never loads anything from `/data`. It mounts shares (from
validated fields only) and keeps the CA. The web app, ffmpeg and installed
updates run as `PUID:PGID` with no capabilities and `no_new_privs`. The image
has no setuid programs, and the compose file drops every capability except
the few the supervisor needs. A bug in the web app, a malicious video on a
share, or a bad update therefore cannot become root, and cannot read the SMB
passwords or the CA key.

**Files on a share are not trusted.** Symlinks are never followed out of a
share, folder vehicles cannot point at `/`, `/data`, the app or system
folders, and nothing on a share can execute.

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
