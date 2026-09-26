// A loopback HTTP endpoint the browser extension posts its game traces to:
// one runs/<ts>-extension-<gameID>/trace.jsonl per game, the same format the
// CLI writes (log/format.ts). The stream runs one in-process; for games from
// a personal browser, `bun run trace-sink`.

import { Trace } from "./trace";

export interface TraceSinkOptions {
  dir: string;
  port: number;
  token: string;
  // Every event as it's posted (e.g. the stream's commentator following Jev's decisions).
  onEvent?: (gameID: string, event: Record<string, unknown>) => void;
}

export interface TraceSinkServer {
  url: string;
  token: string;
  // The game that most recently posted, or null before any.
  latest(): string | null;
  // Adds an event to a game's trace from this process (e.g. the stream's own
  // read of the result). False if that game has no trace.
  annotate(gameID: string | "latest", event: Record<string, unknown>): boolean;
  stop(): Promise<void>;
}

// OpenFront game IDs are short alphanumerics; they also name a directory.
const GAME_ID = /^[A-Za-z0-9_-]{1,40}$/;
// Traces kept open at once; older games are closed (a later post reopens a
// fresh directory, which the analyzer reads like any other).
const OPEN_TRACES = 4;

export function startTraceSink(opts: TraceSinkOptions): TraceSinkServer {
  const traces = new Map<string, Trace>();
  let latest: string | null = null;

  const traceFor = (gameID: string): Trace => {
    let trace = traces.get(gameID);
    if (trace === undefined) {
      trace = new Trace(opts.dir, `extension-${gameID}`);
      traces.set(gameID, trace);
      for (const [id, t] of traces) {
        if (traces.size <= OPEN_TRACES) break;
        if (id === gameID) continue;
        traces.delete(id);
        void t.close();
      }
    }
    latest = gameID;
    return trace;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      // No CORS headers on anything: a web page's preflight fails.
      if (req.method !== "POST" || url.pathname !== "/trace") return new Response("not found", { status: 404 });
      if (req.headers.get("x-jev-trace-token") !== opts.token) return new Response("forbidden", { status: 403 });
      let body: { gameID?: unknown; events?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const { gameID, events } = body;
      if (typeof gameID !== "string" || !GAME_ID.test(gameID) || !Array.isArray(events)) {
        return new Response("want {gameID, events[]}", { status: 400 });
      }
      const trace = traceFor(gameID);
      for (const e of events) {
        if (typeof e !== "object" || e === null || Array.isArray(e)) continue;
        trace.write(e as Record<string, unknown>);
        opts.onEvent?.(gameID, e as Record<string, unknown>);
      }
      return new Response(null, { status: 204 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/trace`,
    token: opts.token,
    latest: () => latest,
    annotate(gameID, event) {
      const id = gameID === "latest" ? latest : gameID;
      const trace = id === null ? undefined : traces.get(id);
      if (trace === undefined) return false;
      trace.write(event);
      return true;
    },
    async stop() {
      await server.stop(true);
      await Promise.all([...traces.values()].map((t) => t.close()));
      traces.clear();
    },
  };
}
