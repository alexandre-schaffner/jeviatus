// Wires agents to a game. Live: real websocket clients against an OpenFront
// server. Offline: a local relay stands in for the server (same GameRunner,
// same turn stream shape), for tests and fast iteration without a server.

import { type Difficulty, type GameMapType, GameMapSize, GameMode, GameType } from "src/core/game/Game";
import type { GameConfig, GameStartInfo, Intent, StampedIntent } from "src/core/Schemas";
import { Agent, type AgentSummary } from "./agent";
import type { HarnessConfig } from "./config";
import type { Jev } from "./jev/client";
import type { TraceSink } from "./log/format";
import { GameSocket } from "./net/client";
import { createGame, workerPathFor, wsUrl } from "./net/http";
import { TokenBucket } from "./net/rateLimit";
import { FsMapLoader } from "./sim/mapLoader";
import type { OverlayEvent } from "./overlay/events";
import { Mirror } from "./sim/mirror";
import type { Strategy } from "./strategy/doctrine";

export interface GameOptions {
  map: GameMapType;
  mapSize?: GameMapSize;
  nations: number | "default" | "disabled";
  difficulty: Difficulty;
  tribes: number;
}

export interface SessionOptions {
  config: HarnessConfig;
  jevFor: (i: number) => Jev;
  agents: number;
  trace?: TraceSink;
  // Once, when the game starts (before any agent acts): the trace header.
  onStart?: (start: GameStartInfo) => void;
  dryRun?: boolean;
  maxMinutes: number;
  log: (line: string) => void;
  onEvent?: (e: OverlayEvent) => void;
  strategy?: Strategy;
}

export interface SessionResult {
  gameID: string;
  ticks: number;
  summaries: AgentSummary[];
  errors: string[];
  desyncs: number;
}

export function gameConfig(g: GameOptions, gameType: GameType): GameConfig {
  return {
    gameMap: g.map,
    gameMapSize: g.mapSize ?? GameMapSize.Normal,
    difficulty: g.difficulty,
    gameType,
    gameMode: GameMode.FFA,
    donateGold: true,
    donateTroops: true,
    nations: g.nations,
    bots: g.tribes,
    infiniteGold: false,
    infiniteTroops: false,
    instantBuild: false,
    randomSpawn: false,
  };
}

const USERNAMES = ["Jev", "JevTwo", "JevThree", "JevFour", "JevFive", "JevSix", "JevSeven", "JevEight"];

// --- live ------------------------------------------------------------------------

interface LiveSeat {
  socket: GameSocket;
  token: string;
  mirror: Mirror | null;
  agent: Agent | null;
  clientID: string | null;
  buffered: Parameters<Mirror["addTurn"]>[0][];
}

export interface WatchOptions {
  // Spectators to wait for in the lobby before starting (0 = start at once).
  spectators: number;
  // Human players (e.g. friends on your LAN) to wait for, besides the agents.
  humans?: number;
  timeoutMs: number;
  // Called with the spectate URL once the lobby exists (e.g. open a browser).
  onLobby?: (spectateUrl: string) => void;
}

