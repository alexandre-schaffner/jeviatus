// From heat peaks to ranked clips. Code finds where something happened and
// gathers the evidence (transcript, chat, viewer clips, loudness); Jev judges
// each moment against what makes this streamer's clips go viral
// (questions.ts) and picks where the clip starts and ends among the
// transcript's own line breaks. Hooks are drafted by Claude and picked by Jev.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Jev } from "../harness/jev/client";
import type { ChatSample, ViewerClip, Vod } from "./kick";
import { type Answers, hookQuestion, momentQuestions, scoreOf } from "./questions";
import type { Streamer } from "./streamer";
import type { Peak } from "./signals";
import { VIEWER_LAG_SEC } from "./signals";
import path from "node:path";
import { between, type Line, retranscribe } from "./transcript";

// How much transcript Jev sees around a peak, and the clip length it may pick.
const BEFORE = 100;
const AFTER = 45;
// His top stream clips are all <= 29 s; median plays fall off past 20 s.
export const MIN_SEC = 8;
export const MAX_SEC = 28;

export interface Candidate {
  peak: Peak;
  lines: { t: number; text: string }[]; // t: seconds from the peak
  chat: string[]; // what chat said just after the peak
  viewerClipTitles: string[];
  summary: string; // the transcript around the peak, short, for logs
  // Filled by judgeAll:
  fromSec: number;
  toSec: number;
  answers?: Answers;
  score: number;
  // Filled by writeHooks:
  hook?: string;
  hookOptions?: string[];
  caption?: string;
}

const EMOTE = /\[emote:\d+:([^\]]+)\]/g;

export function candidates(ps: Peak[], lines: Line[], clips: ViewerClip[], chat: ChatSample[], vod: Vod): Candidate[] {
  const start = Date.parse(vod.startTime);
  return ps
    .map((p) => {
      const around = between(lines, p.sec - BEFORE, p.sec + AFTER);
      const saidLines = around.map((l) => ({ t: Math.round(l.from - p.sec), text: l.text }));
      const after = chat
        .filter((s) => s.offsetSec >= p.sec && s.offsetSec <= p.sec + 45)
        .flatMap((s) => s.messages.map((m) => m.text.replace(EMOTE, "$1")))
        .filter((t) => t.length > 0 && t.length < 120)
        .slice(0, 40);
      const titles = clips
        .filter((c) => {
          const end = (Date.parse(c.createdAt) - start) / 1000 - VIEWER_LAG_SEC;
          return end >= p.sec - 15 && end <= p.sec + 40;
        })
        .sort((a, b) => b.views - a.views)
        .map((c) => c.title.trim())
        .filter((t) => /[a-z]{3}/i.test(t) && !/^(d?f?d?f)+$/i.test(t));
      return {
        peak: p,
        lines: saidLines,
        chat: after,
        viewerClipTitles: [...new Set(titles)].slice(0, 6),
        summary: saidLines.filter((l) => l.t >= -30 && l.t <= 10).map((l) => l.text).join(" "),
        fromSec: p.sec - 30,
        toSec: p.sec + 10,
        score: 0,
      };
    })
    .filter((c) => c.lines.filter((l) => l.t > -60 && l.t < 20).length >= 3);
}

const describe = (z: number) => (z > 4 ? "far above" : z > 2 ? "well above" : z > 0.7 ? "above" : z > -0.7 ? "about" : "below");

function state(st: Streamer, c: Candidate) {
  return {
    streamer: { name: st.name, who: st.who, stream: st.stream },
    moment: {
      transcript_note: "Auto-transcribed from noisy IRL audio; names and slang are often misheard. `t` is seconds from the peak of activity.",
      transcript: c.lines.map((l) => `[${l.t >= 0 ? "+" : ""}${l.t}s] ${l.text}`),
      chat_right_after: c.chat.length ? c.chat : ["(no chat captured)"],
      chat_speed: `${describe(c.peak.chatZ)} usual`,
      chat_laughing: `${describe(c.peak.laughZ)} usual`,
      room_loudness: `${describe(c.peak.loudZ)} usual`,
      viewers_clipped_it: c.peak.clips === 0 ? "no viewer clipped this" : `${c.peak.clips} viewer clip(s)`,
      viewer_clip_titles: c.viewerClipTitles.length ? c.viewerClipTitles : ["(none)"],
    },
  };
}

