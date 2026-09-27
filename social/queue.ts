// The posting queue: every rendered clip (clips/<date>/<id>.mp4 plus its
// sidecar <id>.json) crossed with every platform, minus what the posted log
// says is done, paced by per-platform limits. Pure, apart from the two
// loaders at the bottom.

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ClipKind, Sidecar } from "../clips/metadata";

export const PLATFORMS = ["youtube", "x", "instagram", "tiktok", "reddit"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface QueueItem {
  id: string;
  kind: ClipKind;
  video: string;
  sidecarFile: string;
  createdAt: string;
  meta: Sidecar;
}

export interface PostedEntry {
  id: string;
  platform: Platform;
  at: string;
  url: string | null;
  remoteId: string | null;
  // Reddit: where it went.
  subreddit?: string;
}

export interface Limits {
  // Posts in any rolling 24 hours.
  perDay: number;
  // Minutes between two posts.
  minGapMin: number;
}

// Conservative on purpose: a new account posting a lot looks like spam
// everywhere, and each platform has its own hard caps on top (see README).
export const LIMITS: Record<Platform, Limits> = {
  youtube: { perDay: 3, minGapMin: 180 },
  x: { perDay: 4, minGapMin: 120 },
  instagram: { perDay: 2, minGapMin: 300 },
  // Inbox uploads: TikTok keeps at most 5 pending per 24 h.
  tiktok: { perDay: 3, minGapMin: 180 },
  // One post a day across Reddit, and each subreddit far less (below).
  reddit: { perDay: 1, minGapMin: 1440 },
};

// Days between two posts in the same subreddit (their self-promo rules).
export const SUBREDDIT_GAP_DAYS: Record<string, number> = { Openfront: 3, StrategyGames: 7, artificial: 14, ClaudeAI: 7, Kick: 7, territorial_io: 7 };
const DEFAULT_SUB_GAP_DAYS = 7;

// What goes first: the evolution (nobody else has it), then compilations,
// whole-game highlights, single moments. Newest first within a kind.
const PRIORITY: Record<ClipKind, number> = { evolution: 0, compilation: 1, highlight: 2, moment: 3 };

export const postedKey = (id: string, platform: Platform) => `${platform}:${id}`;

// The game (or change) a clip comes from, so a platform doesn't get two
// clips of the same game back to back.
export function sourceOf(id: string): string {
  const m = /^(?:game|moment)-([^-]+)/.exec(id) ?? /^evo-([0-9a-f]+)-/.exec(id);
  return m ? m[1]! : id;
}

export interface PlannedPost {
  platform: Platform;
  item: QueueItem;
  // Reddit: the subreddit chosen (the sidecar's pick, or an alternative whose gap allows it).
  subreddit?: string;
  title?: string;
}

// The posts to make now: for each platform, as many as its limits allow,
// skipping clips already posted there. `maxPerPlatform` caps one run.
export function planPosts(queue: QueueItem[], posted: PostedEntry[], opts: { now: number; platforms: readonly Platform[]; limits?: Record<Platform, Limits>; maxPerPlatform?: number }): PlannedPost[] {
  const limits = opts.limits ?? LIMITS;
  const done = new Set(posted.map((p) => postedKey(p.id, p.platform)));
  const ordered = [...queue].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const out: PlannedPost[] = [];
  for (const platform of opts.platforms) {
    const history = posted.filter((p) => p.platform === platform).map((p) => ({ ...p, ms: Date.parse(p.at) }));
    const lim = limits[platform];
    let times = history.map((h) => h.ms);
    const recentSources = new Set(history.filter((h) => opts.now - h.ms < 24 * 3_600_000).map((h) => sourceOf(h.id)));
    let made = 0;
    for (const item of ordered) {
      if (made >= (opts.maxPerPlatform ?? Infinity)) break;
      if (done.has(postedKey(item.id, platform))) continue;
      // Planned posts in this run count as if made now.
      const inDay = times.filter((t) => opts.now - t < 24 * 3_600_000).length;
      const last = Math.max(-Infinity, ...times);
      if (inDay >= lim.perDay || opts.now - last < lim.minGapMin * 60_000) break;
      if (recentSources.has(sourceOf(item.id))) continue;
      let sub: { subreddit: string; title: string } | undefined;
      if (platform === "reddit") {
        const r = item.meta.platforms.reddit;
        const options = [{ subreddit: r.subreddit, title: r.title }, ...r.alternatives.map((a) => ({ subreddit: a.subreddit, title: a.title }))];
        sub = options.find((o) => {
          const lastThere = Math.max(-Infinity, ...history.filter((h) => h.subreddit === o.subreddit).map((h) => h.ms));
          return opts.now - lastThere >= (SUBREDDIT_GAP_DAYS[o.subreddit] ?? DEFAULT_SUB_GAP_DAYS) * 86_400_000;
        });
        if (!sub) continue;
      }
      out.push({ platform, item, ...(sub ?? {}) });
      times = [...times, opts.now];
      recentSources.add(sourceOf(item.id));
      made++;
      // The gap applies within a run too: one post per platform per run
      // unless the gap is zero.
      if (lim.minGapMin > 0) break;
    }
  }
  return out;
}

// --- loaders ----------------------------------------------------------------------------

// Every clip with a sidecar under the clips root (one folder per day).
export function loadQueue(root: string): QueueItem[] {
  const out: QueueItem[] = [];
  if (!existsSync(root)) return out;
  for (const day of readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()) {
    const dir = path.join(root, day);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      try {
        const meta = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Sidecar;
        const video = path.join(dir, meta.video);
        if (!meta.platforms || !existsSync(video)) continue;
        out.push({ id: meta.id, kind: meta.kind, video, sidecarFile: path.join(dir, f), createdAt: meta.createdAt, meta });
      } catch {
        // half-written sidecar
      }
    }
  }
  return out;
}

export function loadPosted(file: string): PostedEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as PostedEntry];
      } catch {
        return [];
      }
    });
}

export function appendPosted(file: string, e: PostedEntry): void {
  appendFileSync(file, `${JSON.stringify(e)}\n`);
}
