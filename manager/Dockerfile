# Sentry Manager - TeslaCam footage manager with a web UI on port 9000

# Official Node 24 build (built against an old glibc, so it runs on Ubuntu).
FROM node:24-trixie-slim AS node

FROM ubuntu:24.04

# ffmpeg      Ubuntu's build includes libx264/libx265 plus NVENC, VAAPI and QSV
# cifs-utils  mount.cifs, used when SMB_SHARE is set
# VA drivers  AMD (mesa) everywhere; Intel iHD + oneVPL runtime on amd64
# tini        reaps ffmpeg children and forwards signals
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg cifs-utils mesa-va-drivers vainfo tini ca-certificates tzdata; \
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      apt-get install -y --no-install-recommends intel-media-va-driver-non-free libvpl2 libmfx-gen1.2; \
    fi; \
    rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node

ENV NODE_ENV=production \
    PORT=9000 \
    FOOTAGE_PATH=/footage \
    DATA_PATH=/data \
    UV_THREADPOOL_SIZE=16 \
    NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

VOLUME ["/data"]
EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
