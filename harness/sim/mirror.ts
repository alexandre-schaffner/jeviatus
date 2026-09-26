// Runs the deterministic OpenFront simulation locally, fed by the server's
// turn stream, exactly like the browser's worker does. The server only relays
// intents, so this mirror IS the game state the agent observes.

import type { Game, Player } from "src/core/game/Game";
import type { GameMapLoader } from "src/core/game/GameMapLoader";
import {
  type ErrorUpdate,
  type GameUpdateViewData,
  GameUpdateType,
  type HashUpdate,
  type WinUpdate,
} from "src/core/game/GameUpdates";
import { createGameRunner, type GameRunner } from "src/core/GameRunner";
import type { ClientID, GameStartInfo, Turn } from "src/core/Schemas";

export interface MirrorEvents {
  onHash?: (tick: number, hash: number) => void;
  onWin?: (win: WinUpdate) => void;
  onError?: (err: ErrorUpdate) => void;
}

export class Mirror {
  private turnsSeen = 0;
  private lastError: ErrorUpdate | null = null;
  winner: WinUpdate | null = null;

  private constructor(
    readonly runner: GameRunner,
    readonly clientID: ClientID,
    private readonly events: MirrorEvents,
  ) {}

  static async create(
    gameStart: GameStartInfo,
    clientID: ClientID,
    mapLoader: GameMapLoader,
    events: MirrorEvents = {},
  ): Promise<Mirror> {
    let mirror: Mirror | null = null;
    const runner = await createGameRunner(gameStart, clientID, mapLoader, (gu) =>
      mirror?.onUpdate(gu),
    );
    mirror = new Mirror(runner, clientID, events);
    return mirror;
  }

  get game(): Game {
    return this.runner.game;
  }

  // Null before the roster includes us (spectating) — humans exist from tick 0.
  me(): Player | null {
    return this.game.playerByClientID(this.clientID);
  }

  // The same sim seen as another player. Offline, agents share one sim rather
  // than each running an identical copy.
  viewAs(clientID: ClientID): Mirror {
    return Object.create(this, { clientID: { value: clientID } }) as Mirror;
  }

  ticks(): number {
    return this.game.ticks();
  }

  // Feed one server turn and run it. Gaps (turns the server skipped) are
  // filled with empty turns, as ClientGameRunner does.
  addTurn(turn: Turn): void {
    if (turn.turnNumber < this.turnsSeen) return;
    while (turn.turnNumber > this.turnsSeen) {
      this.runner.addTurn({ turnNumber: this.turnsSeen, intents: [] });
      this.turnsSeen++;
    }
    this.runner.addTurn(turn);
    this.turnsSeen++;
    this.drain();
  }

  private drain(): void {
    while (this.runner.pendingTurns() > 0) {
      this.lastError = null;
      if (!this.runner.executeNextTick(this.runner.pendingTurns())) {
        const err = this.lastError as ErrorUpdate | null;
        throw new Error(`tick ${this.game.ticks()} failed: ${err?.errMsg ?? "unknown"}\n${err?.stack ?? ""}`);
      }
    }
  }

  private onUpdate(gu: GameUpdateViewData | ErrorUpdate): void {
    if ("errMsg" in gu) {
      this.lastError = gu;
      this.events.onError?.(gu);
      return;
    }
    for (const h of gu.updates[GameUpdateType.Hash] as HashUpdate[]) {
      this.events.onHash?.(h.tick, h.hash);
    }
    for (const w of gu.updates[GameUpdateType.Win] as WinUpdate[]) {
      this.winner = w;
      this.events.onWin?.(w);
    }
  }
}
