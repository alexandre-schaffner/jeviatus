// Clips from a streamer's finished Kick stream (vodclips/README.md):
//
//   bun vodclips/cli.ts <stage> [options]
//
//   fetch       the VOD's playlist, its 160p segments, its audio, viewer clips, chat samples
//   transcribe  whisper over the whole stream
//   analyze     heat peaks -> candidate moments -> Jev judges each -> ranked.json
//   render      the top --top moments as vertical clips
//   all         every stage in order
//
//   --channel <slug>     Kick channel (or VODCLIPS_CHANNEL; required)
//   --streamer <file>    streamer profile (or VODCLIPS_STREAMER; default vodclips/streamers/<channel>.json, else a generic one)
//   --vod <id>           a VOD id from the channel's list (default: the latest finished one)
//   --work <dir>         working dir (default .context/<channel>)
//   --out <dir>          finished clips (default <work>/out)
//   --top <n>            clips to render (default 8)
//   --candidates <n>     moments Jev judges (default 150)
//   --refine <n>         best moments re-transcribed accurately and judged again (default 40)
//   --env-from <file>    read TYPESAFE_API_KEY from this .env
//   --no-jev             rank by signals only
//   --captions           burn in running captions (whisper large-v3-turbo)

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { JevClient } from "../harness/jev/client";
import { download, listVods, parseChat, sampleChat, segments, type ViewerClip, type Vod, viewerClips } from "./kick";
import { type Candidate, candidates, judgeAll, rank, refine, writeHooks } from "./moments";
import { render } from "./render";
import { chatCurves, clipCurve, loudness, peaks, type Signals } from "./signals";
import { loadStreamer } from "./streamer";
import { loadTranscript, transcribe } from "./transcript";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    channel: { type: "string", default: process.env.VODCLIPS_CHANNEL },
    streamer: { type: "string", default: process.env.VODCLIPS_STREAMER },
    vod: { type: "string" },
    work: { type: "string" },
    out: { type: "string" },
    top: { type: "string", default: "8" },
    candidates: { type: "string", default: "150" },
    refine: { type: "string", default: "40" },
    "env-from": { type: "string" },
    "no-jev": { type: "boolean", default: false },
    captions: { type: "boolean", default: false },
  },
});

