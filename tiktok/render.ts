// One ffmpeg run per TikTok: cut each moment from the recording, reframe the
// 16:9 broadcast into 9:16 (blurred backdrop, the game, Jev's decision panel
// underneath), punch in on the payoff, burn in the catchphrase, flash
// between clips, and lay the soundtrack under the ducked game audio. Pure:
// returns the arguments plus the small text files drawtext reads.

import path from "node:path";
import { bandHeight } from "../stream/encoder";
import { beatExpression, type Music } from "./music";

export const OUT = { width: 1080, height: 1920, fps: 30 } as const;

export interface Clip {
  // One recording, or consecutive segments played back to back.
  sources: string[];
  seekSec: number;
  spanSec: number;
  speed: number;
  // Output seconds from the clip's start where the payoff lands.
  punchSec: number;
  // Small line at the top before the payoff; big catchphrase after it.
  teaser: string;
  phrase: string;
  stat: string | null;
}

export interface Source {
  width: number;
  height: number;
  hasAudio: boolean;
  // The stream's vote band is cut off the bottom.
  band: boolean;
  // Its lines of text: 3, or 4 with the bribe line (default 3).
  bandLines?: number;
  // Show the Jev extension's panel (top right of the broadcast) as "Jev's brain".
  panel: boolean;
}

export interface VideoPlan {
  clips: Clip[];
  source: Source;
  music: Music;
  font: string;
  outro: string[];
  out: string;
  // Where the drawtext files and concat lists go.
  workDir: string;
}

export const clipSeconds = (c: Clip) => c.spanSec / c.speed;

const escapePath = (file: string) => file.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
const even = (x: number) => Math.round(x / 2) * 2;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

// Greedy word wrap for a centered block of big text. drawtext can't wrap or
// center lines itself, so every line becomes its own drawtext.
export function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface Fit {
  maxSize: number;
  minSize: number;
  widthPx: number;
  heightPx: number;
  // Average uppercase glyph width in ems: ~0.75 for DejaVu Sans Bold, ~0.52 for Impact.
  charEm: number;
}

export const LINE_HEIGHT = 1.12;

// Biggest font size (px) at which the caption fits the box.
export function fitCaption(text: string, f: Fit): { size: number; lines: string[] } {
  const at = (size: number) => wrap(text, Math.max(1, Math.floor(f.widthPx / (size * f.charEm))));
  for (let size = f.maxSize; size > f.minSize; size -= 2) {
    const lines = at(size);
    const fits = lines.every((l) => l.length * size * f.charEm <= f.widthPx) && lines.length * size * LINE_HEIGHT <= f.heightPx;
    if (fits) return { size, lines };
  }
  return { size: f.minSize, lines: at(f.minSize) };
}

export const charEmFor = (font: string) => (/impact|anton|bebas|oswald/i.test(path.basename(font)) ? 0.52 : 0.75);

// Where things go on the 1080x1920 canvas, and what is cut from the source.
export function layout(s: Source) {
  const k = s.height / 720;
  const gameH = s.band ? s.height - bandHeight(s.height, s.bandLines) : s.height;
  // The extension's panel: 340x366 at the top right of a 720p page.
  const panel = { x: even(s.width - 353 * k), y: even(52 * k), w: even(340 * k), h: even(366 * k) };
  // With the panel shown, the game is everything left of it; without, a
  // centered square.
  const game = s.panel ? { x: 0, y: 0, w: even(panel.x - 7 * k), h: gameH } : { x: even((s.width - gameH) / 2), y: 0, w: gameH, h: gameH };
  const gameOut = { y: 430, h: even((game.h * OUT.width) / game.w) };
  const panelScale = 1.5 / k;
  const panelOut = { w: even(panel.w * panelScale), h: even(panel.h * panelScale), y: gameOut.y + gameOut.h + 96 };
  // Captions live above the game, below TikTok's top bar.
  const caption = { y: 160, h: gameOut.y - 16 - 160 };
  return { game, gameOut, panel, panelOut, caption, labelY: gameOut.y + gameOut.h + 40 };
}

