// The analysis report: one row per game, aggregates by strategy, source and
// harness commit (to compare play before and after a change), the pattern
// findings, and the key moments dumped step by step for manual review.

import { COLLAPSE_MIN, collapseScore, detectAll, type Evidence, type Finding, GAIN_MIN, gainScore, type Swing, swings, topSwings } from "./detect";
import type { GameRecord, StepRow } from "./load";

export interface GameRow {
  game: string;
  source: string;
  strategy: string;
  map: string;
  players: number | null;
  harnessCommit: string;
  outcome: "won" | "lost" | "eliminated" | "alive" | "unknown";
  outcomeDetail: string;
  streamResult: string | null;
  placement: number | null;
  finalRank: number | null;
  bestRank: number | null;
  minutesSurvived: number;
  died: boolean;
  peakShare: number;
  peakMinute: number | null;
  finalShare: number;
  causeOfDeath: string | null;
  routeMix: Record<string, number>;
  holdRate: number;
  topHoldReasons: string[];
  jevCalls: number;
  jevFailures: number;
  meanLatencyMs: number;
}

export interface Aggregate {
  key: string;
  games: number;
  wins: number;
  winRate: number;
  meanPlacement: number | null;
  medianMinutes: number;
  meanPeakShare: number;
  // Share of games still alive at each minute mark (games that ended alive
  // before a mark don't count toward it).
  survival: Record<string, number | null>;
}

export interface Moment {
  game: string;
  kind: "collapse" | "gain";
  tick: number;
  minute: number;
  before: number;
  after: number;
  steps: StepRow[];
  file: string;
}

export interface Report {
  generatedAt: string;
  games: GameRow[];
  overall: Aggregate;
  byStrategy: Aggregate[];
  bySource: Aggregate[];
  byCommit: Aggregate[];
  findings: Finding[];
  moments: Omit<Moment, "steps">[];
}

export const SURVIVAL_MARKS = [2, 5, 10, 15, 20, 30, 45, 60];
const MOMENTS_PER_KIND = 8;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