// Line starts Jev may cut at. Keys are stable ids; text shows what's said.
function cutOptions(c: Candidate, from: number, to: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of c.lines) if (l.t >= from && l.t <= to) out[`at${l.t < 0 ? "m" : "p"}${String(Math.abs(l.t)).replace(".", "_")}`] = `[${l.t >= 0 ? "+" : ""}${l.t}s] ${l.text.slice(0, 120)}`;
  return out;
}
const keyToT = (k: string) => (k[2] === "m" ? -1 : 1) * Number(k.slice(3).replace("_", "."));

export async function judgeAll(st: Streamer, cands: Candidate[], jev: Jev | null, log: (l: string) => void, parallel = 6): Promise<Candidate[]> {
  let next = 0;
  const out: Candidate[] = new Array(cands.length);
  const worker = async () => {
    while (next < cands.length) {
      const i = next++;
      out[i] = await judge(st, cands[i]!, jev, log);
      if ((i + 1) % 10 === 0) log(`[jev] judged ${i + 1}/${cands.length}`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return out;
}

async function judge(st: Streamer, c: Candidate, jev: Jev | null, log: (l: string) => void): Promise<Candidate> {
  const starts = cutOptions(c, -60, -1);
  const ends = cutOptions(c, -10, 30);
  // Unjudged moments rank below judged ones.
  const fallback = { ...c, answers: undefined, score: c.peak.heat / 60 };
  if (!jev || !Object.keys(starts).length || !Object.keys(ends).length) return fallback;
  try {
    const res = await jev.ask("vodclip", state(st, c) as never, momentQuestions(st, starts, ends));
    const a = res.answers as unknown as Answers;
    const lineEnd = (t: number) => c.lines.find((l) => l.t === t);
    let from = c.peak.sec + keyToT(a.start?.choice ?? Object.keys(starts)[0]!);
    const endT = keyToT(a.end?.choice ?? Object.keys(ends).at(-1)!);
    // End after the chosen line finishes, not where it starts.
    const endLine = lineEnd(endT);
    const endIdx = endLine ? c.lines.indexOf(endLine) : -1;
    const nextT = endIdx >= 0 && c.lines[endIdx + 1] ? c.lines[endIdx + 1]!.t : endT + 6;
    let to = c.peak.sec + Math.min(nextT, endT + 12);
    // Too long: open on the first line that still fits, not mid-sentence.
    if (to - from > MAX_SEC) from = c.peak.sec + (c.lines.find((l) => c.peak.sec + l.t >= to - MAX_SEC)?.t ?? to - MAX_SEC - c.peak.sec);
    if (to - from < MIN_SEC) to = from + MIN_SEC;
    // A beat after the payoff for the reaction.
    return { ...c, answers: a, fromSec: Math.max(0, from - 0.3), toSec: to + 1.5, score: scoreOf(a, c.peak) };
  } catch (err) {
    log(`[jev] peak ${c.peak.sec}: ${err instanceof Error ? err.message : String(err)}; signals only`);
    return fallback;
  }
}

// The cascade's second pass: the best moments again, with the accurate
// whisper model over the window, then judged again on the better text.
export async function refine(st: Streamer, cs: Candidate[], wav: string, dir: string, jev: Jev | null, log: (l: string) => void): Promise<Candidate[]> {
  mkdirSync(dir, { recursive: true });
  const out: Candidate[] = [];
  for (const c of cs) {
    const lines = await retranscribe(wav, Math.max(0, c.peak.sec - BEFORE), c.peak.sec + AFTER, path.join(dir, `w${c.peak.sec}`));
    const ls = lines.map((l) => ({ t: Math.round((l.from - c.peak.sec) * 10) / 10, text: l.text }));
    out.push({ ...c, lines: ls, summary: ls.filter((l) => l.t >= -30 && l.t <= 10).map((l) => l.text).join(" ") });
  }
  log(`[whisper] re-transcribed ${out.length} windows with ${"large-v3-turbo"}`);
  return judgeAll(st, out, jev, log);
}

// Best first, skipping clips that overlap a better one.
export function rank(cs: Candidate[]): Candidate[] {
  const sorted = [...cs].sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];
  for (const c of sorted) if (!kept.some((k) => c.fromSec < k.toSec && k.fromSec < c.toSec)) kept.push(c);
  return kept;
}

// Hook candidates, drafted by Claude Code (`claude -p`, the user's login)
// from the clip's transcript in the formats that work for this streamer,
// then Jev picks one. Viewer clip titles go in the pool too.
async function draft(st: Streamer, c: Candidate): Promise<{ hooks: string[]; caption: string }> {
  const said = c.lines.filter((l) => l.t >= c.fromSec - c.peak.sec - 1 && l.t <= c.toSec - c.peak.sec).map((l) => `[${l.t}s] ${l.text}`);
  const prompt = [
    `Write on-screen hook text for an Instagram Reel clipped from ${st.name}'s Kick stream (${st.who}).`,
    `What happens in the clip (auto-transcript, may mishear names):\n${said.join("\n")}`,
    `Chat reacted with: ${c.chat.slice(0, 15).join(" | ") || "nothing captured"}`,
    `Viewer clip titles: ${c.viewerClipTitles.join(" | ") || "none"}`,
    st.hookRules.join("\n"),
    st.speakers,
    "Give 5 different hooks (each under 60 characters, no hashtags, no emoji) and one Instagram caption (a 1-4 word ironic moral or lingo tag like 'Always check id' or 'Brutal', then 4-6 hashtags). A quoted hook must be words actually said in the transcript. Never add events, objects or outcomes the transcript doesn't state.",
  ].join("\n\n");
  const schema = { type: "object", properties: { hooks: { type: "array", items: { type: "string" } }, caption: { type: "string" } }, required: ["hooks", "caption"] };
  const p = Bun.spawn(
    ["claude", "-p", "--model", "sonnet", "--tools", "", "--settings", JSON.stringify({ alwaysThinkingEnabled: false }), "--output-format", "json",
      "--json-schema", JSON.stringify(schema), "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"],
    { cwd: tmpdir(), env: { ...process.env, MAX_THINKING_TOKENS: "0" }, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(p.stdout).text();
  await p.exited;
  const body = JSON.parse(out.slice(out.indexOf("{"))) as { structured_output?: { hooks?: string[]; caption?: string }; result?: string };
  if (!body.structured_output?.hooks?.length) throw new Error(`claude -p: ${String(body.result ?? out).slice(0, 200)}`);
  return { hooks: body.structured_output.hooks.map((h) => h.trim()).filter(Boolean), caption: body.structured_output.caption ?? "" };
}

export async function writeHooks(st: Streamer, cs: Candidate[], jev: Jev | null, log: (l: string) => void): Promise<Candidate[]> {
  return Promise.all(
    cs.map(async (c) => {
      let pool: string[] = [];
      let caption = "";
      try {
        const d = await draft(st, c);
        pool = d.hooks;
        caption = d.caption;
      } catch (err) {
        log(`[hooks] ${c.peak.sec}: ${err instanceof Error ? err.message : String(err)}`);
      }
      pool = [...new Set([...pool, ...c.viewerClipTitles.filter((t) => t.length >= 12 && t.length <= 70)])];
      if (!pool.length) pool = [c.summary.split(/[.?!]/)[0]!.slice(0, 60)];
      let hook = pool[0]!;
      if (jev && pool.length > 1) {
        const opts = Object.fromEntries(pool.map((h, i) => [`h${i}`, h]));
        try {
          const res = await jev.ask("vodclip-hook", state(st, c) as never, hookQuestion(st, opts));
          const pick = (res.answers as unknown as { hook?: { choice?: string } }).hook?.choice;
          hook = opts[pick ?? ""] ?? hook;
        } catch (err) {
          log(`[jev] hook ${c.peak.sec}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      hook = hook.replace(/^"(.*)"$/, "\u201c$1\u201d");
      log(`[hooks] ${c.peak.sec}: ${hook}`);
      return { ...c, hook, hookOptions: pool, caption };
    }),
  );
}
