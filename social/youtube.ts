// YouTube Shorts: a vertical video of 3 minutes or less is a Short. Data API
// v3 resumable upload:
//   POST https://oauth2.googleapis.com/token                 refresh -> access token
//   POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status   -> Location
//   PUT  <Location>                                          the bytes (201 when done)
// Auth: an OAuth "Desktop app" client and a refresh token for the channel,
// scope youtube.upload (`bun social/auth.ts youtube` gets one). Until the
// Google Cloud project passes YouTube's API audit, uploads are locked private.

import { type Env, form, http, json, type Poster } from "./common";

export const YT_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

// YouTube rejects < and > in titles and descriptions.
const clean = (s: string) => s.replace(/[<>]/g, "");

export function youtubeResource(p: Parameters<Poster["preview"]>[0], env: Env) {
  const y = p.item.meta.platforms.youtube;
  return {
    snippet: { title: clean(y.title).slice(0, 100), description: clean(y.description).slice(0, 4900), tags: y.tags, categoryId: y.categoryId },
    status: { privacyStatus: env.YOUTUBE_PRIVACY ?? "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: false },
  };
}

export async function googleAccessToken(env: Env): Promise<string> {
  const t = await json<{ access_token?: string }>("youtube token", "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ client_id: env.YOUTUBE_CLIENT_ID!, client_secret: env.YOUTUBE_CLIENT_SECRET!, refresh_token: env.YOUTUBE_REFRESH_TOKEN!, grant_type: "refresh_token" }),
  });
  if (!t.access_token) throw new Error("youtube token: no access_token (is the refresh token revoked or 7 days old in Testing mode?)");
  return t.access_token;
}

export const youtube: Poster = {
  platform: "youtube",
  required: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"],
  preview: (p, env) => ({ endpoint: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", video: p.item.video, ...youtubeResource(p, env) }),
  async post(p, ctx) {
    const token = await googleAccessToken(ctx.env);
    const file = Bun.file(p.item.video);
    const start = await http("youtube upload start", "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(file.size), "X-Upload-Content-Type": "video/mp4" },
      body: JSON.stringify(youtubeResource(p, ctx.env)),
    });
    const session = start.headers.get("location");
    if (!session) throw new Error("youtube upload start: no session URL");
    const res = await json<{ id?: string; status?: { privacyStatus?: string; uploadStatus?: string } }>("youtube upload", session, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "content-type": "video/mp4", "content-length": String(file.size) },
      body: file,
      expect: [200, 201],
    });
    if (!res.id) throw new Error(`youtube upload: no video id in ${JSON.stringify(res)}`);
    ctx.log(`[youtube] uploaded ${res.id} (${res.status?.privacyStatus ?? "?"})`);
    return { remoteId: res.id, url: `https://youtube.com/shorts/${res.id}` };
  },
};