export function gameRow(g: GameRecord): GameRow {
  const main = g.steps.filter((s) => s.me !== null);
  const last = main.at(-1);
  const summary = g.summary;
  const died = g.death !== null || summary?.outcome === "eliminated";
  const won = summary?.won === true || /JEV WON/i.test(g.streamResult ?? "");
  const lost = !won && /someone else won/.test(summary?.outcome ?? "");
  const outcome: GameRow["outcome"] = won ? "won" : died ? "eliminated" : lost ? "lost" : summary?.alive || last !== undefined ? "alive" : "unknown";

  let peakShare = 0;
  let peakMinute: number | null = null;
  for (const s of main) {
    if (s.me!.land_share > peakShare) {
      peakShare = s.me!.land_share;
      peakMinute = s.minute;
    }
  }
  // The agent tracks its peak every step, traced or not.
  peakShare = Math.max(peakShare, summary?.peakLandShare ?? 0);
  const ranks = main.map((s) => s.me!.land_rank).filter((r): r is number => r !== null);
  const finalRank = last?.me?.land_rank ?? null;
  // Battle-royale placement: a winner is 1st; the eliminated place behind
  // everyone still alive when they fell; survivors by land rank.
  const placement = won ? 1 : died ? (last?.playersAlive ?? null) : finalRank;

  const routeMix: Record<string, number> = {};
  for (const s of main) {
    const a = s.record?.action ?? s.route;
    routeMix[a] = (routeMix[a] ?? 0) + 1;
  }
  const holds = main.filter((s) => s.record?.action === "hold");
  const reasons = new Map<string, number>();
  for (const s of holds) {
    const why = (s.holdReason ?? s.record?.detail ?? "chose to hold").replace(/\d+(\.\d+)?/g, "#");
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }
  const calls = g.steps.reduce((n, s) => n + s.calls, 0);
  const failures = g.steps.reduce((n, s) => n + s.failedCalls, 0);
  const latency = g.steps.reduce((n, s) => n + s.callLatencyMs, 0);

  return {
    game: g.id,
    source: g.source,
    strategy: g.strategy,
    map: g.map,
    players: g.players,
    harnessCommit: g.harnessCommit,
    outcome,
    outcomeDetail: summary?.outcome ?? (died ? "eliminated" : "no summary"),
    streamResult: g.streamResult,
    placement,
    finalRank,
    bestRank: ranks.length ? Math.min(...ranks) : null,
    minutesSurvived: r1((g.death?.tick ?? summary?.ticksSurvived ?? g.lastTick) / 600),
    died,
    peakShare: r3(peakShare),
    peakMinute,
    finalShare: r3(died ? 0 : (last?.me?.land_share ?? summary?.finalLandShare ?? 0)),
    causeOfDeath: g.death
      ? g.death.attackers.length
        ? g.death.attackers.map((a) => `${a.name ?? a.ref}${a.troops_vs_mine !== null ? ` (${a.troops_vs_mine}x troops)` : ""}`).join(", ")
        : "no attacker seen"
      : null,
    routeMix,
    holdRate: main.length ? r3(holds.length / main.length) : 0,
    topHoldReasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`),
    jevCalls: calls,
    jevFailures: failures,
    meanLatencyMs: calls ? Math.round(latency / calls) : 0,
  };
}

export function aggregate(key: string, rows: GameRow[]): Aggregate {
  const wins = rows.filter((r) => r.outcome === "won").length;
  const placed = rows.map((r) => r.placement).filter((p): p is number => p !== null);
  const minutes = rows.map((r) => r.minutesSurvived).sort((a, b) => a - b);
  const survival: Record<string, number | null> = {};
  for (const m of SURVIVAL_MARKS) {
    const counted = rows.filter((r) => r.died || r.minutesSurvived >= m);
    survival[String(m)] = counted.length ? r3(counted.filter((r) => r.minutesSurvived >= m).length / counted.length) : null;
  }
  return {
    key,
    games: rows.length,
    wins,
    winRate: rows.length ? r3(wins / rows.length) : 0,
    meanPlacement: placed.length ? r1(placed.reduce((a, b) => a + b, 0) / placed.length) : null,
    medianMinutes: minutes.length ? minutes[Math.floor(minutes.length / 2)] : 0,
    meanPeakShare: rows.length ? r3(rows.reduce((a, r) => a + r.peakShare, 0) / rows.length) : 0,
    survival,
  };
}

function groupBy(rows: GameRow[], key: (r: GameRow) => string): Aggregate[] {
  const groups = new Map<string, GameRow[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return [...groups].map(([k, rs]) => aggregate(k, rs)).sort((a, b) => b.games - a.games);
}

// The biggest collapses (land down 30%+ within a minute) and gains, each with
// the three steps leading into it.
export function keyMoments(games: GameRecord[], perKind = MOMENTS_PER_KIND): Moment[] {
  const pick = (kind: Moment["kind"], score: (s: Swing) => number, min: number) =>
    games
      .flatMap((g) => topSwings(swings(g), score, perKind, min).map((s) => ({ g, s, score: score(s) })))
      .sort((a, b) => b.score - a.score)
      .slice(0, perKind)
      .map(({ g, s }): Moment => {
        const i = g.steps.indexOf(s.from);
        return {
          game: g.id,
          kind,
          tick: s.from.tick,
          minute: s.from.minute,
          before: s.before,
          after: s.after,
          steps: g.steps.slice(Math.max(0, i - 2), i + 1),
          file: `${safe(g.id)}-${s.from.tick}.md`,
        };
      });
  return [...pick("collapse", collapseScore, COLLAPSE_MIN), ...pick("gain", gainScore, GAIN_MIN)];
}

const safe = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_");

export function buildReport(games: GameRecord[]): { report: Report; moments: Moment[] } {
  const rows = games.map(gameRow);
  const moments = keyMoments(games);
  return {
    report: {
      generatedAt: new Date().toISOString(),
      games: rows,
      overall: aggregate("all", rows),
      byStrategy: groupBy(rows, (r) => r.strategy),
      bySource: groupBy(rows, (r) => r.source),
      byCommit: groupBy(rows, (r) => r.harnessCommit.slice(0, 12) + (r.harnessCommit.endsWith("+dirty") ? "+dirty" : "")),
      findings: detectAll(games),
      moments: moments.map(({ steps: _steps, ...m }) => m),
    },
    moments,
  };
}

// --- markdown ----------------------------------------------------------------------

function table(head: string[], rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => (v === null ? "–" : String(v).replace(/\|/g, "\\|").replace(/\n/g, " "));
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

function aggregateTable(title: string, aggs: Aggregate[]): string {
  const marks = [5, 10, 20, 30];
  return `### ${title}\n\n${table(
    ["", "games", "wins", "win rate", "mean placement", "median min", "mean peak land", ...marks.map((m) => `alive@${m}m`)],
    aggs.map((a) => [
      a.key,
      a.games,
      a.wins,
      pct(a.winRate),
      a.meanPlacement,
      a.medianMinutes,
      pct(a.meanPeakShare),
      ...marks.map((m) => (a.survival[String(m)] === null ? null : pct(a.survival[String(m)]!))),
    ]),
  )}`;
}

function evidenceLine(e: Evidence): string {
  return `  - \`${e.game}\` t=${e.tick} (${e.minute} min): ${e.note}`;
}

