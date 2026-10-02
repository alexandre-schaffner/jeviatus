// Strategy memory across decision steps. Everything here is *inferred* or
// remembered by the agent (goals, grudges, threat judgments, what its own
// actions achieved); observed facts come fresh from the sim each step.

import { detectStage, laterStage, type Stage, type StageSignals } from "./stage";

export const GOALS = {
  grow_territory: "Grab as much land as possible, mainly unclaimed land, while it lasts",
  build_economy: "Grow income through business: cities, ports and factories on rail, trade with many partners, and allies whose stations pay the most",
  fortify: "Defend borders against stronger neighbors with defense posts and SAMs; avoid new wars",
  conquer_neighbor: "Farm weaker neighbors, tribes first: finish them one at a time to take their land and all their gold",
  survive: "Stay alive under heavy pressure: keep troops home, seek allies, avoid provoking anyone",
} as const;
export type Goal = keyof typeof GOALS;

export interface Vitals {
  tiles: number;
  troops: number;
  gold: number;
}

export interface ActionRecord {
  tick: number;
  action: string;
  target?: string; // player ref or site label, as shown to Jev
  targetID?: string; // sim player ID, for war-target tracking
  detail?: string;
  before: Vitals;
  outcome?: string;
}

export interface Grudge {
  playerID: string;
  lastTick: number;
  count: number;
}

const SWITCH_PROBABILITY = 0.6; // goal switch needs p above this...
const SWITCH_STREAK = 2; // ...on this many consecutive steps
const MAX_RECENT = 6;

function signed(n: number, unit: string): string {
  const r = Math.round(n);
  return `${r >= 0 ? "+" : ""}${r.toLocaleString("en-US")} ${unit}`;
}

export class StrategyMemory {
  goal: Goal = "grow_territory";
  goalSinceTick = 0;
  stage: Stage = "early";
  stageSinceTick = 0;
  private pending: { goal: Goal; streak: number } | null = null;
  warTarget: string | null = null;
  readonly grudges = new Map<string, Grudge>();
  readonly threat = new Map<string, number>(); // playerID -> 0..3 score
  readonly recent: ActionRecord[] = [];
  // Largest troop count seen per running attack of mine: how much it started with.
  readonly attackPeaks = new Map<string, number>();

  // Hysteresis: a different goal must win with p > threshold on N
  // consecutive steps before it replaces the current one. Returns true on switch.
  observeGoal(probabilities: Record<string, number>, tick: number): boolean {
    let best: Goal = this.goal;
    let bestP = -1;
    for (const [g, p] of Object.entries(probabilities)) {
      if (g in GOALS && p > bestP) {
        best = g as Goal;
        bestP = p;
      }
    }
    if (best === this.goal || bestP <= SWITCH_PROBABILITY) {
      this.pending = null;
      return false;
    }
    this.pending = this.pending?.goal === best ? { goal: best, streak: this.pending.streak + 1 } : { goal: best, streak: 1 };
    if (this.pending.streak >= SWITCH_STREAK) {
      this.goal = best;
      this.goalSinceTick = tick;
      this.pending = null;
      return true;
    }
    return false;
  }

  // The stage only moves forward. Returns true when it advanced.
  advanceStage(signals: StageSignals, tick: number): boolean {
    const next = laterStage(this.stage, detectStage(signals));
    if (next === this.stage) return false;
    this.stage = next;
    this.stageSinceTick = tick;
    return true;
  }

  noteMyAttacks(attacks: { id(): string; troops(): number }[]): void {
    const live = new Set<string>();
    for (const a of attacks) {
      live.add(a.id());
      this.attackPeaks.set(a.id(), Math.max(this.attackPeaks.get(a.id()) ?? 0, a.troops()));
    }
    for (const id of this.attackPeaks.keys()) if (!live.has(id)) this.attackPeaks.delete(id);
  }

  noteAttackers(playerIDs: string[], tick: number): void {
    for (const id of playerIDs) {
      const g = this.grudges.get(id);
      // Count distinct attack waves, not every step an attack is ongoing.
      if (g === undefined) this.grudges.set(id, { playerID: id, lastTick: tick, count: 1 });
      else {
        if (tick - g.lastTick > 300) g.count++;
        g.lastTick = tick;
      }
    }
  }

  // Close out the previous step's action with what changed since it was taken.
  settle(now: Vitals): void {
    const last = this.recent.at(-1);
    if (last !== undefined && last.outcome === undefined) {
      last.outcome = [
        signed(now.tiles - last.before.tiles, "tiles"),
        signed(now.troops - last.before.troops, "troops"),
        signed(now.gold - last.before.gold, "gold"),
      ].join(", ");
    }
  }

  record(rec: Omit<ActionRecord, "before">, before: Vitals): void {
    this.recent.push({ ...rec, before });
    while (this.recent.length > MAX_RECENT) this.recent.shift();
    if (rec.action === "attack_player" || rec.action === "naval_invasion" || rec.action === "nuke" || rec.action === "break_alliance") {
      this.warTarget = rec.targetID ?? this.warTarget;
    }
  }

  // The memory block of the observation. `refOf` maps player IDs to the refs
  // used in the state; unknown players are dropped.
  toState(tick: number, refOf: (playerID: string) => string | undefined): Record<string, unknown> {
    const min = (t: number) => Math.round((t / 600) * 10) / 10;
    const grudges = [...this.grudges.values()]
      .filter((g) => tick - g.lastTick < 3000)
      .map((g) => ({ player: refOf(g.playerID), attacked_me_times: g.count, last_min: min(g.lastTick) }))
      .filter((g) => g.player !== undefined);
    const threats: Record<string, number> = {};
    for (const [id, s] of this.threat) {
      const ref = refOf(id);
      if (ref !== undefined) threats[ref] = Math.round(s * 10) / 10;
    }
    return {
      note: "Inferred by the agent from past steps, not observed facts.",
      goal: this.goal,
      goal_since_min: min(this.goalSinceTick),
      war_target: this.warTarget === null ? null : (refOf(this.warTarget) ?? null),
      grudges,
      threat_levels_0_to_3: threats,
      recent_actions: this.recent.map((r) => ({
        min: min(r.tick),
        action: r.action,
        ...(r.target !== undefined ? { target: r.target } : {}),
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        outcome: r.outcome ?? "pending",
      })),
    };
  }
}
