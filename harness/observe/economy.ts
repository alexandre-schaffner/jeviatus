// Business and trade picture, computed from the sim so Jev can weigh it.
//
// How OpenFront pays (Config.trainGold / tradeShipGold, TrainStation.ts):
// - Factories put stations on rail. A city or port only joins the rail
//   network when some factory (anyone's) is within 110 tiles; rails link
//   stations of any owner. Factories spawn trains.
// - Each train stop at a city/port pays the train owner 10k at its own
//   station, 25k at a foreign one, 35k at an ally's, and the foreign station's
//   owner gets the same amount. Rail links with neighbors, especially allies,
//   are the richest income.
// - Ports send trade ships to other players' ports; both ports' owners are
//   paid, more for longer routes.
// - Any embargo (either direction) blocks both kinds of trade with that
//   player. Being attacked makes the victim embargo the attacker.

import { type Game, type Player, PlayerType, type Unit, UnitType } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";

type Rel = "self" | "ally" | "other" | "embargoed";

function relOf(me: Player, owner: Player): Rel {
  if (owner === me) return "self";
  if (!me.canTrade(owner)) return "embargoed";
  if (me.isAlliedWith(owner) || me.isOnSameTeam(owner)) return "ally";
  return "other";
}

const TRAIN_STOP_GOLD: Record<Rel, number> = { self: 10_000, ally: 35_000, other: 25_000, embargoed: 0 };

const STATION_TYPES = [UnitType.City, UnitType.Port, UnitType.Factory] as const;

function isBuilt(u: Unit): boolean {
  return u.isActive() && !u.isUnderConstruction();
}

export interface EconomySnapshot {
  json: Record<string, unknown>;
  // Per other player: business facts for their `players[]` entry.
  business: Map<string, Record<string, unknown>>;
  unconnectedStations: number; // my cities/ports a new factory could put on rail
  hasFactory: boolean;
}

// Income rates need history; the agent keeps one tracker per game.
export class IncomeTracker {
  private last: { tick: number; trade: number; train: number; total: number } | null = null;
  rates = { trade: 0, train: 0, total: 0 };

  update(me: Player, tick: number): void {
    const now = { tick, trade: Number(me.tradeGold()), train: Number(me.trainGold()), total: Number(me.goldEarned()) };
    if (this.last !== null && tick > this.last.tick) {
      const dt = (tick - this.last.tick) / 600; // minutes
      const ema = (prev: number, x: number) => (prev === 0 ? x : 0.7 * prev + 0.3 * x);
      this.rates = {
        trade: ema(this.rates.trade, (now.trade - this.last.trade) / dt),
        train: ema(this.rates.train, (now.train - this.last.train) / dt),
        total: ema(this.rates.total, (now.total - this.last.total) / dt),
      };
    }
    this.last = now;
  }
}

