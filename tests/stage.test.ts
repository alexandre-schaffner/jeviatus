// Stages of the game: what marks early, mid and late, how the remembered
// stage moves, and what changes with it (hints, playbook, candidates).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Player } from "src/core/game/Game";
import { applyPatch, type Patch, QUESTIONS_FILE } from "../governance/patch";
import { parsePromptFile } from "../governance/prompts";
import { buildCandidates, type Candidates, SeaReach } from "../harness/decide/candidates";
import { CLOSING_PROGRESS, CLOSING_RESERVE, PLAYBOOKS, playbook } from "../harness/decide/playbook";
import { routeQuestions } from "../harness/decide/questions";
import { economy, IncomeTracker } from "../harness/observe/economy";
import { SectorGrid } from "../harness/observe/sectors";
import { observe, RefBook } from "../harness/observe/state";
import { StrategyMemory } from "../harness/strategy/memory";
import { detectStage, EARLY_MAX_MINUTES, LATE_MINUTES, type StageSignals, stageSignals } from "../harness/strategy/stage";
import { neighbors } from "./helpers";

const signals = (o: Partial<StageSignals> = {}): StageSignals => ({
  minutes: 3,
  unclaimedShare: 0.6,
  winShare: 0.8,
  leader: null,
  leaderShare: 0.05,
  myShare: 0.02,
  overtime: false,
  ...o,
});

describe("detectStage", () => {
  test("early while free land is plentiful, and not for long", () => {
    expect(detectStage(signals())).toBe("early");
    expect(detectStage(signals({ unclaimedShare: 0.1 }))).toBe("mid");
    expect(detectStage(signals({ minutes: EARLY_MAX_MINUTES }))).toBe("mid");
  });

  test("late once someone holds half the land needed to win, the game runs long, or overtime starts", () => {
    expect(detectStage(signals({ unclaimedShare: 0.1, leaderShare: 0.39 }))).toBe("mid");
    expect(detectStage(signals({ unclaimedShare: 0.1, leaderShare: 0.4 }))).toBe("late");
    expect(detectStage(signals({ leaderShare: 0.3, winShare: 0.5 }))).toBe("late");
    expect(detectStage(signals({ unclaimedShare: 0.1, minutes: LATE_MINUTES }))).toBe("late");
    expect(detectStage(signals({ overtime: true }))).toBe("late");
  });
});

describe("remembered stage", () => {
  test("only moves forward", () => {
    const m = new StrategyMemory();
    expect(m.stage).toBe("early");
    expect(m.advanceStage(signals(), 100)).toBe(false);
    expect(m.advanceStage(signals({ unclaimedShare: 0.1 }), 600)).toBe(true);
    expect(m).toMatchObject({ stage: "mid", stageSinceTick: 600 });
    expect(m.advanceStage(signals({ unclaimedShare: 0.1, leaderShare: 0.5 }), 9000)).toBe(true);
    // The leader collapses: the endgame doesn't turn back into the mid game.
    expect(m.advanceStage(signals({ unclaimedShare: 0.1, leaderShare: 0.1 }), 9600)).toBe(false);
    expect(m.stage).toBe("late");
  });
});

describe("playbook", () => {
  test("early keeps fewer troops home and lets expansion take more", () => {
    expect(PLAYBOOKS.early.reserveVsNeighbor).toBeLessThan(PLAYBOOKS.mid.reserveVsNeighbor);
    expect(PLAYBOOKS.early.expandFloor).toBeGreaterThan(PLAYBOOKS.mid.expandFloor);
  });

  test("late goes all in only within reach of the win", () => {
    expect(playbook("late", CLOSING_PROGRESS - 0.01).reserveVsNeighbor).toBe(PLAYBOOKS.late.reserveVsNeighbor);
    expect(playbook("late", CLOSING_PROGRESS).reserveVsNeighbor).toBe(CLOSING_RESERVE);
    expect(playbook("mid", 1).reserveVsNeighbor).toBe(PLAYBOOKS.mid.reserveVsNeighbor);
  });
});

