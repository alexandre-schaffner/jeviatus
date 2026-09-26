// Spawn candidates (Call S). Code measures each site's prospects; Jev weighs
// them. The key number is `land_i_would_likely_claim_first`: land on the same
// landmass that is closer to this site than to any other known spawn (placed
// players and the nations' fixed spawn points), i.e. my share of an early
// Voronoi split. It predicts early growth far better than local land density.

import { type Game, type Player, TerrainType } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import { compass, landNear, mapRegion, type SectorGrid } from "../observe/sectors";
import { kindOf } from "../observe/state";
import type { SiteCandidate } from "./candidates";

interface Anchor {
  x: number;
  y: number;
  name: string;
  kind: "human" | "nation" | "tribe";
}

// Connected landmasses on the minimap, computed once per game.
class Landmasses {
  readonly label: Int32Array;
  readonly size: number[] = [0];
  readonly scale: number; // real tiles per minimap tile
  private readonly mw: number;
  private readonly sx: number;
  private readonly sy: number;

  constructor(private readonly game: Game) {
    const mini = game.miniMap();
    this.mw = mini.width();
    const mh = mini.height();
    this.sx = mini.width() / game.width();
    this.sy = mini.height() / game.height();
    this.scale = (game.width() / mini.width()) * (game.height() / mini.height());
    this.label = new Int32Array(this.mw * mh);
    const stack: number[] = [];
    for (let i = 0; i < this.label.length; i++) {
      const t = mini.ref(i % this.mw, Math.floor(i / this.mw));
      if (this.label[i] !== 0 || !mini.isLand(t) || mini.isImpassable(t)) continue;
      const id = this.size.length;
      let n = 0;
      this.label[i] = id;
      stack.push(i);
      while (stack.length > 0) {
        const j = stack.pop()!;
        n++;
        const x = j % this.mw;
        const y = Math.floor(j / this.mw);
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= this.mw || ny >= mh) continue;
          const k = ny * this.mw + nx;
          if (this.label[k] !== 0) continue;
          const nt = mini.ref(nx, ny);
          if (!mini.isLand(nt) || mini.isImpassable(nt)) continue;
          this.label[k] = id;
          stack.push(k);
        }
      }
      this.size.push(n);
    }
  }

  of(x: number, y: number): number {
    return this.label[Math.floor(y * this.sy) * this.mw + Math.floor(x * this.sx)] ?? 0;
  }

  tiles(id: number): number {
    return Math.round((this.size[id] ?? 0) * this.scale);
  }
}

const landmassCache = new WeakMap<Game, Landmasses>();
function landmasses(game: Game): Landmasses {
  let l = landmassCache.get(game);
  if (l === undefined) {
    l = new Landmasses(game);
    landmassCache.set(game, l);
  }
  return l;
}

// Everyone who is or will be on the map: placed spawns plus the nations'
// fixed spawn points (known before they spawn).
function anchors(game: Game, me: Player): Anchor[] {
  const out: Anchor[] = [];
  for (const p of game.allPlayers()) {
    if (p === me) continue;
    const t = p.spawnTile();
    if (t !== undefined) out.push({ x: game.x(t), y: game.y(t), name: p.displayName(), kind: kindOf(p) });
  }
  for (const n of game.nations()) {
    const c = n.spawnCell;
    if (c === undefined) continue;
    if (out.some((a) => Math.hypot(a.x - c.x, a.y - c.y) < 60)) continue; // already placed
    out.push({ x: c.x, y: c.y, name: n.playerInfo.name, kind: "nation" });
  }
  return out;
}

// Land on my landmass closer to (cx, cy) than to any anchor, within `radius`.
function claimFirst(game: Game, lm: Landmasses, cx: number, cy: number, others: Anchor[], radius = 240, step = 8): number {
  const home = lm.of(cx, cy);
  let n = 0;
  const near = others.filter((a) => Math.hypot(a.x - cx, a.y - cy) < radius * 2.2);
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const d2 = dx * dx + dy * dy;
      if (d2 > radius * radius) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!game.isValidCoord(x, y)) continue;
      const t = game.ref(x, y);
      if (!game.isLand(t) || game.isImpassable(t) || lm.of(x, y) !== home) continue;
      if (near.some((a) => (a.x - x) ** 2 + (a.y - y) ** 2 < d2)) continue;
      n++;
    }
  }
  return n * step * step;
}

function terrainShares(game: Game, tile: TileRef, radius = 40, step = 4): Record<string, number> {
  const c = { plains: 0, highland: 0, mountain: 0 };
  let land = 0;
  const cx = game.x(tile);
  const cy = game.y(tile);
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      if (dx * dx + dy * dy > radius * radius || !game.isValidCoord(cx + dx, cy + dy)) continue;
      const t = game.ref(cx + dx, cy + dy);
      if (!game.isLand(t)) continue;
      land++;
      const tt = game.terrainType(t);
      if (tt === TerrainType.Plains) c.plains++;
      else if (tt === TerrainType.Highland) c.highland++;
      else if (tt === TerrainType.Mountain) c.mountain++;
    }
  }
  const r = (v: number) => Math.round((v / Math.max(1, land)) * 100) / 100;
  return { plains: r(c.plains), highland: r(c.highland), mountain: r(c.mountain) };
}