const stage = positionals[0] ?? "all";
if (!values.channel) {
  console.error("pass --channel <kick slug> (or set VODCLIPS_CHANNEL)");
  process.exit(2);
}
const channel = values.channel;
const streamer = loadStreamer(channel, values.streamer);
const work = values.work ?? path.join(".context", channel);
const out = values.out ?? path.join(work, "out");
mkdirSync(work, { recursive: true });
const log = (l: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${l}`);
const save = (name: string, v: unknown) => writeFileSync(path.join(work, name), JSON.stringify(v, null, 1));
const load = <T>(name: string): T => JSON.parse(readFileSync(path.join(work, name), "utf8")) as T;
const has = (name: string) => existsSync(path.join(work, name));

function keyFrom(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return process.env.TYPESAFE_API_KEY;
  const m = readFileSync(file, "utf8").match(/^TYPESAFE_API_KEY=(.*)$/m);
  return m?.[1]?.trim().replace(/^["']|["']$/g, "") || process.env.TYPESAFE_API_KEY;
}

async function vod(): Promise<Vod> {
  if (has("vod.json")) return load<Vod>("vod.json");
  const vods = await listVods(channel);
  const v = values.vod ? vods.find((x) => String(x.id) === values.vod) : vods[0];
  if (!v) throw new Error(`no finished VOD${values.vod ? ` ${values.vod}` : ""} on ${channel}`);
  save("vod.json", v);
  log(`[kick] ${v.title} (${(v.durationSec / 3600).toFixed(1)} h, started ${v.startTime})`);
  return v;
}

async function fetchStage() {
  const v = await vod();
  const segs = await segments(v, "160p30");
  log(`[kick] ${segs.length} segments at 160p`);
  // The playlist's own clock is what the VOD's second 0 is; the API's start
  // time is a few seconds off. Chat and clip times are mapped through it.
  if (segs[0]?.wallclock && segs[0].wallclock !== v.startTime) {
    v.startTime = new Date(segs[0].wallclock).toISOString();
    save("vod.json", v);
  }
  const files = await download(segs, path.join(work, "seg160"), 24);
  const wav = path.join(work, "day.wav");
  if (!existsSync(wav)) {
    writeFileSync(path.join(work, "concat.txt"), files.map((f) => `file '${path.resolve(f)}'`).join("\n"));
    const p = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(work, "concat.txt"), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    if ((await p.exited) !== 0) throw new Error("audio extraction failed");
  }
  if (!has("viewer_clips.json")) save("viewer_clips.json", await viewerClips(channel, v.id, log));
  await sampleChat(v, path.join(work, "chat"), 30, log);
}

function chat(v: Vod) {
  const dir = path.join(work, "chat");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseChat(Number(f.slice(0, -5)), readFileSync(path.join(dir, f), "utf8")));
}

async function analyzeStage() {
  const v = await vod();
  const clips = load<ViewerClip[]>("viewer_clips.json");
  const samples = chat(v);
  const loud = has("loud.f32") ? new Float32Array(readFileSync(path.join(work, "loud.f32")).buffer.slice(0)) : await loudness(path.join(work, "day.wav"));
  if (!has("loud.f32")) writeFileSync(path.join(work, "loud.f32"), new Uint8Array(loud.buffer));
  const n = Math.ceil(v.durationSec);
  const { rate, laugh } = chatCurves(samples, v.startTime, n);
  const s: Signals = { durationSec: n, clip: clipCurve(clips, v.startTime, n), chatRate: rate, chatLaugh: laugh, loud };
  const ps = peaks(s, clips, v.startTime, Number(values.candidates));
  log(`[signals] ${ps.length} peaks; chat sampled at ${samples.length} points; ${clips.length} viewer clips`);
  const lines = loadTranscript(work);
  const cands = candidates(ps, lines, clips, samples, v);
  save("candidates.json", cands);
  const apiKey = keyFrom(values["env-from"]);
  const jev = values["no-jev"] || !apiKey ? null : new JevClient(process.env.JEV_MODEL ?? "jev-1.13.0", apiKey, 30_000);
  const judged = has("judged.json") && process.env.REJUDGE !== "1" ? load<Candidate[]>("judged.json") : await judgeAll(streamer, cands, jev, log);
  save("judged.json", judged);
  // Second pass on the best: accurate transcript, judged again.
  const first = rank(judged).slice(0, Number(values.refine));
  const refined = await refine(streamer, first, path.join(work, "day.wav"), path.join(work, "refine"), jev, log);
  save("refined.json", refined);
  const ranked = rank(refined);
  save("ranked.json", ranked);
  for (const r of ranked.slice(0, 20))
    log(`  ${r.score.toFixed(2)}  ${hms(r.fromSec)}-${hms(r.toSec)}  ${r.peak.clips} clips  ${r.summary.slice(0, 90)}`);
  if (jev) log(`[jev] ${jev.stats.calls} calls, ${jev.stats.failures} failures, ${jev.stats.inputTokens} in / ${jev.stats.outputTokens} out tokens`);
}

const hms = (s: number) => new Date(s * 1000).toISOString().slice(11, 19);

async function renderStage() {
  const v = await vod();
  const top = Number(values.top);
  const ranked = load<Candidate[]>("ranked.json").slice(0, top);
  const apiKey = keyFrom(values["env-from"]);
  const jev = values["no-jev"] || !apiKey ? null : new JevClient(process.env.JEV_MODEL ?? "jev-1.13.0", apiKey, 30_000);
  // Hooks already drafted for these moments are kept (rerunning re-renders).
  const known = has("hooks.json") ? new Map(load<Candidate[]>("hooks.json").map((c) => [c.peak.sec, c])) : new Map<number, Candidate>();
  const fresh = await writeHooks(streamer, ranked.filter((c) => !known.get(c.peak.sec)?.hook), jev, log);
  const hooked = ranked.map((c) => fresh.find((f) => f.peak.sec === c.peak.sec) ?? { ...c, ...known.get(c.peak.sec)!, fromSec: c.fromSec, toSec: c.toSec });
  save("hooks.json", hooked);
  const segs = await segments(v, "1080p60");
  const made: string[] = [];
  for (const [i, c] of hooked.entries()) {
    const id = `${String(i + 1).padStart(2, "0")}-${hms(c.fromSec).replace(/:/g, "")}`;
    made.push(await render({ id, fromSec: c.fromSec, toSec: c.toSec, hook: c.hook!, channel, captions: values.captions }, segs, path.join(work, "render"), out, log));
    writeFileSync(path.join(out, `${id}.txt`), `${c.hook}\n\n${c.caption ?? ""}\n\nsource: kick.com/${channel} VOD ${v.id} at ${hms(c.fromSec)}\n`);
  }
  log(`[done] ${made.length} clips in ${out}`);
}

const stages: Record<string, () => Promise<void>> = {
  fetch: fetchStage,
  transcribe: async () => transcribe(path.join(work, "day.wav"), work, 3, log),
  analyze: analyzeStage,
  render: renderStage,
  all: async () => {
    await fetchStage();
    await transcribe(path.join(work, "day.wav"), work, 3, log);
    await analyzeStage();
    await renderStage();
  },
};
if (!stages[stage]) {
  console.error(`unknown stage ${stage}; one of ${Object.keys(stages).join(", ")}`);
  process.exit(1);
}
await stages[stage]!();
