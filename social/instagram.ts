// Instagram Reels, "Instagram API with Instagram Login" (no Facebook Page):
//   POST graph.instagram.com/<v>/<IG_USER_ID>/media   media_type=REELS, video_url, caption  -> container id
//   GET  graph.instagram.com/<v>/<container>?fields=status_code   until FINISHED
//   POST graph.instagram.com/<v>/<IG_USER_ID>/media_publish        creation_id=<container>
// Instagram fetches the video itself, so it needs a public HTTPS URL for the
// file: set SOCIAL_PUBLIC_BASE_URL (the clips root mirrored somewhere, e.g.
// an R2/S3 bucket; <base>/<YYYY-MM-DD>/<file>.mp4), or SOCIAL_PUBLISH_CMD, a
// command that uploads "$1" and prints its public URL on the last line.
// The long-lived token lasts 60 days; this refreshes it after 7 and keeps the
// new one in the token store.

import path from "node:path";
import { type Env, form, json, type Poster, type PostContext, sleep, withTags } from "./common";
import type { PlannedPost } from "./queue";

const HOST = "https://graph.instagram.com";
const version = (env: Env) => env.IG_GRAPH_VERSION ?? "v25.0";

export function publicUrl(p: PlannedPost, env: Env): string | null {
  const base = env.SOCIAL_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (!base) return null;
  return `${base}/${path.basename(path.dirname(p.item.video))}/${path.basename(p.item.video)}`;
}

async function videoUrl(p: PlannedPost, ctx: PostContext): Promise<string> {
  const direct = publicUrl(p, ctx.env);
  if (direct) return direct;
  const cmd = ctx.env.SOCIAL_PUBLISH_CMD;
  if (!cmd) throw new Error("instagram needs a public video URL: set SOCIAL_PUBLIC_BASE_URL or SOCIAL_PUBLISH_CMD");
  const proc = Bun.spawn(["sh", "-c", `${cmd} "$1"`, "publish", p.item.video], { stdout: "pipe", stderr: "inherit" });
  const out = (await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "";
  if ((await proc.exited) !== 0 || !/^https:\/\//.test(out)) throw new Error(`SOCIAL_PUBLISH_CMD didn't print an https URL (got "${out.slice(0, 120)}")`);
  return out;
}

async function token(ctx: PostContext): Promise<string> {
  const current = ctx.tokens.get("IG_ACCESS_TOKEN", ctx.env)!;
  const refreshedAt = Number(ctx.tokens.get("IG_TOKEN_REFRESHED_AT", {}) ?? 0);
  if (Date.now() - refreshedAt < 7 * 86_400_000) return current;
  try {
    const r = await json<{ access_token?: string }>("instagram token refresh", `${HOST}/refresh_access_token?${form({ grant_type: "ig_refresh_token", access_token: current })}`);
    if (r.access_token) {
      ctx.tokens.set("IG_ACCESS_TOKEN", r.access_token);
      ctx.tokens.set("IG_TOKEN_REFRESHED_AT", String(Date.now()));
      return r.access_token;
    }
  } catch (err) {
    // A token under 24 hours old can't be refreshed yet: use it as is.
    ctx.log(`[instagram] token refresh skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  return current;
}

export const instagram: Poster = {
  platform: "instagram",
  required: ["IG_USER_ID", "IG_ACCESS_TOKEN"],
  preview: (p, env) => ({
    endpoint: `${HOST}/${version(env)}/${env.IG_USER_ID ?? "<IG_USER_ID>"}/media`,
    media_type: "REELS",
    video_url: publicUrl(p, env) ?? (env.SOCIAL_PUBLISH_CMD ? "<from SOCIAL_PUBLISH_CMD>" : "<missing: set SOCIAL_PUBLIC_BASE_URL or SOCIAL_PUBLISH_CMD>"),
    caption: withTags(p.item.meta.platforms.instagram.caption, p.item.meta.platforms.instagram.hashtags),
    share_to_feed: true,
  }),
  async post(p, ctx) {
    const v = version(ctx.env);
    const user = ctx.env.IG_USER_ID!;
    const access = await token(ctx);
    const ig = p.item.meta.platforms.instagram;
    const url = await videoUrl(p, ctx);
    const container = await json<{ id?: string }>("instagram create container", `${HOST}/${v}/${user}/media`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ media_type: "REELS", video_url: url, caption: withTags(ig.caption, ig.hashtags), share_to_feed: "true", access_token: access }),
    });
    if (!container.id) throw new Error(`instagram create container: no id in ${JSON.stringify(container)}`);
    // Instagram downloads and transcodes it: poll, as the docs say, up to ~5 minutes.
    for (let i = 0; ; i++) {
      const s = await json<{ status_code?: string; status?: string }>("instagram container status", `${HOST}/${v}/${container.id}?${form({ fields: "status_code,status", access_token: access })}`);
      if (s.status_code === "FINISHED") break;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`instagram container ${s.status_code}: ${s.status ?? ""}`);
      if (i >= 20) throw new Error("instagram container still processing after 5 minutes");
      await sleep(15_000);
    }
    const pub = await json<{ id?: string }>("instagram publish", `${HOST}/${v}/${user}/media_publish`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ creation_id: container.id, access_token: access }),
    });
    let permalink: string | null = null;
    if (pub.id) {
      const m = await json<{ permalink?: string }>("instagram permalink", `${HOST}/${v}/${pub.id}?${form({ fields: "permalink", access_token: access })}`).catch(() => ({ permalink: undefined }));
      permalink = m.permalink ?? null;
    }
    ctx.log(`[instagram] published ${pub.id}`);
    return { remoteId: pub.id ?? null, url: permalink };
  },
};
