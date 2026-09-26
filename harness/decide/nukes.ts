// Nukes: legal launch options and scored blast sites. Code does the blast
// geometry (what each site would destroy, who it would anger, which SAMs
// cover it); Jev picks the target, the bomb, and the site.
//
// OpenFront rules (PlayerImpl.nukeSpawn, NukeExecution, execution/Util.ts):
// - Launch needs a missile silo that is built and off its cooldown; any
//   distance. Teammates can't be targeted.
// - Every tile within the inner radius and some of the outer ring is wiped
//   (owner loses it, it becomes fallout), troops die in proportion, and every
//   unit within the outer radius is destroyed.
// - Anyone with >100 weighted tiles in the blast, or a structure in it, breaks
//   any alliance with the launcher and turns hostile.
// - Enemy SAM launchers in range can shoot the missile down.

import { type Game, type Player, PlayerType, UnitType } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import { computeNukeBlastCounts, listNukeBreakAlliance, wouldNukeBreakAlliance } from "src/core/execution/Util";
import type { PlayerObs } from "../observe/state";
import type { SiteCandidate, SiteContext } from "./candidates";

const NUKE_TYPES = [UnitType.AtomBomb, UnitType.HydrogenBomb] as const;
export type NukeType = (typeof NUKE_TYPES)[number];

const NUKE_KEYS: Record<NukeType, string> = {
  [UnitType.AtomBomb]: "atom_bomb",
  [UnitType.HydrogenBomb]: "hydrogen_bomb",
};

export interface NukeOption {
  type: NukeType;
  key: string;
  cost: number;
  radius: number; // outer blast radius, tiles
}

// Blast zone may hold at most this much of my own weighted land.
const MAX_SELF_DAMAGE = 20;

const TARGET_STRUCTURES = [
  UnitType.City,
  UnitType.Port,
  UnitType.Factory,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.DefensePost,
] as const;

const STRUCTURE_KEY: Record<(typeof TARGET_STRUCTURES)[number], string> = {
  [UnitType.City]: "city",
  [UnitType.Port]: "port",
  [UnitType.Factory]: "factory",
  [UnitType.MissileSilo]: "silo",
  [UnitType.SAMLauncher]: "sam",
  [UnitType.DefensePost]: "defense_post",
};

function hasReadySilo(me: Player): boolean {
  return me.units(UnitType.MissileSilo).some((s) => s.isActive() && !s.isInCooldown() && !s.isUnderConstruction());
}

export function nukeOptions(game: Game, me: Player): NukeOption[] {
  if (game.inSpawnPhase() || game.isSpawnImmunityActive() || !hasReadySilo(me)) return [];
  const out: NukeOption[] = [];
  for (const type of NUKE_TYPES) {
    if (game.config().isUnitDisabled(type)) continue;
    const cost = game.unitInfo(type).cost(game, me);
    if (cost > me.gold()) continue;
    out.push({ type, key: NUKE_KEYS[type], cost: Number(cost), radius: game.config().nukeMagnitudes(type).outer });
  }
  return out;
}

// Enemies worth a nuke: not friendly, not tribes, with land or structures.
export function nukeTargets(me: Player, players: PlayerObs[]): PlayerObs[] {
  return players.filter(
    (o) =>
      !me.isFriendly(o.player) &&
      !me.isOnSameTeam(o.player) &&
      o.player.type() !== PlayerType.Bot &&
      o.player.numTilesOwned() > 500,
  );
}

function allySmallIds(me: Player): Set<number> {
  return new Set(me.allies().map((a) => a.smallID()));
}

// SAM launchers (not mine or friendly) whose range covers `tile`.
function samCover(game: Game, me: Player, tile: TileRef): number {
  const maxRange = 160;
  let n = 0;
  for (const { unit, distSquared } of game.nearbyUnits(tile, maxRange, [UnitType.SAMLauncher])) {
    if (unit.isUnderConstruction() || me.isFriendly(unit.owner())) continue;
    const r = game.config().samRange(unit.level());
    if (distSquared <= r * r) n++;
  }
  return n;
}

