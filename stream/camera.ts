// The camera director: during a match it points OpenFront's own camera at
// what's happening to Jev (a nuke on the way, an attack on Jev, its boats, its
// attacks), holds each shot long enough to follow, rotates between ongoing
// events, and falls back to Jev's territory. After Jev is out it spectates the
// biggest battle and the leader. Each shot has a caption for the band.
//
// The page side is read-only except for the camera move itself, made through
// the client's TransformHandler (the same smooth pan/zoom the player's own
// "go to" uses), reached via <build-menu>.transformHandler.

// A spot on the map, in tiles: a center and the radius to keep in view.
export interface Place {
  x: number;
  y: number;
  r: number;
}

export type EventKind = "nuke_in" | "nuke_out" | "attack_in" | "boat" | "attack_out" | "battle";

export interface SceneEvent {
  key: string;
  kind: EventKind;
  label: string;
  place: Place;
  // Bigger is more urgent; ties break toward the larger troop count.
  weight: number;
  // The other player involved (attacker, target, the nuke's owner).
  other?: string;
}

export interface Scene {
  phase: "none" | "spawn" | "alive" | "dead";
  map: { w: number; h: number };
  view: { w: number; h: number };
  me: { name: string; place: Place | null; rank: number; players: number; landPct: number } | null;
  events: SceneEvent[];
  leader: { name: string; place: Place } | null;
}

export interface Shot {
  key: string;
  caption: string;
  place: Place;
  weight: number;
}

// Reads the scene from the page's game view. Runs in the page.
export const SCENE = `(() => {
  const bm = document.querySelector("build-menu");
  const g = bm?.game;
  const canvas = bm?.transformHandler?.boundingRect?.();
  const view = { w: canvas?.width || innerWidth, h: canvas?.height || innerHeight };
  if (!g) return { phase: "none", map: { w: 0, h: 0 }, view, me: null, events: [], leader: null };
  const map = { w: g.width(), h: g.height() };
  const players = g.players().filter((p) => p.isAlive());
  const place = (p, min = 14) => {
    const n = p.nameLocation?.();
    if (!n) return null;
    return { x: n.x, y: n.y, r: Math.max(min, Math.sqrt(p.numTilesOwned()) * 0.75) };
  };
  const between = (a, b) => {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: Math.min(160, Math.max(24, d / 2 + Math.min(a.r, b.r) * 0.6)) };
  };
  const tile = (t, r) => ({ x: g.x(t), y: g.y(t), r });
  const name = (p) => p.displayName?.() ?? p.name();
  const byTiles = [...players].sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
  const leader = byTiles[0] && place(byTiles[0]) ? { name: name(byTiles[0]), place: place(byTiles[0]) } : null;
  const events = [];
  const me = g.myPlayer();
  let phase = g.inSpawnPhase() ? "spawn" : me && me.hasSpawned() && me.isAlive() ? "alive" : "dead";
  let meOut = null;
  if (me && me.hasSpawned()) {
    const mine = place(me);
    const land = g.numLandTiles?.() || 1;
    meOut = { name: name(me), place: mine, rank: byTiles.findIndex((p) => p.id() === me.id()) + 1, players: players.length, landPct: me.numTilesOwned() / land * 100 };
    if (phase === "alive" && mine) {
      for (const a of me.incomingAttacks()) {
        const from = g.playerBySmallID(a.attackerID);
        if (!from?.isPlayer?.() || a.retreating) continue;
        const p = place(from);
        if (p) events.push({ key: "in:" + a.id, kind: "attack_in", other: name(from), label: name(from) + " attacks Jev", place: between(mine, p), weight: 60 + Math.min(20, a.troops / Math.max(1, me.troops()) * 20) });
      }
      for (const a of me.outgoingAttacks()) {
        const to = g.playerBySmallID(a.targetID);
        if (!to?.isPlayer?.() || a.retreating) continue;
        const p = place(to);
        if (p) events.push({ key: "out:" + a.id, kind: "attack_out", other: name(to), label: "Jev attacks " + name(to), place: between(mine, p), weight: 40 + Math.min(15, a.troops / Math.max(1, to.troops()) * 10) });
      }
      for (const u of me.units("Transport")) {
        events.push({ key: "boat:" + u.id(), kind: "boat", label: "Jev's invasion fleet", place: tile(u.lastTile(), 26), weight: 50 });
      }
    }
    for (const u of g.units("Atom Bomb", "Hydrogen Bomb", "MIRV")) {
      const target = u.targetTile?.();
      const owner = target !== undefined ? g.owner(target) : null;
      const at = tile(u.lastTile(), 20);
      const aim = target !== undefined ? tile(target, 20) : at;
      const spot = between(at, aim);
      if (u.owner().id() === me.id()) events.push({ key: "nuke:" + u.id(), kind: "nuke_out", label: "Jev launches a " + u.type().toLowerCase(), place: spot, weight: 90 });
      else if (owner?.isPlayer?.() && owner.id() === me.id() && phase === "alive") events.push({ key: "nuke:" + u.id(), kind: "nuke_in", other: name(u.owner()), label: name(u.owner()) + "'s " + u.type().toLowerCase() + " is falling on Jev", place: spot, weight: 100 });
    }
  }
  if (phase !== "alive") {
    let best = null;
    for (const p of players) for (const a of p.outgoingAttacks()) {
      const to = g.playerBySmallID(a.targetID);
      if (!to?.isPlayer?.() || a.retreating) continue;
      if (!best || a.troops > best.troops) best = { a, from: p, to, troops: a.troops };
    }
    if (best) {
      const pa = place(best.from), pb = place(best.to);
      if (pa && pb) events.push({ key: "battle:" + best.a.id, kind: "battle", label: "Biggest battle: " + name(best.from) + " vs " + name(best.to), place: between(pa, pb), weight: 30 });
    }
  }
  return { phase, map, view, me: meOut, events, leader };
})()`;

