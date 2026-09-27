import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ClipFacts, type ClipKind, sidecar } from "../clips/metadata";
import { missingEnv, oauth1Header } from "../social/common";
import { POSTERS, socialEnvFrom } from "../social/post";
import { appendPosted, LIMITS, loadPosted, loadQueue, type PostedEntry, planPosts, type QueueItem, sourceOf } from "../social/queue";
import { redditSubmission } from "../social/reddit";
import { tiktokPostInfo } from "../social/tiktok";
import { youtubeResource } from "../social/youtube";

const H = 3_600_000;
const NOW = Date.parse("2026-09-27T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function item(id: string, kind: ClipKind = "highlight", createdAt = "2026-09-27T01:00:00Z"): QueueItem {
  const f: ClipFacts = { id, kind, durationSec: 20, headline: `Line for ${id}`, moments: [{ kind: "wipeout", what: "Jev wiped Bob off the map" }], map: "World", humans: 40, strategy: null };
  return { id, kind, video: `/clips/2026-09-27/${id}.mp4`, sidecarFile: `/clips/2026-09-27/${id}.json`, createdAt, meta: sidecar(f, `${id}.mp4`, createdAt) };
}

const posted = (id: string, platform: PostedEntry["platform"], agoH: number, subreddit?: string): PostedEntry => ({ id, platform, at: iso(NOW - agoH * H), url: null, remoteId: null, ...(subreddit ? { subreddit } : {}) });

describe("posting queue", () => {
  const queue = [item("game-aaa"), item("moment-aaa-100", "moment"), item("evo-1234567-proposed", "evolution"), item("bestof-aaa-bbb", "compilation"), item("game-bbb", "highlight", "2026-09-27T02:00:00Z")];

  test("one post per platform per run, the evolution first", () => {
    const plan = planPosts(queue, [], { now: NOW, platforms: ["x", "youtube"] });
    expect(plan.map((p) => [p.platform, p.item.id])).toEqual([["x", "evo-1234567-proposed"], ["youtube", "evo-1234567-proposed"]]);
  });

  test("never twice on a platform, and never the same game twice in a day", () => {
    const history = [posted("evo-1234567-proposed", "x", 5), posted("bestof-aaa-bbb", "x", 3)];
    const [next] = planPosts(queue, history, { now: NOW, platforms: ["x"] });
    // Newest highlight first.
    expect(next!.item.id).toBe("game-bbb");
    const later = planPosts(queue, [...history, posted("game-bbb", "x", 3)], { now: NOW, platforms: ["x"] });
    expect(later[0]!.item.id).toBe("game-aaa");
    expect(sourceOf("moment-aaa-100")).toBe("aaa");
    expect(sourceOf("game-aaa")).toBe("aaa");
    // With game-aaa posted in the last day, its single moment waits.
    const sameGame = planPosts([item("moment-aaa-100", "moment")], [posted("game-aaa", "x", 3)], { now: NOW, platforms: ["x"] });
    expect(sameGame).toEqual([]);
  });

  test("pacing: a minimum gap, and a cap per rolling day", () => {
    expect(planPosts(queue, [posted("x1", "x", 1)], { now: NOW, platforms: ["x"] })).toEqual([]);
    const full = Array.from({ length: LIMITS.x.perDay }, (_, i) => posted(`x${i}`, "x", 3 + i));
    expect(planPosts(queue, full, { now: NOW, platforms: ["x"] })).toEqual([]);
    expect(planPosts(queue, full, { now: NOW + 24 * H, platforms: ["x"] }).length).toBe(1);
  });

  test("reddit rotates subreddits by their own self-promo gaps", () => {
    const [first] = planPosts(queue, [], { now: NOW, platforms: ["reddit"] });
    expect(first!.subreddit).toBe("Openfront");
    const history = [posted("other", "reddit", 30, "Openfront")];
    const [second] = planPosts([item("game-ccc")], history, { now: NOW, platforms: ["reddit"] });
    expect(second!.subreddit).toBe("Kick");
    expect(redditSubmission(second!).sr).toBe("Kick");
    const all = [posted("o", "reddit", 30, "Openfront"), posted("k", "reddit", 50, "Kick")];
    expect(planPosts([item("game-ccc")], all, { now: NOW, platforms: ["reddit"] })).toEqual([]);
  });

  test("the queue loads from day folders; the posted log round-trips", () => {
    const root = mkdtempSync(path.join(tmpdir(), "jev-clips-"));
    const day = path.join(root, "2026-09-27");
    mkdirSync(day);
    const it = item("game-aaa");
    writeFileSync(path.join(day, "game-aaa.mp4"), "v");
    writeFileSync(path.join(day, "game-aaa.json"), JSON.stringify(it.meta));
    writeFileSync(path.join(day, "orphan.json"), JSON.stringify(item("orphan").meta));
    writeFileSync(path.join(root, "manifest.json"), "{}");
    const q = loadQueue(root);
    expect(q.map((x) => [x.id, x.video])).toEqual([["game-aaa", path.join(day, "game-aaa.mp4")]]);
    const log = path.join(root, "social-posted.jsonl");
    appendPosted(log, posted("game-aaa", "youtube", 1));
    expect(loadPosted(log).map((p) => p.id)).toEqual(["game-aaa"]);
    expect(planPosts(q, loadPosted(log), { now: NOW, platforms: ["youtube"] })).toEqual([]);
  });
});

