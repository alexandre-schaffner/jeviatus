// bun run play -- [flags]
//
//   --map <name>          map (default world)
//   --nations <n>         AI nations: a number, "default" or "disabled" (default 8)
//   --difficulty <d>      easy | medium | hard | impossible (default easy)
//   --tribes <n>          tribe bots (default 0)
//   --agents <n>          Jev players in the lobby, each with its own UUID (default 1)
//   --join <gameID>       join an existing lobby (e.g. one created in the browser)
//   --interval <ticks>    ticks between decision steps (default 15 = 1.5 s)
//   --minutes <m>         stop after this many game minutes (default 20)
//   --watch               open the live overlay (spectator view + Jev's probabilities)
//                         in your browser and wait for it to join before starting
//                         (up to --watch-timeout seconds, default 300)
//   --overlay-port <p>    port for the overlay page (default 9100)
//   --spectators <n>      spectators to wait for with --watch (default 1)
//   --humans <n>          human players to wait for with --watch (default 0); they
//                         join the printed lobby URL (use `npm run dev:host` for LAN)
//   --offline             no server: simulate locally with a relay in place of it
//   --fast                with --offline: don't pace ticks in real time; the sim
//                         waits for each decision (lockstep), ~6x faster
//   --strategy <file>     play a strategy file (e.g. strategies/turtle.json)
//   --dry-run             decide and log, but never send intents
//   --no-trace            don't write runs/<ts>/trace.jsonl

import { parseArgs } from "node:util";
import { Difficulty } from "src/core/game/Game";
import { loadConfig } from "./config";
import { emptyStats, JevClient, type JevStats } from "./jev/client";
import { runHeader } from "./log/format";
import { harnessCommit, openfrontCommit, Trace } from "./log/trace";
import { OverlayServer } from "./overlay/server";
import { type GameOptions, runLive, runOffline, type SessionResult } from "./session";
import { parseMap } from "./sim/mapLoader";
import { parseStrategy, type Strategy } from "./strategy/doctrine";

const { values } = parseArgs({
  options: {
    map: { type: "string", default: "world" },
    nations: { type: "string", default: "8" },
    difficulty: { type: "string", default: "easy" },
    tribes: { type: "string", default: "0" },
    agents: { type: "string", default: "1" },
    join: { type: "string" },
    interval: { type: "string" },
    minutes: { type: "string", default: "20" },
    offline: { type: "boolean", default: false },
    fast: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
    "watch-timeout": { type: "string", default: "300" },
    spectators: { type: "string", default: "1" },
    humans: { type: "string", default: "0" },
    "no-open": { type: "boolean", default: false },
    "overlay-port": { type: "string", default: "9100" },
    strategy: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "no-trace": { type: "boolean", default: false },
  },
  strict: true,
});

function parseDifficulty(s: string): Difficulty {
  const d = Object.values(Difficulty).find((v) => v.toLowerCase() === s.toLowerCase());
  if (d === undefined) throw new Error(`unknown difficulty "${s}"`);
  return d;
}

