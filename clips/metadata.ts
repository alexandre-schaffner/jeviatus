// Per-platform post text for a clip: the sidecar `<clip>.json` next to every
// video, read by the uploaders (social/). Pure and deterministic: the same
// clip always gets the same text, and different clips get different
// templates, so a queue of posts doesn't read like one message spammed.
//
// Everything is built from facts (what happened, the map, the verdict) and
// reviewed template banks; no free text from a model ends up in a post.

import type { MomentKind } from "../tiktok/moments";

export type ClipKind = "highlight" | "moment" | "compilation" | "evolution";

export const STREAM_URL = "https://kick.com/jeviatus";
export const VOTE_URL = "https://github.com/alexandre-schaffner/jeviatus/pulls";

export interface BuildStats {
  sha: string;
  games: number;
  wins: number;
  meanPlacement: number | null;
  medianMinutes: number;
  meanPeakShare: number;
}

export interface EvolutionFacts {
  // The change, as Claude Code titled it.
  title: string;
  // The lab's change number.
  n: number | null;
  stage: "proposed" | "verdict";
  verdict: "kept" | "dropped" | null;
  before: BuildStats | null;
  after: BuildStats | null;
  files: string[];
}

export interface ClipFacts {
  id: string;
  kind: ClipKind;
  durationSec: number;
  // The big line burned into the video (from tiktok/phrases.ts's bank).
  headline: string;
  // The other fitting lines from the bank, best first, and the players
  // involved: titles prefer a line that names someone or has a number.
  alts?: string[];
  names?: string[];
  moments: { kind: MomentKind; what: string }[];
  map: string | null;
  humans: number | null;
  strategy: string | null;
  // Compilations: how many games the moments come from.
  games?: number;
  evolution?: EvolutionFacts;
}

export interface RedditPost {
  subreddit: string;
  title: string;
  flair: string | null;
  // What to double-check before posting there (the sub's rules).
  rules: string;
}

export interface Sidecar {
  id: string;
  kind: ClipKind;
  video: string;
  durationSec: number;
  createdAt: string;
  facts: ClipFacts;
  platforms: {
    tiktok: { caption: string; hashtags: string[] };
    youtube: { title: string; description: string; tags: string[]; categoryId: string };
    instagram: { caption: string; hashtags: string[] };
    x: { text: string };
    reddit: RedditPost & { alternatives: RedditPost[] };
  };
}

// Reddit communities that fit, and what their rules ask (checked 2026-09;
// see social/README.md). Order is preference within a kind.
export interface Subreddit {
  name: string;
  kinds: ClipKind[];
  flair: string | null;
  rules: string;
}

export const SUBREDDITS: Subreddit[] = [
  {
    name: "Openfront",
    kinds: ["highlight", "moment", "compilation", "evolution"],
    flair: "Discussion",
    rules: "The game's own, very active community; video posts are common and AI-plays posts have precedent. Flair the post and say plainly that Jev is an AI in public lobbies. At most one post every few days.",
  },
  {
    name: "territorial_io",
    kinds: ["compilation"],
    flair: "Discussion",
    rules: "Neighbouring territory-game community (~7k). Flair is mandatory; be nice. Occasional compilations only.",
  },
  {
    name: "Kick",
    kinds: ["highlight", "moment", "compilation"],
    flair: null,
    rules: "Clips and gameplay are allowed when the content is the focus; channel promotion (the stream link) only in the monthly promo thread, so no link in the post.",
  },
  {
    name: "StrategyGames",
    kinds: ["compilation", "evolution"],
    flair: "Self-Promotion",
    rules: "Self-promotion flair required, max one self-promo post per week, and keep it under 10% of the account's activity. No lazy titles.",
  },
  {
    name: "artificial",
    kinds: ["evolution"],
    flair: "Project",
    rules: "10% self-promo rule, the account's first post can't be promo, no clickbait titles; message the mods when unsure. Occasional, substantive posts only.",
  },
  {
    name: "ClaudeAI",
    kinds: ["evolution"],
    flair: "Built with Claude",
    rules: "Must be about Claude (the lab's changes are written by Claude Code); flair required; disclose you made it; no spam.",
  },
];

