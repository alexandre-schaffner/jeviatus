// Reddit: a native video post, the way PRAW does it (the media endpoints
// aren't in Reddit's public docs):
//   POST www.reddit.com/api/v1/access_token        script app, password grant
//   POST oauth.reddit.com/api/media/asset.json     filepath, mimetype -> an S3 upload lease
//   POST https:<lease.action>                      the lease's fields + file
//   (the same for a poster frame)
//   POST oauth.reddit.com/api/submit               kind=video, url, video_poster_url, sr, title, flair
//   then the returned websocket says when the video is processed.
// Since late 2025 Reddit's Responsible Builder Policy requires approval for
// every new API client, personal scripts included: request access first
// (social/README.md). Until then post the sidecar's title by hand.

import path from "node:path";
import { ffmpegBin } from "../tiktok/make";
import { type Env, form, http, json, type Poster, type PostContext } from "./common";
import type { PlannedPost } from "./queue";

const userAgent = (env: Env) => env.REDDIT_USER_AGENT ?? `macos:jeviatus-clips:0.1 (by /u/${env.REDDIT_USERNAME ?? "unknown"})`;

export function redditSubmission(p: PlannedPost) {
  const r = p.item.meta.platforms.reddit;
  const sub = p.subreddit ?? r.subreddit;
  const chosen = sub === r.subreddit ? r : r.alternatives.find((a) => a.subreddit === sub) ?? r;
  return { sr: sub, title: (p.title ?? chosen.title).slice(0, 300), flair: chosen.flair, rules: chosen.rules };
}

async function token(env: Env): Promise<string> {
  const basic = Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString("base64");
  const t = await json<{ access_token?: string; error?: string }>("reddit token", "https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent(env) },
    body: form({ grant_type: "password", username: env.REDDIT_USERNAME!, password: env.REDDIT_PASSWORD! }),
  });
  if (!t.access_token) throw new Error(`reddit token: ${t.error ?? "no access_token"} (is the app approved? 2FA must be off for the password grant)`);
  return t.access_token;
}

// Uploads a file to Reddit's media bucket; returns its URL.
async function upload(file: string, mimetype: string, headers: Record<string, string>): Promise<string> {
  const lease = await json<{ args?: { action: string; fields: { name: string; value: string }[] } }>("reddit media lease", "https://oauth.reddit.com/api/media/asset.json", {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: form({ filepath: path.basename(file), mimetype }),
  });
  if (!lease.args) throw new Error("reddit media lease: no upload args");
  const action = lease.args.action.startsWith("//") ? `https:${lease.args.action}` : lease.args.action;
  const body = new FormData();
  for (const f of lease.args.fields) body.append(f.name, f.value);
  body.append("file", Bun.file(file), path.basename(file));
  await http("reddit media upload", action, { method: "POST", body, expect: [200, 201, 204] });
  const key = lease.args.fields.find((f) => f.name === "key")?.value;
  if (!key) throw new Error("reddit media lease: no key");
  return `${action}/${key}`;
}

async function posterFrame(video: string, ctx: PostContext): Promise<string> {
  const out = path.join(ctx.workDir, `${path.basename(video, ".mp4")}-poster.jpg`);
  const p = Bun.spawn(["nice", "-n", "19", ffmpegBin(), "-v", "error", "-y", "-ss", "3", "-i", video, "-frames:v", "1", "-q:v", "3", out], { stdout: "ignore", stderr: "inherit" });
  if ((await p.exited) !== 0) throw new Error("reddit: couldn't extract a poster frame");
  return out;
}

async function flairId(sr: string, text: string | null, headers: Record<string, string>): Promise<string | null> {
  if (!text) return null;
  try {
    const flairs = await json<{ id: string; text: string }[]>("reddit flairs", `https://oauth.reddit.com/r/${sr}/api/link_flair_v2`, { headers });
    return flairs.find((f) => f.text.toLowerCase() === text.toLowerCase())?.id ?? null;
  } catch {
    return null;
  }
}

// The post's URL once Reddit has processed the video (or null after 2 minutes).
async function awaitProcessed(ws: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(ws);
    const done = (url: string | null) => {
      clearTimeout(timer);
      socket.close();
      resolve(url);
    };
    const timer = setTimeout(() => done(null), 120_000);
    socket.onmessage = (m) => {
      try {
        const e = JSON.parse(String(m.data)) as { type?: string; payload?: { redirect?: string } };
        if (e.type === "success") done(e.payload?.redirect ?? null);
        else if (e.type === "failed") done(null);
      } catch {
        // ignore
      }
    };
    socket.onerror = () => done(null);
  });
}

export const reddit: Poster = {
  platform: "reddit",
  required: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USERNAME", "REDDIT_PASSWORD"],
  preview: (p, env) => ({ endpoint: "https://oauth.reddit.com/api/submit", kind: "video", ...redditSubmission(p), video: p.item.video, userAgent: userAgent(env) }),
  async post(p, ctx) {
    const s = redditSubmission(p);
    const headers = { Authorization: `Bearer ${await token(ctx.env)}`, "user-agent": userAgent(ctx.env) };
    const videoUrl = await upload(p.item.video, "video/mp4", headers);
    const posterUrl = await upload(await posterFrame(p.item.video, ctx), "image/jpeg", headers);
    const flair = await flairId(s.sr, s.flair, headers);
    const res = await json<{ json?: { errors?: unknown[][]; data?: { websocket_url?: string; url?: string } } }>("reddit submit", "https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: form({ api_type: "json", sr: s.sr, title: s.title, kind: "video", url: videoUrl, video_poster_url: posterUrl, sendreplies: "true", resubmit: "true", ...(flair ? { flair_id: flair } : {}) }),
    });
    const errors = res.json?.errors ?? [];
    if (errors.length) throw new Error(`reddit submit: ${JSON.stringify(errors)}`);
    const ws = res.json?.data?.websocket_url;
    const url = ws ? await awaitProcessed(ws) : (res.json?.data?.url ?? null);
    ctx.log(`[reddit] submitted to r/${s.sr}${url ? `: ${url}` : " (still processing)"}`);
    return { remoteId: null, url };
  },
};