// The pan/zoom itself. `scale` is screen pixels per tile.
export function gotoExpression(p: { x: number; y: number }, scale: number): string {
  return `(() => { const th = document.querySelector("build-menu")?.transformHandler; if (!th) return false;
    th.onGoToPosition({ x: ${Math.round(p.x)}, y: ${Math.round(p.y)} }); th.targetScale = ${scale.toFixed(3)}; return true; })()`;
}

// Pixels per tile that keep a place (with margin) in the view.
export function scaleFor(place: Place, view: { w: number; h: number }): number {
  const fit = Math.min(view.w, view.h) / (place.r * 2 * 1.25);
  return Math.max(0.6, Math.min(7, fit));
}

export function overviewScale(map: { w: number; h: number }, view: { w: number; h: number }): number {
  return Math.max(0.2, Math.min(view.w / map.w, view.h / map.h) * 0.95);
}

export interface DirectorOptions {
  minShotMs: number; // no cut before this
  maxShotMs: number; // rotate to another event after this
  revisitMs: number; // an event shown this recently yields to others
  preemptBy: number; // a new event this much more urgent cuts in early
}

const DEFAULTS: DirectorOptions = { minShotMs: 6_000, maxShotMs: 16_000, revisitMs: 30_000, preemptBy: 30 };

export class Director {
  private current: Shot | null = null;
  private since = 0;
  private readonly shownAt = new Map<string, number>();
  private readonly o: DirectorOptions;

  constructor(o: Partial<DirectorOptions> = {}) {
    this.o = { ...DEFAULTS, ...o };
  }

  get shot(): Shot | null {
    return this.current;
  }

  // The shot to show now. Same key as before: keep following it (its place
  // may have moved: a boat, a front). Returns null when there's nothing to film.
  next(scene: Scene, now: number): Shot | null {
    const candidates = this.candidates(scene);
    if (candidates.length === 0) return (this.current = null);
    const held = now - this.since;
    const same = this.current ? candidates.find((c) => c.key === this.current!.key) : undefined;
    const top = candidates[0]!;
    let pick: Shot | undefined;
    if (same && held < this.o.minShotMs) pick = same;
    else if (same && top.key !== same.key && top.weight >= same.weight + this.o.preemptBy) pick = top;
    else if (same && held < this.o.maxShotMs) pick = same;
    else {
      // Rotate: the most urgent thing not shown lately; else the most urgent.
      const fresh = candidates.filter((c) => c.key !== this.current?.key && now - (this.shownAt.get(c.key) ?? -Infinity) > this.o.revisitMs);
      pick = fresh[0] ?? (candidates.find((c) => c.key !== this.current?.key) ?? top);
    }
    if (pick.key !== this.current?.key) {
      this.since = now;
      this.shownAt.set(pick.key, now);
    }
    this.current = pick;
    return pick;
  }

  private candidates(scene: Scene): Shot[] {
    const events = [...scene.events].sort((a, b) => b.weight - a.weight).map((e) => ({ key: e.key, caption: e.label, place: e.place, weight: e.weight }));
    if (scene.phase === "spawn") {
      return [{ key: "overview", caption: "Players are picking where to spawn", place: { x: scene.map.w / 2, y: scene.map.h / 2, r: Math.max(scene.map.w, scene.map.h) / 2 }, weight: 0 }];
    }
    if (scene.phase === "alive" && scene.me?.place) {
      // Home: Jev's land, always a candidate so quiet moments have a shot.
      return [...events, { key: "home", caption: "Jev's territory", place: scene.me.place, weight: 10 }];
    }
    if (scene.phase === "dead") {
      const leader = scene.leader ? [{ key: "leader", caption: `The leader: ${scene.leader.name}`, place: scene.leader.place, weight: 20 }] : [];
      return [...events, ...leader];
    }
    return events;
  }
}

// The camera target and zoom for a shot.
export function framing(shot: Shot, scene: Scene): { x: number; y: number; scale: number } {
  const scale = shot.key === "overview" ? overviewScale(scene.map, scene.view) : scaleFor(shot.place, scene.view);
  return { x: shot.place.x, y: shot.place.y, scale };
}