export function renderReport(r: Report): string {
  const out: string[] = [];
  out.push(`# Jev game report`, "", `${r.games.length} game(s), generated ${r.generatedAt}.`, "");
  out.push("## Aggregates", "");
  out.push(aggregateTable("Overall", [r.overall]), "");
  out.push(aggregateTable("By strategy", r.byStrategy), "");
  out.push(aggregateTable("By source", r.bySource), "");
  out.push(aggregateTable("By harness commit", r.byCommit), "");

  for (const kind of ["bad", "good"] as const) {
    out.push(kind === "bad" ? "## What goes wrong" : "## What works", "");
    const list = r.findings.filter((f) => f.kind === kind).sort((a, b) => b.count - a.count);
    for (const f of list) {
      out.push(`- **${f.title}**: ${f.count} time(s) in ${f.games} game(s)`);
      out.push(...f.evidence.map(evidenceLine));
    }
    out.push("");
  }

  out.push("## Key moments", "", "The three steps leading into each, in `moments/`.", "");
  for (const m of r.moments) {
    out.push(`- ${m.kind === "collapse" ? "Collapse" : "Gain"} \`${m.game}\` ${m.minute} min: ${pct(m.before)} → ${pct(m.after)} ([moments/${m.file}](moments/${m.file}))`);
  }
  out.push("");

  out.push("## Games", "");
  out.push(
    table(
      ["game", "source", "strategy", "map", "players", "outcome", "placement", "rank final/best", "min survived", "peak land (min)", "final land", "cause of death", "routes", "hold rate", "top hold reasons", "Jev fails", "ms/call"],
      r.games.map((g) => [
        g.game,
        g.source,
        g.strategy,
        g.map,
        g.players,
        `${g.outcome}${g.streamResult ? ` · stream: ${g.streamResult}` : ""}`,
        g.placement,
        `${g.finalRank ?? "–"}/${g.bestRank ?? "–"}`,
        g.minutesSurvived,
        `${pct(g.peakShare)}${g.peakMinute !== null ? ` (${g.peakMinute})` : ""}`,
        pct(g.finalShare),
        g.causeOfDeath,
        Object.entries(g.routeMix).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", "),
        pct(g.holdRate),
        g.topHoldReasons.join("; "),
        `${g.jevFailures}/${g.jevCalls}`,
        g.meanLatencyMs,
      ]),
    ),
    "",
  );
  return out.join("\n");
}

// --- moment dumps ------------------------------------------------------------------

type Answer = { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; score?: number; noul?: number };

function topProbs(p: Record<string, number> | undefined, n = 4): string {
  if (!p) return "";
  return Object.entries(p)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(", ");
}

function answerLine(id: string, a: Answer): string {
  if (a.type === "choice") return `${id}: **${a.choice}** (conf ${a.confidence?.toFixed(2)}; ${topProbs(a.probabilities)})`;
  if (a.type === "score") return `${id}: score ${a.score} (conf ${a.confidence?.toFixed(2)})`;
  if (a.type === "noul") return `${id}: ${a.noul?.toFixed(2)}`;
  return `${id}: ${JSON.stringify(a)}`;
}

// The players worth showing: whoever attacks me, whom I attack, allies, and
// this step's target.
function relevantPlayers(s: StepRow): StepRow["players"] {
  const refs = new Set([...(s.me?.under_attack_by ?? []), ...(s.me?.attacking ?? []), ...(s.me?.allies ?? []), s.record?.target].filter(Boolean));
  return s.players.filter((p) => refs.has(p.ref) || p.attacking_me || p.i_am_attacking);
}

export function renderMoment(m: Moment): string {
  const out: string[] = [];
  out.push(`# ${m.kind === "collapse" ? "Collapse" : "Gain"}: ${m.game} at ${m.minute} min`, "");
  out.push(`Land ${pct(m.before)} → ${pct(m.after)} within a minute of t=${m.tick}. The steps leading in:`, "");
  for (const s of m.steps) {
    out.push(`## t=${s.tick} (${s.minute} min)`, "");
    if (s.me) {
      const me = s.me;
      out.push(
        `- **me**: land ${pct(me.land_share)} (rank ${me.land_rank}), ${me.tiles} tiles, troops ${me.troops} (fill ${me.troop_fill}), gold ${me.gold}, ` +
          `unclaimed on border ${me.unclaimed_land_on_border}${me.expanding_into_unclaimed ? " (expanding)" : ""}; ` +
          `under attack by [${me.under_attack_by.join(", ")}], attacking [${me.attacking.join(", ")}], allies [${me.allies.join(", ")}]`,
      );
    }
    for (const p of relevantPlayers(s)) {
      const tags = [p.attacking_me && "attacking me", p.i_am_attacking && "I attack", p.is_ally && "ally"].filter(Boolean).join(", ");
      out.push(`- ${p.ref} ${p.name} (${p.kind ?? "?"}): land ${pct(Number(p.land_share ?? 0))}, troops ${p.troops_vs_mine}x mine${tags ? `; ${tags}` : ""}`);
    }
    out.push(
      `- **decision**: ${s.route}${s.held ? ` HELD (${s.holdReason})` : ""}, conf ${s.confidence.toFixed(2)}, ${s.stage ? `${s.stage} game, ` : ""}goal ${s.goal ?? "?"}` +
        (s.record ? `; recorded ${s.record.action}${s.record.target ? ` → ${s.record.target}` : ""}${s.record.detail ? ` (${s.record.detail})` : ""}` : ""),
    );
    if (s.answers) {
      out.push("- **answers**:");
      for (const [id, a] of Object.entries(s.answers)) out.push(`  - ${answerLine(id, a as Answer)}`);
    }
    out.push(`- **intents**: ${s.intents.map((i) => `${i.desc}${i.sent ? "" : ` (not sent: ${i.reason})`}`).join("; ") || "none"}`);
    out.push(`- **outcome**: ${s.outcome ?? "not settled"}`, "");
  }
  return out.join("\n");
}
