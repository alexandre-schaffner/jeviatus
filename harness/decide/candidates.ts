// Legal candidate actions. Code enumerates what the sim would accept right
// now; Jev only ever picks among these. Every candidate here passes the same
// check the sim runs (canAttackPlayer, canBuild, canSendAllianceRequest...).

import { type Attack, type Game, type Player, PlayerType, type Unit, UnitType } from "src/core/game/Game";
import { KILL_THRESHOLD_TILES, tilesTakeable } from "../observe/conquest";
import type { TileRef } from "src/core/game/GameMap";
import { targetTransportTile } from "src/core/game/TransportShipUtils";
import { type EconomySnapshot, railFeatures } from "../observe/economy";
import { type NukeOption, nukeOptions, nukeTargets } from "./nukes";
import { kindOf, type Observation, type PlayerObs, troopFill } from "../observe/state";
import { compass, landNear, mapRegion, type Scan, type SectorGrid } from "../observe/sectors";

export const ROUTES = {
  expand: "Send troops into adjacent unclaimed land to grow territory",
  attack_player: "Attack a neighboring player over the land border to take their territory",
  naval_invasion: "Send a transport ship with troops across water to land on another player's coast",
  build: "Spend gold on a structure (city, port, factory, defense post, SAM launcher, missile silo)",
  propose_alliance: "Ask another player for an alliance",
  break_alliance: "Break an alliance with a neighboring ally and attack them at once: they and nearby players turn hostile, and for 30 seconds I am a traitor, so attacks on me cost half the usual troops",
  nuke: "Launch a nuke from my missile silo at an enemy: wipes out their land, troops and every structure in the blast; they and anyone hit turn hostile, and SAM launchers can shoot it down",
  hold: "Do nothing this step: let troops and gold accumulate",
} as const;
export type Route = keyof typeof ROUTES;

export const BUILDABLE = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.SAMLauncher,
  UnitType.MissileSilo,
] as const;
export type Buildable = (typeof BUILDABLE)[number];

export const BUILD_KEYS: Record<Buildable, string> = {
  [UnitType.City]: "city",
  [UnitType.Port]: "port",
  [UnitType.Factory]: "factory",
  [UnitType.DefensePost]: "defense_post",
  [UnitType.SAMLauncher]: "sam_launcher",
  [UnitType.MissileSilo]: "missile_silo",
};

export const BUILD_PURPOSE: Record<Buildable, string> = {
  [UnitType.City]: "raises max troops by 250k and is a train station on the rail network",
  [UnitType.Port]: "trade ships to other players' ports pay both sides, more for long routes; also a train station",
  [UnitType.Factory]: "puts nearby cities and ports (mine and neighbors') on rail and runs trains; every stop pays gold, most at allies' and foreign stations",
  [UnitType.DefensePost]: "strengthens defense of nearby border tiles against land attacks; only worth it on a border under real threat",
  [UnitType.SAMLauncher]: "shoots down incoming nukes near important structures",
  [UnitType.MissileSilo]: "launches nukes: atom bombs (750k) wipe out a city-sized area, hydrogen bombs (5M) a whole region; a strong threat against bigger rivals",
};

export interface BoatTarget {
  obs: PlayerObs;
  dst: TileRef;
}

export interface BuildOption {
  type: Buildable;
  key: string;
  cost: number;
  // Situation-specific reason, computed from the sim.
  why: string;
  // Set for upgrades: the existing structure to raise a level (no site needed).
  upgrade?: Unit;
}

// Structures worth upgrading in place, and what a level adds.
export const UPGRADE_PURPOSE: Partial<Record<Buildable, string>> = {
  [UnitType.City]: "upgrade a city: +250k max troops, no new site needed",
  [UnitType.Port]: "upgrade a port: each level adds another chance per check to launch a trade ship",
  [UnitType.SAMLauncher]: "upgrade a SAM launcher: longer range and one more interceptor ready",
};

// A big purchase worth saving gold for instead of spending it now.
export interface SavingsGoal {
  key: string;
  cost: number;
  why: string;
}

// Trains spawn per factory with hyperbolic decay (Config.trainSpawnRate,
// midpoint at 10 factories): past this, another factory adds little unless it
// connects stations.
export const TRAIN_FACTORY_MIDPOINT = 10;

