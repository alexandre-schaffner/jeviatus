// Rolling recording of the broadcast, for TikTok clips (tiktok/README.md).
// ffmpeg writes the same encode it sends to Kick into fixed-length Matroska
// segments named by their UTC start time, so a game's ticks map to a file
// and an offset without any bookkeeping. Old segments are pruned.

import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

// strftime pattern for ffmpeg's segment muxer (run it with TZ=UTC).
export const SEGMENT_PATTERN = "%Y%m%dT%H%M%SZ.mkv";

export interface Segment {
  file: string;
  startMs: number;
}

// "20260926T201500Z.mkv" -> 2026-09-26T20:15:00Z
export function segmentStart(name: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.mkv$/.exec(path.basename(name));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
}

export function listSegments(dir: string): Segment[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ file: path.join(dir, name), startMs: segmentStart(name) }))
    .filter((s): s is Segment => s.startMs !== null)
    .sort((a, b) => a.startMs - b.startMs);
}

// The segments that cover [fromMs, toMs), in order, and where `fromMs` falls
// in the first one. Segments are back to back, so the one covering a moment
// is the last that started before it.
export function segmentsCovering(segments: Segment[], fromMs: number, toMs: number): { files: string[]; offsetSec: number } | null {
  const first = segments.findLastIndex((s) => s.startMs <= fromMs);
  if (first < 0) return null;
  const files: string[] = [];
  for (let i = first; i < segments.length && (i === first || segments[i]!.startMs < toMs); i++) files.push(segments[i]!.file);
  return { files, offsetSec: (fromMs - segments[first]!.startMs) / 1000 };
}

// Deletes segments that started more than `keepHours` ago. The newest one is
// the file ffmpeg is writing, so it is never touched.
export function pruneSegments(dir: string, keepHours: number, now = Date.now()): string[] {
  const segments = listSegments(dir);
  const cutoff = now - keepHours * 3_600_000;
  const doomed = segments.slice(0, -1).filter((s) => s.startMs < cutoff);
  for (const s of doomed) rmSync(s.file, { force: true });
  return doomed.map((s) => s.file);
}