// A stable pick from a bank, different per clip.
export function pickFrom<T>(bank: readonly T[], seed: string, salt = ""): T {
  let h = 2166136261;
  for (const ch of `${seed}|${salt}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return bank[h % bank.length]!;
}

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The one-line "what is this" every post needs: viewers have never heard of Jev.
function who(f: ClipFacts): string {
  const lobby = f.humans ? `${f.humans}-player` : "public";
  return pickFrom(
    [
      `Jev is an AI playing OpenFront (openfront.io) in real ${lobby} lobbies against real people, live 24/7.`,
      `Jev is an AI that plays public OpenFront matches against humans, streamed live around the clock.`,
      `An AI (Jev) plays OpenFront against real players 24/7 on stream, and rewrites its own decision code between games.`,
    ],
    f.id,
    "who",
  );
}

function recordLine(b: BuildStats): string {
  const parts = [`${b.wins}/${b.games} wins`];
  if (b.meanPlacement !== null) parts.push(`avg placement #${Math.round(b.meanPlacement)}`);
  parts.push(`${b.medianMinutes} min survived`, `peak ${pct(b.meanPeakShare)} of the map`);
  return parts.join(", ");
}

// What happened, in plain words, for Reddit and descriptions.
function summary(f: ClipFacts): string {
  if (f.evolution) {
    const e = f.evolution;
    if (e.stage === "proposed") return `Claude Code, running headless between matches, studied Jev's last games and wrote one change to its decision code: "${e.title}". It passed typecheck and tests and now plays the next games.`;
    const verdict = e.verdict === "kept" ? "It beat the previous build, so it's kept as the new baseline." : "It didn't beat the previous build, so it was dropped.";
    return `Claude Code changed Jev's decision code ("${e.title}"), then it was measured on real games. Before: ${e.before ? recordLine(e.before) : "n/a"}. After: ${e.after ? recordLine(e.after) : "n/a"}. ${verdict}`;
  }
  const whats = f.moments.map((m) => sentence(m.what));
  if (f.kind === "compilation") return `The best moments from ${f.games ? plural(f.games, "game") : "tonight's games"}: ${whats.join(" ")}`;
  return `${whats.join(" ")}${f.map ? ` Map: ${f.map}.` : ""}`;
}

const BASE_TAGS = ["openfront", "ai", "strategygame", "gaming"];

function hashtags(f: ClipFacts, max: number): string[] {
  const kinds = new Set(f.moments.map((m) => m.kind));
  const extra: string[] = [];
  if (f.kind === "evolution") extra.push("claudecode", "machinelearning", "coding");
  if (kinds.has("wipeout") || kinds.has("conquest")) extra.push("conquest");
  if (kinds.has("nuke")) extra.push("nuke");
  if (kinds.has("last_stand")) extra.push("fail");
  extra.push("iogames", "aiplays", "livestream");
  return [...new Set([...BASE_TAGS, ...extra])].slice(0, max).map((t) => `#${t}`);
}

// A short title: the headline for gameplay, the change for the lab.
function title(f: ClipFacts): string {
  if (f.evolution) {
    const e = f.evolution;
    if (e.stage === "proposed") return pickFrom([`Claude Code just rewrote my AI's brain: "${e.title}"`, `AI rewrites itself between matches: "${e.title}"`, `Live on stream, Claude Code changed how my AI plays: "${e.title}"`], f.id, "t");
    if (e.verdict === "kept") return pickFrom([`My AI rewrote its brain and got better (${e.before?.wins ?? 0}/${e.before?.games ?? 0} → ${e.after?.wins ?? 0}/${e.after?.games ?? 0} wins)`, `Claude Code's change to my AI worked: "${e.title}"`], f.id, "t");
    return pickFrom([`Claude Code's change to my AI didn't help. Dropped: "${e.title}"`, `My AI tried to improve itself. It got worse: "${e.title}"`], f.id, "t");
  }
  return specificHeadline(f);
}

// "Wiped off the map" says nothing on its own in a feed full of them;
// "RIP Nova Carthago" does. The video keeps the line Jev picked.
export function specificHeadline(f: Pick<ClipFacts, "headline" | "alts" | "names">): string {
  const names = (f.names ?? []).filter((n) => n.length >= 3);
  const specific = (s: string) => /\d/.test(s) || names.some((n) => s.includes(n));
  return [f.headline, ...(f.alts ?? [])].find(specific) ?? f.headline;
}

function redditTitle(f: ClipFacts, sub: Subreddit): string {
  if (f.evolution) {
    const e = f.evolution;
    const result = e.stage === "proposed" ? "the next games test it" : e.verdict === "kept" ? `it helped (${e.before?.wins ?? 0}/${e.before?.games ?? 0} → ${e.after?.wins ?? 0}/${e.after?.games ?? 0} wins), so it stays` : "it didn't help, so it was dropped";
    return truncate(`My OpenFront AI improves itself live on stream: Claude Code proposed "${e.title}", and ${result}`, 300);
  }
  const lead = sub.name === "Openfront" ? "My AI bot Jev playing public lobbies" : "An AI playing OpenFront against real people";
  const what = f.kind === "compilation" ? `best moments from ${f.games ? plural(f.games, "game") : "one night"}` : f.moments[0] ? f.moments[0].what.replace(/^Jev /, "") : f.headline;
  return truncate(`${lead}: ${what}${f.map && f.kind !== "compilation" ? ` (${f.map})` : ""}`, 300);
}

export function sidecar(f: ClipFacts, video: string, createdAt: string): Sidecar {
  const t = title(f);
  const ttTags = hashtags(f, 5);
  const igTags = hashtags(f, 5); // Instagram allows 5 per post since 2025
  const body = summary(f);
  const cta = pickFrom([`Watch it live: ${STREAM_URL}`, `Live 24/7 at ${STREAM_URL}`, `Come heckle it live: ${STREAM_URL}`], f.id, "cta");
  const vote = f.kind === "evolution" ? "" : `\nViewers vote on its strategy: ${VOTE_URL}`;

  const tiktok = { caption: truncate(`${t} 🤖 ${who(f)}`, 2000 - 60), hashtags: ttTags };
  const youtube = {
    title: `${truncate(t, 100 - " #Shorts".length)} #Shorts`,
    description: [sentence(body), "", who(f), cta + vote, "", "#Shorts #OpenFront #AI"].join("\n"),
    tags: ["OpenFront", "openfront.io", "AI", "AI plays", "strategy game", "io game", "Jev", ...(f.kind === "evolution" ? ["Claude Code", "self-improving AI"] : [])],
    categoryId: "20", // Gaming
  };
  const instagram = { caption: truncate(`${t} 🤖\n\n${sentence(body)}\n\n${who(f)} Live on Kick: kick.com/jeviatus`, 2200 - 60), hashtags: igTags };

  // X: 280 characters, and no link: X bills a post with a URL ~13x a plain
  // one (2026 pay-per-use), so the stream goes by name (and in the bio).
  const xTags = ttTags.slice(0, 2).join(" ");
  const xTail = `\n\nLive on Kick: jeviatus\n${xTags}`;
  const x = { text: `${truncate(`${t} 🤖 ${who(f).replace(/ \(openfront\.io\)/, "")}`, 280 - xTail.length)}${xTail}` };

  const fits = SUBREDDITS.filter((s) => s.kinds.includes(f.kind));
  const posts = fits.map((s): RedditPost => ({ subreddit: s.name, title: redditTitle(f, s), flair: s.flair, rules: s.rules }));
  const [main, ...alternatives] = posts;

  return {
    id: f.id,
    kind: f.kind,
    video,
    durationSec: Math.round(f.durationSec * 10) / 10,
    createdAt,
    facts: f,
    platforms: { tiktok, youtube, instagram, x, reddit: { ...main!, alternatives } },
  };
}