// Below this troop fill, sending troops accomplishes nothing: prune the
// troop-spending routes rather than let Jev waste them.
export const MIN_FILL_TO_SEND = 0.05;

// One of my running attacks on a player, with the facts that decide whether
// to pull it back.
export interface RetreatCandidate {
  attack: Attack;
  target: Player;
  ref: string;
  facts: Record<string, unknown>;
}

export interface Candidates {
  routes: Route[];
  nukeOptions: NukeOption[];
  nukeTargets: PlayerObs[];
  // Diplomacy side decisions.
  allianceExtensions: PlayerObs[];
  embargoLifts: PlayerObs[];
  attackTargets: PlayerObs[];
  // Land-bordering allies I could break with and attack.
  betrayTargets: PlayerObs[];
  // Neighbors worth a second push this step, besides the main action:
  // finishable, being ground down by someone else, or tribes.
  sideAttacks: PlayerObs[];
  retreats: RetreatCandidate[];
  boatTargets: BoatTarget[];
  buildOptions: BuildOption[];
  savingsGoals: SavingsGoal[];
  allyCandidates: PlayerObs[];
  incomingRequests: PlayerObs[];
  donateTargets: PlayerObs[];
  threatSubjects: PlayerObs[];
}

// --- sea reachability (cached: pathing is the expensive part) --------------

export class SeaReach {
  private cache = new Map<string, TileRef>();
  private computedAt = -Infinity;

  constructor(private readonly ttlTicks = 100) {}

  // Players a transport ship can land on right now, with a landing tile each.
  get(game: Game, me: Player, scan: Scan, limit = 10): ReadonlyMap<string, TileRef> {
    if (game.ticks() - this.computedAt < this.ttlTicks) return this.cache;
    this.computedAt = game.ticks();
    this.cache = new Map();
    if (game.inSpawnPhase() || !me.isAlive() || game.config().isUnitDisabled(UnitType.TransportShip)) {
      return this.cache;
    }
    const myC = scan.centroids.get(me.smallID());
    if (myC === undefined) return this.cache;
    const others = game
      .players()
      .filter((p) => p !== me && p.isAlive() && me.canAttackPlayer(p))
      .map((p) => {
        const c = scan.centroids.get(p.smallID());
        return { p, d: c ? Math.hypot(c.x - myC.x, c.y - myC.y) : Infinity };
      })
      .filter((x) => x.d < Infinity)
      .sort((a, b) => a.d - b.d)
      .slice(0, limit * 2);
    for (const { p } of others) {
      if (this.cache.size >= limit) break;
      const shore = sampleShore(game, p, 3);
      for (const t of shore) {
        const dst = targetTransportTile(game, me, t);
        if (dst !== null && me.canBuild(UnitType.TransportShip, dst) !== false) {
          this.cache.set(p.id(), dst);
          break;
        }
      }
    }
    return this.cache;
  }

  invalidate(): void {
    this.computedAt = -Infinity;
  }
}

function sampleShore(game: Game, p: Player, n: number): TileRef[] {
  const shore: TileRef[] = [];
  for (const t of p.borderTiles()) if (game.isShore(t)) shore.push(t);
  if (shore.length <= n) return shore;
  const out: TileRef[] = [];
  for (let i = 0; i < n; i++) out.push(shore[Math.floor(((i + 0.5) * shore.length) / n)]);
  return out;
}

// --- per-step candidate sets ------------------------------------------------

