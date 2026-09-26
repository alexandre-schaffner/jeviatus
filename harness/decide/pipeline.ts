// The multi-step decision: Call S (spawn), Call A (route + speculative
// arguments + side decisions, one request), Call B (site selection, only when
// the route needs a concrete tile). Confidence is the weakest link among the
// consequential answers actually used (the route, and who to attack or ally
// with); below the threshold the step holds. Preferences among options that
// are all acceptable (troop amounts, which structure, which pre-validated
// site) are traced but not gated: a spread there means several good options,
// not a reason to do nothing.

import type { ChoiceResponse, NoulResponse, Questions, ScoreResponse, SystemOneResult } from "@typesafe-ai/sdk";
import type { Game, Player } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import type { Action } from "../act/intents";
import type { Jev } from "../jev/client";
import { kindOf, type Observation, type PlayerObs, troopFill, troopStatus } from "../observe/state";
import type { SectorGrid } from "../observe/sectors";
import type { StrategyMemory } from "../strategy/memory";
import {
  boatSites,
  type BuildOption,
  buildSites,
  type Candidates,
  type Route,
  type SiteCandidate,
  type SiteContext,
  spawnCandidates,
} from "./candidates";
import {
  ATTACK_COMMIT,
  boatSiteQuestion,
  buildSiteQuestion,
  commitFraction,
  EXPAND_COMMIT,
  NONE,
  nukeSiteQuestion,
  routeQuestions,
  spawnQuestion,
  type AllianceContext,
} from "./questions";
import { nukeSites } from "./nukes";
import { EXPAND_FLOOR, homeReserve, TroopBudget } from "./reserve";

export interface CallTrace {
  label: string;
  state: unknown;
  questions: Questions;
  answers?: unknown;
  usage?: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  error?: string;
}

export interface Decision {
  route: Route | "spawn";
  // Main action (at most one) followed by side actions.
  actions: Action[];
  confidence: number;
  // Which answers the confidence came from: id -> confidence.
  used: Record<string, number>;
  // Preference answers used but not gated: id -> confidence. Troop amounts use
  // the expected score, so a spread between "moderate" and "heavy" still gives
  // a sensible in-between amount.
  preferences: Record<string, number>;
  held: boolean;
  holdReason?: string;
  // What to write into memory.recent_actions.
  record?: { action: string; target?: string; targetID?: string; detail?: string };
  goalProbabilities?: Record<string, number>;
  threat?: Record<string, number>; // playerID -> expected score
  calls: CallTrace[];
}

// A fallback route needs at least this much of the route distribution.
const FALLBACK_MIN_P = 0.15;

export interface PipelineOptions {
  minConfidence: number;
}

type Answers = SystemOneResult<Questions>["answers"];

function asChoice(a: Answers, id: string): ChoiceResponse | undefined {
  const x = a[id];
  return x?.type === "choice" ? (x as ChoiceResponse) : undefined;
}
function asScore(a: Answers, id: string): ScoreResponse | undefined {
  const x = a[id];
  return x?.type === "score" ? (x as ScoreResponse) : undefined;
}
function asNoul(a: Answers, id: string): NoulResponse | undefined {
  const x = a[id];
  return x?.type === "noul" ? (x as NoulResponse) : undefined;
}

export class Pipeline {
  constructor(
    private readonly jev: Jev,
    private readonly opts: PipelineOptions,
  ) {}

  private async call(label: string, state: Record<string, unknown>, questions: Questions, calls: CallTrace[]): Promise<Answers | null> {
    const t0 = performance.now();
    const trace: CallTrace = { label, state, questions, latencyMs: 0 };
    calls.push(trace);
    try {
      const res = await this.jev.ask(label, state as never, questions);
      trace.latencyMs = performance.now() - t0;
      trace.answers = res.answers;
      trace.usage = res.usage;
      return res.answers;
    } catch (err) {
      trace.latencyMs = performance.now() - t0;
      trace.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return null;
    }
  }

