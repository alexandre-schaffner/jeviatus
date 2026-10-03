// One vertical 1080x1920 clip from a window of the VOD, in the look of
// Clavicular's best-performing Reels: the picture cropped to 4:5 over a
// blurred copy of itself, the hook over the top of the picture (a quoted
// punchline in white, or a headline in a white box), and the KICK bar under
// it that Kick's clipping program asks for. Running captions are optional:
// his top clips don't use them, and noisy IRL audio mis-transcribes.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { download, type Segment } from "./kick";
import { type Word, words } from "./transcript";

// libass lives in the ffmpeg-full keg, not the default one.
export const FFMPEG = ["/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "/usr/bin/ffmpeg"].find((f) => existsSync(f)) ?? "ffmpeg";

const W = 1080;
const H = 1920;
const VIDEO_H = 1350; // 4:5 picture
const VIDEO_Y = 190;
const BAR_H = 150; // the KICK bar under the picture
const KICK_GREEN = "&H0018FC53"; // #53FC18

export interface ClipSpec {
  id: string;
  fromSec: number; // VOD seconds
  toSec: number;
  hook: string; // top text, kept for the whole clip
  channel: string; // for the KICK bar
  captions?: boolean;
}

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`${path.basename(cmd[0]!)} failed: ${err.slice(-600)}`);
};

// ASS colours are &HAABBGGRR.
const WHITE = "&H00FFFFFF";
const BLACK = "&H00000000";

const assText = (s: string) => s.replace(/\\/g, "").replace(/[{}]/g, "").replace(/\n/g, "\\N");
const ts = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

// Words into on-screen groups: up to 3 words / 18 characters, broken at
// pauses, so captions read at speaking pace.
export function groups(ws: Word[]): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of ws) {
    const len = cur.map((c) => c.text).join(" ").length + w.text.length + 1;
    const gap = cur.length ? w.from - cur[cur.length - 1]!.to : 0;
    if (cur.length && (cur.length >= 3 || len > 18 || gap > 0.45 || /[.?!]$/.test(cur[cur.length - 1]!.text))) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function ass(spec: Pick<ClipSpec, "hook" | "channel">, ws: Word[], durationSec: number): string {
  const barY = VIDEO_Y + VIDEO_H;
  const quoted = /^["“]/.test(spec.hook.trim());
  const head = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // A quoted punchline: white with a soft shadow, over the picture.
    `Style: Quote,Helvetica Neue,64,${WHITE},${WHITE},${BLACK},&H64000000,1,0,0,0,100,100,0,0,1,2.5,4,8,110,110,${VIDEO_Y + 230},1`,
    // A headline: black on a white box, the native Reels caption look.
    `Style: Box,Helvetica Neue,56,${BLACK},${BLACK},${WHITE},${WHITE},1,0,0,0,100,100,0,0,3,16,0,8,120,120,${VIDEO_Y + 70},1`,
    `Style: Kick,Arial Black,96,${KICK_GREEN},${KICK_GREEN},${BLACK},${BLACK},1,0,0,0,100,100,-2,0,1,0,0,4,70,0,0,1`,
    `Style: Url,Arial Black,34,${WHITE},${WHITE},${BLACK},${BLACK},1,0,0,0,100,100,0,0,1,0,0,6,0,70,0,1`,
    `Style: Cap,Helvetica Neue,58,${WHITE},${WHITE},${BLACK},&H80000000,1,0,0,0,100,100,0,0,1,4,2,2,80,80,${H - barY + 60},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const all = `${ts(0)},${ts(durationSec)}`;
  const mid = barY + BAR_H / 2;
  const ev = [
    `Dialogue: 2,${all},${quoted ? "Quote" : "Box"},,0,0,0,,${assText(spec.hook)}`,
    `Dialogue: 2,${all},Kick,,0,0,0,,{\\pos(70,${mid})}KICK`,
    `Dialogue: 2,${all},Url,,0,0,0,,{\\pos(${W - 70},${mid})}KICK.COM/${assText(spec.channel.toUpperCase())}`,
  ];
  for (const g of groups(ws)) {
    const from = g[0]!.from;
    const to = Math.min(durationSec, g[g.length - 1]!.to + 0.15);
    if (to > from) ev.push(`Dialogue: 0,${ts(from)},${ts(to)},Cap,,0,0,0,,${assText(g.map((w) => w.text).join(" "))}`);
  }
  return [...head, ...ev, ""].join("\n");
}

// Segments of one rendition that cover [from, to).
export const covering = (segs: Segment[], from: number, to: number) => segs.filter((s) => s.startSec + s.durSec > from && s.startSec < to);

export async function render(spec: ClipSpec, segs1080: Segment[], workRoot: string, outDir: string, log: (l: string) => void = () => {}): Promise<string> {
  const work = path.join(workRoot, spec.id);
  mkdirSync(work, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const need = covering(segs1080, spec.fromSec, spec.toSec);
  if (!need.length) throw new Error(`no segments for ${spec.id}`);
  const files = await download(need, path.join(workRoot, "seg1080"), 8);
  const list = path.join(work, "concat.txt");
  writeFileSync(list, files.map((f) => `file '${path.resolve(f)}'`).join("\n"));
  const seek = spec.fromSec - need[0]!.startSec;
  const dur = spec.toSec - spec.fromSec;
  const cut = path.join(work, "cut.mp4");
  if (!existsSync(cut))
    await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-ss", seek.toFixed(2), "-t", dur.toFixed(2),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-r", "30", "-c:a", "aac", "-b:a", "192k", cut]);
  const wav = path.join(work, "audio.wav");
  if (spec.captions && !existsSync(wav)) await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", cut, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  const ws = spec.captions ? await words(wav, path.join(work, "words")) : [];
  const subs = path.join(work, "overlay.ass");
  writeFileSync(subs, ass(spec, ws, dur));
  const out = path.join(outDir, `${spec.id}.mp4`);
  const cropW = Math.round((1080 * 4) / 5 / 2) * 2; // 864x1080 out of the 1920x1080 picture
  const filter =
    `[0:v]split=2[a][b];` +
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:3,eq=brightness=-0.12[bg];` +
    `[b]crop=${cropW}:ih,scale=${W}:${VIDEO_H}[fg];` +
    `[bg][fg]overlay=0:${VIDEO_Y},drawbox=x=0:y=${VIDEO_Y + VIDEO_H}:w=${W}:h=${BAR_H}:color=black:t=fill,ass='${subs.replace(/'/g, "\\'").replace(/:/g, "\\:")}'[v]`;
  await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", cut, "-filter_complex", filter, "-map", "[v]", "-map", "0:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-af", "loudnorm=I=-14:TP=-1.5:LRA=11", "-movflags", "+faststart", out]);
  log(`[render] ${out} (${dur.toFixed(0)} s)`);
  return out;
}
