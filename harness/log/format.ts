// The trace event format shared by every game source: the CLI writes it to
// disk directly (log/trace.ts), the browser extension batches it to a local
// sink (log/sink.ts). Browser-safe: no node imports.

import type { GameStartInfo } from "src/core/Schemas";
import type { Strategy } from "../strategy/doctrine";

// Anything a trace event can be written to.
export interface TraceSink {
  write(event: Record<string, unknown>): void;
}

// The first event of every trace: which game, played how, by which build.
export interface RunHeader {
  type: "run";
  source: "cli" | "extension";
  gameID: string;
  map: string;
  // Human seats in the lobby (Jev included); nations and tribes come on top.
  players: number;
  gameType: string;
  model: string;
  config: Record<string, unknown>;
  strategy: Strategy | null;
  // Git sha of this repo, with "+dirty" for uncommitted changes.
  harnessCommit: string;
  openfrontCommit: string;
  startedAt: string;
}

export function runHeader(
  start: GameStartInfo,
  rest: Pick<RunHeader, "source" | "model" | "config" | "strategy" | "harnessCommit" | "openfrontCommit">,
): RunHeader {
  return {
    type: "run",
    source: rest.source,
    gameID: start.gameID,
    map: String(start.config.gameMap),
    players: start.players.length,
    gameType: String(start.config.gameType),
    model: rest.model,
    config: rest.config,
    strategy: rest.strategy,
    harnessCommit: rest.harnessCommit,
    openfrontCommit: rest.openfrontCommit,
    startedAt: new Date().toISOString(),
  };
}

// Game state carries bigints (gold); JSON can't.
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}