function siteFeatures(game: Game, lm: Landmasses, tile: TileRef, others: Anchor[]): { f: Record<string, unknown>; score: number } {
  const x = game.x(tile);
  const y = game.y(tile);
  const claim = claimFirst(game, lm, x, y, others);
  const totalLand = Math.max(1, game.numLandTiles());
  const massTiles = lm.tiles(lm.of(x, y));
  const terrain = terrainShares(game, tile);
  const near = landNear(game, tile, 40);
  const rivals = others
    .filter((a) => a.kind !== "tribe")
    .map((a) => ({ a, d: Math.round(Math.hypot(a.x - x, a.y - y)) }))
    .sort((p, q) => p.d - q.d);
  const within200 = rivals.filter((r) => r.d < 200).length;
  // Mountains and highland slow expansion; crowding invites early wars.
  const terrainFactor = terrain.plains + 0.75 * terrain.highland + 0.5 * terrain.mountain;
  const score = (claim / totalLand) * 100 * (0.5 + 0.5 * terrainFactor) - Math.max(0, within200 - 2) * 0.5;
  return {
    score,
    f: {
      map_region: mapRegion(game, tile),
      land_i_would_likely_claim_first: claim,
      that_as_share_of_all_land: Math.round((claim / totalLand) * 1000) / 1000,
      landmass: { tiles: massTiles, is_island: massTiles < totalLand * 0.03 },
      terrain_within_40: terrain,
      coast_share_nearby: Math.round((near.coast / Math.max(1, near.land)) * 100) / 100,
      nearest_rivals: rivals.slice(0, 3).map((r) => ({ name: r.a.name, kind: r.a.kind, distance_tiles: r.d, direction: compass(x, y, r.a.x, r.a.y) })),
      rivals_within_200_tiles: within200,
    },
  };
}

// Legal spawn centers (unowned, non-border land clear of other spawns), spread
// across sectors. A cheap local-density pass shortlists; the full features run
// on the shortlist. With `current`, my present spawn is included as "S0".
export function spawnCandidates(game: Game, me: Player, grid: SectorGrid, count = 12, seed = 1, current?: TileRef): SiteCandidate[] {
  const lm = landmasses(game);
  const others = anchors(game, me);
  const minDist = game.config().minDistanceBetweenPlayers();
  const mine = me.smallID();
  const free = (t: TileRef) => !game.hasOwner(t) || game.ownerID(t) === mine;
  let rnd = seed * 2654435761;
  const rand = () => {
    rnd = (rnd * 1103515245 + 12345) >>> 0;
    return rnd / 2 ** 32;
  };
  const probes: { tile: TileRef; sector: number; pre: number }[] = [];
  for (let s = 0; s < grid.statics.length; s++) {
    if (grid.statics[s].land < 4) continue;
    for (let k = 0; k < 6; k++) {
      const x = Math.floor((s % grid.cols) * (game.width() / grid.cols) + rand() * (game.width() / grid.cols));
      const y = Math.floor(Math.floor(s / grid.cols) * (game.height() / grid.rows) + rand() * (game.height() / grid.rows));
      if (!game.isValidCoord(x, y)) continue;
      const t = game.ref(x, y);
      if (!game.isLand(t) || game.isImpassable(t) || !free(t) || game.isBorder(t)) continue;
      if (others.some((a) => Math.abs(a.x - x) + Math.abs(a.y - y) < minDist)) continue;
      const near = landNear(game, t, 40, 5);
      probes.push({ tile: t, sector: s, pre: near.land / near.n });
    }
  }
  // Best probe per sector, then the densest 40 sectors get full features.
  const perSector = new Map<number, (typeof probes)[number]>();
  for (const p of probes) {
    const b = perSector.get(p.sector);
    if (b === undefined || p.pre > b.pre) perSector.set(p.sector, p);
  }
  const shortlist = [...perSector.values()].sort((a, b) => b.pre - a.pre).slice(0, 40);
  const scored = shortlist.map((p) => ({ tile: p.tile, ...siteFeatures(game, lm, p.tile, others) }));
  scored.sort((a, b) => b.score - a.score);
  const out: SiteCandidate[] = scored.slice(0, count).map((s, i) => ({ id: `S${i + 1}`, tile: s.tile, features: s.f }));
  if (current !== undefined) {
    out.unshift({ id: "S0", tile: current, features: { stay_where_i_am: true, ...siteFeatures(game, lm, current, others).f } });
  }
  return out;
}
