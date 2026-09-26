// One Jev-driven player. The turn loop calls onTick() after every simulated
// tick; decision steps run asynchronously so the sim never waits on Jev, and a
// step is skipped while the previous one is still in flight.

import type { Player } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import type { Intent } from "src/core/Schemas";
import { type Action, describe, resolve } from "./act/intents";
import type { HarnessConfig } from "./config";
import { buildCandidates, SeaReach } from "./decide/candidates";
import { type Decision, Pipeline } from "./decide/pipeline";
import type { Jev } from "./jev/client";
import type { Trace } from "./log/trace";
import type { TokenBucket } from "./net/rateLimit";
import { economy, IncomeTracker } from "./observe/economy";
import { approxTokens, observe, RefBook } from "./observe/state";
import { SectorGrid } from "./observe/sectors";
import { decisionEvent, type OverlayEvent } from "./overlay/events";
import type { Mirror } from "./sim/mirror";
import { StrategyMemory, type Vitals } from "./strategy/memory";

export interface AgentOptions {
  name: string;
  mirror: Mirror;
  jev: Jev;
  config: HarnessConfig;
  bucket: TokenBucket;
  send: (intent: Intent) => void;
  // Checked immediately before every send. Browser integrations use this as
  // the hard stop for a toggle changed while a Jev request is in flight.
  canAct?: () => boolean;
  trace?: Trace;
  dryRun?: boolean;
  log?: (line: string) => void;
  // Live overlay feed: one event per decision step.
  onEvent?: (e: OverlayEvent) => void;
}

export interface AgentSummary {
  name: string;
  alive: boolean;
  won: boolean;
  outcome: string;
  peakLandShare: number;
  finalLandShare: number;
  ticksSurvived: number;
  steps: number;
  skippedSteps: number;
  holds: number;
  intentsSent: number;
  intentsRejected: number;
  meanStepMs: number;
  meanStaleTicks: number;
}

export class Agent {
  readonly memory = new StrategyMemory();
  private readonly refs = new RefBook();
  private readonly sea = new SeaReach();
  private readonly pipeline: Pipeline;
  private grid: SectorGrid | null = null;
  private busy = false;
  private spawnSentAt = -1;
  private spawnAttempts = 0;
  private respawnChecked = false;
  private readonly income = new IncomeTracker();
  private deathTick: number | null = null;
  // An action that must wait for an earlier one to land in the sim (the
  // attack after breaking an alliance), retried every tick until it resolves.
  private followUp: { action: Action; until: number } | null = null;
  private stats = { steps: 0, skipped: 0, holds: 0, sent: 0, rejected: 0, stepMs: 0, staleTicks: 0, peak: 0 };

  constructor(private readonly o: AgentOptions) {
    this.pipeline = new Pipeline(o.jev, { minConfidence: o.config.minConfidence });
  }

  private get game() {
    return this.o.mirror.game;
  }

  private log(line: string): void {
    this.o.log?.(`[${this.o.name} t=${this.game.ticks()}] ${line}`);
  }

  // Resolves when the in-flight step (if any) finishes; used by lockstep runs.
  pending: Promise<void> = Promise.resolve();

