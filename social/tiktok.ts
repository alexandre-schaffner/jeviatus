// TikTok Content Posting API, two modes (TIKTOK_MODE):
//   inbox (default, scope video.upload): the video lands in the TikTok app's
//     inbox; you open it there, add a trending sound, and post. Works without
//     TikTok's audit, which rejects tools that only post to your own account.
//   direct (scope video.publish): posts straight to the profile. Until the
//     app passes the audit, TikTok forces SELF_ONLY (private) visibility.
// Flow: refresh the token (it rotates: the new refresh token is kept), then
//   POST /v2/post/publish/creator_info/query/          (direct only; required first)
//   POST /v2/post/publish/{inbox/}video/init/           source FILE_UPLOAD -> publish_id, upload_url
//   PUT  upload_url                                     one chunk (clips are < 64 MB)
//   POST /v2/post/publish/status/fetch/                 until uploaded / published

import { type Env, form, http, json, type Poster, type PostContext, sleep, withTags } from "./common";
import type { PlannedPost } from "./queue";

const API = "https://open.tiktokapis.com";

interface TikTokResponse<T> {
  data?: T;
  error?: { code?: string; message?: string };
}

const check = <T>(what: string, r: TikTokResponse<T>): T => {
  if (r.error?.code && r.error.code !== "ok") throw new Error(`${what}: ${r.error.code} ${r.error.message ?? ""}`);
  return r.data as T;
};

const mode = (env: Env) => (env.TIKTOK_MODE === "direct" ? "direct" : "inbox");

export function tiktokPostInfo(p: PlannedPost, env: Env, privacyOptions: string[] = []) {
  const t = p.item.meta.platforms.tiktok;
  // The audit-free default: private. Public only when asked for and allowed.
  const wanted = env.TIKTOK_PRIVACY ?? "SELF_ONLY";
  const privacy = privacyOptions.length === 0 || privacyOptions.includes(wanted) ? wanted : "SELF_ONLY";
  return {
    title: withTags(t.caption, t.hashtags).slice(0, 2200),
    privacy_level: privacy,
    disable_duet: false,
    disable_comment: false,
    disable_stitch: false,
    video_cover_timestamp_ms: 1500,
    brand_content_toggle: false,
    brand_organic_toggle: false,
    // Real gameplay footage, not AI-generated imagery.
    is_aigc: false,
  };
}

async function accessToken(ctx: PostContext): Promise<string> {
  const refresh = ctx.tokens.get("TIKTOK_REFRESH_TOKEN", ctx.env)!;
  const t = await json<{ access_token?: string; refresh_token?: string; error?: string; error_description?: string }>("tiktok token", `${API}/v2/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ client_key: ctx.env.TIKTOK_CLIENT_KEY!, client_secret: ctx.env.TIKTOK_CLIENT_SECRET!, grant_type: "refresh_token", refresh_token: refresh }),
  });
  if (!t.access_token) throw new Error(`tiktok token: ${t.error ?? "no access_token"} ${t.error_description ?? ""}`);
  if (t.refresh_token && t.refresh_token !== refresh) ctx.tokens.set("TIKTOK_REFRESH_TOKEN", t.refresh_token);
  return t.access_token;
}

export const tiktok: Poster = {
  platform: "tiktok",
  required: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_REFRESH_TOKEN"],
  preview: (p, env) =>
    mode(env) === "direct"
      ? { mode: "direct", endpoint: `${API}/v2/post/publish/video/init/`, post_info: tiktokPostInfo(p, env), video: p.item.video }
      : { mode: "inbox", endpoint: `${API}/v2/post/publish/inbox/video/init/`, video: p.item.video, note: "finish in the TikTok app: paste this caption, add a sound", caption: withTags(p.item.meta.platforms.tiktok.caption, p.item.meta.platforms.tiktok.hashtags) },
  async post(p, ctx) {
    const token = await accessToken(ctx);
    const auth = { Authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" };
    const size = Bun.file(p.item.video).size;
    const source_info = { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 };
    let init: { publish_id?: string; upload_url?: string };
    if (mode(ctx.env) === "direct") {
      const creator = check("tiktok creator info", await json<TikTokResponse<{ privacy_level_options?: string[]; max_video_post_duration_sec?: number }>>("tiktok creator info", `${API}/v2/post/publish/creator_info/query/`, { method: "POST", headers: auth }));
      if (creator.max_video_post_duration_sec && p.item.meta.durationSec > creator.max_video_post_duration_sec) throw new Error(`tiktok: clip is longer than this creator may post (${creator.max_video_post_duration_sec} s)`);
      init = check("tiktok init", await json<TikTokResponse<typeof init>>("tiktok init", `${API}/v2/post/publish/video/init/`, { method: "POST", headers: auth, body: JSON.stringify({ post_info: tiktokPostInfo(p, ctx.env, creator.privacy_level_options), source_info }) }));
    } else {
      init = check("tiktok inbox init", await json<TikTokResponse<typeof init>>("tiktok inbox init", `${API}/v2/post/publish/inbox/video/init/`, { method: "POST", headers: auth, body: JSON.stringify({ source_info }) }));
    }
    if (!init.publish_id || !init.upload_url) throw new Error(`tiktok init: no upload url in ${JSON.stringify(init)}`);
    await http("tiktok upload", init.upload_url, {
      method: "PUT",
      headers: { "content-type": "video/mp4", "content-length": String(size), "content-range": `bytes 0-${size - 1}/${size}` },
      body: Bun.file(p.item.video),
      expect: [200, 201, 206],
    });
    for (let i = 0; i < 40; i++) {
      await sleep(5_000);
      const s = check("tiktok status", await json<TikTokResponse<{ status?: string; fail_reason?: string; publicaly_available_post_id?: string[] }>>("tiktok status", `${API}/v2/post/publish/status/fetch/`, { method: "POST", headers: auth, body: JSON.stringify({ publish_id: init.publish_id }) }));
      if (s.status === "FAILED") throw new Error(`tiktok: ${s.fail_reason ?? "failed"}`);
      if (s.status === "SEND_TO_USER_INBOX" || s.status === "PUBLISH_COMPLETE") {
        ctx.log(`[tiktok] ${s.status === "SEND_TO_USER_INBOX" ? "in the app's inbox: finish the post there" : "published"} (${init.publish_id})`);
        const postId = s.publicaly_available_post_id?.[0];
        return { remoteId: init.publish_id, url: postId ? `https://www.tiktok.com/video/${postId}` : null };
      }
    }
    throw new Error("tiktok: still processing after 200 s");
  },
};
