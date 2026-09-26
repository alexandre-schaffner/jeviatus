// A playstyle for Jev, proposed as a pull request that adds one JSON file
// under strategies/ and voted onto the stream by viewers. Strategies are data
// only: a name, a short natural-language doctrine Jev reads as state, and an
// optional starting goal. A strategy PR never runs code.

import { GOALS, type Goal } from "./memory";

export interface Strategy {
  name: string;
  doctrine: string;
  goal?: Goal;
}

export const STRATEGY_LIMITS = { name: 40, doctrine: 400 } as const;

// Where proposals live. strategies/example.json is the template, not a proposal.
export const STRATEGY_FILE = /^strategies\/(?!example\.json$)[a-z0-9][a-z0-9-]{0,40}\.json$/;

// Any JSON under strategies/ except the template makes a PR a strategy PR.
export function isStrategyFile(file: string): boolean {
  return file.startsWith("strategies/") && file.endsWith(".json") && file !== "strategies/example.json";
}

const KEYS = new Set(["name", "doctrine", "goal"]);
// Names are painted on the stream: keep them to plain words.
const LINK = /https?:|:\/\/|www\.|\.(com|net|org|io|gg|tv|xyz)\b/i;
const CONTROL = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

export type StrategyParse = { ok: true; strategy: Strategy } | { ok: false; error: string };

export function parseStrategy(value: unknown): StrategyParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: "a strategy is a JSON object" };
  const o = value as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !KEYS.has(k));
  if (extra.length > 0) return { ok: false, error: `unknown field(s): ${extra.join(", ")} (allowed: name, doctrine, goal)` };

  const text = (field: "name" | "doctrine"): string | { error: string } => {
    const v = o[field];
    if (typeof v !== "string" || v.trim() === "") return { error: `"${field}" must be a non-empty string` };
    const s = v.trim().replace(/\s+/g, " ");
    if (s.length > STRATEGY_LIMITS[field]) return { error: `"${field}" is ${s.length} characters; the limit is ${STRATEGY_LIMITS[field]}` };
    if (CONTROL.test(v.replace(/[\n\t]/g, " "))) return { error: `"${field}" contains control or direction-override characters` };
    return s;
  };
  const name = text("name");
  if (typeof name !== "string") return { ok: false, error: name.error };
  if (LINK.test(name)) return { ok: false, error: `"name" must not contain links` };
  const doctrine = text("doctrine");
  if (typeof doctrine !== "string") return { ok: false, error: doctrine.error };

  if (o.goal === undefined) return { ok: true, strategy: { name, doctrine } };
  if (typeof o.goal !== "string" || !(o.goal in GOALS)) {
    return { ok: false, error: `"goal" must be one of ${Object.keys(GOALS).join(", ")}` };
  }
  return { ok: true, strategy: { name, doctrine, goal: o.goal as Goal } };
}

// What Jev sees, as the `strategy` block of its state.
export function strategyState(s: Strategy): Record<string, unknown> {
  return { name: s.name, doctrine: s.doctrine, chosen_by: "the stream's viewers, by vote" };
}
