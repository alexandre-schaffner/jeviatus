// Turns trace.jsonl files (log/format.ts) into one record per agent per game:
// a compact per-step timeline plus the lifecycle events. Parsing is pure;
// only loadTraces touches the filesystem.

import fs from "node:fs";
import path from "node:path";

// The fields of state.me (observe/state.ts) the detectors read.
export interface MeSnap {
  land_share: number;
  land_rank: number | null;
  tiles: number;
  troops: number;
  troop_fill: number;
  gold: number;
  under_attack_by: string[];
  attacking: string[];
  allies: string[];
  unclaimed_land_on_border: number;
  expanding_into_unclaimed: boolean;
}

export interface PlayerSnap {
  ref: string;
  name: string;
  kind?: string;
  land_share?: number;
  troops_vs_mine?: number;
  is_ally?: boolean;
  attacking_me?: boolean;
  i_am_attacking?: boolean;
  [k: string]: unknown;
}

export interface IntentRow {
  desc: string;
  sent: boolean;
  reason?: string;
  intent?: { type: string; [k: string]: unknown };
}

export interface ActionRecord {
  action: string;
  target?: string;
  detail?: string;
}

export interface StepRow {
  tick: number;
  minute: number;
  me: MeSnap | null;
  playersAlive: number | null;
  players: PlayerSnap[];
  route: string;
  held: boolean;
  holdReason?: string;
  confidence: number;
  used: Record<string, number>;
  record?: ActionRecord;
  // What this step's action had done by the next step (memory.settle).
  outcome?: string;
  intents: IntentRow[];
  buildOptions: string[];
  goal?: string;
  // Answers to the route call (Call A), for the moment dumps.
  answers: Record<string, unknown> | null;
  calls: number;
  failedCalls: number;
  callLatencyMs: number;
}

export interface SpawnRow {
  tick: number;
  sent: boolean;
  recheck: boolean;
  ticksLeft: number | null;
}

export interface DeathEvent {
  tick: number;
  minutes: number;
  landShareBefore: number | null;
  peakLandShare: number;
  attackers: { ref: string; name: string | null; troops_vs_mine: number | null; threat: number | null }[];
}

export interface AgentSummaryRow {
  name: string;
  alive: boolean;
  won: boolean;
  outcome: string;
  peakLandShare: number;
  finalLandShare: number;
  ticksSurvived: number;
  steps: number;
  holds: number;
}

export interface GameRecord {
  // Directory name, plus the agent when a trace holds several.
  id: string;
  dir: string;
  agent: string;
  source: string;
  strategy: string;
  map: string;
  players: number | null;
  harnessCommit: string;
  model: string;
  startedAt: string | null;
  steps: StepRow[];
  spawns: SpawnRow[];
  death: DeathEvent | null;
  summary: AgentSummaryRow | null;
  summaryReason: string | null;
  // The stream driver's read of the page (JEV WON / eliminated at ... / never spawned).
  streamResult: string | null;
  errors: string[];
  lastTick: number;
}

type Event = Record<string, unknown> & { type?: string };

const NO_STRATEGY = "(Jev's own judgment)";

function routeCall(calls: unknown): { state: Record<string, unknown>; answers: Record<string, unknown> | null } | null {
  if (!Array.isArray(calls)) return null;
  const c = (calls.find((x) => (x as { label?: string }).label === "route") ?? calls[0]) as
    | { state?: Record<string, unknown>; answers?: Record<string, unknown> }
    | undefined;
  return c?.state ? { state: c.state, answers: c.answers ?? null } : null;
}

function callStats(calls: unknown): { calls: number; failed: number; latency: number } {
  const list = Array.isArray(calls) ? (calls as { error?: string; latencyMs?: number }[]) : [];
  return {
    calls: list.length,
    failed: list.filter((c) => c.error !== undefined).length,
    latency: list.reduce((s, c) => s + (c.latencyMs ?? 0), 0),
  };
}

function stepRow(e: Event): StepRow {
  const tick = Number(e.tick);
  const call = routeCall(e.calls);
  const state = call?.state as { me?: MeSnap; players?: PlayerSnap[]; game?: { players_alive?: number } } | undefined;
  const d = (e.decision ?? {}) as { route?: string; held?: boolean; holdReason?: string; confidence?: number; used?: Record<string, number>; record?: ActionRecord };
  const stats = callStats(e.calls);
  return {
    tick,
    minute: Math.round((tick / 600) * 10) / 10,
    me: state?.me ?? null,
    playersAlive: state?.game?.players_alive ?? null,
    players: state?.players ?? [],
    route: d.route ?? "hold",
    held: d.held === true,
    holdReason: d.holdReason,
    confidence: d.confidence ?? 0,
    used: d.used ?? {},
    record: d.record,
    intents: (e.intents as IntentRow[] | undefined) ?? [],
    buildOptions: ((e.candidates as { build?: string[] } | undefined)?.build ?? []),
    goal: (e.memory as { goal?: string } | undefined)?.goal,
    answers: call?.answers ?? null,
    calls: stats.calls,
    failedCalls: stats.failed,
    callLatencyMs: stats.latency,
  };
}

