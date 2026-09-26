// Environment and defaults. Bun loads .env automatically.

// Shared with the extension, which has no environment.
export const DEFAULTS = {
  model: "jev-1.13.0",
  // Ticks between decision steps (1 tick = 100 ms).
  decisionInterval: 15,
  // Below this weakest-link confidence the step falls back to `hold`.
  minConfidence: 0.35,
  // Intents sent per decision step, at most.
  maxIntentsPerStep: 5,
  // Token bucket: the server allows 150 intents/min; stay under it.
  intentsPerMinute: 140,
};

export type HarnessConfig = typeof DEFAULTS & {
  typesafeApiKey: string | undefined;
  openfrontUrl: string;
  runsDir: string;
};

// What a single Agent reads.
export type AgentConfig = Pick<HarnessConfig, "decisionInterval" | "minConfidence" | "maxIntentsPerStep">;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

export function loadConfig(): HarnessConfig {
  return {
    typesafeApiKey: process.env.TYPESAFE_API_KEY,
    model: process.env.JEV_MODEL ?? DEFAULTS.model,
    openfrontUrl: (process.env.OPENFRONT_URL ?? "http://localhost:9000").replace(/\/+$/, ""),
    decisionInterval: num("DECISION_INTERVAL", DEFAULTS.decisionInterval),
    minConfidence: num("MIN_CONFIDENCE", DEFAULTS.minConfidence),
    maxIntentsPerStep: num("MAX_INTENTS_PER_STEP", DEFAULTS.maxIntentsPerStep),
    intentsPerMinute: num("INTENTS_PER_MINUTE", DEFAULTS.intentsPerMinute),
    runsDir: process.env.RUNS_DIR ?? "runs",
  };
}
