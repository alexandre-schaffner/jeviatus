// Farming: the conquest estimate must match what the sim actually pays, and
// a push sized by it must land the kill.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Player } from "src/core/game/Game";
import { Agent } from "../harness/agent";
import { gameRow } from "../harness/analyze/report";
import { parseTrace } from "../harness/analyze/load";
import { Trace } from "../harness/log/trace";
import { TokenBucket } from "../harness/net/rateLimit";
import { buildCandidates, SeaReach } from "../harness/decide/candidates";
import { FINISH_CAP, FINISH_CAP_UNDER_ATTACK, Pipeline, sizeAttack } from "../harness/decide/pipeline";
import { economy, IncomeTracker } from "../harness/observe/economy";
import { observe, RefBook } from "../harness/observe/state";
import { StrategyMemory } from "../harness/strategy/memory";
import { conquestEstimate, KILL_THRESHOLD_TILES } from "../harness/observe/conquest";
import type { PlayerObs } from "../harness/observe/state";
import { SectorGrid } from "../harness/observe/sectors";
import { FakeJev, neighbors, type OfflineGame, testConfig } from "./helpers";

let g: OfflineGame;
let me: Player;
let other: Player;

// A neighbor that just lost 90% of its troops: worth farming. Fresh per test,
// since each one fights.
async function weakNeighbor(): Promise<void> {
  ({ g, me, other } = await neighbors());
  other.removeTroops(other.troops() * 0.9);
}

function push(share: number): void {
  g.send({ type: "attack", targetID: other.id(), troops: Math.floor(me.troops() * share) });
  for (let i = 0; i < 300 && other.isAlive(); i++) g.step(10);
}

describe("conquest estimate", () => {
  test("counts the tiles to the kill line and who else is attacking", async () => {
    await weakNeighbor();
    const e = conquestEstimate(g.mirror.game, me, other);
    expect(e.tilesToKill).toBe(other.numTilesOwned() - (KILL_THRESHOLD_TILES - 1));
    expect(e.rivals).toEqual([]);
    expect(e.stealRisk).toBe("none");
  }, 120_000);

  test("a push sized by the estimate finishes a weak neighbor and collects the gold", async () => {
    await weakNeighbor();
    const game = g.mirror.game;
    const e = conquestEstimate(game, me, other);
    expect(e.finishFraction).not.toBeNull();
    const goldBefore = Number(me.gold());
    const ticksBefore = game.ticks();
    push(e.finishFraction!);
    expect(other.isAlive()).toBe(false);
    // Loot on top of passive income (100 gold per tick for humans).
    const income = (game.ticks() - ticksBefore) * 100;
    expect(e.loot).toBeGreaterThan(0);
    expect(Number(me.gold()) - goldBefore).toBeGreaterThanOrEqual(e.loot + income * 0.9);
  }, 120_000);

  test("a push well short of the estimate leaves them alive: the estimate is not padding", async () => {
    await weakNeighbor();
    const e = conquestEstimate(g.mirror.game, me, other);
    push(e.finishFraction! / 3);
    expect(other.isAlive()).toBe(true);
  }, 120_000);
});

