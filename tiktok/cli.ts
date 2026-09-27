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

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { JevClient } from "../harness/jev/client";
import { bandLines as streamBandLines } from "../stream/encoder";
import { caption, defaultFont, findTraceFiles, footage, planClip, runFfmpeg } from "./make";
import { findMoments, parseTrace } from "./moments";
import { bpmFromName, chooseTrack, DEFAULT_BPM, type Music } from "./music";
import { direct, OUTRO, type Pick, select } from "./phrases";
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
  const roots = args.length > 0 ? args : [process.env.TRACE_DIR ?? "runs"];
  for (const a of roots) if (!existsSync(a)) fail(`${a}: no such file or directory`);
  return findTraceFiles(roots);
}

// --- run ------------------------------------------------------------------------------

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
const jev = values["no-jev"] || !apiKey ? null : new JevClient(process.env.JEV_MODEL ?? "jev-1.13.0", apiKey, 15_000);
if (!jev) log(values["no-jev"] ? "picking moments without Jev (--no-jev)" : "no TYPESAFE_API_KEY: picking moments without Jev");
const font = defaultFont(values.font) ?? fail("no caption font found; pass --font <file.ttf>");
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
  const video = values.video ?? process.env.STREAM_RECORD_DIR ?? "/data/recordings";
  const where = await footage(g, video, { offsetSec: values.offset !== undefined ? Number(values.offset) : undefined, videoStartMs: values["video-start"] ? Date.parse(values["video-start"]) : null });
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
  if (!(await runFfmpeg(plan.args)).ok) {
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
