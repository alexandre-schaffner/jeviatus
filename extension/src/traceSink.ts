// Game traces from the content script. Events are buffered and handed to the
// background worker in batches, which posts them to the local trace sink
// (harness/log/sink.ts) if one is configured. Logging must never break play:
// a failed hand-off drops that batch with one warning.

import { jsonReplacer, type TraceSink } from "../../harness/log/format";

export interface TraceBatch {
  type: "jev:trace";
  gameID: string;
  events: Record<string, unknown>[];
}

export function isTraceBatch(value: unknown): value is TraceBatch {
  const v = value as Partial<TraceBatch> | null;
  return typeof v === "object" && v !== null && v.type === "jev:trace" && typeof v.gameID === "string" && Array.isArray(v.events);
}

export const TRACE_FLUSH_MS = 3_000;

export class ExtensionTraceSink implements TraceSink {
  private buffer: Record<string, unknown>[] = [];
  private readonly timer: ReturnType<typeof setInterval> | null;
  private warned = false;

  constructor(
    readonly gameID: string,
    private readonly send: (batch: TraceBatch) => Promise<unknown> = (batch) => chrome.runtime.sendMessage(batch),
    flushMs = TRACE_FLUSH_MS,
  ) {
    this.timer = flushMs > 0 ? setInterval(() => void this.flush(), flushMs) : null;
  }

  // Serialized now: the events hold live references into the step's state.
  write(event: Record<string, unknown>): void {
    this.buffer.push(JSON.parse(JSON.stringify(event, jsonReplacer)) as Record<string, unknown>);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const events = this.buffer.splice(0);
    try {
      await this.send({ type: "jev:trace", gameID: this.gameID, events });
    } catch (error) {
      if (!this.warned) console.warn("[Jev extension] trace hand-off failed", error);
      this.warned = true;
    }
  }

  close(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    return this.flush();
  }
}
