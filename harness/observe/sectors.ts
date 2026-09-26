// A coarse sector grid over the map. Jev can't aggregate tiles, so geography
// reaches it only as small feature objects computed here: per-sector land,
// coast and ownership shares, and compass directions/distances between places.

import type { Game } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";

export interface SectorStatic {
  land: number; // sampled land tiles
  coast: number; // sampled shore land tiles
  cx: number;
  cy: number;
}

export interface SectorDynamic {
  unowned: number; // sampled unowned land
  owners: Map<number, number>; // smallID -> sampled tiles
}

export interface Centroid {
  x: number;
  y: number;
  n: number; // sampled tiles
}

export interface Scan {
  tick: number;
  sectors: SectorDynamic[];
  centroids: Map<number, Centroid>; // by smallID
}

const DIRS = ["east", "southeast", "south", "southwest", "west", "northwest", "north", "northeast"];

export function compass(fromX: number, fromY: number, toX: number, toY: number): string {
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return "here";
  // Screen coordinates: y grows southward.
  const angle = Math.atan2(dy, dx);
  const idx = Math.round(angle / (Math.PI / 4));
  return DIRS[(idx + 8) % 8];
}

export class SectorGrid {
  readonly cols: number;
  readonly rows: number;
  readonly step: number;
  readonly statics: SectorStatic[];
  private readonly sw: number;
  private readonly sh: number;

  constructor(
    private readonly game: Game,
    cols = 16,
    rows = 16,
    // Sample every `step`-th tile on both axes; ~150k samples per scan.
    step?: number,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.sw = game.width() / cols;
    this.sh = game.height() / rows;
    this.step = step ?? Math.max(1, Math.floor(Math.sqrt((game.width() * game.height()) / 150_000)));
    this.statics = [];
    for (let i = 0; i < cols * rows; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      this.statics.push({ land: 0, coast: 0, cx: (c + 0.5) * this.sw, cy: (r + 0.5) * this.sh });
    }
    this.forEachSample((t, s) => {
      if (!game.isLand(t) || game.isImpassable(t)) return;
      this.statics[s].land++;
      if (game.isShore(t)) this.statics[s].coast++;
    });
  }

  private forEachSample(fn: (tile: TileRef, sector: number) => void): void {
    const g = this.game;
    const w = g.width();
    const h = g.height();
    for (let y = 0; y < h; y += this.step) {
      const r = Math.min(this.rows - 1, Math.floor(y / this.sh));
      for (let x = 0; x < w; x += this.step) {
        const c = Math.min(this.cols - 1, Math.floor(x / this.sw));
        fn(g.ref(x, y), r * this.cols + c);
      }
    }
  }

  sectorOf(tile: TileRef): number {
    const c = Math.min(this.cols - 1, Math.floor(this.game.x(tile) / this.sw));
    const r = Math.min(this.rows - 1, Math.floor(this.game.y(tile) / this.sh));
    return r * this.cols + c;
  }

  label(sector: number): string {
    return `r${Math.floor(sector / this.cols)}c${sector % this.cols}`;
  }

  // Ownership pass: one sampled sweep gives per-sector owner shares and every
  // player's territory centroid.
  scan(): Scan {
    const g = this.game;
    const sectors: SectorDynamic[] = this.statics.map(() => ({ unowned: 0, owners: new Map() }));
    const sums = new Map<number, { x: number; y: number; n: number }>();
    this.forEachSample((t, s) => {
      if (!g.isLand(t) || g.isImpassable(t)) return;
      const owner = g.ownerID(t);
      if (owner === 0) {
        sectors[s].unowned++;
        return;
      }
      const d = sectors[s];
      d.owners.set(owner, (d.owners.get(owner) ?? 0) + 1);
      const acc = sums.get(owner) ?? { x: 0, y: 0, n: 0 };
      acc.x += g.x(t);
      acc.y += g.y(t);
      acc.n++;
      sums.set(owner, acc);
    });
    const centroids = new Map<number, Centroid>();
    for (const [id, a] of sums) centroids.set(id, { x: a.x / a.n, y: a.y / a.n, n: a.n });
    return { tick: g.ticks(), sectors, centroids };
  }
}

// Sampled land stats in a disc around `tile`.
export function landNear(game: Game, tile: TileRef, radius: number, step = 3): { land: number; unowned: number; coast: number; n: number } {
  const cx = game.x(tile);
  const cy = game.y(tile);
  let land = 0;
  let unowned = 0;
  let coast = 0;
  let n = 0;
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!game.isValidCoord(x, y)) continue;
      n++;
      const t = game.ref(x, y);
      if (!game.isLand(t) || game.isImpassable(t)) continue;
      land++;
      if (!game.hasOwner(t)) unowned++;
      if (game.isShore(t)) coast++;
    }
  }
  return { land, unowned, coast, n: Math.max(1, n) };
}

export function mapRegion(game: Game, tile: TileRef): string {
  const fx = game.x(tile) / game.width();
  const fy = game.y(tile) / game.height();
  const ns = fy < 1 / 3 ? "north" : fy > 2 / 3 ? "south" : "";
  const ew = fx < 1 / 3 ? "west" : fx > 2 / 3 ? "east" : "";
  return ns + ew === "" ? "center" : `${ns}${ns && ew ? "-" : ""}${ew}`;
}
