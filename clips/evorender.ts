// One ffmpeg run per evolution clip (clips/evolution.ts), 1080x1920:
//
//   1. the lab on camera, sped up: Claude Code rewriting Jev's brain;
//   2. the change: its title and the diff;
//   3. the scoreboard: the build before vs the change, measured on real games
//      (or "now testing" for a fresh change);
//   4. gameplay: a moment on the old build over one on the new build;
//   5. the call to action over the last seconds.
//
// Missing footage drops its section. Pure: returns the arguments plus the
// text files drawtext reads.

import path from "node:path";
import { beatExpression, type Music } from "../tiktok/music";
import { charEmFor, fitCaption, layout, LINE_HEIGHT, OUT, type Source } from "../tiktok/render";
import type { DiffLine } from "./evolution";
import type { BuildStats } from "./metadata";

export interface Footage {
  sources: string[];
  seekSec: number;
  spanSec: number;
  speed: number;
}

export interface EvolutionPlan {
  // Big hook over the lab footage.
  hook: string;
  // Small line under it ("12 MINUTES IN 6 SECONDS").
  hookSub: string;
  lab: (Footage & { source: Source }) | null;
  changeLabel: string;
  title: string;
  files: string[];
  diff: DiffLine[];
  stage: "proposed" | "verdict";
  verdict: "kept" | "dropped" | null;
  before: BuildStats | null;
  after: BuildStats | null;
  // Games the change still needs before it's judged.
  testing: number;
  beforeClip: (Footage & { source: Source; label: string }) | null;
  afterClip: (Footage & { source: Source; label: string }) | null;
  outro: string[];
  music: Music;
  font: string;
  mono: string;
  out: string;
  workDir: string;
}

const SECTION = { lab: 6, diff: 6, score: 5, versus: 8 } as const;
const COLORS = { bg: "0x0b0f14", green: "0x53e3a6", red: "0xff5d6c", yellow: "0xffd84a", dim: "0x8b949e", white: "white" } as const;

const escapePath = (file: string) => file.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

export function scoreRows(before: BuildStats | null, after: BuildStats | null): [string, string, string][] {
  const v = (b: BuildStats | null, f: (b: BuildStats) => string) => (b ? f(b) : "-");
  return [
    ["GAMES", v(before, (b) => String(b.games)), v(after, (b) => String(b.games))],
    ["WINS", v(before, (b) => String(b.wins)), v(after, (b) => String(b.wins))],
    ["AVG PLACE", v(before, (b) => (b.meanPlacement === null ? "-" : `#${Math.round(b.meanPlacement)}`)), v(after, (b) => (b.meanPlacement === null ? "-" : `#${Math.round(b.meanPlacement)}`))],
    ["MIN ALIVE", v(before, (b) => String(b.medianMinutes)), v(after, (b) => String(b.medianMinutes))],
    ["PEAK LAND", v(before, (b) => pct(b.meanPeakShare)), v(after, (b) => pct(b.meanPeakShare))],
  ];
}

// The terminal on the lab page: 900x575 at (368, 40) of a 720p broadcast.
export function labTerminal(s: Pick<Source, "width" | "height">) {
  const k = s.height / 720;
  const even = (x: number) => Math.round(x / 2) * 2;
  return { x: even(368 * k), y: even(40 * k), w: even(Math.min(900 * k, s.width - 368 * k)), h: even(575 * k) };
}

export function evolutionDuration(p: Pick<EvolutionPlan, "lab" | "beforeClip" | "afterClip">): number {
  return (p.lab ? SECTION.lab : 0) + SECTION.diff + SECTION.score + (p.beforeClip || p.afterClip ? SECTION.versus : 0);
}