  // Call S.
  // `current` set: a late re-check of my placed spawn, offered as "S0" (stay).
  async spawn(game: Game, me: Player, grid: SectorGrid, obsState: Record<string, unknown>, attempt = 0, current?: TileRef): Promise<Decision> {
    const calls: CallTrace[] = [];
    const sites = spawnCandidates(game, me, grid, 12, attempt + 1, current);
    if (sites.length === 0) return hold("spawn", "no legal spawn sites", calls);
    const state = { game: obsState.game, map: { width: game.width(), height: game.height() }, candidates: sites.map((s) => ({ id: s.id, ...s.features })) };
    const a = await this.call("spawn", state, spawnQuestion(sites, current !== undefined), calls);
    const site = a ? asChoice(a, "site") : undefined;
    // Spawning somewhere beats not spawning: fall back to the best-scored site.
    const pick = sites.find((s) => s.id === site?.choice) ?? sites[0];
    const confidence = site?.confidence ?? 0;
    // Moving costs the head start already made; only move when Jev is sure.
    if (current !== undefined && (pick.id === "S0" || confidence < this.opts.minConfidence)) {
      return { ...hold("spawn", pick.id === "S0" ? "staying at my spawn" : `too unsure to move (${confidence.toFixed(2)})`, calls), confidence, used: site ? { site: confidence } : {} };
    }
    return {
      route: "spawn",
      actions: [{ kind: "spawn", tile: pick.tile }],
      confidence,
      used: site ? { site: confidence } : {},
      preferences: {},
      held: false,
      record: { action: current !== undefined ? "respawn" : "spawn", detail: pick.id },
      calls,
    };
  }

