// The improvement loop's pure parts: which games count toward a build, how
// two builds compare, what the LLM may touch, and reading its proposal.

import { describe, expect, test } from "bun:test";
import type { GameRecord } from "../harness/analyze/load";
import { comparisonMarkdown, gamesFor, isBetter, measure, offLimits } from "../harness/improve/measure";
import { changePrompt, parseProposal } from "../harness/improve/prompt";

const A = "a".repeat(40);
const B = "b".repeat(40);

function game(id: string, commit: string, over: Partial<GameRecord> = {}): GameRecord {
  const me = { land_share: 0.1, land_rank: 2, tiles: 100, troops: 1, troop_fill: 0.5, gold: 0, under_attack_by: [], attacking: [], allies: [], unclaimed_land_on_border: 0, expanding_into_unclaimed: false };
  const step = { tick: 600, minute: 1, me, playersAlive: 5, players: [], route: "expand", held: false, confidence: 1, used: {}, intents: [], buildOptions: [], answers: null, calls: 1, failedCalls: 0, callLatencyMs: 1 };
  return {
    id, dir: id, agent: "Jev", source: "extension", strategy: "s", map: "World", players: 5, harnessCommit: commit, model: "m", startedAt: null,
    steps: [step], spawns: [], death: null, summary: { name: "Jev", alive: true, won: false, outcome: "alive (game not finished)", peakLandShare: 0.1, finalLandShare: 0.1, ticksSurvived: 600, steps: 1, holds: 0 },
    summaryReason: "socket closed", streamResult: null, errors: [], lastTick: 600,
    ...over,
  };
}

describe("games per build", () => {
  test("only finished games Jev played, on exactly that commit", () => {
    const games = [
      game("ok", A),
      game("other build", B),
      game("dirty build", `${A}+dirty`),
      game("never played", A, { steps: [] }),
      game("still running", A, { summary: null }),
      game("died, not yet closed", A, { summary: null, death: { tick: 600, minutes: 1, landShareBefore: 0.1, peakLandShare: 0.1, attackers: [] } }),
      game("out of API credits", A, { steps: [{ ...game("x", A).steps[0], calls: 3, failedCalls: 3 }] }),
    ];
    expect(gamesFor(games, A).map((g) => g.id)).toEqual(["ok", "died, not yet closed"]);
  });
});

describe("comparing builds", () => {
  const agg = (winRate: number, meanPlacement: number | null) => ({ key: "", games: 6, wins: 0, winRate, meanPlacement, medianMinutes: 0, meanPeakShare: 0, survival: {} });

  test("more wins beats placement; then lower placement wins", () => {
    expect(isBetter(agg(0.5, 4), agg(0.33, 1))).toBe(true);
    expect(isBetter(agg(0, 3), agg(0, 4))).toBe(true);
    expect(isBetter(agg(0, 4), agg(0, 4))).toBe(false);
    expect(isBetter(agg(0, null), agg(0, 4))).toBe(false);
  });

  test("the PR comment shows both builds and a verdict", () => {
    const won = game("w", B, { summary: { name: "Jev", alive: true, won: true, outcome: "won", peakLandShare: 0.5, finalLandShare: 0.5, ticksSurvived: 9000, steps: 1, holds: 0 } });
    const md = comparisonMarkdown(measure("baseline", A, [game("x", A)]), measure("change 1", B, [won]));
    expect(md).toContain("`aaaaaaa`");
    expect(md).toContain("| win rate | 0% | 100% |");
    expect(md).toContain("**Better than the baseline.**");
  });
});

test("the LLM may touch anything but OpenFront itself", () => {
  expect(offLimits(["harness/decide/questions.ts", "harness/agent.ts", "extension/src/content.ts", "package.json", "stream/lab.ts"])).toEqual([]);
  expect(offLimits(["vendor/OpenFrontIO", "vendor/OpenFrontIO/src/core/game/Game.ts", ".gitmodules", "vendorPatches.ts"])).toEqual(["vendor/OpenFrontIO", "vendor/OpenFrontIO/src/core/game/Game.ts", ".gitmodules"]);
});

describe("the proposal", () => {
  test("title on line 1, description after; NO CHANGE is recognized", () => {
    expect(parseProposal("# Defend before attacking when under attack\n\n## Pattern\nx")).toEqual({
      title: "Defend before attacking when under attack",
      body: "## Pattern\nx",
      noChange: false,
    });
    expect(parseProposal("NO CHANGE\n\nonly two games")?.noChange).toBe(true);
    expect(parseProposal("  \n")).toBeNull();
  });

  test("the prompt points at the analysis, the rules and what was tried", () => {
    const p = changePrompt({ games: 6, commit: A, past: [{ title: "Hint about idle gold", verdict: "did not help" }] });
    expect(p).toContain(".loop/analysis/report.md");
    expect(p).toContain("harness/decide/");
    expect(p).toContain("Hint about idle gold: did not help");
    expect(p).toContain(".loop/proposal.md");
  });
});