// The step after an action settles it: its memory's last recent action is
// the previous step's record, with the outcome filled in.
function settleOutcomes(steps: StepRow[], raw: Event[]): void {
  for (let i = 0; i + 1 < steps.length; i++) {
    const next = routeCall(raw[i + 1].calls)?.state as { memory?: { recent_actions?: { action: string; outcome: string }[] } } | undefined;
    const last = next?.memory?.recent_actions?.at(-1);
    if (last !== undefined && last.action === steps[i].record?.action && last.outcome !== "pending") steps[i].outcome = last.outcome;
  }
}

export function parseEvents(text: string): Event[] {
  const out: Event[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as Event);
    } catch {
      // A torn last line (process killed mid-write): skip it.
    }
  }
  return out;
}

export function parseTrace(text: string, dir: string): GameRecord[] {
  const events = parseEvents(text);
  const header = events.find((e) => e.type === "run") ?? {};
  const agents = [...new Set(events.map((e) => e.agent).filter((a): a is string => typeof a === "string"))];
  // The CLI writes one summary for all its agents; the extension's agent
  // writes its own.
  const summaries = events.filter((e) => e.type === "summary") as { agents?: AgentSummaryRow[]; reason?: string }[];
  const summaryOf = (agent: string) => summaries.findLast((s) => s.agents?.some((a) => a.name === agent));
  const streamResult = (events.filter((e) => e.type === "stream_result").at(-1)?.result as string | undefined) ?? null;
  const errors = events.filter((e) => e.type === "error").map((e) => `${String(e.title ?? "error")}: ${String(e.detail ?? "")}`);
  const strategy = (header.strategy as { name?: string } | null | undefined)?.name ?? NO_STRATEGY;
  const legacyGame = header.game as { map?: string } | undefined;
  const base = path.basename(dir);
  // A trace from a game that never reached a step still counts (never spawned).
  const names = agents.length > 0 ? agents : [...new Set(summaries.flatMap((s) => s.agents?.map((a) => a.name) ?? []))];
  if (names.length === 0) names.push("Jev");

  return names.map((agent) => {
    const mine = events.filter((e) => e.agent === agent);
    const rawSteps = mine.filter((e) => e.type === "step");
    const steps = rawSteps.map(stepRow);
    settleOutcomes(steps, rawSteps);
    const spawns = mine
      .filter((e) => e.type === "spawn")
      .map((e) => {
        const state = routeCall(e.calls)?.state as { game?: { spawn_phase_ticks_left?: number } } | undefined;
        return {
          tick: Number(e.tick),
          sent: ((e.intents as IntentRow[] | undefined) ?? []).some((i) => i.sent),
          recheck: e.recheck === true,
          ticksLeft: state?.game?.spawn_phase_ticks_left ?? null,
        };
      });
    const death = (mine.find((e) => e.type === "death") as DeathEvent | undefined) ?? null;
    const lastTick = Math.max(0, ...mine.map((e) => Number(e.tick) || 0));
    const summary = summaryOf(agent);
    return {
      id: names.length > 1 ? `${base}:${agent}` : base,
      dir,
      agent,
      source: String(header.source ?? "cli"),
      strategy,
      map: String(header.map ?? legacyGame?.map ?? "unknown"),
      players: steps.find((s) => s.playersAlive !== null)?.playersAlive ?? (typeof header.players === "number" ? header.players : null),
      harnessCommit: String(header.harnessCommit ?? "unknown"),
      model: String(header.model ?? "unknown"),
      startedAt: typeof header.startedAt === "string" ? header.startedAt : typeof header.at === "string" ? header.at : null,
      steps,
      spawns,
      death,
      summary: summary?.agents?.find((a) => a.name === agent) ?? null,
      summaryReason: summary?.reason ?? null,
      streamResult,
      errors,
      lastTick,
    };
  });
}

// Every trace.jsonl under the given directories (a game directory itself, or
// a parent of many).
export function findTraces(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.name === "trace.jsonl") out.push(p);
    }
  };
  for (const r of roots) walk(r, 0);
  return out.sort();
}

export function loadTraces(roots: string[]): GameRecord[] {
  return findTraces(roots).flatMap((file) => parseTrace(fs.readFileSync(file, "utf8"), path.dirname(file)));
}
