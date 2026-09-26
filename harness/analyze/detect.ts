// Pattern detectors over game timelines: what Jev keeps doing badly, and what
// preceded its best moments. Each detector returns every hit with where it
// happened, so the report can count them and link a few for review.

import type { GameRecord, StepRow } from "./load";

export interface Evidence {
  game: string;
  tick: number;
  minute: number;
  note: string;
  // Ranks the evidence when set (highest first).
  score?: number;
}

export interface Detector {
  key: string;
  kind: "bad" | "good";
  title: string;
  detect(g: GameRecord): Evidence[];
}

export interface Finding {
  key: string;
  kind: "bad" | "good";
  title: string;
  count: number;
  games: number;
  evidence: Evidence[];
}

export const MAX_EVIDENCE = 5;
const MINUTE = 600; // ticks
// A condition has to last this long to count as a streak.
const STREAK_TICKS = 300;

const minute = (tick: number) => Math.round((tick / MINUTE) * 10) / 10;
const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

function ev(g: GameRecord, s: { tick: number }, note: string): Evidence {
  return { game: g.id, tick: s.tick, minute: minute(s.tick), note };
}

// Maximal runs of consecutive steps matching `when` that last at least
// `minTicks`: one hit per run, at its start.
function streaks(steps: StepRow[], when: (s: StepRow) => boolean, minTicks = STREAK_TICKS): { from: StepRow; to: StepRow }[] {
  const out: { from: StepRow; to: StepRow }[] = [];
  let from: StepRow | null = null;
  let to: StepRow | null = null;
  const close = () => {
    if (from !== null && to !== null && to.tick - from.tick >= minTicks) out.push({ from, to });
    from = to = null;
  };
  for (const s of steps) {
    if (when(s)) {
      from ??= s;
      to = s;
    } else close();
  }
  close();
  return out;
}

function playerName(s: StepRow, ref: string | undefined): string {
  if (ref === undefined) return "?";
  const p = s.players.find((x) => x.ref === ref);
  return p ? `${ref} ${p.name}` : ref;
}

const ATTACKS = new Set(["attack_player", "naval_invasion"]);

