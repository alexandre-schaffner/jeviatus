// Measuring a build from real games: which traces count toward a commit, and
// how two commits compare. Pure; scripts/improve.ts does the waiting.

import type { Finding } from "../analyze/detect";
import type { GameRecord } from "../analyze/load";
import { type Aggregate, aggregate, buildReport, gameRow } from "../analyze/report";

// A game counts toward a build when that exact commit played it (the
// extension stamps its commit into the trace header), Jev actually made
// decisions, and the game is over for Jev. A game where most Jev calls failed
// (out of API credits, an outage) measures the outage, not the build.
export function gamesFor(games: GameRecord[], commit: string): GameRecord[] {
  return games.filter(
    (g) => g.harnessCommit === commit && g.steps.length > 0 && (g.summary !== null || g.death !== null || g.streamResult !== null) && jevWorked(g),
  );
}

export function jevWorked(g: GameRecord): boolean {
  const calls = g.steps.reduce((n, s) => n + s.calls, 0);
  const failed = g.steps.reduce((n, s) => n + s.failedCalls, 0);
  return calls > 0 && failed / calls < 0.5;
}

export interface BuildResult {
  commit: string;
  label: string;
  aggregate: Aggregate;
  // Bad-pattern hits per game, by detector key.
  badPerGame: Record<string, number>;
  findings: Finding[];
}

export function measure(label: string, commit: string, games: GameRecord[]): BuildResult {
  const { report } = buildReport(games);
  const n = Math.max(1, games.length);
  return {
    commit,
    label,
    aggregate: aggregate(label, games.map(gameRow)),
    badPerGame: Object.fromEntries(report.findings.filter((f) => f.kind === "bad").map((f) => [f.key, Math.round((f.count / n) * 100) / 100])),
    findings: report.findings,
  };
}

// Better: more wins, or as many wins and a better (lower) mean placement.
export function isBetter(candidate: Aggregate, baseline: Aggregate): boolean {
  if (candidate.winRate !== baseline.winRate) return candidate.winRate > baseline.winRate;
  if (candidate.meanPlacement === null || baseline.meanPlacement === null) return false;
  return candidate.meanPlacement < baseline.meanPlacement;
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);

export function comparisonMarkdown(baseline: BuildResult, candidate: BuildResult): string {
  const b = baseline.aggregate;
  const c = candidate.aggregate;
  const rows: [string, string, string][] = [
    ["games", String(b.games), String(c.games)],
    ["win rate", pct(b.winRate), pct(c.winRate)],
    ["mean placement (lower is better)", String(b.meanPlacement ?? "–"), String(c.meanPlacement ?? "–")],
    ["median minutes survived", String(b.medianMinutes), String(c.medianMinutes)],
    ["mean peak land", pct(b.meanPeakShare), pct(c.meanPeakShare)],
    ["alive at 10 min", pct(b.survival["10"]), pct(c.survival["10"])],
  ];
  const titles = new Map(candidate.findings.map((f) => [f.key, f.title]));
  for (const key of Object.keys(candidate.badPerGame)) {
    const before = baseline.badPerGame[key] ?? 0;
    const after = candidate.badPerGame[key] ?? 0;
    if (before !== 0 || after !== 0) rows.push([`${titles.get(key) ?? key} (per game)`, String(before), String(after)]);
  }
  const verdict = isBetter(c, b) ? "**Better than the baseline.**" : "**Not better than the baseline.**";
  return [
    `| | ${baseline.label} \`${baseline.commit.slice(0, 7)}\` | ${candidate.label} \`${candidate.commit.slice(0, 7)}\` |`,
    "| --- | --- | --- |",
    ...rows.map(([k, x, y]) => `| ${k} | ${x} | ${y} |`),
    "",
    `${verdict} With ${c.games} games per build this is a noisy signal, not proof.`,
  ].join("\n");
}

// The loop's LLM may change anything in the repo but OpenFront itself: it is
// pinned to the commit openfront.io runs, and the wire format and simulation
// must match the live server's.
export const OFF_LIMITS = ["vendor/", ".gitmodules"];
// What the extension bundles: the only code the next games play on.
export const LIVE_PATHS = ["harness/", "extension/"];

export function offLimits(files: string[]): string[] {
  return files.filter((f) => OFF_LIMITS.some((p) => f === p || f.startsWith(p)));
}