  // Calls A and (maybe) B.
  async step(game: Game, me: Player, obs: Observation, cands: Candidates, memory: StrategyMemory, site: Omit<SiteContext, "threat">): Promise<Decision> {
    const calls: CallTrace[] = [];
    const fronts = new Set(me.outgoingAttacks().map((x) => x.target()).filter((t): t is Player => t.isPlayer()));
    const shown = homeReserve(me, obs, fronts);
    (obs.state.me as Record<string, unknown>).troops_kept_home_share = me.troops() > 0 ? Math.round(Math.min(1, shown.troops / me.troops()) * 100) / 100 : 0;
    const questions = routeQuestions(cands, obs.unclaimedBorderTiles, troopStatus(troopFill(game, me)), allianceContext(me, obs, cands, memory, site.refOf));
    const a = await this.call("route", obs.state, questions, calls);
    if (a === null) return hold("hold", `route call failed: ${calls.at(-1)?.error ?? "unknown error"}`, calls);

    const used: Record<string, number> = {};
    const preferences: Record<string, number> = {};
    const route = asChoice(a, "route");
    const goal = asChoice(a, "goal");
    const actions: Action[] = [];
    const decision: Decision = {
      route: "hold",
      actions,
      confidence: 1,
      used,
      preferences,
      held: false,
      calls,
      goalProbabilities: goal ? { ...goal.probabilities } : undefined,
      threat: {},
    };

    for (const o of cands.threatSubjects) {
      const s = asScore(a, `threat.${o.ref}`);
      if (s) decision.threat![o.player.id()] = s.score;
    }

    // Side decisions first; they don't depend on the route.
    const side: Action[] = [];
    // Alliance requests expire unanswered, so every one gets a verdict.
    for (const o of cands.incomingRequests) {
      const ch = asChoice(a, `ally_accept.${o.ref}`);
      if (ch === undefined) continue;
      side.push({ kind: ch.choice === "accept" ? "ally_request" : "ally_reject", targetID: o.player.id() });
    }
    for (const o of cands.allianceExtensions) {
      const n = asNoul(a, `ally_extend.${o.ref}`);
      if (n !== undefined && n.noul >= 0.5) side.push({ kind: "ally_extend", targetID: o.player.id() });
    }
    for (const o of cands.embargoLifts) {
      const n = asNoul(a, `embargo_lift.${o.ref}`);
      if (n !== undefined && n.noul >= 0.6) side.push({ kind: "embargo_stop", targetID: o.player.id() });
    }
    for (const o of cands.donateTargets) {
      const n = asNoul(a, `donate.${o.ref}`);
      if (n !== undefined && n.noul >= 0.6) side.push({ kind: "donate", targetID: o.player.id(), fraction: 0.15 });
    }
    // Retreats go right after the main action: they free troops for home.
    const retreats: Action[] = [];
    for (const r of cands.retreats) {
      const n = asNoul(a, `retreat.${r.attack.id()}`);
      if (n !== undefined && n.noul >= 0.6) retreats.push({ kind: "retreat", attackID: r.attack.id(), targetID: r.target.id() });
    }
    const alsoAttack = cands.sideAttacks.filter((o) => (asNoul(a, `also_attack.${o.ref}`)?.noul ?? 0) >= 0.6);

    if (route === undefined) return { ...hold("hold", "no route answer", calls), actions: [...retreats, ...side] };
    used.route = route.confidence;
    // Route and arguments are asked independently, so the top route can come
    // back with "none" as its target. Then fall through to the next most
    // likely route rather than wasting the step; the route's own confidence
    // still gates.
    const ranked = (Object.entries(route.probabilities) as [Route, number][])
      .filter(([r, p]) => r !== "hold" && (r === route.choice || p >= FALLBACK_MIN_P))
      .sort((x, y) => y[1] - x[1]);
    let chosen = route.choice as Route;
    let main: Awaited<ReturnType<Pipeline["mainAction"]>> & { gated?: boolean } = { action: null, reason: "chose to hold" };
    const skipped: string[] = [];
    for (const [r] of chosen === "hold" ? [] : ranked) {
      const tryUsed: Record<string, number> = {};
      const m = await this.mainAction(r, a, tryUsed, preferences, cands, { ...site, threat: memory.threat }, calls);
      if (m.action !== null || !m.noTarget) {
        chosen = r;
        main = m;
        Object.assign(used, tryUsed);
        break;
      }
      skipped.push(`${r}: ${m.reason}`);
    }
    if (main.action === null && skipped.length > 0 && main.reason === "chose to hold") main = { action: null, reason: skipped.join("; ") };
    if (skipped.length > 0 && main.action !== null && main.record) main.record.detail = `${main.record.detail ?? ""} (fallback: ${skipped.join("; ")})`.trim();
    decision.route = chosen;

    decision.confidence = Math.min(...Object.values(used));

    // Every send this step draws on one pool above the home reserve. The
    // players I'm fighting (already, or now) don't count toward the reserve.
    // A main action under the confidence bar is held, so it neither spends
    // troops nor claims its target.
    if (main.action !== null && decision.confidence < this.opts.minConfidence) {
      main = { ...main, action: null, reason: `confidence ${decision.confidence.toFixed(2)} < ${this.opts.minConfidence}`, gated: true };
    }
    const mainTarget = main.action !== null && "targetID" in main.action ? main.action.targetID : null;
    const fighting = new Set(fronts);
    for (const id of [mainTarget, ...alsoAttack.map((o) => o.player.id())]) if (id && game.hasPlayer(id)) fighting.add(game.player(id));
    const reserve = homeReserve(me, obs, fighting);
    const budget = new TroopBudget(me.troops(), reserve.troops);
    if (main.action !== null) {
      const trimmed = applyBudget(main.action, budget);
      if (trimmed === null) {
        main = { action: null, reason: `keeping troops home${reserve.why ? ` against ${reserve.why}` : ""}` };
      } else if (trimmed.cut && main.record) {
        main.record.detail = `${main.record.detail ?? ""} (trimmed to ${Math.round(trimmed.share * 100)}% to keep troops home)`.trim();
      }
    }
    const extra: Action[] = [];
    for (const o of alsoAttack) {
      if (o.player.id() === mainTarget || o.conquest === null) continue;
      const need = o.conquest.finishFraction;
      // A push that can't finish them only softens them for someone else,
      // except against tribes, which are cheap to nibble.
      if (need !== null && budget.available >= need) extra.push({ kind: "attack", targetID: o.player.id(), fraction: budget.take(need) });
      else if (need === null && kindOf(o.player) === "tribe") {
        const share = budget.take(TRIBE_PUSH);
        if (share > 0) extra.push({ kind: "attack", targetID: o.player.id(), fraction: share });
      }
    }

    if (main.action === null) {
      decision.held = chosen !== "hold";
      decision.holdReason = main.reason;
      decision.record = { action: "hold", detail: main.gated ? `wanted ${chosen}, too unsure` : main.reason };
    } else {
      actions.push(main.action);
      decision.record = main.record;
    }
    // The purse: a purchase beside the main action, unless the main action is
    // already a purchase. Sites come from code's ranking (no extra call).
    const purchase: Action[] = [];
    const spend = asChoice(a, "spend");
    const mainBuys = main.action?.kind === "build" || main.action?.kind === "upgrade";
    if (spend !== undefined && !mainBuys) {
      preferences.spend = spend.confidence;
      const option = cands.buildOptions.find((b) => b.key === spend.choice);
      if (option?.upgrade !== undefined) purchase.push({ kind: "upgrade", unit: option.type, unitID: option.upgrade.id() });
      else if (option !== undefined) {
        const best = buildSites({ ...site, threat: memory.threat }, option.type)[0];
        if (best !== undefined) purchase.push({ kind: "build", unit: option.type, tile: best.tile });
      }
    }

    // A new push merges into a running attack on the same player, so don't
    // also pull that attack back.
    const pushed = new Set([mainTarget, ...extra.map((x) => ("targetID" in x ? x.targetID : null))]);
    actions.push(...retreats.filter((r) => r.kind !== "retreat" || !pushed.has(r.targetID)), ...side, ...purchase, ...extra);
    return decision;
  }

