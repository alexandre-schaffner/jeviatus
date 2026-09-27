// The pieces `bun run tiktok` (cli.ts) and the clip pipeline (clips/) share:
// finding traces, probing and syncing recordings with a game, planning each
// moment's clip on the beat, and running ffmpeg politely next to the live
// encoder.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { listSegments, type Segment, segmentStart, segmentsCovering } from "../stream/recordings";
import { type GameTrace, TICKS_PER_SEC } from "./moments";
import { barSeconds } from "./music";
import { brainCard } from "./brain";
import { HOOK, type Pick, statLine } from "./phrases";
import type { Clip } from "./render";

// Trace files from files, game dirs and runs dirs.
export function findTraceFiles(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (!existsSync(a)) continue;
    if (statSync(a).isFile()) out.push(a);
    else if (existsSync(path.join(a, "trace.jsonl"))) out.push(path.join(a, "trace.jsonl"));
    else for (const d of readdirSync(a).sort()) if (existsSync(path.join(a, d, "trace.jsonl"))) out.push(path.join(a, d, "trace.jsonl"));
  }
  return out;
}

export function defaultFont(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.TIKTOK_FONT,
    "/System/Library/Fonts/Supplemental/Impact.ttf",
    "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  ];
  return candidates.find((f) => f && existsSync(f)) ?? null;
}

// Homebrew's plain ffmpeg has no drawtext; ffmpeg-full does.
const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin";
export const ffmpegBin = () => process.env.FFMPEG_BIN ?? (existsSync(`${FFMPEG_FULL}/ffmpeg`) ? `${FFMPEG_FULL}/ffmpeg` : "ffmpeg");
export const ffprobeBin = () => process.env.FFPROBE_BIN ?? (existsSync(`${FFMPEG_FULL}/ffprobe`) ? `${FFMPEG_FULL}/ffprobe` : "ffprobe");

// Renders share the machine with the live encoder: lowest priority, and the
// caller runs one at a time.
export async function runFfmpeg(args: string[], opts: { nice?: boolean; quiet?: boolean } = {}): Promise<{ ok: boolean; stderr: string }> {
  const cmd = [...(opts.nice === false ? [] : ["nice", "-n", "19"]), ffmpegBin(), ...args];
  const p = Bun.spawn(cmd, { stdout: opts.quiet ? "ignore" : "inherit", stderr: "pipe" });
  const stderr = await new Response(p.stderr).text();
  if (!opts.quiet && stderr.trim()) process.stderr.write(stderr);
  return { ok: (await p.exited) === 0, stderr };
}

export interface Probe {
  width: number;
  height: number;
  hasAudio: boolean;
  durationSec: number | null;
  startMs: number | null;
}

const probes = new Map<string, Probe | null>();

