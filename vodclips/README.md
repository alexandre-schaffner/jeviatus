# Clips from someone else's Kick stream

`bun run vodclips all --channel <slug>` takes a finished Kick VOD (default: the channel's latest), finds the moments worth clipping, and renders them as vertical 1080x1920 Reels with a hook and post text. It uses the same split as [tiktok/](../tiktok/README.md): code finds the candidates and gathers the evidence, and Jev judges them.

```
Kick VOD ──► 160p segments ──► audio ──► whisper base.en (whole stream, ~45x realtime)
         ├─► viewer clips (where people pressed "clip")          │
         └─► chat replay, sampled every 30 s                     ▼
signals.ts: heat per second ──► 150 peaks ──► Jev judges each (questions.ts)
   ──► top 40 re-transcribed with large-v3-turbo, judged again ──► ranked.json
   ──► hooks: Claude drafts 5, Jev picks one ──► render.ts ──► out/NN-HHMMSS.mp4 + .txt
```

## Stages

```sh
bun run vodclips fetch       --channel clavicular --work .context/clavicular   # playlist, segments, audio, viewer clips, chat
bun run vodclips transcribe  --channel clavicular --work .context/clavicular
bun run vodclips analyze     --channel clavicular --work .context/clavicular --env-from ~/Projects/jeviatus/.env
bun run vodclips render      --channel clavicular --work .context/clavicular --top 10 --env-from ~/Projects/jeviatus/.env
```

Every stage caches its output in the work dir, so a rerun only does what's missing. Delete `judged.json` (or set `REJUDGE=1`) to re-judge the first pass, and delete `hooks.json` to redraft the hooks. The flags are listed at the top of [cli.ts](cli.ts).

Measured on a 24 h stream on an M-series Mac:

| Step | Time |
| --- | --- |
| 160p download (8,674 segments, about 2.5 GB) | ~5 min |
| Audio extraction | ~2 min |
| Whisper base.en, 3 chunks in parallel | ~30 min |
| Chat sampling (2,900 requests) | ~50 min |
| Jev first pass (150 moments) | seconds |
| Refine pass (40 windows with turbo) | ~4 min |
| Render, per clip | ~20 s |

Chat sampling is slow because Kick blocks bursts with "Request blocked by security policy" for about a minute, so requests go out at roughly one per second.

## Other streamers

The channel is never assumed: pass `--channel <slug>` or set `VODCLIPS_CHANNEL`. What the questions and the hook prompt say about the streamer (name, nickname, what they're known for, who talks on stream, their slang, the hook formats that work for them) comes from a profile, `streamers/<slug>.json`, or the file given with `--streamer` / `VODCLIPS_STREAMER`. The fields are documented in [streamer.ts](streamer.ts). A channel without a profile gets a generic one built from its slug: it runs, but the hooks are blander. [streamers/clavicular.json](streamers/clavicular.json) is the worked example.

## Running it unattended

[watch.ts](watch.ts) checks the channel every 30 minutes and runs `all` on each VOD that has finished since it started, one at a time, with a work dir per VOD under `/data/<channel>/<vod id>`. The first run marks the VODs already on the channel as seen (`--backfill` processes them too). A VOD that fails 3 times is skipped. After a VOD is done, its segments, audio and whisper chunks are deleted (about 3 GB a day of stream), and the JSON and `out/` are kept. Add `--once` to have an outside scheduler (cron, an agent) run it instead of the built-in loop.

The container bundles all of that: ffmpeg with libass, whisper.cpp built on the host, the three models, Claude Code and Bun.

```sh
# .env: TYPESAFE_API_KEY, and CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY
VODCLIPS_CHANNEL=clavicular docker compose -f vodclips/compose.yml up -d --build
docker compose -f vodclips/compose.yml logs -f
docker compose -f vodclips/compose.yml cp vodclips:/data ./vodclips-data   # copy the clips out
```

It only renders. Nothing is posted anywhere.

A 24 h stream needs about 3 GB of disk while it's processed. Whisper is the slow part: on 4 CPU cores, expect a few hours per day of stream, not the 30 min measured on the Mac.

## Where the questions come from

The questions are reverse-engineered from Clavicular's own Instagram: 360 reels with play counts, about 95 of them transcribed. The notes and data are in [research-clavicular-instagram.md](research-clavicular-instagram.md). The short version:

- **What the winners have in common:** they are short. Every top-5 stream clip runs 29 s or less, and median plays drop after 20 s. They open mid-confrontation with someone on camera, and they land one of these beats:
  - a blunt verdict to someone's face;
  - a status flip, where he wins or loses;
  - a foil whose reaction shows the line landed;
  - absurd lingo;
  - a meltdown or a stunt.
- **What flops:** monologues, advice, politics, and long sit-down setups.

[questions.ts](questions.ts) asks one question per beat, plus a flop gate and a minors gate, plus where to start and end the cut. Each start and end is picked from the transcript's own line breaks. `scoreOf` combines the answers with the signals. Its weights follow the research: 2x verdict, 2x status flip, and 1x for the foil, the cold open, lingo, outrage, chat, the audio payoff, the spectacle, and viewer clips.

Nothing is censored for being edgy: slurs, sex talk, self-harm jokes and shock humour all compete on virality like anything else. The one exception is the `minor` gate. A moment where someone may be under 18 in a sexual or romantic context gets a score of 0 when Jev puts that at more than 30%.

## What a clip looks like

It copies his top-performing Reels:
- **Picture:** a 4:5 center crop over a blurred copy of itself.
- **Hook:** sits over the top of the picture. It is either a quoted punchline in white or a headline in a white box ("Clav's camper gets friend zoned live on stream").
- **KICK bar:** a black bar under the picture with KICK / KICK.COM/CLAVICULAR, which Kick's clipping program asks for.
- **Captions:** none by default. His top clips don't use running captions, and noisy IRL audio mis-transcribes. `--captions` burns them in, timed per word by large-v3-turbo.
- **Emoji:** they appear in the post text only. libass can't draw color emoji.

Each `.txt` next to a clip holds the hook, the post caption, and the VOD timestamp it came from.

## Needs

- **ffmpeg-full:** libass lives in the `ffmpeg-full` keg, not the default one.
- **whisper-cli:** from whisper.cpp, with models in `~/.cache/whisper-cpp`:
  - `ggml-base.en.bin`
  - `ggml-large-v3-turbo-q5_0.bin`
  - `ggml-silero-v5.1.2.bin`
- **Jev:** `TYPESAFE_API_KEY`.
- **Claude Code CLI:** `claude`, logged in, for the hook drafts.
