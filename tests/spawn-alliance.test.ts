// Spawn siting and alliance-request handling on a real sim with a fake Jev.

import { beforeAll, describe, expect, test } from "bun:test";
import type { Player } from "src/core/game/Game";
import { resolve } from "../harness/act/intents";
import { buildCandidates, SeaReach, spawnCandidates } from "../harness/decide/candidates";
import { Pipeline } from "../harness/decide/pipeline";
import { economy, IncomeTracker } from "../harness/observe/economy";
import { SectorGrid } from "../harness/observe/sectors";
import { observe, RefBook } from "../harness/observe/state";
import { StrategyMemory } from "../harness/strategy/memory";
import { FakeJev, type OfflineGame, offlineGame } from "./helpers";

let g: OfflineGame;
let me: Player;
let other: Player;
let grid: SectorGrid;

beforeAll(async () => {
  g = await offlineGame({ nations: 6, agents: 2 });
  me = g.mirror.me()!;
  other = g.mirror.viewAs(g.relay.clientIDs[1]).me()!;
  grid = new SectorGrid(g.mirror.game);
  g.step(10);
}, 120_000);

describe("spawn", () => {
  test("candidates are legal, spread out, and carry claim estimates", () => {
    const game = g.mirror.game;
    const sites = spawnCandidates(game, me, grid);
    expect(sites.length).toBeGreaterThan(5);
    const minDist = game.config().minDistanceBetweenPlayers();
    for (const s of sites) {
      expect({ id: s.id, land: game.isLand(s.tile), owner: game.ownerID(s.tile) }).toEqual({ id: s.id, land: true, owner: 0 });
      expect(Number(s.features.land_i_would_likely_claim_first)).toBeGreaterThan(0);
      for (const n of game.nations()) {
        if (!n.spawnCell) continue;
        expect(Math.abs(n.spawnCell.x - game.x(s.tile)) + Math.abs(n.spawnCell.y - game.y(s.tile))).toBeGreaterThanOrEqual(minDist);
      }
    }
    // Ranked best first by code score: the top site claims more than the last.
    expect(Number(sites[0].features.land_i_would_likely_claim_first)).toBeGreaterThan(Number(sites.at(-1)!.features.land_i_would_likely_claim_first));
  });

  test("late re-check offers staying (S0) and only moves on request", async () => {
    const game = g.mirror.game;
    const first = spawnCandidates(game, me, grid)[0];
    g.send({ type: "spawn", tile: first.tile });
    g.sendAs(1, { type: "spawn", tile: spawnCandidates(game, other, grid).at(-1)!.tile });
    g.step(5);
    expect(me.hasSpawned()).toBe(true);
    const jev = new FakeJev();
    const pipeline = new Pipeline(jev, { minConfidence: 0.35 });
    jev.prefer = { site: "S0" };
    const stay = await pipeline.spawn(game, me, grid, { game: {} }, 0, me.spawnTile());
    expect(stay.held).toBe(true);
    expect(stay.actions).toHaveLength(0);
    const offered = Object.keys((jev.asked[0].questions.site as { criteria: object }).criteria);
    expect(offered[0]).toBe("S0");
    jev.prefer = { site: "S1" };
    const move = await pipeline.spawn(game, me, grid, { game: {} }, 0, me.spawnTile());
    expect(move.actions[0]).toMatchObject({ kind: "spawn" });
    expect(move.record?.action).toBe("respawn");
  });
});

describe("alliance requests", () => {
  async function decide(answer: "accept" | "refuse") {
    const game = g.mirror.game;
    const refs = new RefBook();
    const memory = new StrategyMemory();
    const scan = grid.scan();
    const reach = new SeaReach().get(game, me, scan);
    const econ = economy(game, me, new IncomeTracker());
    const obs = observe({ game, me, grid, scan, refs, memory, seaReachable: new Set(reach.keys()), goldPerMin: 0, econ });
    const cands = buildCandidates(game, me, obs, reach, econ, memory.threat);
    const jev = new FakeJev();
    jev.prefer = { route: "hold", [`ally_accept.${refs.peek(other.id())}`]: answer };
    const d = await new Pipeline(jev, { minConfidence: 0.35 }).step(game, me, obs, cands, memory, { game, me, obs, grid, refOf: (id) => refs.peek(id) });
    return { d, jev, refs, cands };
  }

  test("an incoming request is always answered, with the facts attached", async () => {
    // Set up here, not in beforeAll: runs strictly after the spawn tests.
    g.step(220); // past the spawn phase
    g.sendAs(1, { type: "allianceRequest", recipient: me.id() });
    g.step(2);
    expect(me.incomingAllianceRequests().some((r) => r.requestor() === other)).toBe(true);
    const { d, jev, refs, cands } = await decide("refuse");
    expect(cands.incomingRequests.map((o) => o.player)).toContain(other);
    const q = jev.asked[0].questions[`ally_accept.${refs.peek(other.id())}`] as { type: string; criteria: object; instructions: Record<string, unknown> };
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria)).toEqual(["accept", "refuse"]);
    expect(q.instructions.requester).toMatchObject({ name: other.displayName(), is_my_war_target: false });
    const reject = d.actions.find((a) => a.kind === "ally_reject");
    expect(reject).toBeDefined();
    expect(resolve(g.mirror.game, me, reject!).ok).toBe(true);
  });

  test("accepting sends an alliance request back, which forms the alliance", async () => {
    const { d } = await decide("accept");
    const accept = d.actions.find((a) => a.kind === "ally_request");
    expect(accept).toBeDefined();
    const r = resolve(g.mirror.game, me, accept!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    g.send(r.intent);
    g.step(3);
    expect(me.isAlliedWith(other)).toBe(true);
  });
});
