// What the live overlay shows: one event per decision step, with Jev's full
// probability distributions translated into display labels.

import type { ChoiceResponse, NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";
import type { Decision } from "../decide/pipeline";

export interface Dist {
  id: string;
  label: string;
  probs: { key: string; label: string; p: number }[];
  chosen: string;
  confidence: number;
  gated: boolean; // counts toward the weakest-link confidence
  used: boolean; // consumed by the chosen route
  score?: number; // Score questions: expected level
}

export interface OverlayEvent {
  type: "decision" | "spawn";
  agent: string;
  tick: number;
  minutes: number;
  me: Record<string, unknown>;
  route: Dist | null;
  held: boolean;
  holdReason?: string;
  confidence: number;
  threshold: number;
  goal: { current: string; dist: Dist | null };
  args: Dist[];
  side: { label: string; p: number; decision: string }[];
  threats: { label: string; score: number }[];
  intents: { desc: string; sent: boolean; reason?: string }[];
  recent: { min: number; action: string; target?: string; outcome: string }[];
  latencyMs: number;
  calls: { label: string; latencyMs: number; inputTokens?: number }[];
}

const ARG_LABELS: Record<string, string> = {
  attack_target: "Attack target",
  attack_commit: "Attack troops",
  expand_commit: "Expand troops",
  boat_target: "Naval target",
  build_unit: "Structure",
  spend: "Spare gold",
  ally_propose: "Alliance proposal",
  betray_target: "Ally to betray",
  nuke_target: "Nuke target",
  nuke_type: "Bomb",
  site: "Site",
  goal: "Goal",
  route: "Action",
};

// Which Call A arguments each route consumes.
const ROUTE_ARGS: Record<string, string[]> = {
  expand: ["expand_commit"],
  attack_player: ["attack_target", "attack_commit"],
  naval_invasion: ["boat_target", "attack_commit"],
  build: ["build_unit"],
  propose_alliance: ["ally_propose"],
  break_alliance: ["betray_target", "attack_commit"],
  nuke: ["nuke_target", "nuke_type"],
  hold: [],
};

type AnyAnswer = ChoiceResponse | ScoreResponse | NoulResponse;

export function toDist(
  id: string,
  a: AnyAnswer,
  label: (key: string) => string,
  gated: boolean,
  used: boolean,
  levelLabels?: string[],
): Dist | null {
  if (a.type === "choice") {
    return {
      id,
      label: ARG_LABELS[id] ?? id,
      probs: Object.entries(a.probabilities)
        .map(([key, p]) => ({ key, label: label(key), p: p as number }))
        .sort((x, y) => y.p - x.p),
      chosen: a.choice,
      confidence: a.confidence,
      gated,
      used,
    };
  }
  if (a.type === "score") {
    return {
      id,
      label: ARG_LABELS[id] ?? id,
      probs: Object.entries(a.probabilities).map(([key, p]) => ({
        key,
        label: levelLabels?.[Number(key)] ?? key,
        p: p as number,
      })),
      chosen: String(Math.round(a.score)),
      confidence: a.confidence,
      gated,
      used,
      score: a.score,
    };
  }
  return null;
}

export interface EventContext {
  agent: string;
  tick: number;
  me: Record<string, unknown>;
  threshold: number;
  goal: string;
  // Display label for an option key: player refs -> names, etc.
  label: (key: string) => string;
  recent: OverlayEvent["recent"];
  intents: OverlayEvent["intents"];
  latencyMs: number;
}

export function decisionEvent(ctx: EventContext, d: Decision): OverlayEvent {
  const routeCall = d.calls.find((c) => c.label === "route" || c.label === "spawn");
  const answers = (routeCall?.answers ?? {}) as Record<string, AnyAnswer>;
  const routeArgs = new Set(ROUTE_ARGS[d.route] ?? []);
  const args: Dist[] = [];
  let route: Dist | null = null;
  let goal: Dist | null = null;
  const side: OverlayEvent["side"] = [];
  const threats: OverlayEvent["threats"] = [];

  for (const [id, a] of Object.entries(answers)) {
    if (id === "route") route = toDist(id, a, (k) => k.replace("_", " "), true, true);
    else if (id === "goal") goal = toDist(id, a, (k) => k.replace("_", " "), false, true);
    else if (id.startsWith("threat.") && a.type === "score") threats.push({ label: ctx.label(id.slice(7)), score: a.score });
    else if (id.startsWith("ally_accept.") && a.type === "choice")
      side.push({ label: `Alliance request from ${ctx.label(id.slice(12))}`, p: (a.probabilities as Record<string, number>).accept ?? 0, decision: a.choice });
    else if (id.startsWith("ally_extend.") && a.type === "noul")
      side.push({ label: `Extend alliance with ${ctx.label(id.slice(12))}`, p: a.noul, decision: a.noul >= 0.5 ? "extend" : "no" });
    else if (id.startsWith("embargo_lift.") && a.type === "noul")
      side.push({ label: `Lift embargo on ${ctx.label(id.slice(13))}`, p: a.noul, decision: a.noul >= 0.6 ? "lift" : "no" });
    else if (id.startsWith("donate.") && a.type === "noul")
      side.push({ label: `Send troops to ally ${ctx.label(id.slice(7))}`, p: a.noul, decision: a.noul >= 0.6 ? "donate" : "no" });
    else if (id.startsWith("also_attack.") && a.type === "noul")
      side.push({ label: `Also attack ${ctx.label(id.slice(12))}`, p: a.noul, decision: a.noul >= 0.6 ? "attack" : "no" });
    else if (id.startsWith("retreat.") && a.type === "noul")
      side.push({ label: "Pull back a running attack", p: a.noul, decision: a.noul >= 0.6 ? "retreat" : "no" });
    else {
      const used = routeArgs.has(id) || d.route === "spawn";
      const dist = toDist(id, a, ctx.label, id in d.used, used, commitLabels(id));
      if (dist) args.push(dist);
    }
  }
  // Call B (site selection), if it ran.
  for (const c of d.calls) {
    if (c.label !== "build_site" && c.label !== "boat_site" && c.label !== "nuke_site") continue;
    const s = (c.answers as Record<string, AnyAnswer> | undefined)?.site;
    if (s) {
      const dist = toDist(c.label, s, (k) => k, c.label in d.used, true);
      const label = { build_site: "Build site (Call B)", boat_site: "Landing site (Call B)", nuke_site: "Blast site (Call B)" }[c.label];
      if (dist) args.push({ ...dist, label });
    }
  }
  args.sort((a, b) => Number(b.used) - Number(a.used));

  return {
    type: d.route === "spawn" ? "spawn" : "decision",
    agent: ctx.agent,
    tick: ctx.tick,
    minutes: Math.round((ctx.tick / 600) * 10) / 10,
    me: ctx.me,
    route,
    held: d.held,
    holdReason: d.holdReason,
    confidence: d.confidence,
    threshold: ctx.threshold,
    goal: { current: ctx.goal, dist: goal },
    args,
    side,
    threats: threats.sort((a, b) => b.score - a.score),
    intents: ctx.intents,
    recent: ctx.recent,
    latencyMs: ctx.latencyMs,
    calls: d.calls.map((c) => ({ label: c.label, latencyMs: Math.round(c.latencyMs), inputTokens: c.usage?.input_tokens })),
  };
}

function commitLabels(id: string): string[] | undefined {
  if (id === "expand_commit") return ["light ~10%", "moderate ~20%", "heavy ~35%", "all-in ~55%"];
  if (id === "attack_commit") return ["probe ~10%", "moderate ~25%", "heavy ~45%", "all-in ~70%"];
  return undefined;
}