export async function runLive(
  opts: SessionOptions & { game?: GameOptions; joinGameID?: string; watch?: WatchOptions },
): Promise<SessionResult> {
  const { config } = opts;
  const errors: string[] = [];
  let desyncs = 0;
  const creatorToken = crypto.randomUUID();
  let gameID: string;
  let workerPath: string;
  if (opts.joinGameID !== undefined) {
    gameID = opts.joinGameID;
    workerPath = workerPathFor(gameID);
  } else {
    if (opts.game === undefined) throw new Error("need game options or a game to join");
    const created = await createGame(config.openfrontUrl, creatorToken, gameConfig(opts.game, GameType.Private));
    gameID = created.gameID;
    workerPath = created.workerPath;
    opts.log(`created game ${gameID} (${workerPath})`);
  }
  const spectateUrl = `${config.openfrontUrl}/${workerPath}/game/${gameID}?spectate`;
  opts.log(`spectate at ${spectateUrl}`);
  const watch = opts.watch;
  const watchDeadline = Date.now() + (watch?.timeoutMs ?? 0);

  const url = wsUrl(config.openfrontUrl, workerPath);
  const loader = new FsMapLoader();
  const seats: LiveSeat[] = [];
  let startSent = opts.joinGameID !== undefined; // joiners never start the game
  let finish: () => void = () => {};
  const done = new Promise<void>((r) => (finish = r));
  let lastTick = 0;

  for (let i = 0; i < opts.agents; i++) {
    const seat: LiveSeat = {
      socket: new GameSocket(url),
      token: i === 0 && opts.joinGameID === undefined ? creatorToken : crypto.randomUUID(),
      mirror: null,
      agent: null,
      clientID: null,
      buffered: [],
    };
    seats.push(seat);
    const name = USERNAMES[i] ?? `Jev${i + 1}`;
    const bucket = new TokenBucket(config.intentsPerMinute);
    seat.socket.onClose((code, reason) => {
      if (code !== 1000) errors.push(`${name}: socket closed ${code} ${reason}`);
      opts.log(`[${name}] socket closed ${code} ${reason}`);
      finish();
    });
    seat.socket.onMessage(async (m) => {
      switch (m.type) {
        case "lobby_info": {
          seat.clientID = m.myClientID;
          const clients = m.lobby.clients ?? [];
          const players = clients.filter((c) => !c.spectator).length;
          const spectators = clients.length - players;
          const wantSpectators = watch?.spectators ?? 0;
          const wantPlayers = opts.agents + (watch?.humans ?? 0);
          const watchersReady = (spectators >= wantSpectators && players >= wantPlayers) || Date.now() > watchDeadline;
          if (i === 0 && !startSent && players >= opts.agents && watchersReady) {
            startSent = true;
            opts.log(`${players} player(s), ${spectators} spectator(s) in lobby; starting`);
            seat.socket.sendIntent({ type: "toggle_game_start_timer" });
          }
          return;
        }
        case "start": {
          const myID = m.myClientID ?? seat.clientID;
          if (myID === null || myID === undefined) {
            errors.push(`${name}: start without a client ID`);
            return;
          }
          const mirror = await Mirror.create(m.gameStartInfo, myID, loader, {
            onHash: (tick, hash) => seat.socket.sendHash(tick, hash),
            onError: (e) => errors.push(`${name}: sim error ${e.errMsg}`),
          });
          seat.mirror = mirror;
          if (i === 0) opts.onStart?.(m.gameStartInfo);
          seat.agent = new Agent({
            name,
            mirror,
            jev: opts.jevFor(i),
            config,
            bucket,
            send: (intent) => seat.socket.sendIntent(intent),
            trace: opts.trace,
            dryRun: opts.dryRun,
            log: opts.log,
            onEvent: opts.onEvent,
            strategy: opts.strategy,
          });
          for (const t of m.turns) mirror.addTurn(t);
          for (const t of seat.buffered) mirror.addTurn(t);
          seat.buffered = [];
          opts.log(`[${name}] game started, ${m.gameStartInfo.players.length} human player(s), map ${m.gameStartInfo.config.gameMap}`);
          return;
        }
        case "turn": {
          if (seat.mirror === null) {
            seat.buffered.push(m.turn);
            return;
          }
          try {
            seat.mirror.addTurn(m.turn);
          } catch (err) {
            errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
            finish();
            return;
          }
          seat.agent?.onTick();
          if (i === 0) lastTick = seat.mirror.ticks();
          if (seat.mirror.winner !== null) finish();
          if (seat.mirror.ticks() >= opts.maxMinutes * 600) finish();
          if (seats.every((s) => s.agent === null || isOut(s))) finish();
          return;
        }
        case "desync":
          desyncs++;
          errors.push(`${name}: desync at turn ${m.turn}`);
          return;
        case "error":
          errors.push(`${name}: server error ${m.error} ${m.message ?? ""}`);
          finish();
          return;
        default:
          return;
      }
    });
    await seat.socket.connect();
    seat.socket.join({ gameID, token: seat.token, username: name });
  }
  if (watch && (watch.spectators > 0 || (watch.humans ?? 0) > 0)) {
    const playUrl = spectateUrl.replace("?spectate", "");
    if (watch.humans) opts.log(`human players join at ${playUrl}`);
    opts.log(`waiting up to ${Math.round(watch.timeoutMs / 1000)}s for ${watch.spectators} spectator(s) and ${watch.humans ?? 0} human player(s)`);
    watch.onLobby?.(spectateUrl);
  }

  await done;
  for (const s of seats) await s.agent?.pending;
  const summaries = seats.filter((s) => s.agent !== null).map((s) => s.agent!.summary());
  for (const s of seats) s.socket.close();
  return { gameID, ticks: lastTick, summaries, errors, desyncs };
}

