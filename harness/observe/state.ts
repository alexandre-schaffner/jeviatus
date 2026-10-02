// Builds the compact JSON observation Jev sees: one object for the game, one
// for me, one per relevant player (<= 15), plus the inferred memory block.
// Every number Jev might want to compare is precomputed here as a ratio or a
// rank, because System One models are weak at arithmetic and counting.

import { type Game, type Player, PlayerType, Relation, UnitType } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import { type Strategy, strategyState } from "../strategy/doctrine";
import type { StrategyMemory } from "../strategy/memory";
import { type Stage, STAGES, type StageSignals, stageSignals, winProgress } from "../strategy/stage";
import { type ConquestEstimate, conquestEstimate } from "./conquest";
import type { EconomySnapshot } from "./economy";
import { compass, type Scan } from "./sectors";

const MAX_PLAYERS = 15;

// Stable short refs ("P1", "P2", ...) for players, kept for the whole game so
// memory and consecutive observations refer to the same player the same way.
export class RefBook {
  private readonly byID = new Map<string, string>();
  private next = 1;

  ref(playerID: string): string {
    let r = this.byID.get(playerID);
    if (r === undefined) {
      r = `P${this.next++}`;
      this.byID.set(playerID, r);
    }
    return r;
  }

  peek(playerID: string): string | undefined {
    return this.byID.get(playerID);
  }
}

export interface PlayerObs {
  ref: string;
  player: Player;
  json: Record<string, unknown>;
  bordersMe: boolean;
  attackingMe: boolean;
  // Land neighbors I can attack: what finishing them pays and costs.
  conquest: ConquestEstimate | null;
}

export interface Observation {
  tick: number;
  state: Record<string, unknown>;
  players: PlayerObs[];
  byRef: Map<string, PlayerObs>;
  // My border tiles facing each neighbor (smallID; 0 = unclaimed land).
  borderFacing: Map<number, TileRef[]>;
  unclaimedBorderTiles: number;
  coastal: boolean;
  myCentroid: { x: number; y: number } | null;
  // The remembered stage of the game (memory.stage) and what it was read from.
  stage: Stage;
  stageSignals: StageSignals;
}

export interface ObserveInput {
  game: Game;
  me: Player;
  scan: Scan;
  refs: RefBook;
  memory: StrategyMemory;
  // Players a transport ship can reach, found by decide/candidates.
  seaReachable: ReadonlySet<string>;
  goldPerMin: number;
  econ: EconomySnapshot;
  // The viewer-proposed playstyle, if any (strategy/doctrine.ts).
  strategy?: Strategy;
  // Already measured this step (the agent advances memory.stage with them).
  stageSignals?: StageSignals;
}

const RELATION = {
  [Relation.Hostile]: "hostile",
  [Relation.Distrustful]: "distrustful",
  [Relation.Neutral]: "neutral",
  [Relation.Friendly]: "friendly",
} as const;

export function kindOf(p: Player): "human" | "nation" | "tribe" {
  switch (p.type()) {
    case PlayerType.Human:
      return "human";
    case PlayerType.Nation:
      return "nation";
    default:
      return "tribe";
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const thousands = (n: number) => Math.round(n / 1000);
// Shares of the map start tiny; keep 4 decimals so early growth is visible.
const r4 = (n: number) => Math.round(n * 10000) / 10000;

const STRUCTURE_TYPES = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
] as const;

const STRUCTURE_KEYS: Record<(typeof STRUCTURE_TYPES)[number], string> = {
  [UnitType.City]: "city",
  [UnitType.Port]: "port",
  [UnitType.Factory]: "factory",
  [UnitType.DefensePost]: "defense_post",
  [UnitType.SAMLauncher]: "sam",
  [UnitType.MissileSilo]: "silo",
};

function structures(p: Player): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of STRUCTURE_TYPES) {
    const n = p.unitCount(t);
    if (n > 0) out[STRUCTURE_KEYS[t]] = n;
  }
  return out;
}

// Troops regrow at (10 + troops^0.73 / 4) * (1 - troops/max) per tick, which
// peaks near 42% fill. Jev gets the band as a word, not the curve.
type TroopStatus = "depleted" | "low" | "optimal" | "high" | "full";
export function troopStatus(fill: number): TroopStatus {
  if (fill < 0.08) return "depleted";
  if (fill < 0.25) return "low";
  if (fill < 0.6) return "optimal";
  if (fill < 0.9) return "high";
  return "full";
}

const TROOP_STATUS_MEANING: Record<TroopStatus, string> = {
  depleted: "almost no troops; any attack now is futile and regrowth is slow",
  low: "few troops; regrowing, attacks will be weak",
  optimal: "regrowing at the fastest rate; spending some now is efficient",
  high: "plenty of troops; regrowth is slowing, a good time to use them",
  full: "at capacity; troops are being wasted by not using them",
};

