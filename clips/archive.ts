// Keeping the footage: the stream deletes its segments after a few hours, so
// every finished segment is hard-linked into the clips archive (same disk, no
// copy; a copy where links don't work). The archive has its own size cap.

import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { listSegments } from "../stream/recordings";
import { ffmpegBin } from "../tiktok/make";

// Links every segment but the newest (the one ffmpeg is still writing).
export function archiveSegments(from: string, to: string): string[] {
  mkdirSync(to, { recursive: true });
  const added: string[] = [];
  for (const s of listSegments(from).slice(0, -1)) {
    const dest = path.join(to, path.basename(s.file));
    if (existsSync(dest)) continue;
    try {
      linkSync(s.file, dest);
    } catch {
      try {
        copyFileSync(s.file, dest);
      } catch {
        continue; // pruned under us
      }
    }
    added.push(dest);
  }
  return added;
}

// Oldest segments beyond the cap go first.
export function pruneArchive(dir: string, maxBytes: number): string[] {
  const segs = listSegments(dir).map((s) => ({ ...s, size: statSync(s.file).size }));
  let total = segs.reduce((a, s) => a + s.size, 0);
  const removed: string[] = [];
  for (const s of segs) {
    if (total <= maxBytes) break;
    rmSync(s.file, { force: true });
    total -= s.size;
    removed.push(s.file);
  }
  return removed;
}

// Seconds of [start, start+span) where the picture doesn't move at all. The
// stream's screencast sometimes stalls on one frame while the band keeps
// updating: that footage is useless. Only the game area is checked.
export function frozenSeconds(stderr: string, spanSec: number): number {
  let total = 0;
  let open: number | null = null;
  for (const m of stderr.matchAll(/freeze_(start|end): ([\d.]+)/g)) {
    const t = Number(m[2]);
    if (m[1] === "start") open = t;
    else if (open !== null) {
      total += t - open;
      open = null;
    }
  }
  if (open !== null) total += Math.max(0, spanSec - open);
  return total;
}

export const concatList = (files: string[]) => `ffconcat version 1.0\n${files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n")}\n`;

export async function isFrozen(sources: string[], seekSec: number, spanSec: number, workFile: string): Promise<boolean> {
  const concat = sources.length > 1;
  if (concat) await Bun.write(workFile, concatList(sources));
  const args = [
    "-hide_banner", "-nostats",
    ...(concat ? ["-f", "concat", "-safe", "0"] : []),
    "-ss", String(seekSec), "-t", String(spanSec),
    "-i", concat ? workFile : sources[0]!,
    "-an", "-vf", "crop=iw*0.7:ih*0.85:0:0,scale=320:-2,freezedetect=n=-60dB:d=2",
    "-f", "null", "-",
  ];
  const p = Bun.spawn(["nice", "-n", "19", ffmpegBin(), ...args], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(p.stderr).text();
  await p.exited;
  if (concat) rmSync(workFile, { force: true });
  return frozenSeconds(stderr, spanSec) > spanSec * 0.4;
}
