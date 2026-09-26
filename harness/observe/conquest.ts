// What finishing off a neighbor is worth and what it costs, computed with the
// sim's own rules so Jev can farm weak players instead of guessing.
//
// How OpenFront pays for a kill (AttackExecution.handleDeadDefender,
// GameImpl.conquerPlayer, Config.conquerGoldAmount):
// - A player is conquered the moment an attack's tile capture leaves them
//   under 100 tiles. Whoever made that capture gets the gold: all of it from
//   tribes and nations, half from humans (the other half is destroyed), none
//   from a human who never attacked anyone. Their leftover tiles go to the
//   killer where they touch, else to other neighbors.
// - So the loot goes to whoever lands the last blow, not to whoever did the
//   work: an attack that stops short only softens the target for a rival.
// - A kill by nuke (no conqueror) destroys the gold instead.
// - Passive income is flat (100 gold/tick for humans and nations), so a rich
//   victim can be worth many minutes of income.

import { type Game, type Player, PlayerType, UnitType } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import { ATTACK_INDEX_SENT } from "src/core/StatsSchemas";

export const KILL_THRESHOLD_TILES = 100;

export interface Rival {
  player: Player;
  attackTroops: number;
}

export interface ConquestEstimate {
  // Gold I would receive for landing the killing capture now.
  loot: number;
  // Tiles I must take before they drop under the kill threshold.
  tilesToKill: number;
  // Smallest share of my troops that finishes them in one push (with a
  // safety margin), or null if my whole army would not.
  finishFraction: number | null;
  // Attack troops consumed by that push.
  troopsToKill: number | null;
  // Other players attacking the same target right now.
  rivals: Rival[];
  // A rival already pushing enough troops to finish them before I do.
  stealRisk: "none" | "some" | "high";
}

// Gold the conqueror receives, mirroring GameImpl.conquerPlayer.
export function conquestLoot(game: Game, target: Player): number {
  if (target.type() === PlayerType.Human) {
    const sent = game.stats().getPlayerStats(target)?.attacks?.[ATTACK_INDEX_SENT] ?? 0n;
    if (sent === 0n) return 0;
  }
  return Number(game.config().conquerGoldAmount(target));
}

// Candidate stack sizes, as shares of my troops.
const STACKS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 0.9] as const;
// The push must arrive with this share of its troops left: the defender
// regrows and fights back while the attack crawls across its land.
const MARGIN = 0.3;
const CHUNKS = 40;

// Border tiles of `target` facing me, sampled for terrain and defense posts.
function frontSample(game: Game, me: Player, target: Player, n = 8): TileRef[] {
  const mine = me.smallID();
  const front: TileRef[] = [];
  for (const t of target.borderTiles()) {
    let facing = false;
    game.forEachNeighbor(t, (x) => {
      if (game.ownerID(x) === mine) facing = true;
    });
    if (facing) front.push(t);
  }
  if (front.length <= n) return front;
  return Array.from({ length: n }, (_, i) => front[Math.floor(((i + 0.5) * front.length) / n)]);
}

// Attacker troops lost per captured tile, averaged over the front sample.
function lossPerTile(game: Game, me: Player, target: Player, sample: TileRef[], attackTroops: number, defTroops: number, defTiles: number): number {
  const cfg = game.config();
  const falloutRatio = game.numTilesWithFallout() / Math.max(1, game.numLandTiles());
  let sum = 0;
  for (const t of sample) {
    sum += cfg.attackLogic({
      terrain: game.terrainType(t),
      attackTroops,
      attacker: { type: me.type(), numTiles: me.numTilesOwned() },
      defender: {
        type: target.type(),
        numTiles: defTiles,
        troops: defTroops,
        isTraitor: target.isTraitor(),
        isDisconnectedTeammate: target.isDisconnected() && me.isOnSameTeam(target),
      },
      defenderHasDefensePost: game.hasUnitNearby(t, cfg.defensePostRange(), UnitType.DefensePost, target.id()),
      falloutRatio: game.hasFallout(t) ? falloutRatio : null,
      borderSize: Math.max(1, sample.length),
    }).attackerTroopLoss;
  }
  return sum / sample.length;
}

// Troops left in a stack of `stack` after taking `tiles` tiles, or <= 0 if it
// dies on the way. Chunked: losses change as both sides bleed.
function pushRemainder(game: Game, me: Player, target: Player, sample: TileRef[], stack: number, tiles: number): number {
  let attack = stack;
  let defTroops = target.troops();
  let defTiles = target.numTilesOwned();
  const step = Math.max(1, Math.ceil(tiles / CHUNKS));
  for (let taken = 0; taken < tiles && attack > 0; taken += step) {
    const n = Math.min(step, tiles - taken);
    attack -= n * lossPerTile(game, me, target, sample, attack, defTroops, defTiles);
    // The defender loses its troops-per-tile for every tile taken.
    defTroops = Math.max(0, defTroops - n * (defTroops / Math.max(1, defTiles)));
    defTiles -= n;
  }
  return attack;
}

export function conquestEstimate(game: Game, me: Player, target: Player): ConquestEstimate {
  const tilesToKill = Math.max(0, target.numTilesOwned() - (KILL_THRESHOLD_TILES - 1));
  const rivals = target
    .incomingAttacks()
    .filter((a) => a.attacker() !== me && a.attacker().isAlive())
    .map((a) => ({ player: a.attacker(), attackTroops: a.troops() }));

  let finishFraction: number | null = null;
  let troopsToKill: number | null = null;
  const sample = frontSample(game, me, target);
  const troops = me.troops();
  // A new land attack on a target I'm already attacking merges into the
  // running one (AttackExecution), so those troops push too.
  const committed = me
    .outgoingAttacks()
    .filter((a) => a.target() === target)
    .reduce((sum, a) => sum + a.troops(), 0);
  if (sample.length > 0 && troops >= 1) {
    for (const share of STACKS) {
      const stack = troops * share + committed;
      const left = pushRemainder(game, me, target, sample, stack, tilesToKill);
      if (left >= stack * MARGIN) {
        finishFraction = share;
        troopsToKill = Math.round(stack - left);
        break;
      }
    }
  }

  // A rival push that could cover the whole kill cost is a real race.
  const need = troopsToKill ?? Infinity;
  const strongest = rivals.reduce((m, r) => Math.max(m, r.attackTroops), 0);
  const stealRisk = rivals.length === 0 ? "none" : strongest >= need ? "high" : "some";

  return { loot: conquestLoot(game, target), tilesToKill, finishFraction, troopsToKill, rivals, stealRisk };
}

// How many of `target`'s tiles an attack stack can still take before it runs
// out, up to `cap` (the kill line is the interesting cap). For a running
// attack this is the "is it stalling?" number.
export function tilesTakeable(game: Game, me: Player, target: Player, stack: number, cap: number): number {
  const sample = frontSample(game, me, target);
  if (sample.length === 0 || stack < 1) return 0;
  let attack = stack;
  let defTroops = target.troops();
  let defTiles = target.numTilesOwned();
  const step = Math.max(1, Math.ceil(cap / CHUNKS));
  let taken = 0;
  while (taken < cap && defTiles > 0) {
    const n = Math.min(step, cap - taken);
    const loss = n * lossPerTile(game, me, target, sample, attack, defTroops, defTiles);
    if (loss >= attack) return taken + Math.floor((attack / loss) * n);
    attack -= loss;
    defTroops = Math.max(0, defTroops - n * (defTroops / Math.max(1, defTiles)));
    defTiles -= n;
    taken += n;
  }
  return taken;
}