function isOut(s: LiveSeat): boolean {
  const me = s.mirror?.me();
  return me !== null && me !== undefined && me.hasSpawned() && !me.isAlive() && !s.mirror!.game.inSpawnPhase();
}

// --- offline -------------------------------------------------------------------

// The server's role, locally: stamp intents with the sender's clientID and emit
// one turn per tick. All agents share one mirror, since they'd all compute the
// same state anyway.
export class LocalRelay {
  private queue: StampedIntent[] = [];
  readonly clientIDs: string[];
  readonly start: GameStartInfo;

  constructor(game: GameOptions, agents: number) {
    this.clientIDs = Array.from({ length: agents }, (_, i) => `JEVAGNT${i + 1}`);
    this.start = {
      gameID: "OFFLINE01",
      lobbyCreatedAt: 0,
      config: gameConfig(game, GameType.Private),
      players: this.clientIDs.map((clientID, i) => ({
        clientID,
        username: USERNAMES[i] ?? `Jev${i + 1}`,
        clanTag: null,
        isLobbyCreator: i === 0,
      })),
    };
  }

  sender(clientID: string): (intent: Intent) => void {
    return (intent) => this.queue.push({ ...intent, clientID } as StampedIntent);
  }

  nextTurn(turnNumber: number) {
    const intents = this.queue;
    this.queue = [];
    return { turnNumber, intents };
  }
}

export async function runOffline(
  opts: SessionOptions & {
    game: GameOptions;
    // Wait for each in-flight step before the next tick (deterministic tests).
    lockstep?: boolean;
    realtime?: boolean;
    mapsDir?: string;
    fixedMapDir?: string;
  },
): Promise<SessionResult & { mirror: Mirror; agents: Agent[] }> {
  const relay = new LocalRelay(opts.game, opts.agents);
  const errors: string[] = [];
  const mirror = await Mirror.create(relay.start, relay.clientIDs[0], new FsMapLoader(opts.mapsDir, opts.fixedMapDir), {
    onError: (e) => errors.push(`sim error ${e.errMsg}`),
  });
  opts.onStart?.(relay.start);
  const agents = relay.clientIDs.map((clientID, i) => {
    return new Agent({
      name: relay.start.players[i].username,
      mirror: mirror.viewAs(clientID),
      jev: opts.jevFor(i),
      config: opts.config,
      bucket: new TokenBucket(opts.config.intentsPerMinute),
      send: relay.sender(clientID),
      trace: opts.trace,
      dryRun: opts.dryRun,
      log: opts.log,
      onEvent: opts.onEvent,
      strategy: opts.strategy,
    });
  });
  const maxTicks = opts.maxMinutes * 600;
  for (let turn = 0; turn < maxTicks; turn++) {
    const t0 = performance.now();
    mirror.addTurn(relay.nextTurn(turn));
    for (const a of agents) a.onTick();
    if (opts.lockstep) await Promise.all(agents.map((a) => a.pending));
    if (mirror.winner !== null) break;
    if (agents.every((a) => !a.summary().alive) && !mirror.game.inSpawnPhase() && mirror.ticks() > 400) break;
    const wait = opts.realtime ? Math.max(0, 100 - (performance.now() - t0)) : 0;
    // Yield so Jev responses can land between ticks.
    await new Promise((r) => setTimeout(r, wait));
  }
  await Promise.all(agents.map((a) => a.pending));
  return { gameID: relay.start.gameID, ticks: mirror.ticks(), summaries: agents.map((a) => a.summary()), errors, desyncs: 0, mirror, agents };
}
