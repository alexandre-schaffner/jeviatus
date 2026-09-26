// Turn Jev's games into TikToks: find the epic moments in a game's trace,
// let Jev pick the best ones and their catchphrases, and cut them from the
// stream's recording into a 9:16 video with music (tiktok/README.md).
//
//   bun run tiktok <trace.jsonl | game dir | runs dir>... [options]
//
//   --video <file|dir>    the recording: a file, or the stream's segment
//                         directory (default: $STREAM_RECORD_DIR or /data/recordings)
//   --video-start <iso>   wall-clock time of the file's first frame (else
//                         read from its name or metadata)
//   --offset <sec>        nudge the sync; for a file with no start time, the
//                         second of the video where the game's tick 0 is
//   --music <file|dir>    soundtrack (default: music/ if it has tracks, else
//                         the built-in beat)
//   --bpm <n>             the track's tempo (else from its name, "..._128bpm.mp3")
//   --music-start <sec>   start the track here (e.g. at the drop)
//   --moments <n>         moments per video (default 3)
//   --out <file>          output (default: tiktok.mp4 beside the trace)
//   --font <file>         caption font (default: $TIKTOK_FONT, Impact, DejaVu Sans Bold)
//   --no-band             the recording has no vote band to cut off
//   --band-lines <n>      the band's lines of text (default 4 when BRIBE_MINT
//                         is set, since the stream shows the bribe line; else 3)
//   --no-panel            leave out Jev's decision panel
//   --no-jev              pick moments and phrases without Jev calls
//   --dry-run             print the plan, render nothing
//   --force               re-render games that already have a video

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { JevClient } from "../harness/jev/client";
import { bandLines as streamBandLines } from "../stream/encoder";
import { listSegments, segmentStart, segmentsCovering } from "../stream/recordings";
import { type GameTrace, findMoments, parseTrace, TICKS_PER_SEC } from "./moments";
import { barSeconds, bpmFromName, chooseTrack, DEFAULT_BPM, type Music } from "./music";
import { direct, HOOK, OUTRO, type Pick, select, statLine } from "./phrases";
import { type Clip, renderArgs, type Source } from "./render";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    video: { type: "string" },
    "video-start": { type: "string" },
    offset: { type: "string" },
    music: { type: "string" },
    bpm: { type: "string" },
    "music-start": { type: "string", default: "0" },
    moments: { type: "string", default: "3" },
    out: { type: "string" },
    font: { type: "string" },
    "no-band": { type: "boolean", default: false },
    "band-lines": { type: "string" },
    "no-panel": { type: "boolean", default: false },
    "no-jev": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});

const log = (line: string) => console.log(line);
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

// --- inputs ---------------------------------------------------------------------------

function traces(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args.length > 0 ? args : [process.env.TRACE_DIR ?? "runs"]) {
    if (!existsSync(a)) fail(`${a}: no such file or directory`);
    if (statSync(a).isFile()) out.push(a);
    else if (existsSync(path.join(a, "trace.jsonl"))) out.push(path.join(a, "trace.jsonl"));
    else for (const d of readdirSync(a).sort()) if (existsSync(path.join(a, d, "trace.jsonl"))) out.push(path.join(a, d, "trace.jsonl"));
  }
  return out;
}

function defaultFont(): string {
  const candidates = [
    values.font,
    process.env.TIKTOK_FONT,
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  ];
  return candidates.find((f) => f && existsSync(f)) ?? fail("no caption font found; pass --font <file.ttf>");
}

interface Probe {
  width: number;
  height: number;
  hasAudio: boolean;
  durationSec: number | null;
  startMs: number | null;
}

async function probe(file: string): Promise<Probe> {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration:format_tags=creation_time", "-of", "json", file], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = [await new Response(p.stdout).text(), await p.exited];
  if (code !== 0) fail(`ffprobe couldn't read ${file}`);
  const j = JSON.parse(out) as { streams: { codec_type: string; width?: number; height?: number }[]; format?: { duration?: string; tags?: { creation_time?: string } } };
  const v = j.streams.find((s) => s.codec_type === "video") ?? fail(`${file} has no video`);
  const created = Date.parse(j.format?.tags?.creation_time ?? "");
  return {
    width: v.width!,
    height: v.height!,
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
    durationSec: j.format?.duration ? Number(j.format.duration) : null,
    startMs: segmentStart(file) ?? (Number.isFinite(created) ? created : null),
  };
}

