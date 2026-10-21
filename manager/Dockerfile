# Sentry Six Manager: the Sentry Studio viewer and converter as a web app, plus
# footage management, on port 9000.
#
# Build from the repository root (the image ships the same src/ as the
# desktop app):   docker build -f manager/Dockerfile -t sentry-six-manager .

# Official Node 24 build (made against an old glibc, so it runs on Ubuntu).
FROM node:24-trixie-slim AS node

# Small native helper: rename-without-replace (renameat2), used for safe
# in-place replacement of originals on Linux / SMB.
FROM ubuntu:24.04 AS native
RUN set -eux; export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; apt-get install -y --no-install-recommends gcc libc6-dev; rm -rf /var/lib/apt/lists/*
COPY manager/native/noreplace-rename.c /build/
RUN gcc -O2 -Wall -Wextra -o /build/noreplace-rename /build/noreplace-rename.c

FROM ubuntu:24.04

# ffmpeg       libx265 / SVT-AV1 plus NVENC, VA-API (AMD incl. APUs, Intel) and QSV
# cifs-utils   mounting the vehicles' SMB shares
# VA drivers   AMD (mesa radeonsi) everywhere; Intel iHD + oneVPL on amd64
# fonts        for burned-in timestamps / dashboards in exports
# tini         reaps ffmpeg children and forwards signals
# openssl      the local HTTPS certificate authority
# util-linux   setpriv: the app runs unprivileged (supervisor.js)
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg cifs-utils mesa-va-drivers vainfo tini ca-certificates tzdata \
      fontconfig fonts-liberation fonts-dejavu-core openssl util-linux; \
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      apt-get install -y --no-install-recommends intel-media-va-driver-non-free libvpl2 libmfx-gen1.2; \
    fi; \
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

ARG GIT_SHA=""
ARG GIT_BRANCH=""
ARG BUILD_DATE=""
RUN printf '{"sha":"%s","branch":"%s","builtAt":"%s"}\n' "$GIT_SHA" "$GIT_BRANCH" "${BUILD_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" > /app/BUILD_INFO.json

VOLUME ["/data"]
EXPOSE 9000
# /healthz answers on plain HTTP too (everything else there redirects to HTTPS)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/manager/server/supervisor.js"]
