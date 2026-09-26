import type { HarnessConfig } from "../../harness/config";
import { parseStrategy, type Strategy } from "../../harness/strategy/doctrine";

export interface ExtensionSettings {
  enabled: boolean;
  apiKey: string;
  model: string;
  decisionInterval: number;
  minConfidence: number;
  // Viewer-voted playstyle, set by the stream driver (stream/); null plays
  // Jev's own judgment.
  strategy: Strategy | null;
  // Local trace sink (harness/log/sink.ts) the background worker posts game
  // traces to; "" keeps logging off. Loopback only.
  traceUrl: string;
  traceToken: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: false,
  apiKey: "",
  model: "jev-1.13.0",
  decisionInterval: 15,
  minConfidence: 0.35,
  strategy: null,
  traceUrl: "",
  traceToken: "",
};

// Content scripts intentionally do not request the API key (or the trace
// sink's address and token) from extension storage. Only the popup (where they
// are entered) and background worker (where they are used) need them.
export const PUBLIC_SETTINGS_DEFAULTS = {
  enabled: DEFAULT_SETTINGS.enabled,
  model: DEFAULT_SETTINGS.model,
  decisionInterval: DEFAULT_SETTINGS.decisionInterval,
  minConfidence: DEFAULT_SETTINGS.minConfidence,
  strategy: DEFAULT_SETTINGS.strategy,
};

function finiteNumber(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeSettings(value: Partial<Record<keyof ExtensionSettings, unknown>>): ExtensionSettings {
  return {
    enabled: value.enabled === true,
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : DEFAULT_SETTINGS.apiKey,
    model: typeof value.model === "string" && value.model.trim() !== "" ? value.model.trim() : DEFAULT_SETTINGS.model,
    decisionInterval: Math.round(Math.min(600, Math.max(5, finiteNumber(value.decisionInterval, DEFAULT_SETTINGS.decisionInterval)))),
    minConfidence: Math.min(1, Math.max(0, finiteNumber(value.minConfidence, DEFAULT_SETTINGS.minConfidence))),
    strategy: strategyOrNull(value.strategy),
    traceUrl: loopbackUrl(value.traceUrl),
    traceToken: typeof value.traceToken === "string" ? value.traceToken.trim() : DEFAULT_SETTINGS.traceToken,
  };
}

// The manifest only grants loopback hosts for traces; anything else is off.
function loopbackUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") ? url.href : "";
  } catch {
    return "";
  }
}

function strategyOrNull(value: unknown): Strategy | null {
  if (value === null || value === undefined) return null;
  const parsed = parseStrategy(value);
  return parsed.ok ? parsed.strategy : null;
}

export function isAllowedHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "openfront.io" ||
    hostname.endsWith(".openfront.io")
  );
}

export function toHarnessConfig(settings: ExtensionSettings): HarnessConfig {
  return {
    typesafeApiKey: undefined,
    model: settings.model,
    openfrontUrl: location.origin,
    decisionInterval: settings.decisionInterval,
    minConfidence: settings.minConfidence,
    goalSwitchProbability: 0.6,
    maxIntentsPerStep: 5,
    intentsPerMinute: 140,
    runsDir: "",
  };
}
