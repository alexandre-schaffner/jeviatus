// Money: honest rail facts, factories placed where they connect cities,
// upgrades, a purchase beside the main action, and saving for big items.

import { describe, expect, test } from "bun:test";
import { UnitType } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import { resolve } from "../harness/act/intents";
import { buildCandidates, buildSites, SeaReach } from "../harness/decide/candidates";
import { Pipeline } from "../harness/decide/pipeline";
import { economy, IncomeTracker } from "../harness/observe/economy";
import { SectorGrid } from "../harness/observe/sectors";
import { observe, RefBook } from "../harness/observe/state";
import { StrategyMemory } from "../harness/strategy/memory";
import { FakeJev, neighbors, type Neighbors } from "./helpers";

// Build `type` at the first legal tile, spreading picks across my land.
function build(n: Neighbors, type: UnitType, from = 0): void {
  const { g, me } = n;
  const tiles = [...me.tiles()];
  for (let i = from; i < tiles.length; i += 7) {
    const t = me.canBuild(type, tiles[i]);
    if (t !== false) {
      g.send({ type: "build_unit", unit: type, tile: t as TileRef });
      g.step(60);
      return;
    }
  }
  throw new Error(`no site for ${type}`);
}

async function richNeighbors(cities: number): Promise<Neighbors> {
  const n = await neighbors();
  n.me.addGold(50_000_000n);
  const tiles = n.me.numTilesOwned();
  for (let i = 0; i < cities; i++) build(n, UnitType.City, Math.floor((i * tiles) / cities));
  return n;
}

function context(n: Neighbors) {
  const { g, me } = n;
  const game = g.mirror.game;
  const grid = new SectorGrid(game);
  const refs = new RefBook();
  const memory = new StrategyMemory();
  const scan = grid.scan();
  const reach = new SeaReach().get(game, me, scan);
  const econ = economy(game, me, new IncomeTracker());
  const obs = observe({ game, me, scan, refs, memory, seaReachable: new Set(reach.keys()), goldPerMin: 60_000, econ });
  const cands = buildCandidates(game, me, obs, reach, econ, memory.threat, memory.attackPeaks);
  const site = { game, me, obs, grid, refOf: (id: string) => refs.peek(id) };
  return { game, econ, obs, cands, memory, site };
}

describe("rail facts", () => {
  test("off-rail cities are counted until a factory connects them, and factory sites reach them", async () => {
    const n = await richNeighbors(3);
    const before = context(n);
    expect(before.econ.unconnectedStations).toBe(3);
    const best = buildSites({ ...before.site, threat: new Map() }, UnitType.Factory)[0];
    expect(Number(best.features.my_off_rail_stations_it_would_connect)).toBeGreaterThan(0);
    n.g.send({ type: "build_unit", unit: UnitType.Factory, tile: best.tile });
    n.g.step(80);
    expect(context(n).econ.unconnectedStations).toBe(0);
  }, 120_000);
});

describe("upgrades", () => {
  test("a city can be upgraded in place: +1 level, no site", async () => {
    const n = await richNeighbors(1);
    const { game, obs, cands, memory, site } = context(n);
    const option = cands.buildOptions.find((b) => b.key === "upgrade_city");
    expect(option).toBeDefined();
    const jev = new FakeJev();
    jev.prefer = { route: "build", build_unit: "upgrade_city" };
    const d = await new Pipeline(jev, { minConfidence: 0.35 }).step(game, n.me, obs, cands, memory, site);
    const up = d.actions.find((a) => a.kind === "upgrade")!;
    expect(up).toMatchObject({ unit: UnitType.City, unitID: option!.upgrade!.id() });
    const r = resolve(game, n.me, up);
    expect(r.ok && r.intent.type).toBe("upgrade_structure");
    if (!r.ok) return;
    n.g.send(r.intent);
    n.g.step(5);
    expect(option!.upgrade!.level()).toBe(2);
  }, 120_000);
});

describe("the purse", () => {
  test("spare gold buys something beside the main action, and never twice", async () => {
    const n = await richNeighbors(1);
    const { game, obs, cands, memory, site } = context(n);
    const jev = new FakeJev();
    jev.prefer = { route: "hold", spend: "city" };
    const d = await new Pipeline(jev, { minConfidence: 0.35 }).step(game, n.me, obs, cands, memory, site);
    const buy = d.actions.find((a) => a.kind === "build")!;
    expect(buy).toMatchObject({ unit: UnitType.City });
    expect(resolve(game, n.me, buy).ok).toBe(true);

    jev.prefer = { route: "build", build_unit: "city", spend: "port" };
    const both = await new Pipeline(jev, { minConfidence: 0.35 }).step(game, n.me, obs, cands, memory, site);
    expect(both.actions.filter((a) => a.kind === "build" || a.kind === "upgrade")).toHaveLength(1);
  }, 120_000);

  test("a rival's missile silo makes saving for a SAM an option", async () => {
    const n = await richNeighbors(1);
    n.me.removeGold(n.me.gold());
    n.other.addGold(5_000_000n);
    const tiles = [...n.other.tiles()];
    const t = tiles.map((x) => n.other.canBuild(UnitType.MissileSilo, x)).find((x) => x !== false);
    n.g.sendAs(1, { type: "build_unit", unit: UnitType.MissileSilo, tile: t as TileRef });
    n.g.step(150);
    expect(n.other.unitCount(UnitType.MissileSilo)).toBe(1);
    const { cands } = context(n);
    expect(cands.savingsGoals.map((s) => s.key)).toContain("save_for_sam");
  }, 120_000);
});
