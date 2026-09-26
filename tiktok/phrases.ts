// Catchphrases for epic moments, and Jev as the editor: for every candidate
// moment it scores how well it would play on TikTok and picks the caption
// that fits it best. Jev chooses; it never writes free text, so everything
// burned into a public video comes from this reviewed bank. Without an API
// key, a deterministic pick stands in.

import { choice, type Questions, score } from "@typesafe-ai/sdk";
import type { Jev } from "../harness/jev/client";
import type { Moment, MomentKind } from "./moments";

// {name} placeholders are filled from Moment.facts. Short enough for two
// lines of big text; no emoji (burned-in fonts can't draw them).
export const PHRASES: Record<MomentKind, string[]> = {
  conquest: [
    "{target} didn't see it coming",
    "The AI chose violence",
    "Your land is my land, {target}",
    "Nothing personal, {target}",
    "{target} is getting cooked",
  ],
  wipeout: [
    "{target} has left the chat",
    "Deleted. {target} is gone",
    "Wiped off the map",
    "RIP {target}",
  ],
  surge: [
    "+{gain} of the map in {secs}s",
    "The AI is cooking",
    "Speedrunning world domination",
    "Land? I'll take all of it",
    "{x}x bigger in {secs} seconds",
  ],
  top_rank: [
    "From #{from_rank} to #1",
    "The AI is the main character now",
    "Humans, meet your new #1",
    "Top of the leaderboard. Still hungry",
  ],
  nuke: [
    "The AI found the nuke button",
    "Diplomacy has failed",
    "{target}, look up",
    "It launched {bomb}. On purpose",
  ],
  betrayal: [
    "Alliance? Never heard of her",
    "Trust issues: unlocked",
    "Sorry {target}, it's just business",
    "The AI read the fine print",
  ],
  underdog: [
    "{x}x the troops? Jev doesn't care",
    "Picking a fight it can't win?",
    "Confidence of an AI, troops of a toddler",
  ],
  last_stand: [
    "Even AIs have bad days",
    "Outplayed by {killer}",
    "Jev's final moments",
    "Peaked at {peak}. Then this happened",
  ],
  victory: [
    "Humans 0 - AI 1",
    "GG. The AI won the whole map",
    "An AI just beat {humans} real players",
  ],
};

// What each video says before the first moment lands, and after the last.
export const HOOK = "AN AI IS PLAYING OPENFRONT VS REAL PEOPLE";
export const OUTRO = ["VOTE JEV'S NEXT STRATEGY", "LINK IN BIO"];

export function fill(template: string, facts: Moment["facts"]): string | null {
  let missing = false;
  const text = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = facts[key];
    if (v === undefined || v === "?" || v === "") missing = true;
    return String(v ?? "");
  });
  return missing ? null : text;
}

// The phrases that can be filled for a moment, keyed for a Jev choice.
export function options(m: Moment): Record<string, string> {
  const out: Record<string, string> = {};
  PHRASES[m.kind].forEach((t, i) => {
    const text = fill(t, m.facts);
    if (text !== null) out[`p${i}`] = text;
  });
  return out;
}

export interface Pick {
  moment: Moment;
  phrase: string;
  // Every fillable phrase, best first (Jev's probabilities), so a video can
  // swap in the runner-up rather than repeat a line.
  ranked: string[];
  // 0..1: Jev's expected excitement level, or the heuristic heat offline.
  epic: number;
  by: "jev" | "fallback";
}

const ROLE =
  "You edit short vertical gameplay videos (TikTok) of Jev, an AI that plays OpenFront, a real-time territory game, against real people. " +
  "Viewers scroll fast: a moment earns its place only if something big visibly happens on screen.";