function parseNations(s: string): GameOptions["nations"] {
  if (s === "default" || s === "disabled") return s;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--nations must be a count, "default" or "disabled"`);
  return n === 0 ? "disabled" : n;
}

const config = loadConfig();
if (values.interval !== undefined) config.decisionInterval = Number(values.interval);
if (!config.typesafeApiKey) {
  console.error("TYPESAFE_API_KEY is not set (put it in .env; see .env.example)");
  process.exit(1);
}

let strategy: Strategy | undefined;
if (values.strategy !== undefined) {
  const parsed = parseStrategy(await Bun.file(values.strategy).json());
  if (!parsed.ok) {
    console.error(`${values.strategy}: ${parsed.error}`);
    process.exit(1);
  }
  strategy = parsed.strategy;
}

const game: GameOptions = {
  map: parseMap(values.map!),
  nations: parseNations(values.nations!),
  difficulty: parseDifficulty(values.difficulty!),
  tribes: Number(values.tribes),
};
const agents = Math.max(1, Number(values.agents));
const trace = new Trace(config.runsDir, values.offline ? "offline" : "live", !values["no-trace"]);
const jevs: JevClient[] = [];
const jevFor = (_i: number) => {
  const j = new JevClient(config.model, config.typesafeApiKey);
  jevs.push(j);
  return j;
};
const log = (line: string) => console.log(line);
const overlay = values.watch ? new OverlayServer(Number(values["overlay-port"])) : null;
overlay?.start();
const openInBrowser = (url: string) => {
  if (values["no-open"]) return;
  if (process.platform === "darwin") Bun.spawn(["open", url]);
  else if (process.platform === "linux") Bun.spawn(["xdg-open", url]);
};
const commits = { harnessCommit: await harnessCommit(), openfrontCommit: await openfrontCommit() };
const common = {
  config,
  jevFor,
  agents,
  trace,
  // The header waits for the game start: a joined game's map and ID are
  // only known then.
  onStart: (start: Parameters<typeof runHeader>[0]) =>
    trace.write({
      ...runHeader(start, {
        source: "cli",
        model: config.model,
        config: { ...config, typesafeApiKey: undefined },
        strategy: strategy ?? null,
        ...commits,
      }),
      args: values,
      game: values.join ? undefined : game,
    }),
  dryRun: values["dry-run"],
  maxMinutes: Number(values.minutes),
  log,
  onEvent: overlay ? (e: Parameters<OverlayServer["publish"]>[0]) => overlay.publish(e) : undefined,
  strategy,
};

let result: SessionResult;
if (values.offline) {
  result = await runOffline({ ...common, game, realtime: !values.fast, lockstep: values.fast });
} else {
  const watch = values.watch
    ? {
        spectators: Number(values.spectators),
        humans: Number(values.humans),
        timeoutMs: Number(values["watch-timeout"]) * 1000,
        onLobby: (spectateUrl: string) => {
          overlay!.setGame(spectateUrl);
          log(`overlay at ${overlay!.url()}`);
          openInBrowser(overlay!.url());
        },
      }
    : undefined;
  result = await runLive({ ...common, game: values.join ? undefined : game, joinGameID: values.join, watch });
}

const stats: JevStats = jevs.reduce((acc, j) => {
  acc.calls += j.stats.calls;
  acc.failures += j.stats.failures;
  acc.inputTokens += j.stats.inputTokens;
  acc.outputTokens += j.stats.outputTokens;
  acc.totalLatencyMs += j.stats.totalLatencyMs;
  acc.maxLatencyMs = Math.max(acc.maxLatencyMs, j.stats.maxLatencyMs);
  for (const [k, v] of Object.entries(j.stats.byLabel)) {
    const l = (acc.byLabel[k] ??= { calls: 0, latencyMs: 0 });
    l.calls += v.calls;
    l.latencyMs += v.latencyMs;
  }
  return acc;
}, emptyStats());

const summary = {
  gameID: result.gameID,
  ticks: result.ticks,
  minutes: Math.round((result.ticks / 600) * 10) / 10,
  agents: result.summaries,
  jev: {
    model: config.model,
    calls: stats.calls,
    failures: stats.failures,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    meanLatencyMs: stats.calls ? Math.round(stats.totalLatencyMs / stats.calls) : 0,
    maxLatencyMs: Math.round(stats.maxLatencyMs),
    byCall: Object.fromEntries(
      Object.entries(stats.byLabel).map(([k, v]) => [k, { calls: v.calls, meanLatencyMs: Math.round(v.latencyMs / v.calls) }]),
    ),
    costUSD: Math.round(((stats.inputTokens * 0.042) / 1e6) * 1e5) / 1e5,
  },
  desyncs: result.desyncs,
  errors: result.errors,
  trace: values["no-trace"] ? null : trace.dir,
};
trace.write({ type: "summary", ...summary });
overlay?.status(`game over: ${result.summaries.map((a) => `${a.name} ${a.outcome}`).join(", ")}`);
trace.writeFile("summary.json", JSON.stringify(summary, null, 2));
await trace.close();
console.log("\n=== summary ===");
console.log(JSON.stringify(summary, null, 2));
process.exit(result.errors.length > 0 ? 1 : 0);