interface TextFile {
  path: string;
  content: string;
}

export function renderArgs(plan: VideoPlan): { args: string[]; files: TextFile[]; durationSec: number } {
  const { clips, source, music, font } = plan;
  const L = layout(source);
  const files: TextFile[] = [];
  const textFile = (name: string, content: string) => {
    const p = path.join(plan.workDir, name);
    files.push({ path: p, content });
    return p;
  };
  const text = (file: string, o: { size: number | string; y: number; color?: string; border?: number; box?: boolean; enable?: string }) =>
    `drawtext=textfile='${escapePath(file)}':expansion=none:fontfile='${escapePath(font)}':fontsize=${o.size}:fontcolor=${o.color ?? "white"}` +
    `:borderw=${o.border ?? 6}:bordercolor=black:x=(w-text_w)/2:y=${Math.round(o.y)}` +
    `${o.box ? ":box=1:boxcolor=black@0.6:boxborderw=22" : ""}${o.enable ? `:enable='${o.enable}'` : ""}`;

  const inputs: string[] = [];
  const graph: string[] = [];
  const durations = clips.map(clipSeconds);
  const total = durations.reduce((a, b) => a + b, 0);

  clips.forEach((c, i) => {
    const dur = r3(durations[i]!);
    if (c.sources.length === 1) {
      inputs.push("-ss", String(r3(c.seekSec)), "-t", String(r3(c.spanSec)), "-i", c.sources[0]!);
    } else {
      const list = textFile(`clip${i}.ffconcat`, `ffconcat version 1.0\n${c.sources.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n")}\n`);
      inputs.push("-f", "concat", "-safe", "0", "-ss", String(r3(c.seekSec)), "-t", String(r3(c.spanSec)), "-i", list);
    }
    const punch = r3(c.punchSec);
    const { game: g, gameOut: go, panel: p, panelOut: po } = L;
    // Frames: normalized time and rate, cut to length.
    graph.push(`[${i}:v]setpts=(PTS-STARTPTS)/${c.speed},fps=${OUT.fps},trim=duration=${dur},setpts=PTS-STARTPTS,format=yuv420p,split=${source.panel ? 3 : 2}[s${i}a][s${i}b]${source.panel ? `[s${i}c]` : ""}`);
    // Backdrop: the game, blurred at low resolution (cheap) and darkened.
    graph.push(`[s${i}a]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=-2:480,crop=270:480,boxblur=12:2,scale=${OUT.width}:${OUT.height},eq=brightness=-0.22:saturation=1.4[bg${i}]`);
    // The game, and a 1.18x punch-in that takes over on the payoff.
    graph.push(`[s${i}b]crop=${g.w}:${g.h}:${g.x}:${g.y},split[f${i}a][f${i}b]`);
    graph.push(`[f${i}a]scale=${OUT.width}:${go.h}[g${i}a]`);
    graph.push(`[f${i}b]crop=iw/1.18:ih/1.18,scale=${OUT.width}:${go.h}[g${i}b]`);
    graph.push(`[bg${i}][g${i}a]overlay=0:${go.y}[o${i}a]`);
    graph.push(`[o${i}a][g${i}b]overlay=0:${go.y}:enable='gte(t,${punch})'[o${i}b]`);
    let last = `o${i}b`;
    if (source.panel) {
      graph.push(`[s${i}c]crop=${p.w}:${p.h}:${p.x}:${p.y},scale=${po.w}:${po.h}[p${i}]`);
      graph.push(`[${last}][p${i}]overlay=(W-w)/2:${po.y}[o${i}c]`);
      last = `o${i}c`;
    }
    // Words: the teaser until the payoff, then the catchphrase pops in
    // (1.3x size, settling over 0.2 s) with its stat line.
    const draws: string[] = [];
    const box = { widthPx: 980, charEm: charEmFor(font) };
    const teaser = fitCaption(c.teaser.toUpperCase(), { ...box, maxSize: 68, minSize: 40, heightPx: L.caption.h });
    teaser.lines.forEach((line, j) => {
      draws.push(text(textFile(`clip${i}-teaser${j}.txt`, line), { size: teaser.size, y: L.caption.y + j * Math.round(teaser.size * LINE_HEIGHT), border: 6, enable: `lt(t,${punch})` }));
    });
    const statH = c.stat ? 62 : 0;
    const cap = fitCaption(c.phrase.toUpperCase(), { ...box, maxSize: 100, minSize: 48, heightPx: L.caption.h - statH });
    const pop = (base: number) => `'${base}*(1+0.3*max(0,1-(t-${punch})/0.2))'`;
    const lineH = Math.round(cap.size * LINE_HEIGHT);
    cap.lines.forEach((line, j) => {
      draws.push(text(textFile(`clip${i}-line${j}.txt`, line), { size: pop(cap.size), y: L.caption.y + j * lineH, border: 8, enable: `gte(t,${punch})` }));
    });
    if (c.stat) {
      draws.push(text(textFile(`clip${i}-stat.txt`, c.stat), { size: 44, y: L.caption.y + cap.lines.length * lineH + 12, color: "0xffd84a", border: 5, enable: `gte(t,${punch})` }));
    }
    if (source.panel) draws.push(text(textFile(`clip${i}-label.txt`, "JEV'S BRAIN: LIVE AI DECISIONS"), { size: 34, y: L.labelY, color: "0x53e3a6", border: 4 }));
    // A white flash on every cut in.
    graph.push(`[${last}]${draws.join(",")},fade=t=in:st=0:d=0.22:color=white,setsar=1[v${i}]`);

    // Game audio under the music; sped-up clips get silence instead of chipmunks.
    const fmt = `aformat=sample_rates=48000:channel_layouts=stereo`;
    if (source.hasAudio && c.speed === 1) graph.push(`[${i}:a]asetpts=PTS-STARTPTS,${fmt},apad,atrim=0:${dur},volume=0.35[a${i}]`);
    else graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${dur},${fmt}[a${i}]`);
  });

  graph.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${clips.length}:v=1:a=1[vc][ac]`);
  // The call to action over the last seconds.
  const outroFrom = r3(Math.max(0, total - 2.5));
  const outro = plan.outro.map((line, j) =>
    text(textFile(`outro${j}.txt`, line), { size: j === 0 ? 64 : 48, y: L.gameOut.y + L.gameOut.h / 2 - 60 + j * 96, color: j === 0 ? "white" : "0x53e3a6", border: 6, box: true, enable: `gte(t,${outroFrom})` }),
  );
  graph.push(`[vc]${outro.length > 0 ? outro.join(",") : "null"}[vout]`);

  // Soundtrack, faded at both ends, over the ducked game audio.
  const m = clips.length;
  if (music.file) inputs.push("-stream_loop", "-1", "-ss", String(r3(music.startSec)), "-i", music.file);
  else inputs.push("-f", "lavfi", "-i", `aevalsrc='${beatExpression(music.bpm)}':s=48000:c=stereo:d=${r3(total + 1)}`);
  graph.push(
    `[${m}:a]atrim=0:${r3(total)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=0.3,afade=t=out:st=${r3(Math.max(0, total - 1.5))}:d=1.5[music]`,
  );
  graph.push(`[ac][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9[aout]`);

  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    ...inputs,
    "-filter_complex", graph.join(";\n"),
    "-map", "[vout]",
    "-map", "[aout]",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-r", String(OUT.fps),
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-movflags", "+faststart",
    "-t", String(r3(total)),
    plan.out,
  ];
  return { args, files, durationSec: total };
}