  onTick(): void {
    const tick = this.game.ticks();
    const me = this.o.mirror.me();
    if (me === null) return;
    if (!this.game.inSpawnPhase() && me.hasSpawned() && !me.isAlive() && this.deathTick === null) {
      this.deathTick = tick;
      this.log("eliminated");
    }
    this.tryFollowUp(me, tick);
    if (tick % this.o.config.decisionInterval !== 0) return;
    if (this.busy) {
      this.stats.skipped++;
      return;
    }
    this.busy = true;
    this.pending = this.runStep(me)
      .catch((err) => this.log(`step failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))
      .finally(() => {
        this.busy = false;
      });
  }

  private vitals(me: Player): Vitals {
    return { tiles: me.numTilesOwned(), troops: Math.round(me.troops()), gold: Number(me.gold()) };
  }

  private async runStep(me: Player): Promise<void> {
    const game = this.game;
    this.grid ??= new SectorGrid(game);
    if (game.inSpawnPhase()) return this.spawnStep(me);
    if (!me.isAlive()) return;

    const t0 = performance.now();
    const tick = game.ticks();
    const now = this.vitals(me);
    this.memory.settle(now);
    this.memory.noteAttackers(
      me.incomingAttacks().map((a) => a.attacker().id()),
      tick,
    );
    this.memory.noteMyAttacks(me.outgoingAttacks());
    this.income.update(me, tick);
    const econ = economy(game, me, this.income);

    const scan = this.grid.scan();
    const reach = this.sea.get(game, me, scan);
    const obs = observe({
      game,
      me,
      grid: this.grid,
      scan,
      refs: this.refs,
      memory: this.memory,
      seaReachable: new Set(reach.keys()),
      goldPerMin: this.income.rates.total,
      econ,
    });
    const cands = buildCandidates(game, me, obs, reach, econ, this.memory.threat, this.memory.attackPeaks);
    this.stats.peak = Math.max(this.stats.peak, me.numTilesOwned() / Math.max(1, game.numLandTiles()));

    const decision = await this.pipeline.step(game, me, obs, cands, this.memory, {
      game,
      me,
      obs,
      grid: this.grid,
      refOf: (id) => this.refs.peek(id),
    });

    // Fold judgments into memory.
    if (decision.goalProbabilities) {
      if (this.memory.observeGoal(decision.goalProbabilities, game.ticks())) this.log(`goal -> ${this.memory.goal}`);
    }
    for (const [id, s] of Object.entries(decision.threat ?? {})) {
      const prev = this.memory.threat.get(id);
      this.memory.threat.set(id, prev === undefined ? s : 0.6 * prev + 0.4 * s);
    }

    const sent = this.act(me, decision);
    if (decision.record) this.memory.record({ tick, ...decision.record }, now);
    if (decision.held) this.stats.holds++;
    this.stats.steps++;
    const ms = performance.now() - t0;
    this.stats.stepMs += ms;
    this.stats.staleTicks += game.ticks() - tick;

    this.log(
      `${decision.route}${decision.held ? ` HOLD(${decision.holdReason})` : ""} conf=${decision.confidence.toFixed(2)} ` +
        `goal=${this.memory.goal} -> ${sent.map((s) => s.desc).join("; ") || "no intents"} (${Math.round(ms)}ms)`,
    );
    this.o.trace?.write({
      type: "step",
      agent: this.o.name,
      tick,
      actedTick: game.ticks(),
      stateTokens: approxTokens(obs.state),
      candidates: {
        routes: cands.routes,
        attack: cands.attackTargets.map((o) => o.ref),
        boat: cands.boatTargets.map((b) => b.obs.ref),
        build: cands.buildOptions.map((b) => b.key),
        ally: cands.allyCandidates.map((o) => o.ref),
      },
      decision: { route: decision.route, held: decision.held, holdReason: decision.holdReason, confidence: decision.confidence, used: decision.used, preferences: decision.preferences, record: decision.record },
      calls: decision.calls,
      intents: sent,
      memory: { goal: this.memory.goal, warTarget: this.memory.warTarget },
      latencyMs: Math.round(ms),
    });
    this.publish(decision, (obs.state as { me: Record<string, unknown> }).me, sent, ms, (key) => {
      const o = obs.byRef.get(key);
      return o ? String(o.json.name) : key.replace(/_/g, " ");
    });
  }

  private publish(
    decision: Decision,
    me: Record<string, unknown>,
    sent: { desc: string; sent: boolean; reason?: string }[],
    ms: number,
    label: (key: string) => string,
  ): void {
    if (!this.o.onEvent) return;
    const mem = this.memory.toState(this.game.ticks(), (id) => this.refs.peek(id)) as {
      recent_actions: { min: number; action: string; target?: string; outcome: string }[];
    };
    const nameOfRef = (ref?: string) => (ref ? label(ref) : undefined);
    this.o.onEvent(
      decisionEvent(
        {
          agent: this.o.name,
          tick: this.game.ticks(),
          me,
          threshold: this.o.config.minConfidence,
          goal: this.memory.goal,
          label,
          recent: mem.recent_actions.map((r) => ({ ...r, target: nameOfRef(r.target) })),
          intents: sent.map(({ desc, sent, reason }) => ({ desc, sent, reason })),
          latencyMs: Math.round(ms),
        },
        decision,
      ),
    );
  }

  private async spawnStep(me: Player): Promise<void> {
    const game = this.game;
    const tick = game.ticks();
    const spawnTurns = game.config().numSpawnPhaseTurns();
    let current: TileRef | undefined;
    if (this.spawnSentAt >= 0 && (me.hasSpawned() || tick - this.spawnSentAt < 30)) {
      // Placed: one late re-check, once most players have placed too.
      if (!me.hasSpawned() || this.respawnChecked || tick < spawnTurns * 0.6 || tick > spawnTurns - 20) return;
      this.respawnChecked = true;
      current = me.spawnTile();
    } else {
      // Not placed (or it didn't take): place, retrying with fresh candidates.
      if (this.spawnAttempts >= 4) return;
      this.spawnAttempts++;
    }
    const obsState = { game: { tick, phase: "spawn", players: game.players().length, spawn_phase_ticks_left: spawnTurns - tick } };
    const decision = await this.pipeline.spawn(game, me, this.grid!, obsState, this.spawnAttempts - 1, current);
    const sent = this.act(me, decision);
    if (sent.some((s) => s.sent)) this.spawnSentAt = game.ticks();
    const what = current !== undefined ? "respawn check" : "spawn";
    this.log(`${what} conf=${decision.confidence.toFixed(2)} -> ${sent.map((s) => s.desc).join("; ") || decision.holdReason}`);
    this.publish(decision, { name: me.displayName() }, sent, 0, (k) => k);
    this.o.trace?.write({ type: "spawn", agent: this.o.name, tick: game.ticks(), recheck: current !== undefined, decision: { used: decision.used, record: decision.record, holdReason: decision.holdReason }, calls: decision.calls, intents: sent });
  }

  private tryFollowUp(me: Player, tick: number): void {
    if (this.followUp === null) return;
    const { action, until } = this.followUp;
    const r = resolve(this.game, me, action);
    if (!r.ok) {
      if (tick > until) {
        this.log(`follow-up ${describe(action)} dropped: ${r.reason}`);
        this.followUp = null;
      }
      return;
    }
    this.followUp = null;
    if (this.o.canAct !== undefined && !this.o.canAct()) return;
    if (!this.o.bucket.tryTake()) return;
    if (!this.o.dryRun) this.o.send(r.intent);
    this.stats.sent++;
    this.log(`follow-up -> ${describe(action)}`);
  }

  // Re-validate against the live tick, then send through the token bucket.
  private act(me: Player, decision: Decision): { desc: string; sent: boolean; reason?: string; intent?: Intent }[] {
    const out: { desc: string; sent: boolean; reason?: string; intent?: Intent }[] = [];
    let budget = this.o.config.maxIntentsPerStep;
    for (const action of decision.actions as Action[]) {
      const desc = describe(action);
      if (budget <= 0) {
        out.push({ desc, sent: false, reason: "step intent cap" });
        continue;
      }
      const r = resolve(this.game, me, action);
      if (!r.ok) {
        this.stats.rejected++;
        out.push({ desc, sent: false, reason: r.reason });
        continue;
      }
      if (this.o.canAct !== undefined && !this.o.canAct()) {
        out.push({ desc, sent: false, reason: "disabled" });
        continue;
      }
      if (!this.o.bucket.tryTake()) {
        out.push({ desc, sent: false, reason: "rate limited" });
        continue;
      }
      budget--;
      if (!this.o.dryRun) this.o.send(r.intent);
      if (action.kind === "break_alliance" && action.then) this.followUp = { action: action.then, until: this.game.ticks() + 50 };
      this.stats.sent++;
      out.push({ desc, sent: true, intent: r.intent });
    }
    return out;
  }

  summary(): AgentSummary {
    const me = this.o.mirror.me();
    const game = this.game;
    const land = Math.max(1, game.numLandTiles());
    const winner = this.o.mirror.winner?.winner;
    const won = winner !== undefined && winner[0] === "player" && me !== null && winner.includes(me.clientID() ?? "");
    const alive = me?.isAlive() ?? false;
    const share = me ? me.numTilesOwned() / land : 0;
    this.stats.peak = Math.max(this.stats.peak, share);
    return {
      name: this.o.name,
      alive,
      won,
      outcome: won ? "won" : winner !== undefined ? "lost (someone else won)" : alive ? "alive (game not finished)" : "eliminated",
      peakLandShare: Math.round(this.stats.peak * 1000) / 1000,
      finalLandShare: Math.round(share * 1000) / 1000,
      ticksSurvived: this.deathTick ?? game.ticks(),
      steps: this.stats.steps,
      skippedSteps: this.stats.skipped,
      holds: this.stats.holds,
      intentsSent: this.stats.sent,
      intentsRejected: this.stats.rejected,
      meanStepMs: this.stats.steps ? Math.round(this.stats.stepMs / this.stats.steps) : 0,
      meanStaleTicks: this.stats.steps ? Math.round((this.stats.staleTicks / this.stats.steps) * 10) / 10 : 0,
    };
  }
}
