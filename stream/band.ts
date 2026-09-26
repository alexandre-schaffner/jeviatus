// The strip under the game: the call to vote, what's playing, the ballot, how
// to bribe Jev (when bribes are on) and what the driver is doing. ffmpeg draws
// it (drawtext re-reads these files every frame), so it stays up while the
// browser restarts or navigates, and OpenFront's own page is never touched.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Ballot, type BallotEntry, potOf, type Pots, rank } from "./ballot";
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

export interface BandState {
  repo: string;
  playing: BallotEntry | null;
  // The pot that bought the match in play (it's spent by now).
  playingPot: bigint | null;
  ballot: Ballot | null;
  bribe: BribeBand | null;
  status: string;
  games: number;
  lastResult: string | null;
}

export const BAND_FILES = ["headline.txt", "playing.txt", "bribe.txt", "status.txt"] as const;
type BandFile = (typeof BAND_FILES)[number];

export function bandText(s: BandState): Partial<Record<BandFile, string>> {
  const b = s.bribe;
  const tokens = (raw: bigint) => `${formatTokens(raw, b?.decimals ?? 0)} $${b?.ticker ?? ""}`;
  const playing = !s.playing
    ? "NOW PLAYING  Jev's own judgment (no strategy has votes yet)"
    : `NOW PLAYING  "${s.playing.strategy.name}"  (PR #${s.playing.number} by @${s.playing.author}, ${s.playingPot ? `bribed ${tokens(s.playingPot)}` : `${s.playing.votes} votes`})`;
  const entries = rank(s.ballot?.entries ?? [], b?.pots, b?.minPot);
  const top = entries.slice(0, 3).map((e) => {
    const pot = b ? potOf(e, b.pots, b.minPot) : 0n;
    return `#${e.number} ${e.strategy.name} (${e.votes}${pot > 0n ? `, ${tokens(pot)}` : ""})`;
  });
  const history = s.games > 0 ? `  |  games streamed: ${s.games}${s.lastResult ? `, last: ${s.lastResult}` : ""}` : "";
  const text: Partial<Record<BandFile, string>> = {
    "headline.txt": `VOTE JEV'S STRATEGY  >  github.com/${s.repo}/pulls  ·  thumbs-up a PR, the top one plays next`,
    "playing.txt": `${playing}${top.length > 0 ? `   |   BALLOT  ${top.join("  ·  ")}` : ""}`,
    "status.txt": `${s.status}${history}`,
  };
  if (b) {
    const digits = tailDigits(b.decimals);
    const byAmount = digits >= 2 ? ` or amount ending .${"0".repeat(digits - 2)}12` : "";
    text["bribe.txt"] = b.thanks ?? `BRIBE  >  send $${b.ticker} to ${b.wallet}  ·  memo #12${byAmount} backs PR #12  ·  top pot plays next`;
  }
  return text;
}

export class Band {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  file(name: BandFile): string {
    return path.join(this.dir, name);
  }

  // Atomic replace: drawtext must never read a half-written file.
  write(s: BandState): void {
    for (const [name, text] of Object.entries(bandText(s))) {
      const target = path.join(this.dir, name);
      writeFileSync(`${target}.tmp`, text);
      renameSync(`${target}.tmp`, target);
    }
  }
}