export function troopFill(game: Game, p: Player): number {
  const max = game.config().maxTroops(p);
  return max > 0 ? p.troops() / max : 0;
}

// One pass over my border tiles: who each tile touches.
function scanBorder(game: Game, me: Player): {
  facing: Map<number, TileRef[]>;
  counts: Map<number, number>;
  coastal: boolean;
} {
  const facing = new Map<number, TileRef[]>();
  const counts = new Map<number, number>();
  let coastal = false;
  const mine = me.smallID();
  for (const t of me.borderTiles()) {
    if (game.isShore(t)) coastal = true;
    const seen = new Set<number>();
    game.forEachNeighbor(t, (n) => {
      if (!game.isLand(n)) return;
      const o = game.ownerID(n);
      if (o === mine || seen.has(o)) return;
      seen.add(o);
      counts.set(o, (counts.get(o) ?? 0) + 1);
      const list = facing.get(o) ?? [];
      if (list.length < 64) list.push(t);
      facing.set(o, list);
    });
  }
  return { facing, counts, coastal };
}

export function observe(input: ObserveInput): Observation {
  const { game, me, scan, refs, memory, seaReachable, goldPerMin, econ, strategy } = input;
  const signals = input.stageSignals ?? stageSignals(game, me);
  const tick = game.ticks();
  const totalLand = Math.max(1, game.numLandTiles());
  const alive = game.players().filter((p) => p.isAlive());
  const byLand = [...alive].sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
  const rank = new Map(byLand.map((p, i) => [p.id(), i + 1]));
  const border = scanBorder(game, me);
  const myC = scan.centroids.get(me.smallID()) ?? null;

  const incoming = me.incomingAttacks().filter((a) => a.attacker().isAlive());
  const attackersOfMe = new Set(incoming.map((a) => a.attacker().id()));
  const myTargets = new Set(
    me
      .outgoingAttacks()
      .map((a) => a.target())
      .filter((t): t is Player => t.isPlayer())
      .map((t) => t.id()),
  );
  const requesters = new Set(me.incomingAllianceRequests().map((r) => r.requestor().id()));
  const allies = new Set(me.allies().map((a) => a.id()));

  // Relevance: interacting with me, then land neighbors, then sea-reachable,
  // then the land leaders.
  const others = alive.filter((p) => p !== me);
  const score = (p: Player): number => {
    const id = p.id();
    let s = 0;
    const linked = Number(econ.business.get(id)?.rail_stations_linked_to_mine ?? 0);
    if (linked > 0) s += 400 + Math.min(100, linked);
    if (attackersOfMe.has(id) || myTargets.has(id)) s += 1000;
    if (requesters.has(id) || allies.has(id)) s += 800;
    if (border.counts.has(p.smallID())) s += 500 + Math.min(200, border.counts.get(p.smallID())!);
    if (seaReachable.has(id)) s += 300;
    const rk = rank.get(id) ?? 99;
    if (rk <= 5) s += 200 - rk;
    return s + p.numTilesOwned() / totalLand;
  };
  const chosen = others
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s >= 1) // drop irrelevant small fry
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_PLAYERS)
    .map((x) => x.p);

  const myTroops = Math.max(1, me.troops());
  const winShare = game.config().percentageTilesOwnedToWin(game.elapsedGameSeconds()) / 100;
  // Land share I still need to win; allies' land counts against it, since
  // allies never lose tiles to me.
  const winGap = Math.max(0, winShare - me.numTilesOwned() / totalLand);
  const players: PlayerObs[] = chosen.map((p) => {
    const ref = refs.ref(p.id());
    const c = scan.centroids.get(p.smallID());
    const bordersMe = border.counts.has(p.smallID());
    const sea = seaReachable.has(p.id());
    const attackingMe = attackersOfMe.has(p.id());
    const dist = myC && c ? Math.round(Math.hypot(c.x - myC.x, c.y - myC.y)) : null;
    // Allies too: whether one is worth betraying is a farming question.
    const attackable = me.canAttackPlayer(p) && !me.isFriendly(p);
    const betrayable = me.isAlliedWith(p) && !me.isOnSameTeam(p);
    const conquest = bordersMe && (attackable || betrayable) ? conquestEstimate(game, me, p) : null;
    const json: Record<string, unknown> = {
      ref,
      name: p.displayName(),
      kind: kindOf(p),
      their_attitude_to_me: RELATION[p.relation(me)],
      borders_me: bordersMe,
      shared_border_tiles: border.counts.get(p.smallID()) ?? 0,
      reachable: bordersMe ? "land" : sea ? "sea" : "none",
      direction: myC && c ? compass(myC.x, myC.y, c.x, c.y) : "unknown",
      distance_tiles: dist,
      land_share: r4(p.numTilesOwned() / totalLand),
      land_rank: rank.get(p.id()) ?? null,
      troops_vs_mine: r2(p.troops() / myTroops),
      troop_fill: r2(troopFill(game, p)),
      gold_k: thousands(Number(p.gold())),
      is_ally: allies.has(p.id()),
      is_traitor: p.isTraitor(),
      disconnected: p.isDisconnected(),
      attacking_me: attackingMe,
      i_am_attacking: myTargets.has(p.id()),
      sent_me_alliance_request: requesters.has(p.id()),
      structures: structures(p),
      business: econ.business.get(p.id()),
    };
    const info = me.allianceInfo(p);
    if (info !== null) {
      json.alliance = {
        share_of_my_win_gap_they_hold: winGap > 0 ? r2(Math.min(1, p.numTilesOwned() / totalLand / winGap)) : 0,
        expires_in_min: Math.round(((info.expiresAt - tick) / 600) * 10) / 10,
        in_extension_window: info.inExtensionWindow,
        they_agreed_to_extend: info.otherAgreedToExtend,
      };
    }
    if (conquest !== null) json.conquest = conquestJson(conquest, goldPerMin, (id) => refs.ref(id));
    return { ref, player: p, json, bordersMe, attackingMe, conquest };
  });

  const refOf = (id: string) => refs.peek(id);
  const refList = (ids: Iterable<string>) =>
    [...ids].map((id) => refOf(id)).filter((r): r is string => r !== undefined);

  const inSpawn = game.inSpawnPhase();
  const leader = signals.leader;
  const state = {
    game: {
      tick,
      minutes: Math.round((tick / 600) * 10) / 10,
      phase: inSpawn ? "spawn" : "main",
      players_alive: alive.length,
      win_land_share: winShare,
      stage: `${memory.stage}: ${STAGES[memory.stage]}`,
      stage_since_min: Math.round((memory.stageSinceTick / 600) * 10) / 10,
      unclaimed_land_share: r2(signals.unclaimedShare),
      leader:
        leader === null
          ? null
          : {
              player: leader === me ? "me" : (refOf(leader.id()) ?? null),
              name: leader.displayName(),
              land_share: r4(signals.leaderShare),
              share_of_land_needed_to_win: r2(winProgress(signals.leaderShare, signals.winShare)),
            },
    },
    me: {
      name: me.displayName(),
      alive: me.isAlive(),
      land_share: r4(me.numTilesOwned() / totalLand),
      land_rank: rank.get(me.id()) ?? null,
      land_share_still_needed_to_win: r4(winGap),
      land_held_by_my_allies: r4(me.allies().reduce((sum, a) => sum + a.numTilesOwned(), 0) / totalLand),
      tiles: me.numTilesOwned(),
      troops: Math.round(me.troops()),
      troop_fill: r2(troopFill(game, me)),
      troop_status: `${troopStatus(troopFill(game, me))}: ${TROOP_STATUS_MEANING[troopStatus(troopFill(game, me))]}`,
      gold: Number(me.gold()),
      gold_per_min: Math.round(goldPerMin),
      structures: structures(me),
      economy: econ.json,
      coastal: border.coastal,
      unclaimed_land_on_border: border.counts.get(0) ?? 0,
      allies: refList(allies),
      attacking: refList(myTargets),
      expanding_into_unclaimed: me.outgoingAttacks().some((a) => !a.target().isPlayer()),
      under_attack_by: refList(attackersOfMe),
      boats_out: me.unitCount(UnitType.TransportShip),
    },
    players: players.map((p) => p.json),
    ...(strategy ? { strategy: strategyState(strategy) } : {}),
    memory: memory.toState(tick, refOf),
  };

  return {
    tick,
    state,
    players,
    byRef: new Map(players.map((p) => [p.ref, p])),
    borderFacing: border.facing,
    unclaimedBorderTiles: border.counts.get(0) ?? 0,
    coastal: border.coastal,
    myCentroid: myC,
    stage: memory.stage,
    stageSignals: signals,
  };
}

// The kill economics of one neighbor, as ratios and words Jev can compare.
function conquestJson(c: ConquestEstimate, goldPerMin: number, refOf: (id: string) => string): Record<string, unknown> {
  return {
    gold_i_get_for_finishing_them_k: thousands(c.loot),
    loot_in_minutes_of_my_income: goldPerMin > 0 ? r1(c.loot / goldPerMin) : null,
    tiles_to_take_before_they_fall: c.tilesToKill,
    share_of_my_troops_to_finish_them: c.finishFraction,
    others_attacking_them: c.rivals.map((r) => ({ player: refOf(r.player.id()), attack_troops_k: thousands(r.attackTroops) })),
    risk_someone_else_takes_the_loot: c.stealRisk,
  };
}

// Rough token estimate for budget checks (JSON chars / 4).
export function approxTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}
