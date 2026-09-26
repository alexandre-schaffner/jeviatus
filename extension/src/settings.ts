import { DEFAULTS } from "../../harness/config";

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
  model: DEFAULTS.model,
  decisionInterval: DEFAULTS.decisionInterval,
  minConfidence: DEFAULTS.minConfidence,
};

// Content scripts intentionally do not request the API key from extension
// storage. Only the popup (where it is entered) and background worker (where
// it is used) need that secret.
const { apiKey: _, ...publicDefaults } = DEFAULT_SETTINGS;
export const PUBLIC_SETTINGS_DEFAULTS = publicDefaults;

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
