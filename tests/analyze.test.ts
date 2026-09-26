// The analyzer on synthetic traces: what each detector should catch, and
// that the report and the moment dumps render.

import { describe, expect, test } from "bun:test";
import { detectAll, tilesDelta } from "../harness/analyze/detect";
import { parseTrace } from "../harness/analyze/load";
import { buildReport, gameRow, renderMoment, renderReport } from "../harness/analyze/report";

interface StepSpec {
  tick: number;
  share: number;
  fill?: number;
  unclaimed?: number;
  expanding?: boolean;
  underAttackBy?: string[];
  allies?: string[];
  action?: string;
  target?: string;
  build?: string[];
  intents?: { desc: string; sent: boolean; intent?: { type: string } }[];
  players?: Record<string, unknown>[];
  alive?: number;
  outcome?: string;
}

const P2 = { ref: "P2", name: "Bully", kind: "nation", land_share: 0.2, troops_vs_mine: 1.6 };
const P3 = { ref: "P3", name: "Raider", kind: "human", land_share: 0.1, troops_vs_mine: 0.8, attacking_me: true };

function step(agent: string, s: StepSpec, prevAction?: { action: string; outcome: string }) {
  const action = s.action ?? "hold";
  return {
    type: "step",
    agent,
    tick: s.tick,
    candidates: { build: s.build ?? [] },
    decision: {
      route: action === "hold" ? "hold" : action,
      held: false,
      holdReason: action === "hold" ? "chose to hold" : undefined,
      confidence: 0.8,
      used: { route: 0.8 },
      record: { action, ...(s.target ? { target: s.target } : {}) },
    },
    calls: [
      {
        label: "route",
        latencyMs: 400,
        state: {
          game: { tick: s.tick, players_alive: s.alive ?? 10 },
          me: {
            land_share: s.share,
            land_rank: 3,
            tiles: Math.round(s.share * 10000),
            troops: 10000,
            troop_fill: s.fill ?? 0.5,
            gold: 200000,
            under_attack_by: s.underAttackBy ?? [],
            attacking: s.target ? [s.target] : [],
            allies: s.allies ?? [],
            unclaimed_land_on_border: s.unclaimed ?? 0,
            expanding_into_unclaimed: s.expanding ?? false,
          },
          players: s.players ?? [P2, P3],
          memory: { recent_actions: prevAction ? [{ min: 0, action: prevAction.action, outcome: prevAction.outcome }] : [] },
        },
        answers: { route: { type: "choice", choice: action, confidence: 0.8, probabilities: { [action]: 0.8, expand: 0.2 } } },
      },
    ],
    intents: s.intents ?? [],
    memory: { goal: "grow_territory" },
  };
}

// Consecutive steps 15 ticks apart; each settles the previous one's action.
function steps(agent: string, specs: StepSpec[]): Record<string, unknown>[] {
  return specs.map((s, i) => {
    const prev = specs[i - 1];
    return step(agent, s, prev ? { action: prev.action ?? "hold", outcome: prev.outcome ?? "+0 tiles, +0 troops, +0 gold" } : undefined);
  });
}

const range = (from: number, n: number, f: (tick: number, i: number) => Omit<StepSpec, "tick">, every = 15): StepSpec[] =>
  Array.from({ length: n }, (_, i) => ({ tick: from + i * every, ...f(from + i * every, i) }));