export function tilesDelta(outcome: string | undefined): number | null {
  const m = outcome === undefined ? null : /([+-][\d,]+) tiles/.exec(outcome);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

const sentKinds = (s: StepRow) => new Set(s.intents.filter((i) => i.sent).map((i) => i.intent?.type));
// The step's attack actually went out (not rate limited or rejected).
const attackSent = (s: StepRow) => sentKinds(s).has("attack") || sentKinds(s).has("boat");

// Repeated sends on the same target are one episode: a hit only counts if
// the last one on that target was over 30 s earlier.
function episodes(g: GameRecord, hit: (s: StepRow) => { target: string; note: string } | null): Evidence[] {
  const lastTick = new Map<string, number>();
  const out: Evidence[] = [];
  for (const s of g.steps) {
    const h = hit(s);
    if (h === null) continue;
    const prev = lastTick.get(h.target);
    lastTick.set(h.target, s.tick);
    if (prev === undefined || s.tick - prev > STREAK_TICKS) out.push(ev(g, s, h.note));
  }
  return out;
}

// Land share after `ticks`, or at the last step before then.
function shareAt(steps: StepRow[], tick: number): number | null {
  let share: number | null = null;
  for (const s of steps) {
    if (s.tick > tick) break;
    if (s.me) share = s.me.land_share;
  }
  return share;
}

// 1-minute land-share windows, for gains, collapses and key moments.
export interface Swing {
  from: StepRow;
  to: StepRow;
  before: number;
  after: number;
}

export function swings(g: GameRecord, window = MINUTE): Swing[] {
  const steps = g.steps.filter((s) => s.me !== null);
  const out: Swing[] = [];
  let j = 0;
  for (let i = 0; i < steps.length; i++) {
    while (j + 1 < steps.length && steps[j + 1].tick - steps[i].tick <= window) j++;
    if (j <= i) continue;
    out.push({ from: steps[i], to: steps[j], before: steps[i].me!.land_share, after: steps[j].me!.land_share });
  }
  return out;
}

// The best non-overlapping swings by `score` (highest first).
export function topSwings(all: Swing[], score: (s: Swing) => number, n: number, min: number): Swing[] {
  const picked: Swing[] = [];
  for (const s of [...all].sort((a, b) => score(b) - score(a))) {
    if (picked.length >= n || score(s) < min) break;
    if (picked.some((p) => s.from.tick <= p.to.tick && s.to.tick >= p.from.tick)) continue;
    picked.push(s);
  }
  return picked;
}

export const collapseScore = (s: Swing) => (s.before >= 0.002 ? (s.before - s.after) / s.before : 0);
export const gainScore = (s: Swing) => s.after - s.before;
export const COLLAPSE_MIN = 0.3;
export const GAIN_MIN = 0.01;

const routesIn = (g: GameRecord, from: number, to: number) => {
  const counts = new Map<string, number>();
  for (const s of g.steps) if (s.tick >= from && s.tick <= to && s.record) counts.set(s.record.action, (counts.get(s.record.action) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}×${n}`).join(", ");
};

export const DETECTORS: Detector[] = [
  {
    key: "losing_attack",
    kind: "bad",
    title: "Attacked a stronger player, or an attack lost land",
    detect: (g) =>
      episodes(g, (s) => {
        if (s.record?.action !== "attack_player" || !attackSent(s)) return null;
        const ref = s.record.target ?? "?";
        const ratio = s.players.find((p) => p.ref === ref)?.troops_vs_mine;
        const lost = tilesDelta(s.outcome);
        if ((ratio ?? 0) > 1) return { target: ref, note: `attacked ${playerName(s, ref)}, who has ${ratio}x my troops` };
        if (lost !== null && lost < 0) return { target: ref, note: `attack on ${playerName(s, ref)}, then ${lost} tiles` };
        return null;
      }),
  },
  {
    key: "two_front",
    kind: "bad",
    title: "Opened an attack while under attack by someone else",
    detect: (g) =>
      episodes(g, (s) => {
        if (!s.record || !ATTACKS.has(s.record.action) || !s.me || !attackSent(s)) return null;
        const others = s.me.under_attack_by.filter((r) => r !== s.record!.target);
        if (others.length === 0) return null;
        return {
          target: s.record.target ?? "?",
          note: `${s.record.action} on ${playerName(s, s.record.target)} while ${others.map((r) => playerName(s, r)).join(", ")} attacked me`,
        };
      }),
  },
  {
    key: "idle_gold",
    kind: "bad",
    title: "Could afford a structure for 30 s+ and bought nothing",
    detect: (g) =>
      streaks(g.steps, (s) => s.buildOptions.length > 0 && !sentKinds(s).has("build_unit") && !sentKinds(s).has("upgrade_structure")).map(
        ({ from, to }) => ev(g, from, `${Math.round((to.tick - from.tick) / 10)} s with ${from.me?.gold ?? "?"} gold; could buy ${from.buildOptions.join(", ")}`),
      ),
  },
  {
    key: "expansion_stall",
    kind: "bad",
    title: "Unclaimed land on the border but not expanding (first 10 min)",
    detect: (g) =>
      streaks(
        g.steps,
        (s) => s.tick < 10 * MINUTE && s.me !== null && s.me.unclaimed_land_on_border > 0 && !s.me.expanding_into_unclaimed && s.record?.action !== "expand",
        200,
      ).map(({ from, to }) => ev(g, from, `${Math.round((to.tick - from.tick) / 10)} s idle next to ${from.me!.unclaimed_land_on_border} unclaimed border tiles`)),
  },
  {
    key: "wasted_troops",
    kind: "bad",
    title: "Troops at 95%+ of the cap for 30 s+ (regrowth wasted)",
    detect: (g) =>
      streaks(g.steps, (s) => (s.me?.troop_fill ?? 0) >= 0.95).map(({ from, to }) => ev(g, from, `${Math.round((to.tick - from.tick) / 10)} s at full troops`)),
  },
  {
    key: "hold_streak",
    kind: "bad",
    title: "No main action for 30 s+",
    detect: (g) =>
      streaks(g.steps, (s) => s.record?.action === "hold").map(({ from, to }) => {
        const reasons = [...new Set(g.steps.filter((s) => s.tick >= from.tick && s.tick <= to.tick).map((s) => s.holdReason ?? s.record?.detail ?? "chose to hold"))];
        return ev(g, from, `${Math.round((to.tick - from.tick) / 10)} s holding: ${reasons.slice(0, 3).join("; ")}`);
      }),
  },
  {
    key: "betrayed",
    kind: "bad",
    title: "An ally turned on me",
    detect: (g) => {
      const out: Evidence[] = [];
      const allies = new Set<string>();
      const flagged = new Set<string>();
      for (const s of g.steps) {
        if (!s.me) continue;
        for (const r of s.me.under_attack_by) {
          if (allies.has(r) && !s.me.allies.includes(r) && !flagged.has(r)) {
            flagged.add(r);
            out.push(ev(g, s, `former ally ${playerName(s, r)} attacking me`));
          }
        }
        for (const r of s.me.allies) allies.add(r);
      }
      return out;
    },
  },
  {
    key: "broke_alliance_then_lost",
    kind: "bad",
    title: "Broke an alliance and had less land 3 min later",
    detect: (g) =>
      g.steps.flatMap((s) => {
        if (s.record?.action !== "break_alliance" || !s.me) return [];
        const later = g.death && g.death.tick <= s.tick + 3 * MINUTE ? 0 : shareAt(g.steps, s.tick + 3 * MINUTE);
        if (later === null || later >= s.me.land_share) return [];
        return [ev(g, s, `broke with ${playerName(s, s.record.target)} at ${pct(s.me.land_share)}, ${later === 0 ? "dead" : pct(later)} 3 min later`)];
      }),
  },
  {
    key: "spawn_failed",
    kind: "bad",
    title: "Never spawned, or spawned in the last seconds",
    detect: (g) => {
      const first = g.spawns.find((s) => s.sent && !s.recheck);
      const noLand = g.steps.every((s) => (s.me?.tiles ?? 0) === 0);
      // Spawned by hand (Jev switched on after the spawn): not Jev's miss.
      if (first === undefined && !noLand) return [];
      if (first === undefined || noLand || /never spawned/i.test(g.streamResult ?? "")) {
        return [{ game: g.id, tick: first?.tick ?? 0, minute: minute(first?.tick ?? 0), note: first === undefined ? "no spawn intent was sent" : "spawn sent but never held land" }];
      }
      if (first.ticksLeft !== null && first.ticksLeft < 50) return [ev(g, first, `spawned with ${Math.round(first.ticksLeft / 10)} s of spawn phase left`)];
      return [];
    },
  },
  {
    key: "big_gain",
    kind: "good",
    title: "Largest 1-minute land gains (routes taken during them)",
    detect: (g) =>
      topSwings(swings(g), gainScore, 3, GAIN_MIN).map((s) => ({
        ...ev(g, s.from, `${pct(s.before)} → ${pct(s.after)} (+${pct(s.after - s.before)}); ${routesIn(g, s.from.tick, s.to.tick) || "no actions"}`),
        score: gainScore(s),
      })),
  },
  {
    key: "conquest",
    kind: "good",
    title: "Finished off a player I was attacking",
    detect: (g) => {
      const out: Evidence[] = [];
      const done = new Set<string>();
      for (let i = 0; i + 1 < g.steps.length; i++) {
        const s = g.steps[i];
        for (const p of s.players) {
          if (!p.i_am_attacking || done.has(p.ref)) continue;
          // Gone from view within a minute while the alive count dropped.
          const later = g.steps.slice(i + 1).filter((x) => x.tick <= s.tick + MINUTE);
          const gone = later.find((x) => !x.players.some((q) => q.ref === p.ref) && (x.playersAlive ?? 0) < (s.playersAlive ?? 0));
          if (gone) {
            done.add(p.ref);
            out.push(ev(g, gone, `eliminated ${p.ref} ${p.name} (${p.kind ?? "?"}, ${pct(p.land_share ?? 0)} land)`));
          }
        }
      }
      return out;
    },
  },
  {
    key: "lasting_alliance",
    kind: "good",
    title: "Alliances that lasted 5 min+",
    detect: (g) => {
      const refs = new Set(g.steps.flatMap((s) => s.me?.allies ?? []));
      return [...refs].flatMap((r) =>
        streaks(g.steps, (s) => s.me?.allies.includes(r) ?? false, 5 * MINUTE).map(({ from, to }) =>
          ev(g, from, `allied with ${playerName(from, r)} for ${minute(to.tick - from.tick)} min`),
        ),
      );
    },
  },
];

// Up to `max` pieces of evidence, one game at a time so a single bad game
// doesn't fill the list.
function spread(hits: Evidence[], max: number): Evidence[] {
  const byGame = new Map<string, Evidence[]>();
  for (const h of hits) byGame.set(h.game, [...(byGame.get(h.game) ?? []), h]);
  const out: Evidence[] = [];
  for (let round = 0; out.length < max; round++) {
    let any = false;
    for (const list of byGame.values()) {
      if (round < list.length && out.length < max) {
        out.push(list[round]);
        any = true;
      }
    }
    if (!any) break;
  }
  return out;
}

export function detectAll(games: GameRecord[], detectors = DETECTORS): Finding[] {
  return detectors.map((d) => {
    const hits = games.flatMap((g) => d.detect(g));
    return {
      key: d.key,
      kind: d.kind,
      title: d.title,
      count: hits.length,
      games: new Set(hits.map((h) => h.game)).size,
      evidence: spread(hits.some((h) => h.score !== undefined) ? hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)) : hits, MAX_EVIDENCE),
    };
  });
}