export function economy(game: Game, me: Player, income: IncomeTracker): EconomySnapshot {
  const sm = game.railNetwork().stationManager();
  const myClusters = new Set<unknown>();
  let unconnected = 0;
  for (const u of me.units(...STATION_TYPES)) {
    if (!isBuilt(u)) continue;
    const st = sm.findStation(u);
    const c = st?.getCluster() ?? null;
    if (c !== null) myClusters.add(c);
    // A factory only hooks up structures that have never had a station
    // (FactoryExecution.createStation), so only those count as fixable.
    if (st === null && !u.hasTrainStation() && u.type() !== UnitType.Factory) unconnected++;
  }

  // Foreign stations sharing a rail cluster with mine.
  const linked = { ally: 0, other: 0 };
  const linkedWith = new Map<string, number>();
  for (const st of sm.getAll()) {
    const c = st.getCluster();
    if (c === null || !myClusters.has(c)) continue;
    const owner = st.unit.owner();
    if (owner === me || st.unit.type() === UnitType.Factory) continue;
    const rel = relOf(me, owner);
    if (rel === "ally") linked.ally++;
    else if (rel === "other") linked.other++;
    linkedWith.set(owner.id(), (linkedWith.get(owner.id()) ?? 0) + 1);
  }

  const others = game.players().filter((p) => p !== me && p.isAlive());
  const partners = others.filter((p) => p.type() !== PlayerType.Bot && me.canTrade(p));
  const embargoedBy = others.filter((p) => p.hasEmbargoAgainst(me));
  const iEmbargo = others.filter((p) => me.hasEmbargoAgainst(p));
  const partnerPorts = partners.reduce((n, p) => n + p.unitCount(UnitType.Port), 0);
  const total = Math.max(1, income.rates.total);

  const business = new Map<string, Record<string, unknown>>();
  for (const p of others) {
    business.set(p.id(), {
      can_trade_with_me: me.canTrade(p),
      they_embargo_me: p.hasEmbargoAgainst(me),
      i_embargo_them: me.hasEmbargoAgainst(p),
      ports: p.unitCount(UnitType.Port),
      cities: p.unitCount(UnitType.City),
      factories: p.unitCount(UnitType.Factory),
      rail_stations_linked_to_mine: linkedWith.get(p.id()) ?? 0,
      train_stop_pays_each_of_us: TRAIN_STOP_GOLD[relOf(me, p)],
    });
  }

  const ports = me.unitCount(UnitType.Port);
  const factories = me.unitCount(UnitType.Factory);
  const passive = Number(game.config().goldAdditionRate(me)) * 600;
  const json = {
    note: "Train stops pay 10k at my own city/port, 25k at a foreign one, 35k at an ally's (the foreign owner is paid too). Cities and ports join the rail only near a factory. Embargoes block all trade with that player.",
    income_per_min: Math.round(income.rates.total),
    income_per_min_by_source: {
      passive: Math.round(passive),
      trade_ships: Math.round(income.rates.trade),
      trains: Math.round(income.rates.train),
    },
    trade_income_per_port_per_min: ports > 0 ? Math.round(income.rates.trade / ports) : null,
    train_income_per_factory_per_min: factories > 0 ? Math.round(income.rates.train / factories) : null,
    income_share: {
      trade_ships: Math.round((income.rates.trade / total) * 100) / 100,
      trains: Math.round((income.rates.train / total) * 100) / 100,
    },
    factories,
    ports,
    my_cities_and_ports_off_rail: unconnected,
    foreign_stations_on_my_rail: { allied: linked.ally, other: linked.other },
    trade_partners: partners.length,
    partner_ports: partnerPorts,
    embargoed_by: embargoedBy.length,
    i_embargo: iEmbargo.length,
  };
  return { json, business, unconnectedStations: unconnected, hasFactory: me.unitCount(UnitType.Factory) > 0 };
}

// Rail value of a candidate structure site: which stations it would link to.
export function railFeatures(game: Game, me: Player, tile: TileRef, type: UnitType): Record<string, unknown> {
  const min2 = game.config().trainStationMinRange() ** 2;
  const max = game.config().trainStationMaxRange();
  const max2 = max ** 2;
  const factoryNear = type === UnitType.Factory || game.hasUnitNearby(tile, max, UnitType.Factory);
  const counts: Record<Rel, number> = { self: 0, ally: 0, other: 0, embargoed: 0 };
  let myOffRail = 0;
  const sm = game.railNetwork().stationManager();
  for (const { unit, distSquared } of game.nearbyUnits(tile, max, [...STATION_TYPES])) {
    if (distSquared > max2 || !isBuilt(unit)) continue;
    if (unit.type() === UnitType.Factory) continue;
    // A new factory connects every station-less structure in range, near or far.
    if (unit.owner() === me && sm.findStation(unit) === null && !unit.hasTrainStation()) myOffRail++;
    if (distSquared < min2) continue;
    counts[relOf(me, unit.owner())]++;
  }
  const f: Record<string, unknown> = {
    joins_rail: factoryNear,
    stations_in_rail_range: { mine: counts.self, allied: counts.ally, foreign: counts.other },
  };
  if (type === UnitType.Factory) {
    f.my_off_rail_stations_it_would_connect = myOffRail;
    f.factory_already_in_range = game.hasUnitNearby(tile, max, UnitType.Factory);
    // Rough per-trip value of the stops within reach, in thousands of gold.
    f.rail_value_k = Math.round((counts.self * 10 + counts.ally * 35 + counts.other * 25));
  }
  return f;
}
