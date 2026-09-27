// The strip under the game (laid out in stream/bandLayout.ts): what's
// happening, the strategy in play (the newest merged) and the proposals
// leading the review queue, how to propose and promote one (bribes, when on), and on the right the match clock, Jev's
// standing, the stream's record and what the lab is testing. ffmpeg draws it
// (drawtext re-reads these files every frame), so it stays up while the
// browser restarts or navigates, and OpenFront's own page is never touched.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Ballot, type LiveStrategy, potOf, type Pots, rank } from "./ballot";
import { type BandDesign, bandDesign, type BandFile, fit, textWidth } from "./bandLayout";
import { formatTokens, tailDigits } from "./bribes";

// Bribes in the stream's pump.fun coin (stream/bribes.ts).
export interface BribeBand {
  wallet: string;
  ticker: string;
  decimals: number;
  pots: Pots;
  minPot: bigint;
  // Shown instead of the how-to for a while after a bribe lands.
  thanks: string | null;
}

// What the lab (stream/lab.ts) is measuring.
export interface LabBand {
  // "baseline" or "change 3"; null before the first session.
  build: string | null;
  title: string | null;
  // Its games so far, and how they went.
  games: number;
  wins: number;
  meanPlacement: number | null;
  needed: number;
  everyGames: number;
}

export interface BandState {
  repo: string;
  // The newest merged strategy, in play.
  playing: LiveStrategy | null;
  ballot: Ballot | null;
  bribe: BribeBand | null;
  // What's happening: the camera's subject in a match, else what the driver does.
  status: string;
  // The match clock and Jev's place in it ("#4 of 23 · 6.2% land"), in a match only.
  clock: string | null;
  standing: string | null;
  games: number;
  wins: number;
  lastResult: string | null;
  lab: LabBand | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// One line, in glyphs the band's fonts have: no control characters, no emoji.
const clean = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\p{Extended_Pictographic}\u{fe0f}\u{200d}]/gu, "")
    .trim();

// The build under test, its games so far and how they went.
function labText(lab: LabBand | null, games: number): string[] {
  if (!lab) return [];
  const next = (Math.floor(games / lab.everyGames) + 1) * lab.everyGames;
  if (lab.build === null) return [`first session after game ${next}`];
  const score = [...(lab.meanPlacement !== null ? [`avg place ${lab.meanPlacement}`] : []), ...(lab.wins > 0 ? [plural(lab.wins, "win")] : [])];
  if (lab.games >= lab.needed) return [`${lab.build}: verdict after game ${next}`, ...score.map((x) => ` · ${x}`)];
  return [`${lab.build} · ${lab.games}/${lab.needed} games`, ...score.map((x) => ` · ${x}`)];
}

export function bandText(s: BandState, design: BandDesign = bandDesign({ width: 1280, height: 720, bribes: s.bribe !== null, lab: true })): Partial<Record<BandFile, string>> {
  const b = s.bribe;
  const tokens = (raw: bigint) => `${formatTokens(raw, b?.decimals ?? 0)} $${b?.ticker ?? ""}`;
  // The review queue's leaders: open proposals, by bribes then 👍.
  const others = rank(s.ballot?.entries ?? [], b?.pots, b?.minPot)
    .slice(0, 2)
    .map((e) => {
      const pot = b ? potOf(e, b.pots, b.minPot) : 0n;
      return `#${e.number} ${e.strategy.name} (${e.votes}${pot > 0n ? `, ${tokens(pot)}` : ""})`;
    });
  const playing = s.playing ? `"${s.playing.strategy.name}"  ·  by @${s.playing.author}, PR #${s.playing.number}` : "Jev's own judgment (no strategy merged yet)";
  const next = s.games + 1;
  // Each file is its parts: the first always shows, each next one only if it
  // fits whole, so the band drops details instead of cutting words.
  const parts: Partial<Record<BandFile, string[]>> = {
    "now.txt": [s.status],
    "strategy.txt": [playing, ...others.map((o, i) => (i === 0 ? `      PROPOSED  ${o}` : `  ·  ${o}`))],
    "vote.txt": [`github.com/${s.repo}/pulls`, b ? "  ·  propose a PR; thumbs-up or bribe it into review" : "  ·  propose a PR, thumbs-up the best"],
    "game.txt": [s.clock ? `GAME #${next}  ·  LIVE` : "NEXT GAME"],
    "clock.txt": [s.clock ?? `#${next}`],
    "standing.txt": [s.clock ? (s.standing ?? "") : s.lastResult ? `Last: ${s.lastResult}` : ""],
    "record.txt": [s.games > 0 ? `${plural(s.wins, "win")} in ${plural(s.games, "game")}` : "first game of this stream"],
    "lab.txt": labText(s.lab, s.games),
  };
  if (b) {
    const digits = tailDigits(b.decimals);
    const byAmount = digits >= 2 ? ` or amount ending .${"0".repeat(digits - 2)}12` : "";
    parts["bribe.txt"] = b.thanks ? [b.thanks] : [`send $${b.ticker} to ${b.wallet}`, `  ·  memo #12${byAmount} promotes PR #12`, "  ·  top pots get reviewed first"];
  }
  // Each to the width of its slot (drawtext would run it off the band), and
  // never empty: ffmpeg can fail to map a zero-byte file.
  const text: Partial<Record<BandFile, string>> = {};
  for (const [name, [first = "", ...rest]] of Object.entries(parts) as [BandFile, string[]][]) {
    const slot = design.slots.find((x) => x.file === name);
    let t = clean(first);
    if (slot) {
      for (const more of rest) {
        const longer = t + more.replace(/[\u0000-\u001f\u007f]+/g, " ");
        if (textWidth(longer, slot.font, slot.size) > slot.maxWidth * 0.97) break;
        t = longer;
      }
      t = fit(t, slot.font, slot.size, slot.maxWidth);
    }
    text[name] = t || " ";
  }
  return text;
}

export class Band {
  constructor(
    readonly dir: string,
    readonly design: BandDesign,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  // Atomic replace: drawtext must never read a half-written file.
  write(s: BandState): void {
    for (const [name, text] of Object.entries(bandText(s, this.design))) {
      const target = path.join(this.dir, name);
      writeFileSync(`${target}.tmp`, text);
      renameSync(`${target}.tmp`, target);
    }
  }
}