export async function probe(file: string): Promise<Probe | null> {
  const size = existsSync(file) ? statSync(file).size : -1;
  const key = `${file}:${size}`;
  if (probes.has(key)) return probes.get(key)!;
  const p = Bun.spawn([ffprobeBin(), "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration:format_tags=creation_time", "-of", "json", file], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = [await new Response(p.stdout).text(), await p.exited];
  let result: Probe | null = null;
  if (code === 0) {
    const j = JSON.parse(out) as { streams: { codec_type: string; width?: number; height?: number }[]; format?: { duration?: string; tags?: { creation_time?: string } } };
    const v = j.streams.find((s) => s.codec_type === "video");
    const created = Date.parse(j.format?.tags?.creation_time ?? "");
    if (v?.width && v.height) {
      result = {
        width: v.width,
        height: v.height,
        hasAudio: j.streams.some((s) => s.codec_type === "audio"),
        durationSec: j.format?.duration ? Number(j.format.duration) : null,
        startMs: segmentStart(file) ?? (Number.isFinite(created) ? created : null),
      };
    }
  }
  probes.set(key, result);
  return result;
}

// Where ticks [from, to] of a game are: which file(s), and how far in.
export type Locate = (fromTick: number, toTick: number) => { sources: string[]; seekSec: number } | null;

// Segments that really hold [fromMs, toMs]: the stream restarting leaves
// short segments and gaps, and a window that falls in one has no footage.
export function coveredBy(segments: (Segment & { durationSec: number })[], fromMs: number, toMs: number): { files: string[]; offsetSec: number } | null {
  const c = segmentsCovering(segments, fromMs, toMs);
  if (!c) return null;
  const used = c.files.map((f) => segments.find((s) => s.file === f)!);
  let end = used[0]!.startMs;
  for (const s of used) {
    if (s.startMs - end > 1500) return null; // a gap inside the window
    end = s.startMs + s.durationSec * 1000;
  }
  return end >= toMs ? c : null;
}

// A segment cut short by a stream restart has no duration in its header:
// it lasted until the next segment started, at most a full segment.
export function segmentDurations(segs: (Segment & { durationSec: number | null; readable: boolean })[], fullSec = 300): (Segment & { durationSec: number })[] {
  const out: (Segment & { durationSec: number })[] = [];
  segs.forEach((s, i) => {
    if (!s.readable) return;
    const next = segs[i + 1];
    const d = s.durationSec ?? (next ? Math.min(fullSec, (next.startMs - s.startMs) / 1000 - 1) : null);
    if (d && d > 0) out.push({ file: s.file, startMs: s.startMs, durationSec: d });
  });
  return out;
}

export async function segmentsWithDurations(dir: string): Promise<(Segment & { durationSec: number })[]> {
  const segs: (Segment & { durationSec: number | null; readable: boolean })[] = [];
  for (const s of listSegments(dir)) {
    const p = await probe(s.file);
    segs.push({ ...s, durationSec: p?.durationSec ?? null, readable: p !== null });
  }
  return segmentDurations(segs);
}

// A game's footage in a directory of stream segments (or one file with a
// known start), or why there is none.
export async function footage(
  g: GameTrace,
  video: string,
  opts: { offsetSec?: number; videoStartMs?: number | null; segments?: (Segment & { durationSec: number })[] } = {},
): Promise<{ locate: Locate; probe: Probe } | string> {
  const nudge = opts.offsetSec ?? 0;
  if (!existsSync(video)) return `no recording at ${video} (pass --video)`;
  if (statSync(video).isDirectory()) {
    const segments = opts.segments ?? (await segmentsWithDurations(video));
    if (segments.length === 0) return `no recording segments in ${video}`;
    if (g.startedAtMs === null) return "the trace has no start time to find its footage by";
    const start = g.startedAtMs + nudge * 1000;
    const at = (tick: number) => start + (tick / TICKS_PER_SEC) * 1000;
    const first = segmentsCovering(segments, at(0), at(g.lastTick));
    if (!first) return "the recording starts after this game";
    const p = await probe(first.files.at(-1)!);
    if (!p) return `ffprobe couldn't read ${first.files.at(-1)}`;
    return {
      probe: p,
      locate: (from, to) => {
        const c = coveredBy(segments, at(from), at(to));
        return c && { sources: c.files, seekSec: c.offsetSec };
      },
    };
  }
  const p = await probe(video);
  if (!p) return `ffprobe couldn't read ${video}`;
  const startMs = opts.videoStartMs ?? p.startMs;
  let zero: number;
  if (startMs !== null && Number.isFinite(startMs) && g.startedAtMs !== null) zero = (g.startedAtMs - startMs) / 1000 + nudge;
  else if (opts.offsetSec !== undefined) zero = nudge;
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

export const gameClock = (tick: number) => `${Math.floor(tick / 600)}:${String(Math.floor(tick / 10) % 60).padStart(2, "0")}`;

// Each clip is a whole number of bars with the payoff on a bar line, so the
// punch-in and catchphrase land on the beat. Surges play sped up. The first
// clip of a video opens on the hook (or `opts.hook`), and gets a longer run-up
// when `opts.leadBars` asks for one (single-moment clips).
export function planClip(pick: Pick, i: number, bpm: number, locate: Locate, opts: { hook?: string; leadBars?: number; tailBars?: number } = {}): Clip | null {
  const m = pick.moment;
  const bar = barSeconds(bpm);
  const buildUp = (m.tick - m.fromTick) / TICKS_PER_SEC;
  const leadBars = opts.leadBars ?? Math.max(i === 0 ? 2 : 1, Math.min(3, Math.round(Math.min(buildUp, 6) / bar)));
  const tailBars = opts.tailBars ?? (m.kind === "surge" ? 1 : bar <= 2.2 ? 2 : 1);
  const speed = m.kind === "surge" ? Math.min(8, Math.max(1, Math.round(buildUp / (leadBars * bar)))) : 1;
  const leadSrc = leadBars * bar * speed;
  const spanSec = (leadBars + tailBars) * bar * speed;
  const fromTick = Math.round(m.tick - leadSrc * TICKS_PER_SEC);
  const where = locate(fromTick, fromTick + spanSec * TICKS_PER_SEC);
  if (!where) return null;
  return {
    ...where,
    spanSec,
    speed,
    punchSec: leadBars * bar,
    teaser: i === 0 ? (opts.hook ?? HOOK) : speed > 1 ? `${speed}X SPEED` : `MINUTE ${gameClock(m.tick)}`,
    phrase: pick.phrase,
    stat: statLine(m),
    ...(m.brain ? { brain: { ...brainCard(m.brain), clock: gameClock(m.brain.tick) } } : {}),
  };
}

export function caption(g: GameTrace, picks: Pick[]): string {
  const best = [...picks].sort((a, b) => b.epic - a.epic)[0]!;
  return [
    `${best.phrase} 🤖`,
    "",
    `That's Jev playing, TypeSafe's System One model. It doesn't chat or write text: it answers questions about the game with probabilities, and code turns them into moves. The bars at the bottom are its actual numbers. Real OpenFront lobbies against real people, live 24/7.${g.map ? ` Map: ${g.map}.` : ""}${g.strategy ? ` Strategy by a viewer: "${g.strategy}".` : ""}`,
    "",
    "#openfront #ai #gaming #strategygames #aigaming #jev",
  ].join("\n");
}
