#!/usr/bin/env bash
# Runs the 24/7 stream on a fresh Ubuntu server, from this Mac (deploy/README.md).
#
#   deploy/deploy.sh <host> up         install Docker if needed, send this commit and .env, build, go live
#   deploy/deploy.sh <host> dry-run    the same, but record to /data/dry-run.mkv instead of going live
#   deploy/deploy.sh <host> migrate    copy the Mac stream's traces, bribe ledger and own music to the server
#   deploy/deploy.sh <host> logs       follow the stream's logs (Ctrl-C stops following, not the stream)
#   deploy/deploy.sh <host> status     container state, health, CPU and memory
#   deploy/deploy.sh <host> down       stop the stream
#   deploy/deploy.sh <host> fetch <path under /data> [local dir]   copy files out (runs, dry-run.mkv, recordings)
#   deploy/deploy.sh <host> setup      only install Docker and the firewall
#
# <host> is anything ssh accepts: root@203.0.113.7, or a Host from ~/.ssh/config.
# The server needs no GitHub access: the code goes over as a git bundle of HEAD.
set -euo pipefail

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 2 ] || usage
HOST=$1
CMD=$2
shift 2
FORCE=false
for a in "$@"; do [ "$a" = "--force" ] && FORCE=true; done

REPO=$(cd "$(dirname "$0")/.." && pwd)
REMOTE=/opt/jeviatus
COMPOSE="docker compose -f $REMOTE/stream/compose.yml"
MAC_DATA="$HOME/Library/Application Support/jeviatus"
say() { printf '\033[32m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }
remote() { ssh -o ServerAliveInterval=30 "$HOST" "$@"; }
# With a terminal, so Ctrl-C reaches the remote command.
remote_tty() { ssh -t -o ServerAliveInterval=30 "$HOST" "$@"; }

# --- the server ----------------------------------------------------------------------

setup() {
  say "setting up $HOST (Docker, firewall, swap)"
  remote 'bash -s' <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
[ "$(id -u)" = 0 ] || { echo "log in as root (or a user with passwordless sudo, and run this as root)" >&2; exit 1; }
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -yq ca-certificates curl git
  # Docker's own packages: Engine, BuildKit (buildx) and the compose plugin.
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null || { apt-get update -q && apt-get install -yq git; }
systemctl enable --now docker >/dev/null
# Nothing listens for the stream: it only connects out (Kick, openfront.io).
if command -v ufw >/dev/null && ! ufw status | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null && ufw --force enable >/dev/null
fi
# Headroom for Chromium's memory spikes.
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo "docker $(docker version --format '{{.Server.Version}}'), $(nproc) vCPU, $(free -g | awk '/Mem:/ {print $2}') GB RAM"
EOF
}

# --- what goes over --------------------------------------------------------------------

# .env for the server: Mac-only paths are dropped (the container has its own),
# and Chromium keeps --no-sandbox, which the container needs.
server_env() {
  awk '
    /^[[:space:]]*#/ || !/=/ { print; next }
    {
      key = $0; sub(/=.*/, "", key); val = $0; sub(/^[^=]*=/, "", val)
      if (key == "STREAM_PLATFORM" || val ~ /(^|["'\''])\/Users\/|\/opt\/homebrew|\/Library\//) {
        printf("[deploy] not sending %s (Mac only)\n", key) > "/dev/stderr"; next
      }
      if (key == "CHROMIUM_FLAGS" && val !~ /--no-sandbox/) $0 = "CHROMIUM_FLAGS=--no-sandbox " val
      print
    }' "$REPO/.env"
}

env_value() { grep -E "^$1=" "$REPO/.env" | tail -1 | cut -d= -f2- | tr -d "\"' " || true; }

check_env() {
  [ -f "$REPO/.env" ] || die "no .env at $REPO/.env (see .env.example)"
  [ -n "$(env_value TYPESAFE_API_KEY)" ] || die ".env has no TYPESAFE_API_KEY"
  if [ "$1" = live ] && [ -z "$(env_value KICK_STREAM_KEY)$(env_value PUMPFUN_STREAM_KEY)$(env_value STREAM_OUTPUT)" ]; then
    die ".env has no KICK_STREAM_URL/KEY or PUMPFUN_STREAM_URL/KEY"
  fi
  if [ "$(env_value STREAM_LAB)" != false ] && [ -z "$(env_value CLAUDE_CODE_OAUTH_TOKEN)$(env_value LAB_ANTHROPIC_API_KEY)" ]; then
    warn "no CLAUDE_CODE_OAUTH_TOKEN or LAB_ANTHROPIC_API_KEY in .env: the lab will analyze games but can't write changes (deploy/README.md#claude-code-for-the-lab)"
  fi
}

# One stream per key: Kick and pump.fun take a second encoder on the same key
# badly (the two fight, or the second is refused). Stop the Mac first.
check_mac_stopped() {
  if pgrep -f 'stream/(main|launch)\.ts' >/dev/null && [ "$FORCE" = false ]; then
    die "the stream is still running on this Mac (bun run live). Stop it first (Ctrl-C in its terminal), or pass --force if it isn't using the same stream key"
  fi
}

send_code() {
  cd "$REPO"
  if [ -n "$(git status --porcelain --untracked-files=no -- . ':!vendor' 2>/dev/null)" ]; then
    warn "uncommitted changes are NOT deployed: only commit $(git rev-parse --short HEAD) goes over"
  fi
  local tmp
  tmp=$(mktemp -d)
  git bundle create --quiet "$tmp/jeviatus.bundle" HEAD
  say "sending $(git rev-parse --short HEAD) ($(du -h "$tmp/jeviatus.bundle" | cut -f1))"
  scp -q "$tmp/jeviatus.bundle" "$HOST:/tmp/jeviatus.bundle"
  rm -rf "$tmp"
  remote "set -e
    [ -d $REMOTE/.git ] || git init -q $REMOTE
    cd $REMOTE
    git fetch -q /tmp/jeviatus.bundle HEAD
    git checkout -q -f -B live FETCH_HEAD
    git clean -fdq -e .env
    rm -f /tmp/jeviatus.bundle"
}

send_env() {
  local extra=${1:-}
  { server_env; [ -z "$extra" ] || printf '\n# deploy.sh dry-run\n%s\n' "$extra"; } |
    remote "umask 077 && cat > $REMOTE/.env"
}

start() {
  say "building and starting (the first build takes 10-15 minutes)"
  remote "set -e
    cd $REMOTE
    export OPENFRONT_COMMIT=\$(git rev-parse HEAD:vendor/OpenFrontIO) HARNESS_COMMIT=\$(git rev-parse HEAD)
    $COMPOSE up -d --build --remove-orphans
    docker image prune -f >/dev/null"
  say "started. Follow it with: deploy/deploy.sh $HOST logs"
}

# --- commands -----------------------------------------------------------------------

case "$CMD" in
  setup) setup ;;
  up)
    check_env live
    check_mac_stopped
    setup
    send_code
    send_env
    start
    ;;
  dry-run)
    # Plays public matches as JEV_USERNAME like the live stream, but the
    # broadcast goes to a file: safe to run while the Mac is live.
    check_env dry
    setup
    send_code
    send_env $'STREAM_OUTPUT=/data/dry-run.mkv\nSTREAM_RECORD_HOURS=0'
    start
    say "recording to /data/dry-run.mkv (about 2 GB an hour). Copy it out with: deploy/deploy.sh $HOST fetch dry-run.mkv"
    ;;
  migrate)
    [ -d "$MAC_DATA" ] || die "no Mac stream data at $MAC_DATA"
    check_mac_stopped
    items=()
    for f in bribes.json runs music; do [ -e "$MAC_DATA/$f" ] && items+=("$f"); done
    [ ${#items[@]} -gt 0 ] || die "nothing to migrate in $MAC_DATA"
    say "copying ${items[*]} from $MAC_DATA"
    remote "rm -rf /tmp/jev-migrate && mkdir -p /tmp/jev-migrate"
    tar -C "$MAC_DATA" -czf - "${items[@]}" | remote "tar -xzf - -C /tmp/jev-migrate"
    remote "set -e
      docker volume inspect jeviatus_jev-data >/dev/null 2>&1 || docker volume create --label com.docker.compose.project=jeviatus --label com.docker.compose.volume=jev-data jeviatus_jev-data >/dev/null
      docker run --rm -v jeviatus_jev-data:/data -v /tmp/jev-migrate:/in:ro busybox sh -c 'cp -a /in/. /data/ && chown -R 10001:10001 /data'
      rm -rf /tmp/jev-migrate"
    say "done; restart the stream to pick up the bribe ledger: deploy/deploy.sh $HOST up"
    ;;
  logs) remote_tty "$COMPOSE logs -f --tail=200" ;;
  status)
    remote "$COMPOSE ps; echo; docker stats --no-stream jeviatus-stream-1 2>/dev/null || true; echo; docker inspect --format '{{range .State.Health.Log}}{{.End}} exit={{.ExitCode}} {{.Output}}{{end}}' jeviatus-stream-1 2>/dev/null | tail -3"
    ;;
  down) remote "$COMPOSE down" ;;
  fetch)
    [ $# -ge 1 ] || die "fetch what? e.g. runs, dry-run.mkv, recordings"
    what=${1#/data/}
    dest=${2:-.}
    [ "$what" != "--force" ] || die "fetch what?"
    say "copying /data/$what to $dest"
    remote "docker run --rm -v jeviatus_jev-data:/data:ro busybox tar -C /data -cf - '$what'" | tar -C "$dest" -xf -
    ;;
  *) usage ;;
esac