describe("game trace", () => {
  test("the farmed player's agent traces its death with the attacker, then one summary", async () => {
    await weakNeighbor();
    const trace = new Trace(testConfig().runsDir, "death-test");
    // The victim's own agent: observes and decides, never sends.
    const victim = new Agent({
      name: "JevTwo",
      mirror: g.mirror.viewAs(g.relay.clientIDs[1]),
      jev: new FakeJev(),
      config: testConfig({ decisionInterval: 10 }),
      bucket: new TokenBucket(140),
      send: () => {},
      dryRun: true,
      trace,
    });
    const need = conquestEstimate(g.mirror.game, me, other).finishFraction!;
    g.send({ type: "attack", targetID: other.id(), troops: Math.floor(me.troops() * need) });
    for (let i = 0; i < 3000 && other.isAlive(); i++) {
      g.step(1);
      victim.onTick();
      await victim.pending;
    }
    expect(other.isAlive()).toBe(false);
    victim.onTick();
    victim.finish("test over");
    victim.finish("again");
    await trace.close();

    const text = fs.readFileSync(path.join(trace.dir, "trace.jsonl"), "utf8");
    const events = text.trim().split("\n").map((l) => JSON.parse(l) as { type: string; attackers?: { name: string }[] });
    expect(events.filter((e) => e.type === "death")).toHaveLength(1);
    expect(events.find((e) => e.type === "death")!.attackers!.map((a) => a.name)).toEqual([me.displayName()]);
    expect(events.filter((e) => e.type === "summary")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "summary", reason: "test over", agents: [{ name: "JevTwo", alive: false }] });

    // The analyzer reads it as an elimination by that attacker.
    const [record] = parseTrace(text, trace.dir);
    const row = gameRow(record);
    expect(row.outcome).toBe("eliminated");
    expect(row.causeOfDeath).toContain(me.displayName());
  }, 120_000);
});

describe("farming decision", () => {
  test("Jev sees the loot, and a small probe on a finishable neighbor is raised to a finishing push", async () => {
    await weakNeighbor();
    const game = g.mirror.game;
    const grid = new SectorGrid(game);
    const refs = new RefBook();
    const memory = new StrategyMemory();
    const scan = grid.scan();
    const reach = new SeaReach().get(game, me, scan);
    const econ = economy(game, me, new IncomeTracker());
    const obs = observe({ game, me, scan, refs, memory, seaReachable: new Set(reach.keys()), goldPerMin: 60_000, econ });
    const cands = buildCandidates(game, me, obs, reach, econ, memory.threat);
    const ref = refs.peek(other.id())!;
    const jev = new FakeJev();
    jev.prefer = { route: "attack_player", attack_target: ref };
    jev.score = { attack_commit: 0 }; // "probe: about a tenth"
    const d = await new Pipeline(jev, { minConfidence: 0.35 }).step(game, me, obs, cands, memory, { game, me, obs, grid, refOf: (id) => refs.peek(id) });

    const q = jev.asked[0].questions as Record<string, { criteria: Record<string, unknown> }>;
    expect(q.attack_target.criteria[ref]).toMatchObject({ conquest: { tiles_to_take_before_they_fall: other.numTilesOwned() - 99 } });
    expect(String(q.route.criteria.attack_player)).toContain("I can finish now");
    const need = obs.byRef.get(ref)!.conquest!.finishFraction!;
    expect(d.actions[0]).toMatchObject({ kind: "attack", targetID: other.id(), fraction: need });
    expect(d.record?.detail).toContain("sized to finish");
  }, 120_000);
});

describe("attack sizing", () => {
  const target = (finishFraction: number | null) =>
    ({ player: {} as Player, conquest: { finishFraction, loot: 0, tilesToKill: 1, troopsToKill: 1, rivals: [], stealRisk: "none" } }) as unknown as PlayerObs;
  const calm = { incomingAttacks: () => [] } as unknown as Player;
  const attacked = { incomingAttacks: () => [{ attacker: () => ({ isAlive: () => true }) }] } as unknown as Player;

  test("raises a short commit to what finishes the target", () => {
    expect(sizeAttack(calm, target(0.4), 0.25)).toEqual({ fraction: 0.4, finishing: true });
  });
  test("never sends less than Jev asked for", () => {
    expect(sizeAttack(calm, target(0.1), 0.45)).toEqual({ fraction: 0.45, finishing: true });
    expect(sizeAttack(calm, target(null), 0.25)).toEqual({ fraction: 0.25, finishing: false });
  });
  test("won't empty the home army for a kill", () => {
    expect(sizeAttack(calm, target(FINISH_CAP + 0.1), 0.25)).toEqual({ fraction: 0.25, finishing: false });
    expect(sizeAttack(attacked, target(FINISH_CAP_UNDER_ATTACK + 0.1), 0.25)).toEqual({ fraction: 0.25, finishing: false });
  });
});
