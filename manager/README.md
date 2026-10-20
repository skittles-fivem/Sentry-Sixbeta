# Sentry Manager

A self-hosted Docker service that manages your TeslaCam archive on a NAS. It
connects to the SMB share your footage lives on and gives you a web UI on
port **9000** to:

- **See every day's size**: total, split into Recent / Sentry / Saved clips,
  number of events, and how much of it has been encoded.
- **Purge old days**: click a day and it is selected together with every
  older day ("purge up to here"); use the checkboxes to pick single days.
  The confirm dialog shows exactly how much will be deleted and lets you keep
  SavedClips.
- **Shrink footage automatically**: clips are re-encoded in place with the
  best encoder the container can actually use (NVIDIA NVENC, Intel Quick
  Sync, VAAPI or CPU), and never encoded twice.

## Quick start

```bash
cd manager
cp .env.example .env      # set SMB_SHARE, SMB_USERNAME, SMB_PASSWORD
docker compose up -d --build
```

Open `http://<docker-host>:9000`.

## Getting at the footage

**Option A: the container mounts the share (default).** Set `SMB_SHARE`,
`SMB_USERNAME` and `SMB_PASSWORD` in `.env`. The compose file grants the
`SYS_ADMIN` / `DAC_READ_SEARCH` capabilities and the AppArmor exception that
`mount.cifs` needs. The manager then:

- writes the password to a `0600` credentials file instead of putting it on a
  command line;
- checks the share every 30 s and remounts it if the NAS drops or stops
  answering (soft mount, 15 s timeouts, backoff on repeated failures);
- runs a write test on start and every 10 minutes that does exactly what an
  encode needs (create, flush, rename over an existing file, set mtime,
  delete), and shows the result in the UI;
- shows mount errors with a hint (wrong password, missing capability, SMB
  version mismatch, host kernel without CIFS, ...). **Reconnect** in the UI
  retries immediately.

The Docker host kernel needs CIFS support (`sudo modprobe cifs`; it is built
in on Synology, Unraid, TrueNAS and most distros).

**Option B: you mount it.** Remove `SMB_*`, `cap_add` and `security_opt`
and give the container the folder at `/footage`, either as a bind mount (when
Docker runs on the NAS itself):

```yaml
    volumes:
      - ./data:/data
      - /volume1/TeslaCam:/footage
```

or as a Docker-managed CIFS volume:

```yaml
services:
  sentry-manager:
    volumes:
      - ./data:/data
      - teslacam:/footage
volumes:
  teslacam:
    driver: local
    driver_opts:
      type: cifs
      device: //192.168.1.50/TeslaCam
      o: username=tesla,password=change-me,vers=3.0,uid=0,gid=0,file_mode=0664,dir_mode=0775
```

Either way, `/footage` can be the `TeslaCam` folder or any folder that
contains `RecentClips`, `SentryClips` and `SavedClips` (or Tesla-named clips
anywhere below it).

## Encoding

### Which encoder

At start-up (and when you press **Re-detect**) every encoder ffmpeg offers is
tried with a real test encode using the exact production settings. Being
listed by `ffmpeg -encoders` is not enough: NVENC is compiled into most builds
whether or not a GPU exists. Each candidate's output is checked for codec,
frame count, and whether Tesla's telemetry survived. The UI shows every
candidate with the reason it was or wasn't used.

| GPU | What to add to `docker-compose.yml` |
| --- | --- |
| NVIDIA | the `deploy:` block (needs the NVIDIA Container Toolkit) |
| Intel iGPU / Arc | `devices: - /dev/dri:/dev/dri` |
| AMD | `devices: - /dev/dri:/dev/dri` |
| none | nothing, the CPU (x264/x265) is used |

`ENCODER=nvenc|qsv|vaapi|software` forces a choice (it falls back if that
encoder fails its test). `ENCODER_DEVICE` picks a render node on multi-GPU
hosts; otherwise every `/dev/dri/renderD*` node is tried.

### Telemetry

Tesla stores speed, GPS, gear and Autopilot state as an SEI message on every
video frame, which is what Sentry Studio's dashboard reads. A plain re-encode
throws that away. Sentry Manager copies it into the new file (`-udu_sei`) and,
with `PRESERVE_TELEMETRY=true` (the default), refuses encoders that can't:
NVENC and the CPU encoders keep it; VAAPI and Quick Sync in current ffmpeg
builds do not. The output also keeps every frame and timestamp, no B-frames
and one slice per frame, so Sentry Studio still plays it and its telemetry
stays in sync.

`ENCODE_CODEC=h264` (default) keeps clips playable in Sentry Studio and in
the car. `hevc` saves more space, but Sentry Studio can't open HEVC clips.

### Never encoding the same clip twice

Three independent checks, any one of which is enough:

1. The state database (`/data/sentry-manager.db`) remembers every clip it
   finished, keyed by path, size and mtime. Unchanged clips are skipped
   without touching the share.
2. Every encoded file carries a `SentryManager` tag in its MP4 metadata. If
   the database is lost or a clip is moved or renamed, the tag is found and
   the clip is recorded as done.
3. Only H.264 sources are encoded, and an output that isn't at least
   `ENCODE_MIN_SAVINGS_PERCENT` smaller is thrown away, the original kept, and
   the clip recorded as skipped so it is not retried.

### How a clip is replaced

1. Only clips older than `ENCODE_MIN_AGE_MINUTES` are touched, so files still
   being copied are left alone.
2. The encode is written to local scratch space (`/data/scratch`), not the
   share, and checked: right codec, tag present, same frame count, same
   duration.
3. It is uploaded next to the original as a hidden `.<name>.sentrymgr.tmp`
   file, size-checked, then renamed over the original. If the server refuses
   rename-over, the original is parked as `.sentrymgr.orig` first and put back
   if anything fails.
4. The original's timestamps are restored. If the source changed meanwhile,
   nothing is replaced.

Leftovers from a crash or power cut are cleaned up on the next scan; a parked
original with no replacement is restored.

Newest footage is encoded first, since it is kept longest. ffmpeg runs at
low priority. **Pause** stops the current encode and holds the queue; the
lightning button on a day moves that day to the front of the queue.

## Purging

Purging only deletes files the scan identified as Tesla footage on the
chosen days: per-camera clips, plus `event.json` / `thumb.png` / `event.mp4`
of events on those days. Folders left empty are removed with `rmdir` (never
recursively), and the root, its top-level folders and the
RecentClips / SentryClips / SavedClips folders are always kept. Anything else
on the share is ignored.

## Settings

All settings are environment variables; `.env.example` lists and explains
them. A few others: `PORT` (9000), `FOOTAGE_PATH` (`/footage`), `DATA_PATH`
(`/data`), `SCRATCH_PATH` (`/data/scratch`), `UI_PASSWORD` (enables a login),
`SCAN_INTERVAL_MINUTES` (15), `LOG_LEVEL` (`info`).

Without `UI_PASSWORD` anyone who can reach port 9000 can delete footage, so
set one unless the port is only reachable on a trusted network.

## Development

Requires Node.js 22.13+ (uses the built-in `node:sqlite`, no npm packages)
and ffmpeg for the integration tests.

```bash
cd manager
npm test
FOOTAGE_PATH=/path/to/TeslaCam DATA_PATH=./data npm start
```