export function renderEvolutionArgs(p: EvolutionPlan): { args: string[]; files: { path: string; content: string }[]; durationSec: number } {
  const files: { path: string; content: string }[] = [];
  const textFile = (name: string, content: string) => {
    const f = path.join(p.workDir, name);
    files.push({ path: f, content });
    return f;
  };
  const text = (file: string, o: { size: number; y: number; x?: string; color?: string; border?: number; font?: string; box?: boolean; enable?: string }) =>
    `drawtext=textfile='${escapePath(file)}':expansion=none:fontfile='${escapePath(o.font ?? p.font)}':fontsize=${o.size}:fontcolor=${o.color ?? "white"}` +
    `:borderw=${o.border ?? 0}:bordercolor=black:x=${o.x ?? "(w-text_w)/2"}:y=${Math.round(o.y)}` +
    `${o.box ? ":box=1:boxcolor=black@0.6:boxborderw=20" : ""}${o.enable ? `:enable='${o.enable}'` : ""}`;
  const charEm = charEmFor(p.font);
  let n = 0;
  const bigText = (name: string, s: string, o: { y: number; maxSize: number; minSize: number; heightPx: number; color?: string; border?: number; enable?: string }) => {
    const fit = fitCaption(s.toUpperCase(), { maxSize: o.maxSize, minSize: o.minSize, widthPx: 980, heightPx: o.heightPx, charEm });
    const lh = Math.round(fit.size * LINE_HEIGHT);
    return {
      h: fit.lines.length * lh,
      draws: fit.lines.map((l, j) => text(textFile(`${name}${n++}.txt`, l), { size: fit.size, y: o.y + j * lh, color: o.color, border: o.border ?? 6, enable: o.enable })),
    };
  };

  const inputs: string[] = [];
  const graph: string[] = [];
  const parts: string[] = [];
  let input = 0;
  const addFootage = (f: Footage, name: string): number => {
    if (f.sources.length === 1) inputs.push("-ss", String(r3(f.seekSec)), "-t", String(r3(f.spanSec)), "-i", f.sources[0]!);
    else {
      const list = textFile(`${name}.ffconcat`, `ffconcat version 1.0\n${f.sources.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n")}\n`);
      inputs.push("-f", "concat", "-safe", "0", "-ss", String(r3(f.seekSec)), "-t", String(r3(f.spanSec)), "-i", list);
    }
    return input++;
  };
  const addCard = (dur: number): number => {
    inputs.push("-f", "lavfi", "-i", `color=c=${COLORS.bg}:s=${OUT.width}x${OUT.height}:r=${OUT.fps}:d=${dur}`);
    return input++;
  };

  // 1. The lab, sped up to fit.
  if (p.lab) {
    const i = addFootage(p.lab, "lab");
    const src = p.lab.source;
    const h = layout(src).game.h;
    graph.push(`[${i}:v]setpts=(PTS-STARTPTS)/${p.lab.speed},fps=${OUT.fps},trim=duration=${SECTION.lab},setpts=PTS-STARTPTS,format=yuv420p,crop=${src.width}:${h}:0:0,split[lab0][lab1]`);
    graph.push(`[lab0]scale=-2:480,crop=270:480,boxblur=12:2,scale=${OUT.width}:${OUT.height},eq=brightness=-0.3[labbg]`);
    // The lab page's terminal (stream/studio.ts), where Claude Code's reads,
    // diffs and test runs scroll by, fills the width.
    const t = labTerminal(src);
    const outH = Math.round((t.h * OUT.width) / t.w / 2) * 2;
    graph.push(`[lab1]crop=${t.w}:${t.h}:${t.x}:${t.y},scale=${OUT.width}:${outH}[labfg]`);
    const hook = bigText("hook", p.hook, { y: 170, maxSize: 96, minSize: 56, heightPx: 330 });
    const sub = text(textFile("hooksub.txt", p.hookSub.toUpperCase()), { size: 44, y: 170 + hook.h + 20, color: COLORS.yellow, border: 5 });
    graph.push(`[labbg][labfg]overlay=0:${Math.max(560, 170 + hook.h + 110)}[labo]`);
    graph.push(`[labo]${[...hook.draws, sub].join(",")},fade=t=in:st=0:d=0.2:color=white,setsar=1[p${parts.length}]`);
    parts.push(`[p${parts.length}]`);
  }

  // 2. The change.
  {
    const i = addCard(SECTION.diff);
    const draws: string[] = [];
    draws.push(text(textFile("label.txt", p.changeLabel.toUpperCase()), { size: 46, y: 170, color: COLORS.green, border: 0 }));
    const t = bigText("title", `"${p.title}"`, { y: 250, maxSize: 92, minSize: 52, heightPx: 420 });
    draws.push(...t.draws);
    let y = 250 + t.h + 40;
    const fileLine = p.files.slice(0, 3).join("  ") + (p.files.length > 3 ? `  +${p.files.length - 3}` : "");
    draws.push(text(textFile("files.txt", fileLine), { size: 28, y, color: COLORS.dim, font: p.mono }));
    y += 64;
    const color = { file: COLORS.yellow, hunk: COLORS.dim, add: COLORS.green, del: COLORS.red, ctx: "0xc9d1d9" } as const;
    const lineH = 44;
    const maxLines = Math.floor((1880 - 260 - y) / lineH);
    p.diff.slice(0, maxLines).forEach((l, j) => {
      draws.push(text(textFile(`diff${j}.txt`, l.text), { size: 32, y: y + j * lineH, x: "50", color: color[l.kind], font: p.mono }));
    });
    graph.push(`[${i}:v]format=yuv420p,${draws.join(",")},fade=t=in:st=0:d=0.2:color=white,setsar=1[p${parts.length}]`);
    parts.push(`[p${parts.length}]`);
  }

  // 3. The scoreboard.
  {
    const i = addCard(SECTION.score);
    const draws: string[] = [];
    const head = p.stage === "verdict" ? "MEASURED ON REAL GAMES" : "THE BUILD IT REPLACES";
    draws.push(text(textFile("scorehead.txt", head), { size: 54, y: 190, color: COLORS.white, border: 0 }));
    const rows = scoreRows(p.before, p.stage === "verdict" ? p.after : null);
    const colX = { label: 70, before: 560, after: 830 };
    const top = 330;
    draws.push(text(textFile("colb.txt", "BEFORE"), { size: 40, y: top, x: String(colX.before), color: COLORS.dim }));
    if (p.stage === "verdict") draws.push(text(textFile("cola.txt", "AFTER"), { size: 40, y: top, x: String(colX.after), color: COLORS.dim }));
    rows.forEach(([k, b, a], j) => {
      const y = top + 90 + j * 110;
      draws.push(text(textFile(`rk${j}.txt`, k), { size: 50, y, x: String(colX.label), color: COLORS.dim }));
      draws.push(text(textFile(`rb${j}.txt`, b), { size: 64, y: y - 6, x: String(colX.before) }));
      if (p.stage === "verdict") draws.push(text(textFile(`ra${j}.txt`, a), { size: 64, y: y - 6, x: String(colX.after), color: COLORS.yellow }));
    });
    const stampY = top + 90 + rows.length * 110 + 60;
    // The verdict stamps in with a pop a beat after the numbers.
    const stamp = p.stage === "proposed" ? ["NOW TESTING", `ON THE NEXT ${p.testing} GAMES`] : p.verdict === "kept" ? ["IT GOT BETTER", "KEPT AS THE NEW BRAIN"] : ["IT DIDN'T HELP", "DROPPED"];
    const stampColor = p.stage === "proposed" ? COLORS.yellow : p.verdict === "kept" ? COLORS.green : COLORS.red;
    const at = 1.2;
    draws.push(`${text(textFile("stamp0.txt", stamp[0]!), { size: 120, y: stampY, color: stampColor, border: 8, enable: `gte(t,${at})` }).replace(/fontsize=120/, `fontsize='120*(1+0.35*max(0,1-(t-${at})/0.2))'`)}`);
    draws.push(text(textFile("stamp1.txt", stamp[1]!), { size: 52, y: stampY + 150, color: COLORS.white, border: 5, enable: `gte(t,${at})` }));
    graph.push(`[${i}:v]format=yuv420p,${draws.join(",")},fade=t=in:st=0:d=0.2:color=white,setsar=1[p${parts.length}]`);
    parts.push(`[p${parts.length}]`);
  }

  // 4. Old brain over new brain.
  const clips = [p.beforeClip, p.afterClip].filter((c): c is NonNullable<typeof c> => c !== null);
  if (clips.length > 0) {
    const bg = addCard(SECTION.versus);
    const w = 960;
    let last = `${bg}:v`;
    const draws: string[] = [];
    clips.forEach((c, k) => {
      const i = addFootage(c, `vs${k}`);
      const g = layout(c.source).game;
      const h = Math.round((g.h * w) / g.w / 2) * 2;
      const y = clips.length === 1 ? 560 : k === 0 ? 250 : 250 + h + 110;
      graph.push(`[${i}:v]setpts=(PTS-STARTPTS)/${c.speed},fps=${OUT.fps},trim=duration=${SECTION.versus},setpts=PTS-STARTPTS,format=yuv420p,crop=${g.w}:${g.h}:${g.x}:${g.y},scale=${w}:${h}[vs${k}]`);
      graph.push(`[${last}][vs${k}]overlay=${(OUT.width - w) / 2}:${y}[vso${k}]`);
      last = `vso${k}`;
      draws.push(text(textFile(`vsl${k}.txt`, c.label.toUpperCase()), { size: 46, y: y - 62, color: k === 0 && clips.length === 2 ? COLORS.dim : COLORS.green, border: 4 }));
    });
    draws.push(...bigText("vshead", clips.length === 2 ? "OLD BRAIN VS NEW BRAIN" : "THE OLD BRAIN IN ACTION", { y: 110, maxSize: 64, minSize: 44, heightPx: 80 }).draws);
    graph.push(`[${last}]format=yuv420p,${draws.join(",")},fade=t=in:st=0:d=0.2:color=white,setsar=1[p${parts.length}]`);
    parts.push(`[p${parts.length}]`);
  }

  const total = evolutionDuration(p);
  graph.push(`${parts.join("")}concat=n=${parts.length}:v=1:a=0[vc]`);
  const outroFrom = r3(Math.max(0, total - 2.5));
  const outro = p.outro.map((line, j) => text(textFile(`outro${j}.txt`, line), { size: j === 0 ? 64 : 48, y: 1480 + j * 96, color: j === 0 ? "white" : COLORS.green, border: 6, box: true, enable: `gte(t,${outroFrom})` }));
  graph.push(`[vc]${outro.length ? outro.join(",") : "null"}[vout]`);

  const m = input;
  if (p.music.file) inputs.push("-stream_loop", "-1", "-ss", String(r3(p.music.startSec)), "-i", p.music.file);
  else inputs.push("-f", "lavfi", "-i", `aevalsrc='${beatExpression(p.music.bpm)}':s=48000:c=stereo:d=${r3(total + 1)}`);
  graph.push(`[${m}:a]atrim=0:${r3(total)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.8,afade=t=in:d=0.3,afade=t=out:st=${r3(Math.max(0, total - 1.5))}:d=1.5,alimiter=limit=0.9[aout]`);

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    ...inputs,
    "-filter_complex", graph.join(";\n"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(OUT.fps),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart",
    "-t", String(r3(total)),
    p.out,
  ];
  return { args, files, durationSec: total };
}
