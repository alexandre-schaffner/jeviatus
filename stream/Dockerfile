# syntax=docker/dockerfile:1.7
# 24/7 Kick stream of Jev playing public OpenFront matches. Build and run it
# with `bun run stream:up` (see stream/README.md), which passes the pinned
# OpenFront commit.
FROM node:24-slim

ARG OPENFRONT_COMMIT
RUN test -n "$OPENFRONT_COMMIT" || { echo "build with --build-arg OPENFRONT_COMMIT=\$(git -C vendor/OpenFrontIO rev-parse HEAD), or use bun run stream:up"; exit 1; }

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb xdotool pulseaudio pulseaudio-utils ffmpeg git ca-certificates tini \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      libgl1-mesa-dri libegl1 libegl-mesa0 libgles2 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
 && npm install --global --ignore-scripts npm@12.1.0

COPY --from=oven/bun:1.3.14-slim /usr/local/bin/bun /usr/local/bin/bun

RUN useradd --create-home --uid 10001 jev && mkdir -p /app /data && chown jev:jev /app /data
USER jev
WORKDIR /app
ENV XDG_RUNTIME_DIR=/tmp/runtime-jev
RUN mkdir -p -m 700 /tmp/runtime-jev

# OpenFront as a real git checkout at the pinned commit: the stream's updater
# moves it to whatever openfront.io serves after each release.
RUN git init -q vendor/OpenFrontIO \
 && cd vendor/OpenFrontIO \
 && git remote add origin https://github.com/openfrontio/OpenFrontIO.git \
 && git fetch -q --depth=1 origin "$OPENFRONT_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && npm ci --ignore-scripts --no-audit --no-fund

COPY --chown=jev:jev package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY --chown=jev:jev harness harness
COPY --chown=jev:jev extension extension
COPY --chown=jev:jev scripts scripts
COPY --chown=jev:jev stream stream
COPY --chown=jev:jev tiktok tiktok
# No .git in the image: the trace header's harness commit comes from here.
ARG HARNESS_COMMIT=unknown
ENV HARNESS_COMMIT=$HARNESS_COMMIT
RUN bun scripts/build-extension.ts

# Docker's default seccomp profile denies the user namespaces Chromium's own
# sandbox needs; the container (non-root, no capabilities) is the boundary.
ENV DISPLAY=:99 \
    CHROME_PROFILE_DIR=/data/chrome-profile \
    CHROMIUM_FLAGS=--no-sandbox
VOLUME /data
ENTRYPOINT ["tini", "--", "bun", "stream/main.ts"]
