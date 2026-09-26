import type { HarnessConfig } from "../../harness/config";

export interface ExtensionSettings {
  enabled: boolean;
  apiKey: string;
  model: string;
  decisionInterval: number;
  minConfidence: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: false,
  apiKey: "",
  model: "jev-1.13.0",
  decisionInterval: 15,
  minConfidence: 0.35,
};

// Content scripts intentionally do not request the API key from extension
// storage. Only the popup (where it is entered) and background worker (where
// it is used) need that secret.
export const PUBLIC_SETTINGS_DEFAULTS = {
  enabled: DEFAULT_SETTINGS.enabled,
  model: DEFAULT_SETTINGS.model,
  decisionInterval: DEFAULT_SETTINGS.decisionInterval,
  minConfidence: DEFAULT_SETTINGS.minConfidence,
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
  };
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
