# Clips of Jev's games and its evolution

`bun run clips` turns everything the stream recorded into vertical 1080x1920 clips. Each clip gets a sidecar with post text for TikTok, YouTube Shorts, Instagram Reels, X and Reddit ([social/README.md](../social/README.md) posts them). It builds on the TikTok cutter in [tiktok/](../tiktok/README.md), which it uses for the gameplay.

```
~/Library/Application Support/jeviatus/clips/
  2026-09-27/<id>.mp4 + <id>.json   the clips, by the day they were rendered
  archive/recordings/               the stream's segments, kept past its 6 h rotation
  manifest.json                     what's rendered, skipped, frozen, batched
```

## Clip kinds

| id | What |
| --- | --- |
| `game-<gameID>` | A game's 3 most epic moments (Jev picks them, see tiktok/). A game with one moment gets one long clip. |
| `moment-<gameID>-<tick>` | One standout moment with an 8 s run-up, when the game has several. |
| `bestof-<first>-<last>` | The best 5 moments of a batch of 6 games. |
| `wipeouts-<first>-<last>` | A batch's eliminations, back to back. |
| `evo-<sha>-proposed` | **Evolution.** The lab writes a change: its on-camera session sped up, the change's title and diff, the build it replaces, and that build in action. |
| `evo-<sha>-verdict` | **Evolution.** Real games judged the change: the same clip plus a before/after scoreboard (wins, placement, minutes alive, peak land), KEPT or DROPPED, and old brain over new brain. |

Where the evolution data comes from ([evolution.ts](evolution.ts)):
- **The changes:** each is a commit on a local `jev-lab/<n>-<slug>` branch. Its parent is the build it was written against.
- **The games:** a game counts toward a build when its trace names that commit. The lab judges by the same rule.
- **The lab's verdicts:** `lab/state.json`.
- **When the lab was on screen:** the stream log (`~/Library/Logs/jeviatus-stream.log`).

## Running it

```sh
bun run clips --env-from /path/to/.env      # one pass (Jev picks the moments with TYPESAFE_API_KEY)
bun run clips --dry-run --no-jev            # what it would render
bun run clips:start --env-from /path/to/.env   # the watcher, detached: a pass every 20 min
bun run clips:stop
sh clips/watch-daemon.sh status
bun run clips --refresh-text                # after editing clips/metadata.ts: rewrite every sidecar's post text, no render
```

What a pass does:
1. Hard-links every finished recording segment into the archive, capped at 120 GB with the oldest pruned first.
2. Plans every clip it doesn't have yet.
3. Renders up to 12 clips, one ffmpeg at a time at `nice 19`, next to the live encoder. A 30 s clip takes about 6 s on an M-series Mac.

The watcher logs to `~/Library/Logs/jeviatus-clips.log`.

How it avoids bad or duplicate clips:
- Footage where the stream's picture froze (the screencast stalls sometimes) is detected with ffmpeg's `freezedetect` and left out.
- Games and lab sessions whose footage is still being written wait for the next pass.
- Rerunning is safe: clips are made once, by id.