  private async mainAction(
    route: Route,
    a: Answers,
    used: Record<string, number>,
    preferences: Record<string, number>,
    c: Candidates,
    site: SiteContext,
    calls: CallTrace[],
  ): Promise<{ action: Action | null; reason?: string; noTarget?: boolean; record?: Decision["record"] }> {
    switch (route) {
      case "hold":
        return { action: null, reason: "chose to hold" };
      case "expand": {
        const s = asScore(a, "expand_commit");
        const fraction = commitFraction(s?.score ?? 1, EXPAND_COMMIT);
        if (s) preferences.expand_commit = s.confidence;
        return { action: { kind: "expand", fraction }, record: { action: "expand", detail: `${Math.round(fraction * 100)}% troops` } };
      }
      case "attack_player": {
        const t = asChoice(a, "attack_target");
        if (t === undefined || t.choice === NONE) return { action: null, reason: "no attack target", noTarget: true };
        used.attack_target = t.confidence;
        const target = c.attackTargets.find((o) => o.ref === t.choice);
        if (target === undefined) return { action: null, reason: "unknown attack target", noTarget: true };
        const s = asScore(a, "attack_commit");
        if (s) preferences.attack_commit = s.confidence;
        const { fraction, finishing } = sizeAttack(site.me, target, commitFraction(s?.score ?? 1, ATTACK_COMMIT));
        const detail = `${Math.round(fraction * 100)}% troops${finishing ? `, sized to finish them (~${Math.round(target.conquest!.loot / 1000)}k gold)` : ""}`;
        return {
          action: { kind: "attack", targetID: target.player.id(), fraction },
          record: { action: "attack_player", target: target.ref, targetID: target.player.id(), detail },
        };
      }
      case "naval_invasion": {
        const t = asChoice(a, "boat_target");
        if (t === undefined || t.choice === NONE) return { action: null, reason: "no boat target", noTarget: true };
        used.boat_target = t.confidence;
        const target = c.boatTargets.find((b) => b.obs.ref === t.choice);
        if (target === undefined) return { action: null, reason: "unknown boat target", noTarget: true };
        const sites = boatSites(site, target.obs.player);
        let dst = target.dst;
        let label = "default";
        if (sites.length > 1) {
          const b = await this.site("boat_site", site, boatSiteQuestion(target.obs.ref, sites), sites, calls);
          if (b !== null) {
            preferences.boat_site = b.confidence;
            dst = b.site.tile;
            label = b.site.id;
          }
        } else if (sites.length === 1) dst = sites[0].tile;
        const s = asScore(a, "attack_commit");
        if (s) preferences.attack_commit = s.confidence;
        // A sunk transport loses everyone aboard, and the game's own default
        // boat stack is a fifth of the army: keep landings small.
        const fraction = Math.min(BOAT_MAX_FRACTION, commitFraction(s?.score ?? 1, ATTACK_COMMIT) * 0.8);
        return {
          action: { kind: "boat", targetID: target.obs.player.id(), dst, fraction },
          record: { action: "naval_invasion", target: target.obs.ref, targetID: target.obs.player.id(), detail: `landing ${label}, ${Math.round(fraction * 100)}% troops` },
        };
      }
      case "build": {
        const u = asChoice(a, "build_unit");
        const option = c.buildOptions.find((b) => b.key === u?.choice);
        if (u === undefined || option === undefined) return { action: null, reason: "no build choice" };
        preferences.build_unit = u.confidence;
        if (option.upgrade !== undefined) {
          return {
            action: { kind: "upgrade", unit: option.type, unitID: option.upgrade.id() },
            record: { action: "build", detail: `${option.key} to level ${option.upgrade.level() + 1}` },
          };
        }
        const sites = buildSites(site, option.type);
        if (sites.length === 0) return { action: null, reason: `no legal site for ${option.key}` };
        const b = sites.length === 1 ? { site: sites[0], confidence: 1 } : await this.site("build_site", site, buildSiteQuestion(option, sites), sites, calls);
        if (b === null) return { action: null, reason: "site call failed" };
        preferences.build_site = b.confidence;
        return {
          action: { kind: "build", unit: option.type, tile: b.site.tile },
          record: { action: "build", detail: `${option.key} at ${b.site.id}` },
        };
      }
      case "nuke": {
        const t = asChoice(a, "nuke_target");
        if (t === undefined || t.choice === NONE) return { action: null, reason: "no nuke target", noTarget: true };
        used.nuke_target = t.confidence;
        const target = c.nukeTargets.find((o) => o.ref === t.choice);
        if (target === undefined) return { action: null, reason: "unknown nuke target", noTarget: true };
        const k = asChoice(a, "nuke_type");
        if (k) preferences.nuke_type = k.confidence;
        const opt = c.nukeOptions.find((n) => n.key === k?.choice) ?? c.nukeOptions[0];
        const sites = nukeSites(site, target.player, opt);
        if (sites.length === 0) return { action: null, reason: `no safe ${opt.key} site on ${target.ref}`, noTarget: true };
        const b = sites.length === 1 ? { site: sites[0], confidence: 1 } : await this.site("nuke_site", site, nukeSiteQuestion(target.ref, opt.key, sites), sites, calls);
        if (b === null) return { action: null, reason: "site call failed" };
        preferences.nuke_site = b.confidence;
        return {
          action: { kind: "nuke", unit: opt.type, tile: b.site.tile, targetID: target.player.id() },
          record: { action: "nuke", target: target.ref, targetID: target.player.id(), detail: `${opt.key} at ${b.site.id}` },
        };
      }
      case "break_alliance": {
        const t = asChoice(a, "betray_target");
        if (t === undefined || t.choice === NONE) return { action: null, reason: "no ally worth betraying", noTarget: true };
        used.betray_target = t.confidence;
        const target = c.betrayTargets.find((o) => o.ref === t.choice);
        if (target === undefined) return { action: null, reason: "unknown betray target", noTarget: true };
        const s = asScore(a, "attack_commit");
        if (s) preferences.attack_commit = s.confidence;
        const { fraction } = sizeAttack(site.me, target, commitFraction(s?.score ?? 2, ATTACK_COMMIT));
        return {
          // The attack can't ride in the same turn (the break lands after the
          // attack is validated): the agent sends it once they are attackable.
          action: { kind: "break_alliance", targetID: target.player.id(), then: { kind: "attack", targetID: target.player.id(), fraction } },
          record: { action: "break_alliance", target: target.ref, targetID: target.player.id(), detail: `then attack with ${Math.round(fraction * 100)}% troops` },
        };
      }
      case "propose_alliance": {
        const t = asChoice(a, "ally_propose");
        if (t === undefined || t.choice === NONE) return { action: null, reason: "no alliance target", noTarget: true };
        used.ally_propose = t.confidence;
        const target = c.allyCandidates.find((o) => o.ref === t.choice);
        if (target === undefined) return { action: null, reason: "unknown alliance target", noTarget: true };
        return {
          action: { kind: "ally_request", targetID: target.player.id() },
          record: { action: "propose_alliance", target: target.ref, targetID: target.player.id() },
        };
      }
    }
  }