export function buildCandidates(
  game: Game,
  me: Player,
  obs: Observation,
  sea: ReadonlyMap<string, TileRef>,
  econ: EconomySnapshot,
  threat: ReadonlyMap<string, number>,
  attackPeaks: ReadonlyMap<string, number> = new Map(),
): Candidates {
  const gold = me.gold();
  const underAttack = me.incomingAttacks().some((a) => a.attacker().isPlayer());
  const maxThreat = obs.players.filter((o) => o.bordersMe).reduce((m, o) => Math.max(m, threat.get(o.player.id()) ?? 0), 0);
  const attackTargets = obs.players.filter(
    (o) => o.bordersMe && me.canAttackPlayer(o.player) && !me.isFriendly(o.player),
  );
  const sideAttacks = attackTargets
    .filter((o) => o.conquest !== null && (o.conquest.finishFraction !== null || o.conquest.stealRisk !== "none" || kindOf(o.player) === "tribe"))
    .sort((a, b) => (b.conquest?.loot ?? 0) - (a.conquest?.loot ?? 0))
    .slice(0, 3);
  const retreats = retreatCandidates(game, me, obs, attackPeaks);
  const betrayTargets = obs.players.filter(
    (o) => o.bordersMe && me.isAlliedWith(o.player) && !me.isOnSameTeam(o.player) && o.player.isAlive(),
  );
  const boatsFree = me.unitCount(UnitType.TransportShip) < game.config().boatMaxNumber();
  const boatTargets: BoatTarget[] = boatsFree
    ? obs.players
        .filter((o) => sea.has(o.player.id()) && !me.isFriendly(o.player))
        .map((o) => ({ obs: o, dst: sea.get(o.player.id())! }))
    : [];
  const buildOptions: BuildOption[] = [];
  for (const type of BUILDABLE) {
    if (game.config().isUnitDisabled(type)) continue;
    const cost = game.unitInfo(type).cost(game, me);
    if (cost > gold) continue;
    if (type === UnitType.Port && !obs.coastal) continue;
    // Defense only means something with a player on the border; SAMs only
    // once someone can launch nukes.
    // Trains spawn per factory with diminishing returns, and one factory in
    // range already puts a station on rail: past one per city/port, extra
    // factories only help if some of my stations are still off rail.
    if (type === UnitType.Factory && econ.hasFactory && econ.unconnectedStations === 0 && me.unitCount(UnitType.Factory) >= TRAIN_FACTORY_MIDPOINT) continue;
    // Defense posts only pay off on a threatened border.
    if (type === UnitType.DefensePost && !underAttack && maxThreat < 1.5) continue;
    if (type === UnitType.SAMLauncher && !game.players().some((p) => p !== me && p.unitCount(UnitType.MissileSilo) > 0)) continue;
    buildOptions.push({ type, key: BUILD_KEYS[type], cost: Number(cost), why: buildWhy(game, me, type, econ, underAttack, maxThreat) });
    const upgrade = UPGRADE_PURPOSE[type] === undefined ? undefined : upgradeCandidate(me, type);
    if (upgrade !== undefined && (type !== UnitType.SAMLauncher || buildOptions.some((b) => b.type === UnitType.SAMLauncher))) {
      buildOptions.push({ type, key: `upgrade_${BUILD_KEYS[type]}`, cost: Number(cost), why: upgradeWhy(game, me, type, upgrade, econ), upgrade });
    }
  }
  const savingsGoals = savings(game, me, gold);
  const allyCandidates = obs.players.filter(
    (o) => o.player.type() !== PlayerType.Bot && me.canSendAllianceRequest(o.player),
  );
  const incomingRequests = obs.players.filter((o) =>
    me.incomingAllianceRequests().some((r) => r.requestor() === o.player),
  );
  const donateTargets = obs.players.filter(
    (o) =>
      me.isAlliedWith(o.player) &&
      o.player.incomingAttacks().length > 0 &&
      me.canDonateTroops(o.player),
  );
  const threatSubjects = obs.players.filter((o) => o.bordersMe || o.attackingMe).slice(0, 8);
  const allianceExtensions = obs.players.filter((o) => {
    const info = me.allianceInfo(o.player);
    return info !== null && info.inExtensionWindow && info.canExtend && !info.myPlayerAgreedToExtend;
  });
  const embargoLifts = obs.players.filter(
    (o) => me.hasEmbargoAgainst(o.player) && !o.attackingMe && o.player.type() !== PlayerType.Bot,
  );

  const nukes = nukeOptions(game, me);
  const targetsForNukes = nukes.length > 0 ? nukeTargets(me, obs.players) : [];

  const routes: Route[] = [];
  if (!game.inSpawnPhase() && me.isAlive()) {
    const canSend = troopFill(game, me) >= MIN_FILL_TO_SEND;
    if (canSend && obs.unclaimedBorderTiles > 0) routes.push("expand");
    if (canSend && attackTargets.length > 0) routes.push("attack_player");
    if (canSend && boatTargets.length > 0) routes.push("naval_invasion");
    if (canSend && betrayTargets.length > 0) routes.push("break_alliance");
    if (buildOptions.length > 0) routes.push("build");
    if (allyCandidates.length > 0 && !game.config().disableAlliances()) routes.push("propose_alliance");
    if (nukes.length > 0 && targetsForNukes.length > 0) routes.push("nuke");
  }
  routes.push("hold");

  return {
    routes,
    nukeOptions: nukes,
    nukeTargets: targetsForNukes,
    allianceExtensions,
    embargoLifts,
    attackTargets,
    betrayTargets,
    sideAttacks,
    retreats,
    boatTargets,
    buildOptions,
    savingsGoals,
    allyCandidates,
    incomingRequests,
    donateTargets,
    threatSubjects,
  };
}