// Where tick `t` of this game is: which file(s), and how far in.
type Locate = (fromTick: number, toTick: number) => { sources: string[]; seekSec: number } | null;

async function footage(g: GameTrace): Promise<{ locate: Locate; probe: Probe } | string> {
  const video = values.video ?? process.env.STREAM_RECORD_DIR ?? "/data/recordings";
  const nudge = Number(values.offset ?? 0);
  if (!existsSync(video)) return `no recording at ${video} (pass --video)`;
  if (statSync(video).isDirectory()) {
    const segments = listSegments(video);
    if (segments.length === 0) return `no recording segments in ${video}`;
    if (g.startedAtMs === null) return "the trace has no start time to find its footage by";
    const start = g.startedAtMs + nudge * 1000;
    const at = (tick: number) => start + (tick / TICKS_PER_SEC) * 1000;
    const first = segmentsCovering(segments, at(0), at(g.lastTick));
    if (!first) return "the recording starts after this game";
    return {
      probe: await probe(first.files[0]!),
      locate: (from, to) => {
        const c = segmentsCovering(segments, at(from), at(to));
        return c && { sources: c.files, seekSec: c.offsetSec };
      },
    };
  }
  const p = await probe(video);
  const startMs = values["video-start"] ? Date.parse(values["video-start"]) : p.startMs;
  let zero: number;
  if (startMs !== null && Number.isFinite(startMs) && g.startedAtMs !== null) zero = (g.startedAtMs - startMs) / 1000 + nudge;
  else if (values.offset !== undefined) zero = nudge;
  else return `can't sync ${video} with the game: pass --offset (the video second where the game starts) or --video-start`;
  return {
    probe: p,
    locate: (from, to) => {
      const seek = zero + from / TICKS_PER_SEC;
      const end = zero + to / TICKS_PER_SEC;
      if (seek < 0 || (p.durationSec !== null && end > p.durationSec)) return null;
      return { sources: [video], seekSec: seek };
    },
  };
}

// --- plan -----------------------------------------------------------------------------

// Each clip is a whole number of bars with the payoff on a bar line, so the
// punch-in and catchphrase land on the beat. Surges play sped up.
function planClip(pick: Pick, i: number, bpm: number, locate: Locate): Clip | null {
  const m = pick.moment;
  const bar = barSeconds(bpm);
  const buildUp = (m.tick - m.fromTick) / TICKS_PER_SEC;
  const leadBars = Math.max(i === 0 ? 2 : 1, Math.min(3, Math.round(Math.min(buildUp, 6) / bar)));
  const tailBars = m.kind === "surge" ? 1 : bar <= 2.2 ? 2 : 1;
  const speed = m.kind === "surge" ? Math.min(8, Math.max(1, Math.round(buildUp / (leadBars * bar)))) : 1;
  const leadSrc = leadBars * bar * speed;
  const spanSec = (leadBars + tailBars) * bar * speed;
  const fromTick = Math.round(m.tick - leadSrc * TICKS_PER_SEC);
  const where = locate(fromTick, fromTick + spanSec * TICKS_PER_SEC);
  if (!where) return null;
  const clock = `${Math.floor(m.tick / 600)}:${String(Math.floor(m.tick / 10) % 60).padStart(2, "0")}`;
  return {
    ...where,
    spanSec,
    speed,
    punchSec: leadBars * bar,
    teaser: i === 0 ? HOOK : speed > 1 ? `${speed}X SPEED` : `MINUTE ${clock}`,
    phrase: pick.phrase,
    stat: statLine(m),
  };
}

function caption(g: GameTrace, picks: Pick[]): string {
  const best = [...picks].sort((a, b) => b.epic - a.epic)[0]!;
  return [
    `${best.phrase} 🤖`,
    "",
    `Jev is an AI playing OpenFront against real people, live 24/7.${g.map ? ` Map: ${g.map}.` : ""}${g.strategy ? ` Strategy voted by viewers: "${g.strategy}".` : ""}`,
    "",
    "#openfront #ai #gaming #strategygames #aigaming #jev",
  ].join("\n");
}