// A stream game: slow start, a bad war, a collapse, death.
function lostGame(): string {
  const specs = [
    // 0:30-1:15, idle next to unclaimed land (holds), troops full.
    ...range(300, 30, () => ({ share: 0.01, unclaimed: 40, fill: 0.97 })),
    // Growing, gold idle with a city affordable.
    ...range(750, 30, (_t, i) => ({ share: 0.01 + i * 0.002, action: "expand", expanding: true, build: ["city"] })),
    // Attacks a stronger P2 while P3 attacks me; the attack loses land.
    { tick: 1200, share: 0.07, action: "attack_player", target: "P2", underAttackBy: ["P3"], outcome: "-120 tiles, -4,000 troops, +0 gold", intents: [{ desc: "attack P2", sent: true, intent: { type: "attack" } }] },
    // The same war a step later is the same episode; a rate-limited send isn't an attack.
    { tick: 1203, share: 0.07, action: "attack_player", target: "P2", underAttackBy: ["P3"], intents: [{ desc: "attack P2", sent: true, intent: { type: "attack" } }] },
    { tick: 1206, share: 0.07, action: "attack_player", target: "P2", underAttackBy: ["P3"], intents: [{ desc: "attack P2", sent: false }] },
    // Collapse: 7% -> 1% within a minute.
    ...range(1215, 30, (_t, i) => ({ share: Math.max(0.005, 0.07 - i * 0.003), underAttackBy: ["P3"], alive: 8 })),
  ];
  const events = [
    { type: "run", source: "extension", gameID: "LOST01", map: "World", players: 20, gameType: "Public", model: "jev-1.13.0", config: {}, strategy: { name: "Turtle", doctrine: "Hide." }, harnessCommit: "a".repeat(40), openfrontCommit: "b".repeat(40), startedAt: "2026-09-26T10:00:00Z" },
    { type: "spawn", agent: "Jev", tick: 280, recheck: false, calls: [{ label: "spawn", latencyMs: 300, state: { game: { spawn_phase_ticks_left: 20 } } }], intents: [{ desc: "spawn@1", sent: true }] },
    ...steps("Jev", specs),
    { type: "death", agent: "Jev", tick: 1700, minutes: 2.8, landShareBefore: 0.005, peakLandShare: 0.07, attackers: [{ ref: "P3", name: "Raider", troops_vs_mine: 3.2, threat: 2.5 }] },
    { type: "stream_result", result: "eliminated at 2:50", strategy: null, pr: 4, votes: 3, wallMs: 200000 },
    { type: "summary", tick: 1800, agents: [{ name: "Jev", alive: false, won: false, outcome: "eliminated", peakLandShare: 0.07, finalLandShare: 0, ticksSurvived: 1700, steps: 91, holds: 30 }], reason: "socket closed", jev: { calls: 92 } },
  ];
  return events.map((e) => JSON.stringify(e)).join("\n");
}

// A CLI game: steady growth and a win at 6.5 min, allied the whole way.
function wonGame(): string {
  const specs = range(300, 60, (_t, i) => ({
    share: 0.02 + i * 0.005,
    allies: ["P2"],
    action: i % 3 === 0 ? "build" : "expand",
    build: i % 3 === 0 ? ["city"] : [],
    intents: i % 3 === 0 ? [{ desc: "build city", sent: true, intent: { type: "build_unit" } }] : [],
  }), 60);
  const events = [
    { type: "run", source: "cli", gameID: "OFFLINE01", map: "World", players: 1, gameType: "Private", model: "jev-1.13.0", config: {}, strategy: null, harnessCommit: "c".repeat(40), openfrontCommit: "b".repeat(40), startedAt: "2026-09-26T11:00:00Z" },
    { type: "spawn", agent: "Jev", tick: 100, recheck: false, calls: [{ label: "spawn", latencyMs: 300, state: { game: { spawn_phase_ticks_left: 200 } } }], intents: [{ desc: "spawn@1", sent: true }] },
    ...steps("Jev", specs),
    { type: "summary", gameID: "OFFLINE01", ticks: 3900, agents: [{ name: "Jev", alive: true, won: true, outcome: "won", peakLandShare: 0.32, finalLandShare: 0.32, ticksSurvived: 3900, steps: 60, holds: 0 }] },
  ];
  return events.map((e) => JSON.stringify(e)).join("\n");
}

const lost = parseTrace(lostGame(), "runs/2026-09-26T10-00-00-000Z-extension-LOST01");
const won = parseTrace(wonGame(), "runs/2026-09-26T11-00-00-000Z-offline");
const games = [...lost, ...won];

describe("trace loading", () => {
  test("one record per agent, with header, lifecycle and settled outcomes", () => {
    expect(lost).toHaveLength(1);
    const g = lost[0];
    expect(g).toMatchObject({ source: "extension", strategy: "Turtle", map: "World", players: 10, streamResult: "eliminated at 2:50" });
    expect(g.death?.attackers[0].name).toBe("Raider");
    const attack = g.steps.find((s) => s.record?.action === "attack_player")!;
    expect(attack.outcome).toBe("-120 tiles, -4,000 troops, +0 gold");
    expect(tilesDelta(attack.outcome)).toBe(-120);
    expect(won[0].strategy).toBe("(Jev's own judgment)");
  });

  test("a torn last line is skipped", () => {
    expect(parseTrace(`${wonGame()}\n{"type":"step","ag`, "x")[0].steps).toHaveLength(60);
  });
});