// Would this blast hurt me or an ally too much? (Pure geometry at this tick.)
export function unsafeBlast(game: Game, me: Player, tile: TileRef, type: NukeType): string | null {
  const magnitude = game.config().nukeMagnitudes(type);
  const counts = computeNukeBlastCounts({ gm: game, targetTile: tile, magnitude });
  if ((counts.get(me.smallID()) ?? 0) > MAX_SELF_DAMAGE) return "would hit my own land";
  if (game.anyUnitNearby(tile, magnitude.outer, TARGET_STRUCTURES, (u) => u.owner() === me)) return "would destroy my own structures";
  const allies = allySmallIds(me);
  if (wouldNukeBreakAlliance({ game, targetTile: tile, magnitude, allySmallIds: allies, threshold: game.config().nukeAllianceBreakThreshold() })) {
    return "would break an alliance";
  }
  return null;
}

// Candidate blast centers on `target`: its structures, its territory near its
// center, and its border with me. Scored by what the blast destroys.
export function nukeSites(ctx: SiteContext, target: Player, opt: NukeOption, count = 8): SiteCandidate[] {
  const { game, me, obs } = ctx;
  const pool: TileRef[] = [];
  for (const u of target.units(TARGET_STRUCTURES)) pool.push(u.tile());
  const facing = obs.borderFacing.get(target.smallID()) ?? [];
  let i = 0;
  // Blast geometry is a few circle scans per site, so keep the pool small.
  const stride = Math.max(1, Math.floor(target.numTilesOwned() / 40));
  for (const t of target.tiles()) {
    if (i++ % stride === 0) pool.push(t);
    if (pool.length > 80) break;
  }
  const magnitude = game.config().nukeMagnitudes(opt.type);
  const minSpacing2 = (magnitude.outer * 0.8) ** 2;
  const scored: { tile: TileRef; score: number; f: Record<string, unknown> }[] = [];
  for (const t of pool) {
    if (scored.some((s) => game.euclideanDistSquared(s.tile, t) < minSpacing2)) continue;
    if (me.canBuild(opt.type, t) === false) continue;
    if (unsafeBlast(game, me, t, opt.type) !== null) continue;
    const counts = computeNukeBlastCounts({ gm: game, targetTile: t, magnitude });
    const theirTiles = Math.round(counts.get(target.smallID()) ?? 0);
    if (theirTiles < 20) continue;
    const destroyed: Record<string, number> = {};
    let structureValue = 0;
    for (const { unit } of game.nearbyUnits(t, magnitude.outer, [...TARGET_STRUCTURES])) {
      if (unit.owner() !== target) continue;
      const k = STRUCTURE_KEY[unit.type() as (typeof TARGET_STRUCTURES)[number]];
      destroyed[k] = (destroyed[k] ?? 0) + 1;
      structureValue += unit.type() === UnitType.City || unit.type() === UnitType.MissileSilo ? 3 : 1;
    }
    const angered = [...listNukeBreakAlliance({ game, targetTile: t, magnitude, threshold: game.config().nukeAllianceBreakThreshold() })]
      .map((sid) => game.playerBySmallID(sid))
      .filter((p): p is Player => p.isPlayer() && p !== target && p !== me)
      .map((p) => ctx.refOf(p.id()) ?? p.displayName());
    const sams = samCover(game, me, t);
    const facingDist = facing.reduce((m, b) => Math.min(m, game.manhattanDist(b, t)), Infinity);
    scored.push({
      tile: t,
      score: theirTiles / 50 + structureValue * 2 - sams * 3 - angered.length,
      f: {
        their_land_destroyed_tiles: theirTiles,
        their_share_of_land_destroyed: Math.round((theirTiles / Math.max(1, target.numTilesOwned())) * 1000) / 1000,
        their_structures_destroyed: destroyed,
        enemy_sams_covering: sams,
        other_players_angered: angered,
        near_my_border: Number.isFinite(facingDist) && facingDist < magnitude.outer * 2,
      },
    });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((s, j) => ({ id: `N${j + 1}`, tile: s.tile, features: s.f }));
}