// --- run ------------------------------------------------------------------------------

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
const jev = values["no-jev"] || !apiKey ? null : new JevClient(process.env.JEV_MODEL ?? "jev-1.13.0", apiKey, 15_000);
if (!jev) log(values["no-jev"] ? "picking moments without Jev (--no-jev)" : "no TYPESAFE_API_KEY: picking moments without Jev");
const font = defaultFont();
const bandLines = values["band-lines"] ? Number(values["band-lines"]) : streamBandLines(Boolean(process.env.BRIBE_MINT?.trim()));
if (!Number.isInteger(bandLines) || bandLines < 1) fail(`--band-lines must be a whole number, got ${values["band-lines"]}`);
const files = traces(positionals);
if (files.length === 0) fail("no traces found");

let made = 0;
for (const file of files) {
  const dir = path.dirname(file);
  const out = values.out && files.length === 1 ? values.out : path.join(dir, "tiktok.mp4");
  if (existsSync(out) && !values.force && !values["dry-run"]) {
    log(`${dir}: already has ${path.basename(out)} (--force to redo)`);
    continue;
  }
  const g = parseTrace(await Bun.file(file).text());
  const candidates = findMoments(g);
  if (candidates.length === 0) {
    log(`${dir}: no epic moments`);
    continue;
  }
  const where = await footage(g);
  if (typeof where === "string") {
    log(`${dir}: ${where}`);
    continue;
  }

  const seed = [...dir].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0);
  const track = values.music ? chooseTrack(values.music, seed) : existsSync("music") ? chooseTrack("music", seed) : null;
  if (values.music && !track) fail(`no audio files at ${values.music}`);
  const music: Music = { file: track, bpm: Number(values.bpm ?? 0) || (track && bpmFromName(track)) || DEFAULT_BPM, startSec: Number(values["music-start"]) };

  const picks = select(await direct(candidates, g, jev, log), Number(values.moments));
  const clips: Clip[] = [];
  const used: Pick[] = [];
  for (const p of picks) {
    const c = planClip(p, clips.length, music.bpm, where.locate);
    if (c) {
      clips.push(c);
      used.push(p);
    } else log(`${dir}: no footage for ${p.moment.kind} at tick ${p.moment.tick}`);
  }
  log(`${dir}: ${candidates.length} candidates, ${used.length} in the video`);
  for (const p of used) log(`  ${p.moment.kind.padEnd(10)} t=${p.moment.tick} epic=${p.epic.toFixed(2)} (${p.by}) "${p.phrase}"  ${p.moment.what}`);
  if (clips.length === 0) continue;

  const source: Source = { width: where.probe.width, height: where.probe.height, hasAudio: where.probe.hasAudio, band: !values["no-band"], bandLines, panel: !values["no-panel"] };
  const workDir = path.join(dir, ".tiktok");
  const plan = renderArgs({ clips, source, music, font, outro: OUTRO, out, workDir });
  if (values["dry-run"]) {
    log(`  would render ${plan.durationSec.toFixed(1)} s to ${out} with ${music.file ?? `the built-in beat at ${music.bpm} bpm`}`);
    continue;
  }
  mkdirSync(workDir, { recursive: true });
  for (const f of plan.files) writeFileSync(f.path, f.content);
  const ff = Bun.spawn(["ffmpeg", ...plan.args], { stdout: "inherit", stderr: "inherit" });
  if ((await ff.exited) !== 0) {
    log(`${dir}: ffmpeg failed`);
    continue;
  }
  rmSync(workDir, { recursive: true, force: true });
  writeFileSync(out.replace(/\.mp4$/, "") + ".txt", `${caption(g, used)}\n`);
  writeFileSync(out.replace(/\.mp4$/, "") + ".json", `${JSON.stringify({ trace: file, music, picks: used, candidates }, null, 2)}\n`);
  log(`  wrote ${out} (${plan.durationSec.toFixed(1)} s)`);
  made++;
}
log(`${made} video${made === 1 ? "" : "s"} made`);
