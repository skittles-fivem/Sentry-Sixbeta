# Sentry Six Manager: the Sentry Studio viewer and converter as a web app, plus
# footage management, on port 9000.
#
# Build from the repository root (the image ships the same src/ as the
# desktop app):   docker build -f manager/Dockerfile -t sentry-six-manager .

# Official Node 24 build.
FROM node:24-trixie-slim AS node

# Small native helper: rename-without-replace (renameat2), used for safe
# in-place replacement of originals on Linux / SMB.
FROM debian:trixie-slim AS native
RUN set -eux; export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; apt-get install -y --no-install-recommends gcc libc6-dev; rm -rf /var/lib/apt/lists/*
COPY manager/native/noreplace-rename.c /build/
RUN gcc -O2 -Wall -Wextra -o /build/noreplace-rename /build/noreplace-rename.c

# Debian 13: every package below gets Debian security updates.
FROM debian:trixie-slim

# jellyfin-ffmpeg  FFmpeg kept current by the Jellyfin team: libx265 / SVT-AV1
#                  plus NVENC, VA-API (AMD incl. APUs, Intel), QSV and AMF, with
#                  its own VA-API drivers and vainfo. From Jellyfin's signed
#                  repository; manager/jellyfin.gpg is their key, fingerprint
#                  4918 AABC 486C A052 358D 778D 4902 3CD0 1DE2 1A7B.
# cifs-utils       mounting the vehicles' SMB shares
# fonts            for burned-in timestamps / dashboards in exports
# tini             reaps ffmpeg children and forwards signals
# openssl          the local HTTPS certificate authority
# util-linux       setpriv: the app runs unprivileged (supervisor.js)
COPY manager/jellyfin.gpg /etc/apt/keyrings/jellyfin.gpg
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    printf 'Types: deb\nURIs: https://repo.jellyfin.org/debian\nSuites: trixie\nComponents: main\nSigned-By: /etc/apt/keyrings/jellyfin.gpg\n' \
      > /etc/apt/sources.list.d/jellyfin.sources; \
    apt-get update; \
    # FFmpeg 8 when Jellyfin publishes it for this release, else their 7.x
    ffmpeg_pkg=jellyfin-ffmpeg8; apt-cache show "$ffmpeg_pkg" >/dev/null 2>&1 || ffmpeg_pkg=jellyfin-ffmpeg7; \
    apt-get install -y --no-install-recommends "$ffmpeg_pkg" cifs-utils tini tzdata \
      fontconfig fonts-liberation fonts-dejavu-core openssl util-linux; \
    ln -s /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/lib/jellyfin-ffmpeg/ffprobe /usr/lib/jellyfin-ffmpeg/vainfo /usr/local/bin/; \
    rm -rf /var/lib/apt/lists/*; \
    # no setuid/setgid programs: nothing inside can become root again (the
    # root supervisor runs mount.cifs as root anyway)
    find / -xdev -perm /6000 -type f -exec chmod a-s {} +

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=native /build/noreplace-rename /usr/local/bin/noreplace-rename

ENV NODE_ENV=production \
    PORT=9000 \
    PUID=1000 \
    PGID=1000 \
    DATA_PATH=/data \
    FOOTAGE_ROOT=/footage \
    UV_THREADPOOL_SIZE=16 \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

WORKDIR /app
COPY version.json ./
COPY assets ./assets
COPY src ./src
COPY manager/server ./manager/server
COPY manager/web ./manager/web

# Set by the release build (.github/workflows/manager-image.yml); IMAGE and
# IMAGE_TAG let Settings > Updates check the registry for a newer image.
ARG GIT_SHA=""
ARG GIT_BRANCH=""
ARG BUILD_DATE=""
ARG IMAGE=""
ARG IMAGE_TAG=""
RUN printf '{"sha":"%s","branch":"%s","builtAt":"%s","image":"%s","tag":"%s"}\n' "$GIT_SHA" "$GIT_BRANCH" \
      "${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" "$IMAGE" "$IMAGE_TAG" > /app/BUILD_INFO.json

VOLUME ["/data"]
EXPOSE 9000
# /healthz answers on plain HTTP too (everything else there redirects to HTTPS)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/manager/server/supervisor.js"]