export function questions(opts: Record<string, string>): Questions {
  return {
    epic: score(
      {
        role: ROLE,
        question: "How strongly would this moment grab a viewer scrolling TikTok?",
        consider: [
          "`moment.what_happened` is what the viewer sees",
          "big swings of land, eliminations, nukes and betrayals beat slow growth",
          "an AI failing in a funny or dramatic way is also great content",
        ],
      },
      [
        "skip: nothing visible happens",
        "weak: a small change few would notice",
        "decent: a clear change on the map",
        "great: a dramatic swing people would rewatch",
        "legendary: a jaw-dropping moment people would share",
      ],
    ),
    phrase: choice(
      {
        role: ROLE,
        question: "Which catchphrase should appear in big letters over this moment?",
        consider: ["it must be true to `moment.what_happened`", "punchy and funny beats descriptive", "it should make sense to someone who never played OpenFront"],
      },
      opts,
    ),
  };
}

function momentState(m: Moment, ctx: { map: string | null; strategy: string | null }): Record<string, unknown> {
  return {
    moment: { kind: m.kind.replace("_", " "), what_happened: m.what, facts: m.facts, minute: Math.round(m.tick / 60) / 10 },
    game: { map: ctx.map ?? "unknown", jev_strategy_voted_by_viewers: ctx.strategy ?? "none, Jev's own judgment" },
  };
}

// Stable per moment, so re-rendering offline gives the same video.
function fallbackPhrase(m: Moment, opts: Record<string, string>): string {
  const keys = Object.keys(opts);
  let h = 0;
  for (const ch of `${m.kind}${m.tick}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return opts[keys[h % keys.length]!]!;
}

export async function direct(
  moments: Moment[],
  ctx: { map: string | null; strategy: string | null },
  jev: Jev | null,
  log: (line: string) => void = () => {},
): Promise<Pick[]> {
  return Promise.all(
    moments.map(async (m): Promise<Pick> => {
      const opts = options(m);
      if (jev) {
        try {
          const res = await jev.ask("tiktok", momentState(m, ctx) as never, questions(opts));
          const a = res.answers as Record<string, { type: string; score?: number; choice?: string; probabilities?: Record<string, number> }>;
          const epic = (a.epic?.score ?? 0) / 4;
          const probs = a.phrase?.probabilities ?? {};
          const ranked = Object.keys(opts).sort((x, y) => (probs[y] ?? 0) - (probs[x] ?? 0)).map((k) => opts[k]!);
          const phrase = opts[a.phrase?.choice ?? ""] ?? ranked[0] ?? fallbackPhrase(m, opts);
          return { moment: m, phrase, ranked: [phrase, ...ranked.filter((r) => r !== phrase)], epic, by: "jev" };
        } catch (err) {
          log(`[jev] ${m.kind}@${m.tick}: ${err instanceof Error ? err.message : String(err)}; using the fallback`);
        }
      }
      const phrase = fallbackPhrase(m, opts);
      return { moment: m, phrase, ranked: [phrase, ...Object.values(opts).filter((o) => o !== phrase)], epic: m.heat, by: "fallback" };
    }),
  );
}

// The moments that make the video: the most epic ones, in game order, and
// no catchphrase twice (a later moment takes its next-best line).
export function select(picks: Pick[], max: number, minEpic = 0.4): Pick[] {
  const rank = (p: Pick) => p.epic * 0.75 + p.moment.heat * 0.25;
  const chosen = picks
    .filter((p) => p.epic >= minEpic || p.moment.kind === "victory")
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, max)
    .sort((a, b) => a.moment.tick - b.moment.tick);
  const used = new Set<string>();
  return chosen.map((p) => {
    const phrase = p.ranked.find((r) => !used.has(r)) ?? p.phrase;
    used.add(phrase);
    return { ...p, phrase };
  });
}

// The small line under the catchphrase: the number that makes it real.
export function statLine(m: Moment): string | null {
  const f = m.facts;
  const line = {
    surge: "{from} TO {to} OF THE MAP",
    conquest: "JEV VS {target}",
    wipeout: "{target}: ELIMINATED",
    top_rank: "#1 OF {players_alive} PLAYERS",
    nuke: "TARGET: {target}",
    betrayal: "EX-ALLY: {target}",
    underdog: "{x}X OUTNUMBERED",
    last_stand: "ELIMINATED AT {time}",
    victory: "WON AT {time}",
  }[m.kind];
  return fill(line, f)?.toUpperCase() ?? null;
}