describe("detectors", () => {
  const findings = Object.fromEntries(detectAll(games).map((f) => [f.key, f]));
  const hit = (key: string, game: string) => findings[key].evidence.some((e) => e.game.includes(game));

  test("the bad patterns fire on the lost game", () => {
    for (const key of ["losing_attack", "two_front", "idle_gold", "expansion_stall", "wasted_troops", "hold_streak", "spawn_failed"]) {
      expect({ key, hit: hit(key, "LOST01") }).toEqual({ key, hit: true });
    }
    expect(findings.losing_attack.evidence[0].note).toContain("1.6x my troops");
    expect(findings.losing_attack.count).toBe(1);
    expect(findings.two_front.count).toBe(1);
    expect(findings.two_front.evidence[0].note).toContain("P3 Raider");
    expect(findings.spawn_failed.evidence[0].note).toContain("2 s of spawn phase left");
  });

  test("and not on the clean win", () => {
    for (const key of ["losing_attack", "two_front", "idle_gold", "wasted_troops", "hold_streak", "spawn_failed", "betrayed"]) {
      expect({ key, hit: hit(key, "offline") }).toEqual({ key, hit: false });
    }
  });

  test("the good patterns: land gains and a lasting alliance", () => {
    expect(hit("big_gain", "offline")).toBe(true);
    expect(hit("lasting_alliance", "offline")).toBe(true);
    expect(findings.lasting_alliance.evidence[0].note).toContain("P2 Bully");
  });

  test("a game spawned by hand (no spawn event, but land) is not a failed spawn", () => {
    const handSpawned = parseTrace(wonGame().split("\n").filter((l) => !l.includes('"type":"spawn"')).join("\n"), "hand");
    expect(detectAll(handSpawned).find((f) => f.key === "spawn_failed")!.count).toBe(0);
  });

  test("evidence is capped and spread across games", () => {
    for (const f of Object.values(findings)) expect(f.evidence.length).toBeLessThanOrEqual(5);
  });
});

describe("report", () => {
  test("per-game rows", () => {
    const l = gameRow(lost[0]);
    expect(l).toMatchObject({ outcome: "eliminated", placement: 8, minutesSurvived: 2.8, peakShare: 0.07, finalShare: 0, causeOfDeath: "Raider (3.2x troops)" });
    expect(l.holdRate).toBeGreaterThan(0.3);
    const w = gameRow(won[0]);
    expect(w).toMatchObject({ outcome: "won", placement: 1, died: false });
    expect(w.routeMix).toEqual({ build: 20, expand: 40 });
  });

  test("aggregates by strategy, source and commit; the collapse is a key moment", () => {
    const { report, moments } = buildReport(games);
    expect(report.overall).toMatchObject({ games: 2, wins: 1, winRate: 0.5 });
    expect(report.byStrategy.map((a) => a.key).sort()).toEqual(["(Jev's own judgment)", "Turtle"]);
    expect(report.bySource.map((a) => a.key).sort()).toEqual(["cli", "extension"]);
    expect(report.byCommit.map((a) => a.key).sort()).toEqual(["aaaaaaaaaaaa", "cccccccccccc"]);
    // Alive at 5 minutes: the win only; the death at 2.8 counts against it.
    expect(report.overall.survival["5"]).toBe(0.5);

    const collapse = moments.find((m) => m.kind === "collapse")!;
    expect(collapse.game).toContain("LOST01");
    expect(collapse.steps.length).toBeLessThanOrEqual(3);
    expect(moments.some((m) => m.kind === "gain")).toBe(true);

    const md = renderReport(report);
    for (const heading of ["## Aggregates", "## What goes wrong", "## What works", "## Key moments", "## Games"]) expect(md).toContain(heading);
    expect(md).toContain("stream: eliminated at 2:50");
    const dump = renderMoment(collapse);
    expect(dump).toContain("**me**: land");
    expect(dump).toContain("route: **");
    expect(dump).toContain("P3 Raider");
  });
});
