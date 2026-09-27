// Posts the clip queue to social platforms (social/README.md).
//
//   bun run social:post --dry-run           what would be posted now, nothing sent
//   bun run social:post                     post what the limits allow now
//   bun run social:post --clip <id> --platforms x --dry-run
//
//   --clips <dir>        clips root (default: <data>/clips, as in clips/cli.ts)
//   --platforms <list>   comma-separated (default: every platform with credentials)
//   --clip <id>          just this clip (ignores pacing, never re-posts)
//   --env-from <file>    read the social keys (X_, REDDIT_, YOUTUBE_, IG_,
//                        TIKTOK_, SOCIAL_ prefixes only) from this .env
//   --dry-run            print the requests' content; no network, no log
//
// Posted clips are appended to <clips>/social-posted.jsonl, which is how a
// clip is never posted twice to a platform. Run it every hour or so (cron or
// launchd); per-platform pacing lives in social/queue.ts.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { type Env, missingEnv, type Poster, TokenStore } from "./common";
import { instagram } from "./instagram";
import { appendPosted, loadPosted, loadQueue, type Platform, PLATFORMS, type PlannedPost, planPosts } from "./queue";
import { reddit } from "./reddit";
import { tiktok } from "./tiktok";
import { x } from "./x";
import { youtube } from "./youtube";

export const POSTERS: Record<Platform, Poster> = { youtube, x, instagram, tiktok, reddit };

const SOCIAL_KEY = /^(X_|REDDIT_|YOUTUBE_|IG_|TIKTOK_|SOCIAL_)[A-Z0-9_]*$/;

export function socialEnvFrom(text: string): Env {
  const out: Env = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && SOCIAL_KEY.test(m[1]!)) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      clips: { type: "string" },
      platforms: { type: "string" },
      clip: { type: "string" },
      "env-from": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const home = process.env.HOME ?? "";
  const data = process.env.STREAM_DATA_DIR ?? (process.platform === "darwin" ? path.join(home, "Library/Application Support/jeviatus") : "/data");
  const root = values.clips ?? path.join(data, "clips");
  const env: Env = { ...process.env, ...(values["env-from"] && existsSync(values["env-from"]) ? socialEnvFrom(readFileSync(values["env-from"], "utf8")) : {}) };
  const dry = values["dry-run"];

  const asked = values.platforms ? (values.platforms.split(",").map((s) => s.trim()) as Platform[]) : [...PLATFORMS];
  for (const p of asked) if (!PLATFORMS.includes(p)) throw new Error(`unknown platform ${p} (one of ${PLATFORMS.join(", ")})`);
  const ready = asked.filter((p) => {
    const missing = missingEnv(POSTERS[p], env);
    if (missing.length) log(`[${p}] ${dry ? "would skip (no credentials yet)" : "skipped"}: set ${missing.join(", ")}`);
    return missing.length === 0 || dry;
  });

  const postedFile = path.join(root, "social-posted.jsonl");
  const posted = loadPosted(postedFile);
  let queue = loadQueue(root);
  log(`${queue.length} clip(s) in ${root}, ${posted.length} post(s) logged`);
  let plan: PlannedPost[];
  if (values.clip) {
    queue = queue.filter((q) => q.id === values.clip || q.video === values.clip);
    if (queue.length === 0) throw new Error(`no clip ${values.clip}`);
    const done = new Set(posted.map((p) => `${p.platform}:${p.id}`));
    plan = ready.filter((p) => !done.has(`${p}:${queue[0]!.id}`)).map((platform) => ({ platform, item: queue[0]! }));
  } else plan = planPosts(queue, posted, { now: Date.now(), platforms: ready });
  if (plan.length === 0) log("nothing to post right now (pacing, or everything is posted)");

  const workDir = path.join(root, ".social");
  mkdirSync(workDir, { recursive: true });
  const tokens = new TokenStore(path.join(root, ".social-tokens.json"));
  let failures = 0;
  for (const p of plan) {
    const poster = POSTERS[p.platform];
    if (dry) {
      log(`[${p.platform}] would post ${p.item.id}:\n${JSON.stringify(poster.preview(p, env), null, 2)}`);
      continue;
    }
    try {
      const r = await poster.post(p, { env, log, tokens, workDir });
      appendPosted(postedFile, { id: p.item.id, platform: p.platform, at: new Date().toISOString(), url: r.url, remoteId: r.remoteId, ...(p.subreddit ? { subreddit: p.subreddit } : {}) });
      log(`[${p.platform}] posted ${p.item.id}${r.url ? ` -> ${r.url}` : ""}`);
    } catch (err) {
      failures++;
      log(`[${p.platform}] ${p.item.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.exit(failures > 0 ? 1 : 0);
}
