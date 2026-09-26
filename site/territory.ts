// The hero map: an illustrative OpenFront-style match on a generated map.
// Nations claim unclaimed land, then fight over borders; Jev (magenta) tends
// to win, and the map regenerates for the next game. Each cell is one pixel
// of a small canvas that CSS scales up with crisp edges.

type RGB = [number, number, number];

// OKLCH -> sRGB bytes, so the canvas speaks the stylesheet's colors.
export function oklch(l: number, c: number, h: number): RGB {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((v) => {
    const x = Math.max(0, Math.min(1, v));
    return Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255);
  }) as RGB;
}

const WATER = oklch(0.1, 0, 0);
const WATER_DOT = oklch(0.17, 0, 0);
const TERRAIN = [oklch(0.2, 0.005, 150), oklch(0.235, 0.006, 120), oklch(0.28, 0.006, 90)];

interface Nation {
  fill: RGB;
  edge: RGB;
  frontier: number[];
  size: number;
  speed: number;
  jev: boolean;
}

const JEV = { fill: oklch(0.5, 0.19, 340), edge: oklch(0.72, 0.19, 340) };
const RIVALS: [RGB, RGB][] = [
  [oklch(0.38, 0.05, 235), oklch(0.55, 0.07, 235)],
  [oklch(0.4, 0.05, 165), oklch(0.58, 0.07, 165)],
  [oklch(0.42, 0.06, 75), oklch(0.62, 0.08, 75)],
  [oklch(0.36, 0.04, 285), oklch(0.54, 0.06, 285)],
  [oklch(0.4, 0.05, 25), oklch(0.58, 0.07, 25)],
  [oklch(0.37, 0.03, 200), oklch(0.55, 0.05, 200)],
  [oklch(0.41, 0.04, 110), oklch(0.6, 0.06, 110)],
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise, a few octaves: continents with ragged coasts.
function noiseField(w: number, h: number, rand: () => number): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1;
  let total = 0;
  for (const scale of [42, 20, 9, 4]) {
    const gw = Math.ceil(w / scale) + 2;
    const gh = Math.ceil(h / scale) + 2;
    const grid = Float32Array.from({ length: gw * gh }, rand);
    for (let y = 0; y < h; y++) {
      const gy = y / scale;
      const y0 = Math.floor(gy);
      const ty = gy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < w; x++) {
        const gx = x / scale;
        const x0 = Math.floor(gx);
        const tx = gx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const i = y0 * gw + x0;
        const top = grid[i] + (grid[i + 1] - grid[i]) * sx;
        const bot = grid[i + gw] + (grid[i + gw + 1] - grid[i + gw]) * sx;
        out[y * w + x] += (top + (bot - top) * sy) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

export interface MapStats {
  game: number;
  jevShare: number;
  phase: "spawn" | "claim" | "war" | "won";
}

export class TerritoryMap {
  private w = 0;
  private h = 0;
  private land!: Uint8Array; // 0 water, 1..3 terrain band
  private owner!: Int8Array; // -1 unowned
  private nations: Nation[] = [];
  private landCount = 0;
  private image!: ImageData;
  private ctx: CanvasRenderingContext2D;
  private rand = rng(7);
  private raf = 0;
  private running = false;
  private wonAt = 0;
  private started = 0;
  game = 0;
  onStats?: (s: MapStats) => void;
  // Jev's newest border cell, in 0..1 canvas coordinates: where the HUD pings.
  focus = { x: 0.5, y: 0.5 };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly cell = 5) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.reset();
  }

  reset(): void {
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.max(80, Math.min(360, Math.ceil(r.width / this.cell)));
    this.h = Math.max(60, Math.min(220, Math.ceil(r.height / this.cell)));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.image = this.ctx.createImageData(this.w, this.h);
    this.game += 1;
    this.rand = rng(1000 + this.game * 7919);
    const n = noiseField(this.w, this.h, this.rand);
    this.land = new Uint8Array(this.w * this.h);
    this.owner = new Int8Array(this.w * this.h).fill(-1);
    this.landCount = 0;
    for (let i = 0; i < n.length; i++) {
      const v = n[i];
      if (v > 0.47) {
        this.land[i] = v > 0.66 ? 3 : v > 0.56 ? 2 : 1;
        this.landCount++;
      }
    }
    this.spawn();
    this.wonAt = 0;
    this.started = performance.now();
  }

  private spawn(): void {
    const count = Math.min(RIVALS.length + 1, Math.max(4, Math.round((this.w * this.h) / 5200)));
    const seeds: number[] = [];
    const minGap = Math.min(this.w, this.h) / 3.2;
    for (let tries = 0; seeds.length < count && tries < 4000; tries++) {
      const i = Math.floor(this.rand() * this.land.length);
      if (this.land[i] === 0 || this.land[i] === 3) continue;
      const x = i % this.w;
      const y = (i / this.w) | 0;
      // Keep the lower-left clear of Jev's spawn: the headline sits there.
      if (seeds.length === 0 && (x < this.w * 0.45 || y > this.h * 0.55)) continue;
      if (seeds.every((s) => Math.hypot((s % this.w) - x, ((s / this.w) | 0) - y) > minGap)) seeds.push(i);
    }
    this.nations = seeds.map((s, k) => {
      const [fill, edge] = k === 0 ? [JEV.fill, JEV.edge] : RIVALS[(k - 1 + this.game) % RIVALS.length];
      const nation: Nation = { fill, edge, frontier: [], size: 0, speed: k === 0 ? 1.25 : 0.8 + this.rand() * 0.45, jev: k === 0 };
      return nation;
    });
    seeds.forEach((s, k) => {
      for (const j of this.disc(s, 2)) this.claim(j, k);
    });
  }

  private disc(center: number, r: number): number[] {
    const cx = center % this.w;
    const cy = (center / this.w) | 0;
    const out: number[] = [];
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if (x >= 0 && y >= 0 && x < this.w && y < this.h && (x - cx) ** 2 + (y - cy) ** 2 <= r * r && this.land[y * this.w + x]) out.push(y * this.w + x);
    return out;
  }

  private claim(i: number, k: number): void {
    const prev = this.owner[i];
    if (prev === k) return;
    if (prev >= 0) {
      const loser = this.nations[prev];
      loser.size--;
      // The loser's cells next to the lost one are border again.
      for (const j of this.neighbors(i)) if (this.owner[j] === prev) loser.frontier.push(j);
    }
    this.owner[i] = k;
    const n = this.nations[k];
    n.size++;
    n.frontier.push(i);
    if (n.jev) this.focus = { x: (i % this.w) / this.w, y: ((i / this.w) | 0) / this.h };
  }

  private neighbors(i: number): number[] {
    const x = i % this.w;
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < this.w - 1) out.push(i + 1);
    if (i >= this.w) out.push(i - this.w);
    if (i < this.w * (this.h - 1)) out.push(i + this.w);
    return out;
  }

  private step(): void {
    const claimed = this.nations.reduce((s, n) => s + n.size, 0);
    const war = claimed > this.landCount * 0.93;
    for (let k = 0; k < this.nations.length; k++) {
      const n = this.nations[k];
      if (n.size === 0) continue;
      const tries = Math.ceil((war ? 10 : 26) * n.speed * (1 + Math.sqrt(n.size) * 0.035));
      for (let t = 0; t < tries && n.frontier.length > 0; t++) {
        const fi = Math.floor(this.rand() * n.frontier.length);
        const i = n.frontier[fi];
        if (this.owner[i] !== k) {
          n.frontier[fi] = n.frontier[n.frontier.length - 1];
          n.frontier.pop();
          continue;
        }
        let open = false;
        for (const j of this.neighbors(i)) {
          if (!this.land[j] || this.owner[j] === k) continue;
          open = true;
          const o = this.owner[j];
          // Mountains slow everyone down.
          const terrain = this.land[j] === 3 ? 0.35 : this.land[j] === 2 ? 0.7 : 1;
          if (o === -1) {
            if (this.rand() < terrain) this.claim(j, k);
          } else if (war) {
            const them = this.nations[o];
            const odds = (n.size * n.speed) / (n.size * n.speed + them.size * them.speed * 1.15);
            if (this.rand() < odds * terrain * 0.5) this.claim(j, k);
          }
          break;
        }
        if (!open) {
          n.frontier[fi] = n.frontier[n.frontier.length - 1];
          n.frontier.pop();
        }
      }
    }
  }

  stats(): MapStats {
    const jev = this.nations[0]?.size ?? 0;
    const claimed = this.nations.reduce((s, n) => s + n.size, 0);
    const share = this.landCount ? jev / this.landCount : 0;
    const phase = this.wonAt ? "won" : claimed < this.nations.length * 30 ? "spawn" : claimed > this.landCount * 0.93 ? "war" : "claim";
    return { game: this.game, jevShare: share, phase };
  }

  draw(): void {
    const d = this.image.data;
    const { w, h } = this;
    for (let i = 0; i < w * h; i++) {
      const o = this.owner[i];
      let c: RGB;
      if (!this.land[i]) {
        const x = i % w;
        const y = (i / w) | 0;
        c = x % 4 === 0 && y % 4 === 0 ? WATER_DOT : WATER;
      } else if (o < 0) c = TERRAIN[this.land[i] - 1];
      else {
        const n = this.nations[o];
        const x = i % w;
        const border =
          (x > 0 && this.owner[i - 1] !== o) ||
          (x < w - 1 && this.owner[i + 1] !== o) ||
          (i >= w && this.owner[i - w] !== o) ||
          (i < w * (h - 1) && this.owner[i + w] !== o);
        c = border ? n.edge : n.fill;
      }
      const p = i * 4;
      d[p] = c[0];
      d[p + 1] = c[1];
      d[p + 2] = c[2];
      d[p + 3] = 255;
    }
    this.ctx.putImageData(this.image, 0, 0);
  }

  // Run the game to its end state instantly: the reduced-motion frame.
  settle(): void {
    for (let s = 0; s < 900 && this.stats().jevShare < 0.4; s++) this.step();
    this.draw();
    this.onStats?.(this.stats());
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.step();
    this.draw();
    const s = this.stats();
    if (s.jevShare > 0.58 && !this.wonAt) this.wonAt = now;
    // A stalemate or a finished game restarts with a new map.
    if ((this.wonAt && now - this.wonAt > 2600) || now - this.started > 75_000) this.reset();
    this.onStats?.(this.stats());
    this.raf = requestAnimationFrame(this.frame);
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
