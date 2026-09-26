// Test fixtures: a scripted fake Jev and an offline game on OpenFront's test
// maps, driven tick by tick through the same relay the --offline mode uses.

import type { EntryType, Questions, SystemOneResult } from "@typesafe-ai/sdk";
import path from "node:path";
import { Difficulty, GameMapType } from "src/core/game/Game";
import type { Player } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import type { Intent } from "src/core/Schemas";
import { spawnCandidates } from "../harness/decide/candidates";
import { SectorGrid } from "../harness/observe/sectors";
import { loadConfig, type HarnessConfig } from "../harness/config";
import type { Jev } from "../harness/jev/client";
import { TEST_MAPS_DIR, FsMapLoader } from "../harness/sim/mapLoader";
import { Mirror } from "../harness/sim/mirror";
import { LocalRelay } from "../harness/session";

export interface AskRecord {
  label: string;
  state: EntryType;
  questions: Questions;
}

// Answers every question deterministically. `prefer[id]` names the option a
// Choice should pick (falls back to the first option); Scores answer level
// `score[id]` (default 1); Nouls answer `noul[id]` (default 0).
export class FakeJev implements Jev {
  readonly asked: AskRecord[] = [];
  prefer: Record<string, string | ((keys: string[]) => string)> = {};
  score: Record<string, number> = {};
  noul: Record<string, number> = {};

  async ask<const Q extends Questions>(label: string, state: EntryType, questions: Q): Promise<SystemOneResult<Q>> {
    this.asked.push({ label, state, questions });
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "choice") {
        const keys = Object.keys(q.criteria);
        const pref = this.prefer[id];
        const want = typeof pref === "function" ? pref(keys) : pref;
        const choice = want !== undefined && keys.includes(want) ? want : keys[0];
        answers[id] = {
          type: "choice",
          choice,
          confidence: 0.9,
          probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : 0.1 / Math.max(1, keys.length - 1)])),
        };
      } else if (q.type === "score") {
        const levels = q.criteria.length;
        const s = Math.min(levels - 1, this.score[id] ?? 1);
        answers[id] = {
          type: "score",
          score: s,
          confidence: 0.9,
          legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
          probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === s ? 1 : 0])),
        };
      } else {
        answers[id] = { type: "noul", noul: this.noul[id] ?? this.noul[id.split(".")[0]] ?? 0 };
      }
    }
    return { model: "fake", answers, usage: { input_tokens: 0, output_tokens: 0 } } as unknown as SystemOneResult<Q>;
  }
}

export function testConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return { ...loadConfig(), runsDir: "/tmp/jeviatus-test-runs", ...overrides };
}

export interface OfflineGame {
  relay: LocalRelay;
  mirror: Mirror;
  send: (intent: Intent) => void;
  // Intents from the other human seats (agents > 1).
  sendAs: (seat: number, intent: Intent) => void;
  step: (n?: number) => void;
}

// An offline game on the vendored test copy of the World map (2000x1000).
export async function offlineGame(opts: { nations?: number; spawnImmunity?: number; agents?: number } = {}): Promise<OfflineGame> {
  const relay = new LocalRelay({ map: GameMapType.World, nations: opts.nations ?? 6, difficulty: Difficulty.Easy, tribes: 0 }, opts.agents ?? 1);
  relay.start.config.spawnImmunityDuration = opts.spawnImmunity ?? 0;
  const mirror = await Mirror.create(relay.start, relay.clientIDs[0], new FsMapLoader(undefined, path.join(TEST_MAPS_DIR, "world")));
  let turn = 0;
  return {
    relay,
    mirror,
    send: relay.sender(relay.clientIDs[0]),
    sendAs: (seat, intent) => relay.sender(relay.clientIDs[seat])(intent),
    step: (n = 1) => {
      for (let i = 0; i < n; i++) mirror.addTurn(relay.nextTurn(turn++));
    },
  };
}

// An unowned land tile 32-44 tiles east or west of `from`: past the minimum
// spawn distance, close enough that two players meet quickly.
function nearbyLand(game: Mirror["game"], from: TileRef): TileRef {
  const x0 = game.x(from);
  const y0 = game.y(from);
  for (let d = 32; d <= 44; d++) {
    for (const dx of [d, -d]) {
      for (const dy of [0, 2, -2, 4, -4]) {
        if (!game.isValidCoord(x0 + dx, y0 + dy)) continue;
        const t = game.ref(x0 + dx, y0 + dy);
        if (game.isLand(t) && !game.hasOwner(t)) return t;
      }
    }
  }
  throw new Error("no nearby land");
}

export interface Neighbors {
  g: OfflineGame;
  me: Player;
  other: Player;
}

// Two human seats spawned close together and grown until they share a border.
export async function neighbors(): Promise<Neighbors> {
  const g = await offlineGame({ nations: 0, agents: 2 });
  const game = g.mirror.game;
  const me = g.mirror.me()!;
  const other = g.mirror.viewAs(g.relay.clientIDs[1]).me()!;
  const mine = spawnCandidates(game, me, new SectorGrid(game))[0].tile;
  g.send({ type: "spawn", tile: mine });
  g.sendAs(1, { type: "spawn", tile: nearbyLand(game, mine) });
  while (game.inSpawnPhase()) g.step(10);
  for (let i = 0; i < 300 && !me.sharesBorderWith(other); i++) {
    if (i % 2 === 0) {
      g.send({ type: "attack", targetID: null, troops: Math.floor(me.troops() * 0.4) });
      g.sendAs(1, { type: "attack", targetID: null, troops: Math.floor(other.troops() * 0.4) });
    }
    g.step(10);
  }
  if (!me.sharesBorderWith(other)) throw new Error("neighbors never met");
  g.step(100); // let expansions settle and troops regrow
  return { g, me, other };
}