  // Call B.
  private async site(
    label: string,
    ctx: SiteContext,
    questions: Questions,
    sites: SiteCandidate[],
    calls: CallTrace[],
  ): Promise<{ site: SiteCandidate; confidence: number } | null> {
    const state = {
      me: { name: ctx.me.displayName(), gold: Number(ctx.me.gold()), troops: Math.round(ctx.me.troops()) },
      candidates: sites.map((s) => ({ id: s.id, ...s.features })),
    };
    const a = await this.call(label, state, questions, calls);
    const c = a ? asChoice(a, "site") : undefined;
    const pick = sites.find((s) => s.id === c?.choice);
    return c && pick ? { site: pick, confidence: c.confidence } : null;
  }
}

export const BOAT_MAX_FRACTION = 0.3;
// Side push at a tribe that no single push can finish.
export const TRIBE_PUSH = 0.15;

// Trim a troop-spending action to the step's budget. Null: nothing left to send.
function applyBudget(action: Action, budget: TroopBudget): { share: number; cut: boolean } | null {
  const spend = (want: number, floor = 0) => {
    const share = budget.take(want, floor);
    return share <= 0 ? null : { share, cut: share < want - 1e-9 };
  };
  switch (action.kind) {
    case "expand": {
      const r = spend(action.fraction, EXPAND_FLOOR);
      if (r) action.fraction = r.share;
      return r;
    }
    case "attack":
    case "boat": {
      const r = spend(action.fraction);
      if (r) action.fraction = r.share;
      return r;
    }
    case "break_alliance": {
      if (action.then?.kind !== "attack") return { share: 0, cut: false };
      const r = spend(action.then.fraction);
      if (r) action.then.fraction = r.share;
      return r;
    }
    default:
      return { share: 0, cut: false };
  }
}

