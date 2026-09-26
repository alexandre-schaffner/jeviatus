// Environment and defaults. Bun loads .env automatically.

export interface HarnessConfig {
  typesafeApiKey: string | undefined;
  model: string;
  openfrontUrl: string;
  // Ticks between decision steps (1 tick = 100 ms).
  decisionInterval: number;
  // Below this weakest-link confidence the step falls back to `hold`.
  minConfidence: number;
  // Goal switches need p above this on two consecutive steps.
  goalSwitchProbability: number;
  // Intents sent per decision step, at most.
  maxIntentsPerStep: number;
  // Token bucket: the server allows 150 intents/min; stay under it.
  intentsPerMinute: number;
  runsDir: string;
}

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
    model: process.env.JEV_MODEL ?? "jev-1.13.0",
    openfrontUrl: (process.env.OPENFRONT_URL ?? "http://localhost:9000").replace(/\/+$/, ""),
    decisionInterval: num("DECISION_INTERVAL", 15),
    minConfidence: num("MIN_CONFIDENCE", 0.35),
    goalSwitchProbability: num("GOAL_SWITCH_P", 0.6),
    maxIntentsPerStep: num("MAX_INTENTS_PER_STEP", 5),
    intentsPerMinute: num("INTENTS_PER_MINUTE", 140),
    runsDir: process.env.RUNS_DIR ?? "runs",
  };
}