function retreatCandidates(game: Game, me: Player, obs: Observation, peaks: ReadonlyMap<string, number>): RetreatCandidate[] {
  const home = troopFill(game, me);
  const incoming = me.incomingAttacks().filter((a) => a.attacker().isAlive());
  const incomingTroops = incoming.reduce((sum, a) => sum + a.troops(), 0);
  const out: RetreatCandidate[] = [];
  for (const a of me.outgoingAttacks()) {
    const target = a.target();
    if (!target.isPlayer() || a.retreating() || a.sourceTile() !== null) continue; // land attacks on players only
    const o = obs.players.find((x) => x.player === target);
    const ref = o?.ref ?? target.displayName();
    const toKill = Math.max(0, target.numTilesOwned() - (KILL_THRESHOLD_TILES - 1));
    const canTake = tilesTakeable(game, me, target, a.troops(), Math.max(1, toKill));
    const peak = Math.max(a.troops(), peaks.get(a.id()) ?? a.troops());
    out.push({
      attack: a,
      target,
      ref,
      facts: {
        target: ref,
        target_name: target.displayName(),
        target_kind: kindOf(target),
        attack_troops_left: Math.round(a.troops()),
        share_of_the_attack_still_alive: Math.round((a.troops() / Math.max(1, peak)) * 100) / 100,
        their_troops_vs_this_attack: Math.round((target.troops() / Math.max(1, a.troops())) * 100) / 100,
        tiles_it_can_still_take: canTake,
        tiles_to_take_before_they_fall: toKill,
        it_will_finish_them: toKill > 0 && canTake >= toKill,
        my_home_troop_fill: Math.round(home * 100) / 100,
        attacks_coming_at_me_vs_my_home_troops: Math.round((incomingTroops / Math.max(1, me.troops())) * 100) / 100,
        attacked_by: incoming.map((x) => obs.players.find((p) => p.player === x.attacker())?.ref ?? x.attacker().displayName()),
      },
    });
  }
  return out.slice(0, 4);
}

// The lowest-level finished structure of `type` I can upgrade.
function upgradeCandidate(me: Player, type: Buildable): Unit | undefined {
  return me
    .units(type)
    .filter((u) => me.canUpgradeUnit(u))
    .sort((a, b) => a.level() - b.level())[0];
}

function upgradeWhy(game: Game, me: Player, type: Buildable, u: Unit, econ: EconomySnapshot): string {
  const j = econ.json as { trade_income_per_port_per_min: number | null };
  switch (type) {
    case UnitType.City: {
      const max = game.config().maxTroops(me);
      return `my lowest city is level ${u.level()}; +250k is +${Math.round((250_000 / Math.max(1, max)) * 100)}% on my troop capacity`;
    }
    case UnitType.Port:
      return `my lowest port is level ${u.level()}; my ports earn about ${Math.round((j.trade_income_per_port_per_min ?? 0) / 1000)}k gold per minute each from trade`;
    default:
      return `my lowest SAM launcher is level ${u.level()}`;
  }
}