// Share of my troops above which a finishing push is not worth the exposure.
export const FINISH_CAP = 0.75;
// Lower cap while someone else is attacking me: keep a reserve at home.
export const FINISH_CAP_UNDER_ATTACK = 0.5;

// An attack that stops short of the kill hands the loot to whoever lands the
// last blow, and the target regrows meanwhile. When one push can finish the
// target within the cap, send that much rather than Jev's (usually smaller)
// commit; never send less than Jev asked for.
export function sizeAttack(me: Player, target: PlayerObs, asked: number): { fraction: number; finishing: boolean } {
  const need = target.conquest?.finishFraction;
  if (need == null) return { fraction: asked, finishing: false };
  if (need <= asked) return { fraction: asked, finishing: true };
  const threatened = me.incomingAttacks().some((a) => a.attacker() !== target.player && a.attacker().isAlive());
  const cap = threatened ? FINISH_CAP_UNDER_ATTACK : FINISH_CAP;
  return need <= cap ? { fraction: need, finishing: true } : { fraction: asked, finishing: false };
}

function allianceContext(
  me: Player,
  obs: Observation,
  cands: Candidates,
  memory: StrategyMemory,
  refOf: (id: string) => string | undefined,
): AllianceContext {
  const tick = obs.tick;
  return {
    goal: memory.goal,
    warTargetRef: memory.warTarget ? (refOf(memory.warTarget) ?? null) : null,
    myAllies: me.allies().length,
    hostileNeighbors: obs.players.filter((o) => o.bordersMe && (o.attackingMe || (memory.threat.get(o.player.id()) ?? 0) >= 2)).length,
    winGap: Number((obs.state.me as Record<string, unknown>).land_share_still_needed_to_win ?? 0),
    alliedLand: Number((obs.state.me as Record<string, unknown>).land_held_by_my_allies ?? 0),
    facts: (o) => {
      const j = o.json;
      const g = memory.grudges.get(o.player.id());
      const b = (j.business ?? {}) as Record<string, unknown>;
      return {
        name: j.name,
        kind: j.kind,
        borders_me: j.borders_me,
        troops_vs_mine: j.troops_vs_mine,
        land_share: j.land_share,
        land_rank: j.land_rank,
        is_traitor: j.is_traitor,
        attacking_me_now: j.attacking_me,
        i_am_attacking_them: j.i_am_attacking,
        is_my_war_target: memory.warTarget === o.player.id(),
        attacked_me_before: g ? { times: g.count, minutes_ago: Math.round(((tick - g.lastTick) / 600) * 10) / 10 } : null,
        threat_to_me_0_to_3: Math.round((memory.threat.get(o.player.id()) ?? 1) * 10) / 10,
        trades_with_me: b.can_trade_with_me,
        their_stations_on_my_rail: b.rail_stations_linked_to_mine,
        their_ports: b.ports,
        also_attackable_by_me: cands.attackTargets.includes(o),
      };
    },
  };
}

function hold(route: Decision["route"], reason: string, calls: CallTrace[]): Decision {
  return { route, actions: [], confidence: 0, used: {}, preferences: {}, held: true, holdReason: reason, record: { action: "hold", detail: reason }, calls };
}

export type { BuildOption };
