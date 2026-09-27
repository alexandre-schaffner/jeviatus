# syntax=docker/dockerfile:1.7
# 24/7 Kick stream of Jev playing public OpenFront matches. Build and run it
# with `bun run stream:up` (see stream/README.md), or on a server with
# `deploy/deploy.sh` (deploy/README.md); both pass the pinned OpenFront commit.
FROM node:24-slim

ARG OPENFRONT_COMMIT
RUN test -n "$OPENFRONT_COMMIT" || { echo "build with --build-arg OPENFRONT_COMMIT=\$(git rev-parse HEAD:vendor/OpenFrontIO), or use bun run stream:up"; exit 1; }

ENV DEBIAN_FRONTEND=noninteractive
# Debian's ffmpeg has everything stream/encoder.ts uses: x11grab, pulse,
# drawtext (freetype), libx264, tee and segment.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb xdotool pulseaudio pulseaudio-utils ffmpeg git ca-certificates tini procps \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      libgl1-mesa-dri libegl1 libegl-mesa0 libgles2 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix \
 && npm install --global --ignore-scripts npm@12.1.0

# Claude Code for the lab (stream/lab.ts). Pinned: a 24/7 stream shouldn't
# change tools under itself. It logs in from CLAUDE_CODE_OAUTH_TOKEN or
# LAB_ANTHROPIC_API_KEY in .env (deploy/README.md).
ARG CLAUDE_CODE_VERSION=2.1.283
# npm 12 blocks install scripts unless allowed; this one links the native binary.
RUN npm install --global --no-audit --no-fund --allow-scripts=@anthropic-ai/claude-code "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && claude --version
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

COPY --from=oven/bun:1.3.14-slim /usr/local/bin/bun /usr/local/bin/bun

RUN useradd --create-home --uid 10001 jev && mkdir -p /app /data && chown jev:jev /app /data
USER jev
WORKDIR /app
ENV XDG_RUNTIME_DIR=/tmp/runtime-jev
# The lab commits its changes on local branches.
RUN mkdir -p -m 700 /tmp/runtime-jev \
 && git config --global user.name "Jev's lab" \
 && git config --global user.email "jev-lab@users.noreply.github.com" \
 && git config --global init.defaultBranch main \
 && git config --global advice.detachedHead false

# OpenFront as a real git checkout at the pinned commit: the stream's updater
# moves it to whatever openfront.io serves after each release.
RUN git init -q vendor/OpenFrontIO \
 && cd vendor/OpenFrontIO \
 && git remote add origin https://github.com/openfrontio/OpenFrontIO.git \
 && git fetch -q --depth=1 origin "$OPENFRONT_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && npm ci --ignore-scripts --no-audit --no-fund

# Dev dependencies too: the lab typechecks and tests every change it writes.
COPY --chown=jev:jev package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# The whole repository, .git included when the build context has a real one
# (a clone; deploy/deploy.sh makes one on the server): the lab works in git
# worktrees of it, and traces name the real harness commit. From a checkout
# whose .git is a file (a git worktree) it becomes a one-commit repository of
# its own instead, and the trace header falls back to HARNESS_COMMIT.
COPY --chown=jev:jev . .
ARG HARNESS_COMMIT=unknown
ENV HARNESS_COMMIT=$HARNESS_COMMIT
RUN git rev-parse -q --verify HEAD >/dev/null 2>&1 \
 || { rm -rf .git \
   && git init -q \
   && git add -A -- . ':!vendor' \
   && git commit -q -m "jeviatus ${HARNESS_COMMIT} (image snapshot)"; } \
 && bun scripts/build-extension.ts

# Docker's default seccomp profile denies the user namespaces Chromium's own
# sandbox needs; the container (non-root, no capabilities) is the boundary.
ENV DISPLAY=:99 \
    CHROME_PROFILE_DIR=/data/chrome-profile \
    CHROMIUM_FLAGS=--no-sandbox
VOLUME /data
# Informational (`docker ps`, deploy/deploy.sh status): the stream restarts
# its own crashed processes; the first match needs a minute to come up.
HEALTHCHECK --interval=60s --timeout=15s --start-period=180s --retries=3 CMD ["bun", "stream/healthcheck.ts"]
ENTRYPOINT ["tini", "--", "bun", "stream/main.ts"]