// Big-ticket items I can't afford yet but may want: saving is a real option.
function savings(game: Game, me: Player, gold: bigint): SavingsGoal[] {
  const out: SavingsGoal[] = [];
  const cost = (t: UnitType) => Number(game.unitInfo(t).cost(game, me));
  const nukesOn = !game.config().isUnitDisabled(UnitType.MissileSilo) && !game.config().isUnitDisabled(UnitType.AtomBomb);
  const enemySilo = game.players().some((p) => p !== me && p.isAlive() && !me.isFriendly(p) && p.unitCount(UnitType.MissileSilo) > 0);
  const hasSilo = me.unitCount(UnitType.MissileSilo) > 0;
  const g = Number(gold);
  if (enemySilo && me.unitCount(UnitType.City) > 0 && !game.config().isUnitDisabled(UnitType.SAMLauncher) && cost(UnitType.SAMLauncher) > g) {
    out.push({ key: "save_for_sam", cost: cost(UnitType.SAMLauncher), why: "a rival owns a missile silo; a SAM launcher over my cities shoots nukes down" });
  }
  if (nukesOn && !hasSilo && cost(UnitType.MissileSilo) + cost(UnitType.AtomBomb) > g) {
    out.push({ key: "save_for_silo_and_atom_bomb", cost: cost(UnitType.MissileSilo) + cost(UnitType.AtomBomb), why: "a missile silo and a first atom bomb: a nuclear threat against bigger rivals" });
  }
  if (nukesOn && hasSilo && !game.config().isUnitDisabled(UnitType.HydrogenBomb) && cost(UnitType.HydrogenBomb) > g) {
    out.push({ key: "save_for_hydrogen_bomb", cost: cost(UnitType.HydrogenBomb), why: "a hydrogen bomb wipes out a whole region, cities and SAMs included" });
  }
  return out;
}

function buildWhy(game: Game, me: Player, type: Buildable, econ: EconomySnapshot, underAttack: boolean, maxThreat: number): string {
  const j = econ.json as { trade_partners: number; partner_ports: number; foreign_stations_on_my_rail: { allied: number; other: number } };
  const cities = me.unitCount(UnitType.City);
  const ports = me.unitCount(UnitType.Port);
  switch (type) {
    case UnitType.City: {
      const max = game.config().maxTroops(me);
      return `I have ${cities} cities; another adds 250k troop capacity (+${Math.round((250_000 / Math.max(1, max)) * 100)}% on my current cap)${econ.hasFactory ? " and a paying train stop" : ""}`;
    }
    case UnitType.Port: {
      const perPort = (econ.json as { trade_income_per_port_per_min: number | null }).trade_income_per_port_per_min;
      return `${j.trade_partners} players can trade with me, with ${j.partner_ports} ports between them; I have ${ports} ports${perPort !== null ? `, earning about ${Math.round(perPort / 1000)}k gold per minute each` : ""}. Ports and factories share one price ladder`;
    }
    case UnitType.Factory:
      return econ.hasFactory
        ? `I have ${me.unitCount(UnitType.Factory)} factories${trainRate(econ)} for ${cities + ports} cities/ports; ${econ.unconnectedStations} of them a new factory could still put on rail; my rail reaches ${j.foreign_stations_on_my_rail.allied} allied and ${j.foreign_stations_on_my_rail.other} foreign stations. Past ${TRAIN_FACTORY_MIDPOINT} factories each extra one adds few trains. Ports and factories share one price ladder`
        : `I have no factory, so none of my ${cities + ports} cities/ports earn train income yet`;
    case UnitType.DefensePost:
      return underAttack ? "I am under attack right now" : `a neighbor's threat level is ${maxThreat.toFixed(1)} of 3`;
    case UnitType.SAMLauncher:
      return "someone owns a missile silo and could nuke my cities; nations aim nukes at whoever attacks them hardest and at a runaway land leader, hitting the densest cities and silos first";
    case UnitType.MissileSilo:
      return me.unitCount(UnitType.MissileSilo) > 0
        ? "I already have a silo; another only adds launch capacity"
        : "I have no silo, so I cannot nuke anyone yet";
  }
}

function trainRate(econ: EconomySnapshot): string {
  const per = (econ.json as { train_income_per_factory_per_min: number | null }).train_income_per_factory_per_min;
  return per === null ? "" : ` earning about ${Math.round(per / 1000)}k gold per minute each from trains`;
}

// --- spawn candidates (Call S) ----------------------------------------------

export interface SiteCandidate {
  id: string; // "S1", ...
  tile: TileRef;
  features: Record<string, unknown>;
}

export { spawnCandidates } from "./spawn";

// --- build sites (Call B) ------------------------------------------------------

