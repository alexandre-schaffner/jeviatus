// "Jev's brain" in words: the card under the game in every clip shows the
// call Jev made at the moment's key decision (moments.ts keyDecision), the
// options it weighed with their probabilities, and how sure it was.

import type { Brain } from "./moments";

export interface BrainCard {
  // What Jev decided, e.g. "ATTACK KALMYKIA".
  title: string;
  // The top options, most likely first; `chosen` is the one it took.
  options: { label: string; p: number; chosen: boolean }[];
  // e.g. "59% SURE · SENDING 30% OF ITS TROOPS".
  footer: string;
}

const ROUTE: Record<string, string> = {
  expand: "Expand into free land",
  attack_player: "Attack a player",
  naval_invasion: "Invade by sea",
  build: "Build",
  propose_alliance: "Propose an alliance",
  break_alliance: "Betray an ally",
  nuke: "Launch a nuke",
  hold: "Hold",
};

function title(b: Brain): string {
  const t = b.target;
  if (b.held) return "HOLD";
  switch (b.route) {
    case "attack_player":
      return t ? `ATTACK ${t}` : "ATTACK";
    case "break_alliance":
      return t ? `BETRAY ${t}` : "BETRAY AN ALLY";
    case "naval_invasion":
      return t ? `INVADE ${t} BY SEA` : "INVADE BY SEA";
    case "nuke":
      return t ? `NUKE ${t}` : "LAUNCH A NUKE";
    case "propose_alliance":
      return t ? `ALLY WITH ${t}` : "PROPOSE AN ALLIANCE";
    case "expand":
      return "GRAB FREE LAND";
    default:
      return (ROUTE[b.route] ?? b.route.replace(/_/g, " ")).toUpperCase();
  }
}

// "confidence 0.28 < 0.35" / "keeping troops home against X" → words.
function holdWhy(reason: string | undefined): string {
  const low = /confidence ([\d.]+) < ([\d.]+)/.exec(reason ?? "");
  if (low) return `TOO UNSURE TO ACT (${Math.round(Number(low[1]) * 100)}% < ${Math.round(Number(low[2]) * 100)}%)`;
  return (reason ?? "WAITING FOR AN OPENING").replace(/\s*\(.*\)$/, "").toUpperCase();
}

export function brainCard(b: Brain): BrainCard {
  const chosenKey = b.held ? "hold" : b.route;
  const options = b.options.slice(0, 3).map((o) => ({
    label: ROUTE[o.key] ?? o.key.replace(/_/g, " "),
    p: o.p,
    chosen: o.key === chosenKey,
  }));
  // The chosen route is always on the card, even when it wasn't the top one
  // (a held step: Jev wanted something but wasn't sure enough).
  if (!options.some((o) => o.chosen)) {
    const own = b.options.find((o) => o.key === chosenKey);
    if (own) options[options.length - 1] = { label: ROUTE[own.key] ?? own.key, p: own.p, chosen: true };
  }
  const sure = b.options.find((o) => o.key === b.route)?.p ?? b.options[0]!.p;
  const troops = /(\d+)% troops/.exec(b.detail ?? "")?.[1];
  const footer = b.held
    ? holdWhy(b.holdReason)
    : [`${Math.round(sure * 100)}% SURE`, troops ? `SENDING ${troops}% OF ITS TROOPS` : b.goal ? `GOAL: ${b.goal.replace(/_/g, " ").toUpperCase()}` : null].filter(Boolean).join(" · ");
  return { title: title(b).toUpperCase(), options, footer };
}
