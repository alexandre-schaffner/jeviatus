# syntax=docker/dockerfile:1.7
# Clips from a Kick channel's VODs, around the clock: vodclips/watch.ts waits
# for each stream to finish and renders its best moments into /data (vodclips/README.md).
# Build and run from the repository root:
#   VODCLIPS_CHANNEL=<kick slug> docker compose -f vodclips/compose.yml up -d --build

# whisper.cpp. Portable by default: the CPU the build sees isn't always the
# one that runs it (Docker Desktop on Apple silicon misdetects dot-product
# support, and the Freebox VMs are Cortex-A72s without it). Build with
# --build-arg WHISPER_NATIVE=ON on the machine that runs it for more speed.
FROM node:24-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.7.6
ARG WHISPER_NATIVE=OFF
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && git clone -q --depth=1 --branch "$WHISPER_CPP_VERSION" https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DGGML_NATIVE="$WHISPER_NATIVE" \
 && cmake --build /build -j"$(nproc)" --target whisper-cli

FROM node:24-slim
ENV DEBIAN_FRONTEND=noninteractive
# Debian's ffmpeg has libass, which render.ts needs for the hook and the KICK bar.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl tini fontconfig fonts-liberation2 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
# render.ts names the fonts of the Mac it was tuned on; these are the
# metric-compatible ones on Linux.
COPY <<'XML' /etc/fonts/conf.d/99-vodclips.conf
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <alias binding="same"><family>Helvetica Neue</family><prefer><family>Liberation Sans</family></prefer></alias>
  <alias binding="same"><family>Arial Black</family><prefer><family>DejaVu Sans</family></prefer></alias>
</fontconfig>
XML
COPY --from=whisper /build/bin/whisper-cli /usr/local/bin/whisper-cli

# Claude Code drafts the hooks (moments.ts). It logs in from
# CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) or ANTHROPIC_API_KEY.
ARG CLAUDE_CODE_VERSION=2.1.283
RUN npm install --global --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && claude --version
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

COPY --from=oven/bun:1.3.14-slim /usr/local/bin/bun /usr/local/bin/bun

RUN useradd --create-home --uid 10001 jev && mkdir -p /app /data && chown jev:jev /app /data
USER jev
WORKDIR /app

# The models transcript.ts expects in ~/.cache/whisper-cpp (about 650 MB).
RUN mkdir -p ~/.cache/whisper-cpp && cd ~/.cache/whisper-cpp \
 && curl -fsSLO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
 && curl -fsSLO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin \
 && curl -fsSLO https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin

COPY --chown=jev:jev package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
# bunfig.toml preloads harness/preload.ts for every bun run.
COPY --chown=jev:jev harness/preload.ts harness/vendorPatches.ts harness/
COPY --chown=jev:jev harness/jev harness/jev
COPY --chown=jev:jev vodclips vodclips

ENTRYPOINT ["tini", "--", "bun", "vodclips/watch.ts"]
