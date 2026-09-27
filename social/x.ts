// X: chunked v2 media upload, then a post with the video.
//   POST /2/media/upload/initialize   {media_type, total_bytes, media_category: "tweet_video"}
//   POST /2/media/upload/{id}/append  multipart: segment_index, media (<= 5 MB chunks)
//   POST /2/media/upload/{id}/finalize
//   GET  /2/media/upload?command=STATUS&media_id={id}   until processing succeeds
//   POST /2/tweets                     {text, media: {media_ids: [id]}}
// Auth: OAuth 1.0a user context with your own app's keys and your account's
// access token and secret (they don't expire). See social/README.md.

import { type Env, json, oauth1Header, type OAuth1Keys, type Poster, sleep } from "./common";

const API = "https://api.x.com";
const CHUNK = 4 * 1024 * 1024;

const keys = (env: Env): OAuth1Keys => ({
  consumerKey: env.X_API_KEY!,
  consumerSecret: env.X_API_SECRET!,
  token: env.X_ACCESS_TOKEN!,
  tokenSecret: env.X_ACCESS_TOKEN_SECRET!,
});

interface MediaResponse {
  data?: { id?: string; media_key?: string; processing_info?: { state: string; check_after_secs?: number; error?: { message?: string } } };
}

export const x: Poster = {
  platform: "x",
  required: ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"],
  preview: (p) => ({ endpoint: `${API}/2/tweets`, text: p.item.meta.platforms.x.text, video: p.item.video, chars: p.item.meta.platforms.x.text.length }),
  async post(p, ctx) {
    const k = keys(ctx.env);
    const auth = (method: string, url: string) => ({ Authorization: oauth1Header(method, url, k) });
    const file = Bun.file(p.item.video);
    const size = file.size;

    const initUrl = `${API}/2/media/upload/initialize`;
    const init = await json<MediaResponse>("x media initialize", initUrl, {
      method: "POST",
      headers: { ...auth("POST", initUrl), "content-type": "application/json" },
      body: JSON.stringify({ media_type: "video/mp4", total_bytes: size, media_category: "tweet_video" }),
    });
    const id = init.data?.id;
    if (!id) throw new Error(`x media initialize: no media id in ${JSON.stringify(init)}`);

    for (let i = 0, off = 0; off < size; i++, off += CHUNK) {
      const url = `${API}/2/media/upload/${id}/append`;
      const body = new FormData();
      body.append("segment_index", String(i));
      body.append("media", new Blob([await file.slice(off, Math.min(size, off + CHUNK)).arrayBuffer()], { type: "application/octet-stream" }), "chunk");
      await json("x media append", url, { method: "POST", headers: auth("POST", url), body });
    }

    const finUrl = `${API}/2/media/upload/${id}/finalize`;
    let info = (await json<MediaResponse>("x media finalize", finUrl, { method: "POST", headers: auth("POST", finUrl) })).data?.processing_info;
    for (let tries = 0; info && info.state !== "succeeded"; tries++) {
      if (info.state === "failed") throw new Error(`x media processing failed: ${info.error?.message ?? "unknown"}`);
      if (tries > 60) throw new Error("x media processing timed out");
      await sleep((info.check_after_secs ?? 2) * 1000);
      const url = `${API}/2/media/upload?command=STATUS&media_id=${id}`;
      info = (await json<MediaResponse>("x media status", url, { headers: auth("GET", url) })).data?.processing_info;
    }

    const postUrl = `${API}/2/tweets`;
    const res = await json<{ data?: { id?: string } }>("x post", postUrl, {
      method: "POST",
      headers: { ...auth("POST", postUrl), "content-type": "application/json" },
      body: JSON.stringify({ text: p.item.meta.platforms.x.text, media: { media_ids: [id] } }),
    });
    const postId = res.data?.id ?? null;
    ctx.log(`[x] posted ${postId}`);
    return { remoteId: postId, url: postId ? `https://x.com/i/status/${postId}` : null };
  },
};
