#!/bin/sh
# Starts or stops the clip watcher (`bun run clips:watch`) as a detached
# background process that outlives the terminal (and the session) that
# started it, at the lowest CPU priority.
#
#   clips/watch-daemon.sh start [--env-from <.env>] [extra clips flags]
#   clips/watch-daemon.sh stop
#   clips/watch-daemon.sh status
#
# Log: ~/Library/Logs/jeviatus-clips.log (CLIPS_LOG); pid: <clips root>/watch.pid.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
data=${STREAM_DATA_DIR:-"$HOME/Library/Application Support/jeviatus"}
pidfile=${CLIPS_PIDFILE:-"$data/clips/watch.pid"}
logfile=${CLIPS_LOG:-"$HOME/Library/Logs/jeviatus-clips.log"}
bun=${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}

running() { [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }

case "${1:-}" in
  start)
    shift
    if running; then echo "already running (pid $(cat "$pidfile"))"; exit 0; fi
    mkdir -p "$(dirname "$pidfile")" "$(dirname "$logfile")"
    # Double fork + setsid: no controlling terminal, reparented to launchd.
    python3 - "$pidfile" "$logfile" "$repo" nice -n 19 "$bun" clips/cli.ts --watch "$@" <<'PY'
import os, sys
pidfile, logfile, repo, *cmd = sys.argv[1:]
if os.fork() > 0:
    sys.exit(0)
os.setsid()
if os.fork() > 0:
    os._exit(0)
os.chdir(repo)
with open(pidfile, "w") as f:
    f.write(str(os.getpid()))
fd = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
null = os.open(os.devnull, os.O_RDONLY)
os.dup2(null, 0)
os.dup2(fd, 1)
os.dup2(fd, 2)
os.execvp(cmd[0], cmd)
PY
    sleep 1
    if running; then echo "started (pid $(cat "$pidfile")), log: $logfile"; else echo "failed to start; see $logfile"; exit 1; fi
    ;;
  stop)
    if running; then kill "$(cat "$pidfile")" && rm -f "$pidfile" && echo "stopped"; else echo "not running"; rm -f "$pidfile"; fi
    ;;
  status)
    if running; then echo "running (pid $(cat "$pidfile")), log: $logfile"; else echo "not running"; fi
    ;;
  *)
    echo "usage: $0 start [--env-from <.env>] [clips flags] | stop | status" >&2
    exit 2
    ;;
esac
