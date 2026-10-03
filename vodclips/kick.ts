// Kick's public endpoints for a finished stream: the VOD's HLS playlist, the
// clips viewers made while it was live, and its chat replay. No login. Chat
// replay sits behind a bot wall that blocks bursts, so it is sampled slowly.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

export interface Vod {
  id: number;
  channelId: number;
  slug: string;
  title: string;
  startTime: string; // ISO, when the broadcast started
  durationSec: number;
  master: string; // HLS master playlist
}

export async function listVods(channel: string): Promise<Vod[]> {
  type Raw = { id: number; channel_id: number; slug: string; session_title: string; start_time: string; duration: number; is_live: boolean; source: string };
  const raw = await getJson<Raw[]>(`https://kick.com/api/v2/channels/${channel}/videos`);
  return raw
    .filter((v) => !v.is_live && v.duration > 0)
    .map((v) => ({
      id: v.id,
      channelId: v.channel_id,
      slug: v.slug,
      title: v.session_title,
      startTime: new Date(`${v.start_time.replace(" ", "T")}Z`).toISOString(),
      durationSec: v.duration / 1000,
      master: v.source,
    }));
}

export interface Segment {
  url: string;
  startSec: number; // from the first segment
  durSec: number;
  wallclock: string | null; // EXT-X-PROGRAM-DATE-TIME
}

// One rendition's segments. `variant` is a folder of the master: 160p30,
// 360p30, 480p30, 720p60, 1080p60.
export async function segments(vod: Vod, variant: string): Promise<Segment[]> {
  const base = vod.master.replace(/master\.m3u8$/, `${variant}/`);
  const text = await (await fetch(`${base}playlist.m3u8`, { headers: { "user-agent": UA } })).text();
  const out: Segment[] = [];
  let t = 0;
  let dur = 0;
  let wall: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) wall = line.slice(25).trim();
    else if (line.startsWith("#EXTINF:")) dur = Number.parseFloat(line.slice(8));
    else if (line.trim().endsWith(".ts")) {
      out.push({ url: base + line.trim(), startSec: t, durSec: dur, wallclock: wall });
      t += dur;
      wall = null;
    }
  }
  return out;
}

// Download segments into dir (as <index>.ts), skipping ones already there.
export async function download(segs: Segment[], dir: string, parallel = 16): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const files = segs.map((s) => path.join(dir, path.basename(s.url)));
  let next = 0;
  const worker = async () => {
    while (next < segs.length) {
      const i = next++;
      const file = files[i]!;
      if (existsSync(file) && statSync(file).size > 0) continue;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(segs[i]!.url, { headers: { "user-agent": UA } });
          if (!res.ok) throw new Error(`${res.status}`);
          writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
          break;
        } catch (err) {
          if (attempt >= 4) throw new Error(`segment ${segs[i]!.url}: ${err}`);
          await sleep(1000 * (attempt + 1));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return files;
}

export interface ViewerClip {
  id: string;
  title: string;
  views: number;
  durationSec: number;
  createdAt: string;
  url: string;
}

// Every clip viewers made of this broadcast. Kick only lists a channel's
// clips, so page through them all and keep this stream's.
export async function viewerClips(channel: string, livestreamId: number, log: (l: string) => void = () => {}): Promise<ViewerClip[]> {
  type Raw = { id: string; livestream_id: string; title: string; views: number; duration: number; created_at: string; clip_url: string };
  const seen = new Map<string, ViewerClip>();
  for (const sort of ["view", "date"]) {
    let cursor: unknown = null;
    for (let page = 0; page < 200; page++) {
      const q = cursor ? `&cursor=${encodeURIComponent(typeof cursor === "string" ? cursor : JSON.stringify(cursor))}` : "";
      const d = await getJson<{ clips: Raw[]; nextCursor: unknown }>(`https://kick.com/api/v2/channels/${channel}/clips?sort=${sort}&time=all${q}`);
      for (const c of d.clips) {
        if (c.livestream_id !== String(livestreamId) || seen.has(c.id)) continue;
        seen.set(c.id, { id: c.id, title: c.title, views: c.views, durationSec: c.duration, createdAt: c.created_at, url: c.clip_url });
      }
      cursor = d.nextCursor;
      if (!cursor || d.clips.length === 0) break;
      await sleep(300);
    }
    log(`[kick] clips sorted by ${sort}: ${seen.size} of this stream so far`);
  }
  return [...seen.values()];
}

export interface ChatSample {
  offsetSec: number; // into the VOD
  messages: { at: string; text: string }[];
}

// The chat replay returns a few seconds of messages from a start time. One
// request per `stepSec`, cached in dir, at about one per second: Kick blocks
// bursts ("Request blocked by security policy") for about a minute.
export async function sampleChat(vod: Vod, dir: string, stepSec = 30, log: (l: string) => void = () => {}): Promise<ChatSample[]> {
  mkdirSync(dir, { recursive: true });
  const start = Date.parse(vod.startTime);
  const out: ChatSample[] = [];
  for (let off = 0; off < vod.durationSec; off += stepSec) {
    const file = path.join(dir, `${String(off).padStart(6, "0")}.json`);
    let body: string | null = existsSync(file) ? readFileSync(file, "utf8") : null;
    while (!body) {
      const at = new Date(start + off * 1000).toISOString();
      const res = await fetch(`https://kick.com/api/v2/channels/${vod.channelId}/messages?start_time=${at}`, { headers: { "user-agent": UA } });
      const text = await res.text();
      if (text.startsWith('{"status"')) {
        writeFileSync(file, text);
        body = text;
        await sleep(700);
      } else {
        log(`[kick] chat blocked at ${off}s; waiting`);
        await sleep(30_000);
      }
    }
    out.push(parseChat(off, body));
  }
  return out;
}

export function parseChat(offsetSec: number, body: string): ChatSample {
  const d = JSON.parse(body) as { data?: { messages?: { created_at: string; content: string }[] } };
  return { offsetSec, messages: (d.data?.messages ?? []).map((m) => ({ at: m.created_at, text: m.content })) };
}
