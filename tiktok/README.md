# TikToks from Jev's games

`bun run tiktok` turns a streamed game into a vertical video (1080x1920, 30 fps, about 15 to 30 s). It finds the game's epic moments, has Jev pick the best ones and a catchphrase for each, and cuts them from the stream's recording with music.

```
trace.jsonl ──► moments.ts ──► phrases.ts (Jev) ──► render.ts ──► tiktok.mp4
(what Jev saw)   candidates     epic score +         ffmpeg: cut, 9:16,   + tiktok.txt (post caption)
                                catchphrase          captions, music      + tiktok.json (what was picked, why)
/data/recordings/*.mkv ─────────────────────────────────┘
```

## Make one

The stream records itself (after a `bun run stream:up` rebuild that includes this change): ffmpeg writes the broadcast to 5-minute segments in `/data/recordings` and keeps 6 hours of them (see `STREAM_RECORD_*` in [stream/README.md](../stream/README.md)). Each match's trace goes to `/data/runs/<game>/trace.jsonl`. The container has ffmpeg and fonts, so render there:

```sh
# Every game that doesn't have a video yet (the newest traces still have footage):
docker compose -f stream/compose.yml exec stream bun run tiktok /data/runs
# Copy one out:
docker compose -f stream/compose.yml cp stream:/data/runs/<game>/tiktok.mp4 .
```

Each game directory then holds:
- `tiktok.mp4`: the video.
- `tiktok.txt`: a ready-to-paste caption with hashtags.
- `tiktok.json`: every candidate moment and why the chosen ones won.

To render outside the container, install ffmpeg and point it at a recording: `bun run tiktok runs/<game> --video dry-run.mkv --offset 18`. `--offset` is the second of the video where the game starts, needed when the file's start time isn't known. All flags are listed at the top of [cli.ts](cli.ts).

## Epic moments

[moments.ts](moments.ts) reads the state Jev was shown at every decision step and flags:

| Moment | When |
| --- | --- |
| `surge` | Land share up at least 35% (and 1 point) within a minute. It's shown sped up, up to 8x. |
| `conquest` | A player Jev attacked lost 80% of their land within 3 minutes. |
| `wipeout` | Same, but they're gone. Only these get elimination lines ("has left the chat"). |
| `top_rank` | Jev reaches #1 on land for the first time after the opening. |
| `nuke` | Jev launched an atom bomb, hydrogen bomb or MIRV. The clip waits for impact. |
| `betrayal` | Jev broke an alliance to attack. |
| `underdog` | Jev attacked someone with 1.5x its troops or more. |
| `last_stand` | Jev was eliminated. Losses make good TikToks too. |
| `victory` | Jev won the match. |

Candidates whose clips would show the same footage are merged, and the hotter one is kept.

## Jev as the editor

For each candidate, [phrases.ts](phrases.ts) asks Jev two things in one call:
- **`epic`**: a score from 0 to 4 for how hard the moment would stop a scroll.
- **`phrase`**: the best catchphrase from that moment's bank, filled in with names and numbers ("BigBob has left the chat", "+3% of the map in 60s").

The three most epic moments (`--moments`) go in the video, in game order. No line is used twice in one video: a later moment falls back to its next-best phrase.

Jev only chooses; it never writes text. Everything burned into a public video comes from the bank in `PHRASES`, so add or edit lines there. Placeholders like `{target}` come from the moment's facts, and a phrase whose fact is missing is skipped. Without `TYPESAFE_API_KEY`, or with `--no-jev`, a heuristic score and a stable pick stand in.

## What the video looks like

- **Top:** the hook ("AN AI IS PLAYING OPENFRONT VS REAL PEOPLE") on the first clip, then each moment's catchphrase. It pops in on the payoff with a yellow stat line under it.
- **Middle:** the game, with the vote band cropped off (4 lines tall when the stream has bribes on: `BRIBE_MINT` is set, or pass `--band-lines`). It punches in 1.18x on the payoff.
- **Bottom:** "Jev's brain", the extension's live decision panel, enlarged.
- A white flash on every cut. "VOTE JEV'S NEXT STRATEGY / LINK IN BIO" plays over the last 2.5 s.

The backdrop is the game, blurred.

Clips are whole bars long with the payoff on a bar line, so cuts, punch-ins and captions all land on the beat. The game audio plays under the music at 35%. Sped-up clips are silent.

## Music

- **Default:** a built-in synthesized beat at 120 bpm (kick, clap, hats, bass and pad on Am-F-C-G). No licensing questions.
- **Your own:** drop tracks in `music/` (gitignored), or pass `--music <file|dir>`. Put the tempo in the file name (`hype_128bpm.mp3`) or pass `--bpm`, so cuts land on the beat. `--music-start` skips to the drop. Only use tracks you have the rights to publish.
- **Trending sounds:** those have to be added in the TikTok app after uploading. Render a video, then add the sound there and turn the original audio down.

## Fonts

The container uses DejaVu Sans Bold. On a Mac, Impact is used if it's installed. For the classic TikTok look, use a condensed display font such as Anton (OFL): `TIKTOK_FONT=/path/Anton-Regular.ttf`. Caption sizing adapts to condensed fonts by name (Impact, Anton, Bebas, Oswald).
