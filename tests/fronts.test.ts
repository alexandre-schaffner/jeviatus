// Fronts: a home reserve against over-committing, extra pushes beside the
// main action, and retreats from stalled attacks.

import { describe, expect, test } from "bun:test";
import type { Player } from "src/core/game/Game";
import { resolve } from "../harness/act/intents";
import { buildCandidates, SeaReach } from "../harness/decide/candidates";
import { Pipeline } from "../harness/decide/pipeline";
import { EXPAND_FLOOR, homeReserve, MIN_SEND, RESERVE_VS_NEIGHBOR, TroopBudget } from "../harness/decide/reserve";
import { economy, IncomeTracker } from "../harness/observe/economy";
import { SectorGrid } from "../harness/observe/sectors";
import { type Observation, observe, RefBook } from "../harness/observe/state";
import { StrategyMemory } from "../harness/strategy/memory";
import { FakeJev, neighbors, type Neighbors } from "./helpers";

describe("troop budget", () => {
  test("hands out shares above the reserve, across sends", () => {
    const b = new TroopBudget(100_000, 40_000);
    expect(b.take(0.5)).toBeCloseTo(0.5);
    expect(b.take(0.3)).toBeCloseTo(0.1);
    expect(b.take(0.3)).toBe(0);
  });
  test("drops sends too small to matter, but expansion keeps a floor", () => {
    expect(new TroopBudget(100_000, 99_000).take(0.5)).toBe(0);
    expect(new TroopBudget(100_000, 100_000).take(0.2, EXPAND_FLOOR)).toBeCloseTo(EXPAND_FLOOR);
    expect(MIN_SEND).toBeLessThan(EXPAND_FLOOR);
  });
});

describe("home reserve", () => {
  const p = (troops: number, type = "HUMAN") =>
    ({ troops: () => troops, type: () => type, isAlive: () => true }) as unknown as Player;
  const strong = p(100_000);
  const tribe = p(500_000, "BOT");
  const obs = {
    players: [
      { player: strong, bordersMe: true, json: { name: "Strong" } },
      { player: tribe, bordersMe: true, json: { name: "Tribe" } },
    ],
  } as unknown as Observation;
  const me = (incoming: number) =>
    ({ isFriendly: () => false, incomingAttacks: () => (incoming ? [{ troops: () => incoming, attacker: () => ({ isAlive: () => true }) }] : []) }) as unknown as Player;

  test("keeps most of the strongest non-tribe neighbor's army home", () => {
    expect(homeReserve(me(0), obs, new Set())).toEqual({ troops: 100_000 * RESERVE_VS_NEIGHBOR, why: "Strong" });
  });
  test("a neighbor I'm fighting doesn't count, attacks coming at me do", () => {
    expect(homeReserve(me(0), obs, new Set([strong])).troops).toBe(0);
    expect(homeReserve(me(120_000), obs, new Set())).toEqual({ troops: 120_000, why: "attacks coming at me" });
  });
});

async function decide(n: Neighbors, prime: (jev: FakeJev) => void, minConfidence = 0.35) {
  const { g, me } = n;
  const game = g.mirror.game;
  const grid = new SectorGrid(game);
  const refs = new RefBook();
  const memory = new StrategyMemory();
  memory.noteMyAttacks(me.outgoingAttacks());
  const scan = grid.scan();
  const reach = new SeaReach().get(game, me, scan);
  const econ = economy(game, me, new IncomeTracker());
  const obs = observe({ game, me, scan, refs, memory, seaReachable: new Set(reach.keys()), goldPerMin: 60_000, econ });
  const cands = buildCandidates(game, me, obs, reach, econ, memory.threat, memory.attackPeaks);
  const jev = new FakeJev();
  jev.prefer = { route: "hold" };
  prime(jev);
  const d = await new Pipeline(jev, { minConfidence }).step(game, me, obs, cands, memory, { game, me, obs, grid, refOf: (id) => refs.peek(id) });
  return { d, cands, obs, refs, jev };
}

test("a finishable neighbor gets an extra push even when the main action is something else", async () => {
  const n = await neighbors();
  n.other.removeTroops(n.other.troops() * 0.9);
  const { d, cands, obs, refs } = await decide(n, (jev) => (jev.noul = { also_attack: 1 }));
  expect(cands.sideAttacks.map((o) => o.player)).toContain(n.other);
  const need = obs.byRef.get(refs.peek(n.other.id())!)!.conquest!.finishFraction!;
  expect(d.actions).toContainEqual({ kind: "attack", targetID: n.other.id(), fraction: need });
}, 120_000);

test("a stalled attack can be pulled back, and the troops come home", async () => {
  const n = await neighbors();
  const { g, me, other } = n;
  // A tiny raid into a full-strength neighbor: it will stall.
  g.send({ type: "attack", targetID: other.id(), troops: Math.floor(me.troops() * 0.03) });
  g.step(3);
  const raid = me.outgoingAttacks().find((a) => a.target() === other)!;
  expect(raid).toBeDefined();
  const { d, cands } = await decide(n, (jev) => (jev.noul = { retreat: 1 }));
  const candidate = cands.retreats.find((r) => r.attack === raid)!;
  expect(candidate.facts).toMatchObject({ it_will_finish_them: false });
  const retreat = d.actions.find((a) => a.kind === "retreat")!;
  expect(retreat).toMatchObject({ attackID: raid.id() });
  const r = resolve(g.mirror.game, me, retreat);
  expect(r.ok && r.intent.type).toBe("cancel_attack");
  if (!r.ok) return;
  g.send(r.intent);
  g.step(25); // the retreat lands after 2 seconds
  expect(me.outgoingAttacks().some((a) => a.id() === raid.id())).toBe(false);
}, 120_000);

test("a held main attack doesn't block the extra push, and a push isn't undone by retreating the same front", async () => {
  const n = await neighbors();
  const { g, me, other } = n;
  other.removeTroops(other.troops() * 0.9);
  g.send({ type: "attack", targetID: other.id(), troops: Math.floor(me.troops() * 0.03) });
  g.step(3);
  // The fake answers with confidence 0.9: a 0.95 bar holds the main attack.
  const { d } = await decide(
    n,
    (jev) => {
      jev.prefer = { route: "attack_player", attack_target: (keys) => keys.find((k) => k !== "none")! };
      jev.noul = { also_attack: 1, retreat: 1 };
    },
    0.95,
  );
  expect(d.held).toBe(true);
  expect(d.actions.some((a) => a.kind === "attack" && a.targetID === other.id())).toBe(true);
  expect(d.actions.some((a) => a.kind === "retreat")).toBe(false);
}, 120_000);
