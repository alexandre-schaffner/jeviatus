// The nuke route end to end on a real sim: offered only with a ready silo and
// gold, every blast site is safe for me and my allies, the decision maps to a
// schema-valid intent, and the bomb actually lands.

import { beforeAll, describe, expect, test } from "bun:test";
import { type Player, UnitType } from "src/core/game/Game";
import { IntentSchema } from "src/core/Schemas";
import { resolve } from "../harness/act/intents";
import { buildCandidates, type Candidates, SeaReach, spawnCandidates } from "../harness/decide/candidates";
import { nukeSites, unsafeBlast } from "../harness/decide/nukes";
import { Pipeline } from "../harness/decide/pipeline";
import { economy, IncomeTracker } from "../harness/observe/economy";
import { SectorGrid } from "../harness/observe/sectors";
import { type Observation, observe, RefBook } from "../harness/observe/state";
import { StrategyMemory } from "../harness/strategy/memory";
import { FakeJev, type OfflineGame, offlineGame } from "./helpers";

let g: OfflineGame;
let me: Player;
let grid: SectorGrid;
const refs = new RefBook();
const memory = new StrategyMemory();

function snapshot(): { obs: Observation; cands: Candidates } {
  const game = g.mirror.game;
  const scan = grid.scan();
  const reach = new SeaReach().get(game, me, scan);
  const econ = economy(game, me, new IncomeTracker());
  const obs = observe({ game, me, grid, scan, refs, memory, seaReachable: new Set(reach.keys()), goldPerMin: 0, econ });
  return { obs, cands: buildCandidates(game, me, obs, reach, econ, memory.threat) };
}

beforeAll(async () => {
  g = await offlineGame({ nations: 6 });
  me = g.mirror.me()!;
  grid = new SectorGrid(g.mirror.game);
  g.step(10);
  g.send({ type: "spawn", tile: spawnCandidates(g.mirror.game, me, grid)[0].tile });
  // Past the spawn phase, and long enough for nations to grow real territory.
  g.step(900);
}, 120_000);

describe("nuke route", () => {
  test("not offered without a silo", () => {
    expect(me.isAlive()).toBe(true);
    const { cands } = snapshot();
    expect(cands.routes).not.toContain("nuke");
  });

  test("offered once a silo is built and a bomb is affordable", () => {
    const game = g.mirror.game;
    me.addGold(20_000_000n); // test-only: skip the economy
    const site = [...me.tiles()].find((t) => me.canBuild(UnitType.MissileSilo, t) !== false);
    expect(site).toBeDefined();
    g.send({ type: "build_unit", unit: UnitType.MissileSilo, tile: site! });
    g.step(120); // construction takes 100 ticks
    expect(me.unitCount(UnitType.MissileSilo)).toBe(1);
    expect(game.ticks()).toBeGreaterThan(0);
    const { cands } = snapshot();
    expect(cands.routes).toContain("nuke");
    expect(cands.nukeOptions.map((n) => n.key)).toEqual(["atom_bomb", "hydrogen_bomb"]);
    expect(cands.nukeTargets.length).toBeGreaterThan(0);
  });

  test("every blast site is safe for me and scored", () => {
    const { obs, cands } = snapshot();
    const game = g.mirror.game;
    for (const opt of cands.nukeOptions) {
      const sites = nukeSites({ game, me, obs, grid, threat: memory.threat, refOf: (id) => refs.peek(id) }, cands.nukeTargets[0].player, opt);
      expect(sites.length).toBeGreaterThan(0);
      for (const s of sites) {
        expect(unsafeBlast(game, me, s.tile, opt.type)).toBeNull();
        expect(Number(s.features.their_land_destroyed_tiles)).toBeGreaterThanOrEqual(20);
      }
    }
  });

  test("pipeline picks a nuke, it resolves to a valid intent, and it lands", async () => {
    const game = g.mirror.game;
    const { obs, cands } = snapshot();
    const jev = new FakeJev();
    jev.prefer = { route: "nuke", nuke_type: "atom_bomb" };
    const pipeline = new Pipeline(jev, { minConfidence: 0.35 });
    const decision = await pipeline.step(game, me, obs, cands, memory, { game, me, obs, grid, refOf: (id) => refs.peek(id) });
    expect(decision.route).toBe("nuke");
    expect(decision.held).toBe(false);
    const action = decision.actions[0];
    expect(action.kind).toBe("nuke");
    expect(jev.asked.map((a) => a.label)).toEqual(["route", "nuke_site"]);

    const r = resolve(game, me, action);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(IntentSchema.safeParse(r.intent).success).toBe(true);
    expect(r.intent).toMatchObject({ type: "build_unit", unit: UnitType.AtomBomb });

    const falloutBefore = game.numTilesWithFallout();
    const goldBefore = me.gold();
    g.send(r.intent);
    g.step(250);
    expect(me.gold()).toBeLessThan(goldBefore); // paid for it
    expect(game.numTilesWithFallout()).toBeGreaterThan(falloutBefore); // it detonated
  }, 60_000);

  test("allies are never targets", () => {
    const { cands } = snapshot();
    for (const t of cands.nukeTargets) expect(me.isFriendly(t.player)).toBe(false);
  });
});