describe("stage hints", () => {
  const empty = ["nukeOptions", "nukeTargets", "allianceExtensions", "embargoLifts", "attackTargets", "betrayTargets", "sideAttacks", "retreats", "boatTargets", "buildOptions", "savingsGoals", "allyCandidates", "incomingRequests", "donateTargets", "threatSubjects"];
  const cands = { routes: ["expand", "attack_player", "hold"], ...Object.fromEntries(empty.map((k) => [k, []])) } as unknown as Candidates;
  const FILE = parsePromptFile(readFileSync(QUESTIONS_FILE, "utf8"));
  const staged = (id: string, stage: string) => FILE.prompts[id].hints.filter((h) => h.stage === stage).map((h) => h.text);

  test("Jev reads the general hints plus the current stage's", () => {
    const general = FILE.prompts.route.hints.filter((h) => h.stage === undefined).map((h) => h.text);
    const all = JSON.stringify(routeQuestions(cands, 3, "full", undefined, false, "early"));
    for (const h of general) expect(all).toContain(JSON.stringify(h).slice(1, -1));
    for (const h of staged("route", "early")) expect(all).toContain(JSON.stringify(h).slice(1, -1));
    for (const h of [...staged("route", "mid"), ...staged("route", "late")]) expect(all).not.toContain(JSON.stringify(h).slice(1, -1));
  });

  test("every stage has route and goal hints, each one rewritable", () => {
    for (const stage of ["early", "mid", "late"]) {
      expect(staged("route", stage).length).toBeGreaterThan(0);
      expect(staged("goal", stage).length).toBeGreaterThan(0);
    }
    expect(FILE.prompts.route.hints.every((h) => h.span)).toBe(true);
  });

  test("a hint added after a stage hint joins that stage", () => {
    const text = readFileSync(QUESTIONS_FILE, "utf8");
    const route = FILE.prompts.route;
    const i = route.hints.findIndex((h) => h.stage === "late");
    const patch: Patch = { v: 1, file: QUESTIONS_FILE, base: "test", edits: [{ op: "add-hint", prompt: "route", after: i, anchor: route.hints[i].text, to: "a late one" }] };
    const r = applyPatch(text, FILE, patch);
    expect(r.problems).toEqual([]);
    const added = parsePromptFile(r.text).prompts.route.hints.find((h) => h.text === "a late one");
    expect(added?.stage).toBe("late");
    expect(added?.span).toBeDefined();
  });
});

describe("candidates by stage", () => {
  test("no missile silo while the land grab is on", async () => {
    const { g, me } = await neighbors();
    me.addGold(50_000_000n);
    const game = g.mirror.game;
    const grid = new SectorGrid(game);
    const scan = grid.scan();
    const reach = new SeaReach().get(game, me, scan);
    const econ = economy(game, me, new IncomeTracker());
    const builds = (stage: "early" | "mid") => {
      const memory = new StrategyMemory();
      memory.stage = stage;
      const obs = observe({ game, me, scan, refs: new RefBook(), memory, seaReachable: new Set(reach.keys()), goldPerMin: 0, econ });
      expect((obs.state.game as { stage: string }).stage.startsWith(stage)).toBe(true);
      return buildCandidates(game, me, obs, reach, econ, memory.threat).buildOptions.map((b) => b.key);
    };
    expect(builds("mid")).toContain("missile_silo");
    expect(builds("early")).not.toContain("missile_silo");
    expect(builds("early")).toContain("city");
  }, 120_000);

  test("signals read the sim", async () => {
    const { g, me } = await neighbors();
    const s = stageSignals(g.mirror.game, me);
    expect(s.leader).not.toBeNull();
    expect((s.leader as Player).numTilesOwned()).toBeGreaterThanOrEqual(me.numTilesOwned());
    expect(s.unclaimedShare).toBeGreaterThanOrEqual(0);
    expect(s.unclaimedShare).toBeLessThanOrEqual(1);
    expect(s.winShare).toBeCloseTo(0.8);
  }, 120_000);
});