function interiorScore(game: Game, me: Player, t: TileRef): number {
  // Distance to the nearest non-owned tile, capped; bigger = safer interior.
  const cx = game.x(t);
  const cy = game.y(t);
  const mine = me.smallID();
  for (let r = 4; r <= 40; r += 4) {
    for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const x = cx + dx;
      const y = cy + dy;
      if (!game.isValidCoord(x, y)) return r;
      const n = game.ref(x, y);
      if (game.isLand(n) && game.ownerID(n) !== mine) return r;
    }
  }
  return 44;
}

function sampleOwned(me: Player, n: number): TileRef[] {
  const total = me.numTilesOwned();
  if (total === 0) return [];
  const stride = Math.max(1, Math.floor(total / n));
  const out: TileRef[] = [];
  let i = 0;
  for (const t of me.tiles()) {
    if (i++ % stride === 0) out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

export interface SiteContext {
  game: Game;
  me: Player;
  obs: Observation;
  grid: SectorGrid;
  // playerID -> threat 0..3 (memory), for defense siting.
  threat: ReadonlyMap<string, number>;
  refOf: (playerID: string) => string | undefined;
}

// ~`count` legal, well-spread sites for `type`, each with features for Jev.
export function buildSites(ctx: SiteContext, type: Buildable, count = 10): SiteCandidate[] {
  const { game, me, obs } = ctx;
  let pool: TileRef[] = [];
  const cities = me.units(UnitType.City).map((u) => u.tile());
  switch (type) {
    case UnitType.City:
    case UnitType.MissileSilo:
      pool = sampleOwned(me, 200);
      break;
    case UnitType.Factory:
      // Interior plus borders facing players, whose cities and ports a
      // factory there can pull onto my rail.
      // Sites next to my off-rail cities and ports come first: a factory
      // there puts them on rail.
      for (const u of me.units(UnitType.City, UnitType.Port)) {
        if (!u.hasTrainStation() && !u.isUnderConstruction()) pool.push(...ringAround(game, u.tile(), 20));
      }
      pool.push(...sampleOwned(me, 150));
      for (const [sid, tiles] of obs.borderFacing) if (sid !== 0) pool.push(...tiles.slice(0, 16));
      break;
    case UnitType.Port:
      pool = [...me.borderTiles()].filter((t) => game.isShore(t));
      break;
    case UnitType.DefensePost: {
      // Border facing the most threatening neighbors first.
      const ranked = [...obs.borderFacing.entries()]
        .filter(([sid]) => sid !== 0)
        .map(([sid, tiles]) => {
          const p = game.playerBySmallID(sid);
          const th = p.isPlayer() ? (ctx.threat.get(p.id()) ?? 1) : 0;
          return { tiles, th };
        })
        .sort((a, b) => b.th - a.th);
      for (const r of ranked) pool.push(...r.tiles);
      break;
    }
    case UnitType.SAMLauncher:
      pool = cities.length > 0 ? cities.flatMap((c) => ringAround(game, c, 6)) : sampleOwned(me, 200);
      break;
  }
  const seen = new Set<TileRef>();
  const sites: { tile: TileRef; f: Record<string, unknown>; score: number }[] = [];
  const takenSectors = new Map<number, number>();
  for (const t of pool) {
    if (sites.length >= count * 3) break;
    const snapped = me.canBuild(type, t);
    if (snapped === false || seen.has(snapped)) continue;
    seen.add(snapped);
    const sector = ctx.grid.sectorOf(snapped);
    const perSector = takenSectors.get(sector) ?? 0;
    if (perSector >= 2) continue; // spread out
    takenSectors.set(sector, perSector + 1);
    const f = siteFeatures(ctx, snapped, cities, type);
    const factoryScore = Number(f.my_off_rail_stations_it_would_connect ?? 0) * 100 + Number(f.rail_value_k ?? 0) - (f.factory_already_in_range ? 50 : 0);
    sites.push({ tile: snapped, f, score: type === UnitType.Factory ? factoryScore : Number(f.interior_depth ?? 0) });
  }
  // Factories: keep the best-connected sites; others keep the spread order.
  if (type === UnitType.Factory) sites.sort((a, b) => b.score - a.score);
  return sites.slice(0, count).map((s, i) => ({ id: `S${i + 1}`, tile: s.tile, features: s.f }));
}

function ringAround(game: Game, t: TileRef, r: number): TileRef[] {
  const out: TileRef[] = [];
  const cx = game.x(t);
  const cy = game.y(t);
  for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
    if (game.isValidCoord(cx + dx, cy + dy)) out.push(game.ref(cx + dx, cy + dy));
  }
  return out;
}

function siteFeatures(ctx: SiteContext, t: TileRef, cities: TileRef[], type: Buildable): Record<string, unknown> {
  const { game, me, obs } = ctx;
  const f: Record<string, unknown> = {};
  if (obs.myCentroid) {
    f.direction_from_my_center = compass(obs.myCentroid.x, obs.myCentroid.y, game.x(t), game.y(t));
  }
  f.interior_depth = interiorScore(game, me, t);
  f.on_coast = game.isShore(t);
  const nearestCity = cities.reduce((m, c) => Math.min(m, game.manhattanDist(c, t)), Infinity);
  f.nearest_my_city_tiles = Number.isFinite(nearestCity) ? nearestCity : null;
  // Nearest foreign neighbor within ~40 tiles, with its threat level.
  let nearest: { ref: string; d: number; threat: number } | null = null;
  for (const [sid, tiles] of obs.borderFacing) {
    if (sid === 0) continue;
    const p = game.playerBySmallID(sid);
    if (!p.isPlayer()) continue;
    const ref = ctx.refOf(p.id());
    if (ref === undefined) continue;
    const d = tiles.reduce((m, b) => Math.min(m, game.manhattanDist(b, t)), Infinity);
    if (d < 60 && (nearest === null || d < nearest.d)) nearest = { ref, d, threat: ctx.threat.get(p.id()) ?? 1 };
  }
  f.nearest_neighbor = nearest === null ? null : { player: nearest.ref, border_distance_tiles: nearest.d, threat_0_to_3: Math.round(nearest.threat * 10) / 10 };
  f.existing_defense_nearby = game.hasUnitNearby(t, game.config().defensePostRange(), UnitType.DefensePost, me.id());
  if (type === UnitType.City || type === UnitType.Port || type === UnitType.Factory) {
    Object.assign(f, railFeatures(game, me, t, type));
  }
  return f;
}

// Landing sites for a boat attack on `target` (Call B, naval branch).
export function boatSites(ctx: SiteContext, target: Player, count = 8): SiteCandidate[] {
  const { game, me } = ctx;
  const shore = sampleShore(game, target, count * 3);
  const out: SiteCandidate[] = [];
  const seen = new Set<TileRef>();
  const sectors = new Set<number>();
  for (const t of shore) {
    if (out.length >= count) break;
    const dst = targetTransportTile(game, me, t);
    if (dst === null || seen.has(dst)) continue;
    const sector = ctx.grid.sectorOf(dst);
    if (sectors.has(sector) && out.length < shore.length / 2) continue;
    const src = me.canBuild(UnitType.TransportShip, dst);
    if (src === false) continue;
    seen.add(dst);
    sectors.add(sector);
    const near = landNear(game, dst, 25);
    const theirs = countOwnerNear(game, dst, target.smallID(), 25);
    out.push({
      id: `S${out.length + 1}`,
      tile: dst,
      features: {
        target_region: mapRegion(game, dst),
        sea_distance_tiles: game.manhattanDist(src, dst),
        target_land_share_within_25: Math.round((theirs / near.n) * 100) / 100,
        target_defense_post_nearby: game.hasUnitNearby(dst, game.config().defensePostRange(), UnitType.DefensePost, target.id()),
        target_city_nearby: game.hasUnitNearby(dst, 40, UnitType.City, target.id()),
      },
    });
  }
  return out;
}

function countOwnerNear(game: Game, tile: TileRef, owner: number, radius: number): number {
  const cx = game.x(tile);
  const cy = game.y(tile);
  let n = 0;
  for (let dy = -radius; dy <= radius; dy += 3) {
    for (let dx = -radius; dx <= radius; dx += 3) {
      if (dx * dx + dy * dy > radius * radius) continue;
      if (!game.isValidCoord(cx + dx, cy + dy)) continue;
      if (game.ownerID(game.ref(cx + dx, cy + dy)) === owner) n++;
    }
  }
  return n;
}