describe("uploaders", () => {
  test("OAuth 1.0a signs like X's documented example", () => {
    const h = oauth1Header(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      { consumerKey: "xvz1evFS4wEEPTGEFPHBog", consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" },
      { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      { nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: "1318622958" },
    );
    expect(h).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });

  test("only social keys come from the stream's .env", () => {
    const env = socialEnvFrom("KICK_STREAM_KEY=secret\nTYPESAFE_API_KEY=k\nX_API_KEY=abc\nexport YOUTUBE_REFRESH_TOKEN=\"r\"\nSOCIAL_PUBLIC_BASE_URL=https://cdn\n");
    expect(env).toEqual({ X_API_KEY: "abc", YOUTUBE_REFRESH_TOKEN: "r", SOCIAL_PUBLIC_BASE_URL: "https://cdn" });
    expect(missingEnv(POSTERS.x, env)).toEqual(["X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]);
  });

  test("previews show what each platform would get, without credentials", () => {
    const p = { platform: "instagram" as const, item: item("game-aaa") };
    for (const poster of Object.values(POSTERS)) expect(Object.keys(poster.preview({ ...p, platform: poster.platform }, {})).length).toBeGreaterThan(2);
    expect(POSTERS.instagram.preview(p, { SOCIAL_PUBLIC_BASE_URL: "https://cdn.example/clips/" }).video_url).toBe("https://cdn.example/clips/2026-09-27/game-aaa.mp4");
    expect(youtubeResource(p, {}).status.privacyStatus).toBe("public");
    expect(youtubeResource({ ...p, item: { ...p.item, meta: { ...p.item.meta, platforms: { ...p.item.meta.platforms, youtube: { ...p.item.meta.platforms.youtube, title: "a <b> c" } } } } }, {}).snippet.title).toBe("a b c");
    // TikTok stays private unless asked and allowed.
    expect(tiktokPostInfo(p, {}).privacy_level).toBe("SELF_ONLY");
    expect(tiktokPostInfo(p, { TIKTOK_PRIVACY: "PUBLIC_TO_EVERYONE" }, ["SELF_ONLY"]).privacy_level).toBe("SELF_ONLY");
    expect(tiktokPostInfo(p, { TIKTOK_PRIVACY: "PUBLIC_TO_EVERYONE" }, ["PUBLIC_TO_EVERYONE", "SELF_ONLY"]).privacy_level).toBe("PUBLIC_TO_EVERYONE");
  });
});
