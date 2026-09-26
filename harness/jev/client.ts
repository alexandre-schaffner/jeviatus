// Thin wrapper over the TypeSafe SDK: pins the model, and accounts for calls,
// tokens and latency. `Jev` is the interface the pipeline depends on, so tests
// can swap in a fake that returns canned answers.

import {
  type EntryType,
  type Questions,
  type SystemOneResult,
  TypeSafeClient,
} from "@typesafe-ai/sdk";

export interface Jev {
  ask<const Q extends Questions>(label: string, state: EntryType, questions: Q): Promise<SystemOneResult<Q>>;
}

export interface JevStats {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  byLabel: Record<string, { calls: number; latencyMs: number }>;
}

export function emptyStats(): JevStats {
  return { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalLatencyMs: 0, maxLatencyMs: 0, byLabel: {} };
}

export class JevClient implements Jev {
  readonly stats: JevStats = emptyStats();
  private readonly client: TypeSafeClient;

  constructor(
    readonly model: string,
    apiKey?: string,
    // Decisions go stale fast; don't let retries stretch a call past a few seconds.
    timeoutMs = 4_000,
  ) {
    this.client = new TypeSafeClient({
      apiKey,
      defaultModel: model,
      timeout: timeoutMs,
      retry: { maxRetries: 1, backoffInitialMs: 200, backoffMaxMs: 500 },
    });
  }

  async ask<const Q extends Questions>(label: string, state: EntryType, questions: Q): Promise<SystemOneResult<Q>> {
    const t0 = performance.now();
    try {
      const res = await this.client.systemOne({ state, questions, model: this.model });
      const ms = performance.now() - t0;
      this.stats.calls++;
      this.stats.inputTokens += res.usage.input_tokens;
      this.stats.outputTokens += res.usage.output_tokens;
      this.stats.totalLatencyMs += ms;
      this.stats.maxLatencyMs = Math.max(this.stats.maxLatencyMs, ms);
      const l = (this.stats.byLabel[label] ??= { calls: 0, latencyMs: 0 });
      l.calls++;
      l.latencyMs += ms;
      return res;
    } catch (err) {
      this.stats.failures++;
      throw err;
    }
  }
}
