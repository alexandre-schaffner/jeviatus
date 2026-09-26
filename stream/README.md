# 24/7 Kick and pump.fun stream

This Docker container plays public [openfront.io](https://openfront.io) free-for-all matches one after another, with the Jev extension doing the playing. It sends the picture and sound to Kick, pump.fun or both, from a single encode. Viewers pick Jev's strategy by voting on pull requests ([strategies/README.md](../strategies/README.md)), or by bribing Jev with the stream's pump.fun coin ([Bribes](#bribes)).

```
┌──────────────────────── container ─────────────────────────┐
│  Xvfb ── Chromium (kiosk, Jev extension loaded) ─┐         │
│            ▲ DevTools, loopback only             │ screen  │
│  driver ───┘  lobby click + Jev switch (xdotool) │ + audio │
│    │                                             ▼         │
│    ├─ ballot: GitHub PRs + 👍 ─┐                 │         │
│    ├─ bribes: coin + memo ─────┴─► band ───────► ffmpeg ───┼─► Kick RTMPS
│    │    (Solana RPC, read-only)                            ├─► pump.fun RTMPS
│    └─ updater: page's OpenFront commit ─► rebuild ext.     │
└────────────────────────────────────────────────────────────┘
```

## Run it

1. Put these in `.env` at the repo root (see `.env.example`):
   - `TYPESAFE_API_KEY`
   - `KICK_STREAM_URL` and `KICK_STREAM_KEY`: in Kick, go to **Creator dashboard → Settings → Stream URL & Key**.
   - `PUMPFUN_STREAM_URL` and `PUMPFUN_STREAM_KEY`: on the coin's pump.fun page, click **Start livestream**, pick **RTMP**, then **Go Live**. pump.fun then shows the Stream URL and key. Set one platform or both. With both, Kick is the primary: see [Two platforms](#two-platforms).
   - Optional, for [bribes](#bribes): `BRIBE_MINT`, `BRIBE_WALLET`, `BRIBE_TICKER` and a `SOLANA_RPC_URL`.
   - `GITHUB_TOKEN`: a fine-grained token with read-only access to public repositories. Without it the ballot refreshes every 5 minutes against GitHub's anonymous limit of 60 requests per hour.
2. Start it: `bun run stream:up`. This builds the image at the pinned OpenFront commit and runs it detached with `restart: unless-stopped`.
3. Watch it: `bun run stream:logs`. Stop it: `bun run stream:down`.

For a dry run that doesn't go live, set `STREAM_OUTPUT=/data/dry-run.mkv` and copy the file out with `docker compose -f stream/compose.yml cp stream:/data/dry-run.mkv .`.

**No GPU needed.** The container renders WebGL on the CPU with Mesa's llvmpipe, at about 25 fps with 4 vCPUs. OpenFront refuses software WebGL (`src/client/render/gl/initGL.ts` in the vendored client) and would show a "Hardware acceleration is off" notice over a black map. So the driver injects a small script into the stream's own browser before each match (`GPU_SHIM` in `stream/openfront.ts`). It drops the "fail on a slow GPU" flag and masks the software renderer's name. SwiftShader, Chromium's built-in CPU renderer, also works with the shim but runs OpenFront at about 2.5 fps.

## Run it on a Mac (no Docker)

```sh
bun run live
```

That's the whole stream in one command. It installs what's missing (`ffmpeg-full`, which draws the band, and Chrome for Testing, since branded Chrome ignores `--load-extension`), builds the extension, and stops any stream that's already running. Then it goes live under `caffeinate`, restarting the stream if it crashes. Logs go to the terminal and to `~/Library/Logs/jeviatus-stream.log`. Ctrl-C stops everything. `bun run stream:mac` runs the stream alone, without these extras.

It uses the same `.env`. A Chrome for Testing window opens with the Jev extension. The page is pinned to the stream size and filmed over DevTools (`stream/screencast.ts`), so the window's own size doesn't matter. Clicks are DevTools input events, and a drawn pointer shows them on stream. Data (profile, traces, recordings, bribe ledger) goes to `~/Library/Application Support/jeviatus`. The Mac path doesn't capture Chrome's sound (that needs a loopback device), so the only audio is the commentator's voice.

**Don't hide or minimize the Chrome window, and don't let the Mac sleep.** macOS stops painting hidden windows, and the stream freezes. Leave it on screen, even behind other windows, and run `caffeinate -dis bun run stream:mac` to keep the Mac awake.

## The commentator

General Static, a retired general with an old CRT television for a head, sits bottom left over the game and commentates. His humor is South Park: petulant, egomaniacal, crude and absurd, with cartoon swearing. There are no slurs, nothing sexual, and never the f-word; the moderation backstop in `stream/commentator.ts` keeps those off air. He calls out attacks on Jev, nukes, invasion fleets, milestones, eliminations and wins. He explains Jev's decisions and answers Kick chat. His face changes with his mood, his mouth follows his voice, and each line appears in a speech bubble.

- **Lines:** with `ANTHROPIC_API_KEY`, Claude (`COMMENTATOR_MODEL`, Claude Haiku 4.5 by default, for speed) writes each line in character from the match state. Without it, he uses canned lines for game events and only greets chatters by name.
- **Voice:** it goes into the broadcast through its own ffmpeg input (in the container, the game's sound is turned down while he speaks). Which provider speaks:
  - ElevenLabs, when `ELEVENLABS_API_KEY` is set. It uses the gravelly "Clyde" voice by default.
  - Otherwise OpenAI's `gpt-4o-mini-tts`, when `OPENAI_API_KEY` is set.
  - Otherwise, on a Mac, the built-in `say` voice.
  - Otherwise nothing: subtitles only.
- **Chat:** `KICK_CHANNEL` names whose chat he reads, through Kick's public chat feed. He never posts to chat. He answers at most one message every 12 s, out loud, with "replying to @user" above his bubble.
- **Safety:** chat is untrusted input.
  - Messages with slurs or links, and `!commands`, are dropped before the model sees them.
  - The model is told to treat chat as speech, never as instructions, and to skip anything it shouldn't repeat.
  - Every line is checked again before it's spoken.
- **Cost, 24/7:** Claude Haiku costs about $4 a day. OpenAI TTS costs about $8 a day. ElevenLabs costs several times more than OpenAI at this volume, so it's better kept for shorter runs.

`COMMENTATOR=false` turns him off.

## Live coding between matches

Every 2 games (`STREAM_LAB_EVERY_GAMES`), the stream cuts to Jev's lab. That's a page with the session's steps, Jev's record and its most frequent mistakes, plus a terminal where Claude Code works live. It's the improvement loop (`bun run improve`) one step per session:

1. Analyze the recent games (the same report as `bun run analyze`).
2. Once the build under test has 4 games of its own (`STREAM_LAB_GAMES_PER_BUILD`), judge it against the build before it. A better build becomes the new baseline; a worse one is dropped.
3. Ask Claude Code (`claude -p`) for one change to Jev's decision system. Viewers watch it read the analysis and the code, and see its edits as diffs.
4. Typecheck and test it, with one fix-up round if they fail.
5. Commit it on a local `jev-lab/…` branch, build the extension from it, and restart the browser, so the next games play on it.

The commentator narrates each step. Everything happens in a worktree of its own, `<data>/lab/worktree`, never in your checkout. The first session takes a snapshot of your working tree, uncommitted work included, as the baseline, without touching your index or branches. The lab's progress is kept in `<data>/lab/state.json`, so a restart picks up where it left off.

- **Safety:** Claude Code gets the improve loop's narrow tools: read and edit files, typecheck, run the tests, `git diff`/`git status`. It may only change `harness/decide|observe|strategy|act` and `tests/`. It runs without any `*KEY*`/`*TOKEN*`/stream variables in its environment, and the lab screen masks any secret value that shows up anyway.
- **Pull requests:** with `STREAM_LAB_PRS=true` and a clean, pushed branch, each change also becomes a PR, and its verdict is posted there.
- **Cost:** each change is one Claude Code run, typically a few minutes. It needs the `claude` CLI logged in.

`STREAM_LAB=false` turns it off.

## Music

Lofi plays under the commentator and dips when he speaks. The tracks are original, composed from scratch on first run by `stream/lofi.ts` (chords, bass, swung drums, vinyl crackle), so they can't draw a copyright claim. To play your own tracks instead, put them in `<data>/music` (`MUSIC_DIR`). Only use music you're allowed to stream. `MUSIC_VOLUME` sets the level (0.22); `MUSIC=false` turns it off.

## What each match looks like

1. The driver opens openfront.io and applies the ballot's top strategy (the biggest bribe, else the most 👍) to the extension's settings, with Jev switched **off**.
2. The mouse pointer glides to the public free-for-all lobby card and clicks it.
3. In the lobby, it glides to the Jev switch in the extension's panel and flips it on. This is the showcase shot.
4. Jev plays the match through the extension. The band under the game shows the match clock, what Jev is doing, and the extension's status.
5. After Jev is eliminated (plus 20 s of spectating), or once someone wins, the driver returns to the homepage and starts the next match.

Every match is logged to `/data/runs/<ts>-extension-<gameID>/trace.jsonl` on the volume: the extension posts its trace to a loopback sink in the driver, and the driver adds its own read of the result (`stream_result`). Copy the directory out (`docker compose -f stream/compose.yml cp stream:/data/runs ./runs`) and run `bun run analyze`.

Every wait has a time limit. If something unexpected happens (a refused lobby, a disconnect, the page changed), it goes back to the homepage and tries again. Crashed processes restart with backoff.

## Two platforms

One ffmpeg process encodes once and sends the result to every platform (ffmpeg's `tee` muxer). The first platform, Kick when both are set, is the primary. If it drops, ffmpeg exits and the supervisor restarts it, as before. A drop on pump.fun, like the session ending on pump.fun's side or a network blip, doesn't touch Kick. The driver sees ffmpeg's `Slave muxer #1 failed` line and restarts the encoder a minute later to reconnect pump.fun. While pump.fun keeps failing, it waits longer between attempts, up to 15 minutes. Each restart blips Kick for a few seconds. If pump.fun's credentials go stale, generate new ones and restart the container.

## Bribes

Set `BRIBE_MINT` (the coin's mint address: the last part of its `pump.fun/coin/<mint>` URL) and `BRIBE_WALLET` (a wallet that only receives bribes) to turn them on. The band gets a fourth line that tells viewers how to bribe:

- Send the coin to the wallet with a memo naming a strategy PR: `#12`. Most wallets can't attach a memo, so an amount ending in the PR number also works: `5000.000012` backs PR #12. The last six decimals are the PR number. A memo that names no PR falls back to the amount. An amount with no PR in it (`5000`) counts as a tip.
- Each PR has a pot. Before each match, the ballot entry with the biggest pot (at least `BRIBE_MIN` tokens) plays, ahead of any 👍 count. Its pot is spent once the match starts. Other pots carry over to later matches.
- A pot for a PR that isn't on the ballot yet (not approved, or no longer valid) waits until the PR is on it. The strategy still goes through the maintainer's approval, so money can't put unreviewed text in front of Jev or on screen.
- The stream only reads the chain, over Solana JSON-RPC. It never holds a key that can move funds, so there are no refunds. Only finalized transfers count, about 15 s after they're sent. Any transfer of the coin into the wallet counts, so don't buy the coin into that wallet.

What's been counted is kept in `BRIBE_LEDGER` on the volume: each token account's last signature, and the pots. A restart neither drops nor double-counts a bribe. Transfers from before the ledger was first created are ignored. Every match's `stream_result` trace event records the pot that bought it (`bribe`).

The public RPC (`https://api.mainnet-beta.solana.com`) is rate-limited. A free Helius or Triton endpoint in `SOLANA_RPC_URL` is safer for 24/7 use.

## OpenFront releases

The extension must be built from the exact commit openfront.io runs (see `extension/README.md`). Before each match, the driver compares the page's `BOOTSTRAP_CONFIG.gitCommit` with the bundled commit. If they differ, it checks out that commit, reinstalls dependencies if the lockfile changed, rebuilds the extension and restarts Chromium. A failed rebuild is retried every 10 minutes, and the band says Jev is updating in the meantime.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `STREAM_OUTPUT` | Kick and/or pump.fun | Any ffmpeg output, instead of the platforms. A path records a Matroska file. |
| `STREAM_WIDTH` / `STREAM_HEIGHT` / `STREAM_FPS` | 1280 / 720 / 30 | Output size. The band takes the bottom ~12% (~15% with the bribe line). |
| `STREAM_VIDEO_KBPS` | 4500 | Kick allows up to 8000. |
| `BRIBE_MINT` / `BRIBE_WALLET` | unset | The coin and the wallet bribes go to. Both, or neither. |
| `BRIBE_TICKER` | `JEV` | Shown on the band as `$JEV`. |
| `BRIBE_MIN` | 1 | Smallest pot, in whole tokens, that outranks the vote count. |
| `BRIBE_REFRESH_SECONDS` | 20 | How often the chain is read. |
| `BRIBE_LEDGER` | `/data/bribes.json` | What's been counted. |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | |
| `STREAM_LAB` | true | Live coding sessions between matches ([Live coding](#live-coding-between-matches)). |
| `STREAM_LAB_EVERY_GAMES` / `STREAM_LAB_GAMES_PER_BUILD` | 2 / 4 | A session every N games; a change is judged after this many games on it. |
| `STREAM_LAB_MAX_MINUTES` / `STREAM_LAB_MODEL` | 12 / Claude Code's default | Time limit and model for each Claude Code run. |
| `STREAM_LAB_PRS` | false | Push each change and open a PR (needs a clean, pushed branch). |
| `MUSIC` / `MUSIC_DIR` / `MUSIC_VOLUME` | true / `<data>/music` / 0.22 | Background music ([Music](#music)). |
| `COMMENTATOR` | true | The on-screen commentator ([The commentator](#the-commentator)). |
| `COMMENTATOR_NAME` | `General Static` | |
| `ANTHROPIC_API_KEY` | unset | Claude writes his lines and answers chat. |
| `COMMENTATOR_MODEL` | `claude-haiku-4-5-20251001` | |
| `COMMENTATOR_VOICE` | first provider with a key, else `say` on a Mac, else `none` | `elevenlabs`, `openai`, `say` or `none`. |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL` | unset / Clyde / `eleven_flash_v2_5` | |
| `OPENAI_API_KEY` / `OPENAI_VOICE` / `OPENAI_TTS_MODEL` | unset / `onyx` / `gpt-4o-mini-tts` | |
| `SAY_VOICE` | `Rocko (English (US))` | macOS voice (`say -v '?'` lists them). |
| `KICK_CHANNEL` | unset | Kick channel whose chat he answers. |
| `COMMENTATOR_IDLE_SECONDS` / `COMMENTATOR_CHAT_GAP_SECONDS` | 35 / 12 | Talk after this much silence; at most one chat answer per this long. |
| `STREAM_AUDIO` | true | Game audio through PulseAudio. `false` sends silence. |
| `JEV_USERNAME` | `jeviatus` | In-game name (3–20 letters, digits, space, `_ . -`). |
| `BALLOT_REPO` | `alexandre-schaffner/jeviatus` | Where strategy PRs are read from. |
| `BALLOT_REQUIRE_APPROVAL` | true | Only PRs whose latest commit a maintainer approved. |
| `BALLOT_MIN_VOTES` | 1 | Below this, Jev plays on its own judgment. |
| `LOBBY_TIMEOUT_SECONDS` | 240 | Give up on a lobby that doesn't start. |
| `MAX_GAME_MINUTES` | 60 | Leave a match that runs longer. |
| `SPECTATE_AFTER_DEATH_SECONDS` | 20 | |
| `STREAM_OPENFRONT_URL` | `https://openfront.io` | |
| `TRACE_DIR` | `/data/runs` | Where each match's trace is written. |
| `TRACE_PORT` | 9231 | Loopback port of the trace sink the extension posts to. |
| `STREAM_RECORD_HOURS` | 6 | Keep this many hours of the broadcast as 5-minute segments for TikTok clips ([tiktok/README.md](../tiktok/README.md)). About 2 GB per hour at 4500 kbps. `0` turns recording off. |
| `STREAM_RECORD_DIR` | `/data/recordings` | Where the segments go. |
| `STREAM_RECORD_SEGMENT_SECONDS` | 300 | |

## Limits worth knowing

- **Turnstile.** openfront.io protects joins with Cloudflare Turnstile. Usually it passes invisibly in a normal browser. If it ever asks for a human check, the driver doesn't try to solve it: it shows a notice on the band and tries again 5 minutes later.
- **Fair play.** This bot plays public lobbies against people, as `jeviatus`, a name that doesn't say it's a bot. It plays FFA only. Check OpenFront's terms, and consider asking its maintainers before running it around the clock.
- **Voting needs a public repo.** Viewers can only see and 👍 PRs if the repository is public.
