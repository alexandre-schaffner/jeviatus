import type { EntryType, Questions, SystemOneResult } from "@typesafe-ai/sdk";
import { buildAssetUrl } from "src/core/AssetUrls";
import type { ClientID, ServerMessage, Turn } from "src/core/Schemas";
import { FetchGameMapLoader } from "src/core/game/FetchGameMapLoader";
import { createGameWireContext, decodeServerMessage, encodeClientMessage } from "src/core/ZbinWire";
import { Agent } from "../../harness/agent";
import { DEFAULTS } from "../../harness/config";
import type { Jev } from "../../harness/jev/client";
import { runHeader } from "../../harness/log/format";
import { TokenBucket } from "../../harness/net/rateLimit";
import { Mirror } from "../../harness/sim/mirror";
import { BRIDGE, isPageMessage, type BridgeBootstrap, type BridgeHello, type BridgeSend } from "./protocol";
import { checkBuild, REPIN_COMMAND, short } from "./compat";
import { jevFailureStatus } from "./jevErrors";
import { ExtensionTraceSink } from "./traceSink";
import { OverlayPanel, type OverlayStatus } from "./overlayPanel";
import { PUBLIC_SETTINGS_DEFAULTS, type ExtensionSettings, normalizeSettings } from "./settings";

interface JevResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

class BackgroundJev implements Jev {
  private failing = false;

  constructor(
    private readonly onFailure: (message: string) => void,
    private readonly onRecover: () => void,
  ) {}

  async ask<const Q extends Questions>(_label: string, state: EntryType, questions: Q): Promise<SystemOneResult<Q>> {
    let response: JevResponse<SystemOneResult<Q>> | undefined;
    try {
      response = await chrome.runtime.sendMessage<JevResponse<SystemOneResult<Q>>>({ type: "jev:ask", state, questions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(message);
      throw error;
    }
    if (!response?.ok || response.result === undefined) {
      const message = response?.error ?? "Jev background request failed";
      this.fail(message);
      throw new Error(message);
    }
    if (this.failing) {
      this.failing = false;
      this.onRecover();
    }
    return response.result;
  }

  private fail(message: string): void {
    this.failing = true;
    this.onFailure(message);
  }
}

// With a matching codec every game-socket frame decodes, so a handful of
// failures after the start message is already a verdict. (Frames on non-game
// sockets, like the public lobby feed, fail before any start and don't count.)
const DECODE_FAILURE_LIMIT = 3;

class CapturedGame {
  private context: ReturnType<typeof createGameWireContext> | undefined;
  private clientID: ClientID | undefined;
  private mirror: Mirror | null = null;
  private agent: Agent | null = null;
  private queuedTurns: Turn[] = [];
  private generation = 0;
  private bootstrap: BridgeBootstrap | undefined;
  private blocked = false;
  private decodeFailures = 0;
  private trace: ExtensionTraceSink | null = null;
  private finished = false;
  // Set once the match starts: a reconnect (a new socket, same game) hands
  // this game's mirror over instead of starting from scratch.
  gameID: string | null = null;

  constructor(
    public socketId: number,
    private readonly jev: Jev,
    private readonly panel: OverlayPanel,
    private settings: ExtensionSettings,
    private readonly isEnabled: () => boolean,
  ) {}

  setBootstrap(bootstrap: BridgeBootstrap): void {
    this.bootstrap = bootstrap;
    this.panel.setBuild(__JEV_OPENFRONT_COMMIT__, bootstrap.gitCommit);
    const check = checkBuild(bootstrap.gitCommit, __JEV_OPENFRONT_COMMIT__, location.hostname);
    if (check === "mismatch") {
      // The wire format and sim are commit-specific: feeding this game's
      // frames into a foreign codec desyncs the mirror (it crashes ticks
      // later). Block instead.
      this.block({
        tone: "error",
        title: "OpenFront updated",
        detail: `This page runs ${short(bootstrap.gitCommit)}, the extension bundles ${short(__JEV_OPENFRONT_COMMIT__)}. Jev stays off until you rebuild.`,
        hint: REPIN_COMMAND,
      });
    } else if (check === "unverified") {
      // Not a block: the decode guard still catches a real mismatch. But a
      // silent pass here is how a stale bundle once went unnoticed.
      this.panel.show({
        tone: "warn",
        title: "Build not verified",
        detail: `The page did not report its OpenFront commit, so the bundled ${short(__JEV_OPENFRONT_COMMIT__)} could not be checked against it.`,
      });
    }
  }

  // Sticky until the socket closes: later status updates must not paint over
  // a stop condition.
  private block(status: OverlayStatus): void {
    this.blocked = true;
    console.error(`[Jev extension] ${status.title}: ${status.detail ?? ""}`);
    this.panel.block(status);
  }

  private idle(): OverlayStatus {
    return this.isEnabled()
      ? { tone: "idle", title: "Armed", detail: "Jev takes over when the match starts." }
      : { tone: "idle", title: "Off", detail: "Switch Jev on to let it play this match." };
  }

  decode(frame: ArrayBuffer): ServerMessage | null {
    if (this.blocked) return null;
    try {
      const message = decodeServerMessage(new Uint8Array(frame), this.context);
      if (message.type === "start") {
        this.context = createGameWireContext(message.gameStartInfo.players);
      }
      return message;
    } catch {
      // Frames on the page's non-game sockets (e.g. the public lobby feed)
      // legitimately fail the game codec. Only a game socket that has already
      // produced its start message can convict the codec.
      if (this.context !== undefined) {
        this.decodeFailures++;
        if (this.decodeFailures === DECODE_FAILURE_LIMIT) {
          const page = this.bootstrap?.gitCommit;
          this.block({
            tone: "error",
            title: "Can't read this game",
            detail: `The game server sends messages the bundled OpenFront ${short(__JEV_OPENFRONT_COMMIT__)} can't decode${page ? ` (page reports ${short(page)})` : ""}. It was most likely updated.`,
            hint: REPIN_COMMAND,
          });
        }
      }
      return null;
    }
  }

  accept(message: ServerMessage): void {
    if (this.blocked) return;
    if (message.type === "lobby_info") {
      this.clientID = message.myClientID;
      this.panel.show(this.idle());
      return;
    }
    if (message.type === "error") {
      const mismatch = message.error === "version_mismatch";
      this.block({
        tone: "error",
        title: mismatch ? "OpenFront updated" : "Server refused the game",
        detail: mismatch
          ? `The server runs ${short(message.gitCommit)}. Reload the page, then rebuild the extension if it bundles an older build.`
          : `${message.error}${message.gitCommit ? ` (server build ${short(message.gitCommit)})` : ""}`,
        hint: mismatch ? REPIN_COMMAND : undefined,
      });
      return;
    }
    if (message.type === "start") {
      this.clientID = message.myClientID ?? this.clientID;
      if (this.mirror !== null && this.gameID === message.gameStartInfo.gameID) this.resume(message);
      else void this.start(message);
      return;
    }
    if (message.type !== "turn") return;
    if (this.mirror === null) {
      this.queuedTurns.push(message.turn);
      return;
    }
    this.advance(this.mirror, message.turn);
  }

  reconfigure(settings: ExtensionSettings): void {
    const decisionShapeChanged =
      settings.decisionInterval !== this.settings.decisionInterval ||
      settings.minConfidence !== this.settings.minConfidence;
    this.settings = settings;
    if (decisionShapeChanged && this.mirror !== null) this.agent = this.createAgent(this.mirror);
    if (!this.isGameSocket() || this.blocked) return;
    this.panel.show(this.mirror === null ? this.idle() : this.playing());
  }

  // Every socket that carries frames gets a CapturedGame, the public lobby
  // feed included; only a real game socket may paint the panel.
  isGameSocket(): boolean {
    return this.clientID !== undefined || this.context !== undefined;
  }

  private playing(): OverlayStatus {
    return this.isEnabled()
      ? { tone: "ok", title: "Playing" }
      : { tone: "idle", title: "Watching", detail: "Jev is off. Its decisions are not sent." };
  }

  // The page's socket dropped mid-match. OpenFront reconnects on a new socket
  // and the server resends the start message with only the turns after the
  // client's last one (GameServer.rejoinClient), which can't rebuild a
  // mirror. Keep this one for the new socket instead. False: nothing worth
  // keeping (no match running), close as usual.
  detach(): boolean {
    return this.mirror !== null && this.gameID !== null && !this.finished;
  }

  rebind(socketId: number, bootstrap: BridgeBootstrap | undefined): void {
    this.socketId = socketId;
    if (bootstrap !== undefined) this.bootstrap = bootstrap;
  }

  private resume(message: Extract<ServerMessage, { type: "start" }>): void {
    this.context = createGameWireContext(message.gameStartInfo.players);
    this.trace?.write({ type: "reconnect", tick: this.mirror?.ticks() ?? null, resentTurns: message.turns.length });
    console.info(`[Jev extension] reconnected to ${message.gameStartInfo.gameID}; resuming at tick ${this.mirror?.ticks()}`);
    const mirror = this.mirror!;
    for (const turn of message.turns) this.advance(mirror, turn);
    this.panel.show(this.playing());
  }

  // The panel is shared by every socket: only a game socket may lift its own
  // stop condition (closing the lobby feed must not clear a game's error).
  close(): void {
    this.finish("socket closed");
    void this.trace?.close();
    this.trace = null;
    this.generation++;
    if (this.blocked && this.isGameSocket()) this.panel.unblock();
  }

  private async start(message: Extract<ServerMessage, { type: "start" }>): Promise<void> {
    if (this.clientID === undefined) {
      this.fail("Can't join as a player", "The game did not send this player's client ID, so Jev has no one to play as.");
      return;
    }
    const generation = ++this.generation;
    this.panel.show({ tone: "idle", title: "Loading map", detail: message.gameStartInfo.config.gameMap });
    try {
      const assets = this.bootstrap;
      const mapLoader = new FetchGameMapLoader((path) =>
        assets === undefined
          ? new URL(`/maps/${path}`, location.origin).href
          : buildAssetUrl(`maps/${path}`, assets.mapManifest ?? {}, assets.cdnBase ?? ""),
      );
      const mirror = await Mirror.create(message.gameStartInfo, this.clientID, mapLoader);
      if (generation !== this.generation) return;
      for (const turn of message.turns) mirror.addTurn(turn);
      for (const turn of this.queuedTurns.splice(0)) mirror.addTurn(turn);
      this.mirror = mirror;
      this.gameID = message.gameStartInfo.gameID;
      this.startTrace(message.gameStartInfo);
      this.agent = this.createAgent(mirror);
      this.panel.show(this.playing());
    } catch (error) {
      if (generation !== this.generation) return;
      console.error("[Jev extension] attach failed", error);
      this.fail("Couldn't replay the match", errorMessage(error));
    }
  }

  private advance(mirror: Mirror, turn: Turn): void {
    try {
      mirror.addTurn(turn);
      if (this.isEnabled()) this.agent?.onTick();
      if (mirror.winner !== null) this.finish("winner");
    } catch (error) {
      // A crashed mirror never recovers and its state can no longer be
      // trusted: surface it loudly and drop every later turn.
      console.error("[Jev extension] mirror error", error);
      this.fail("Lost track of the match", errorMessage(error));
    }
  }

  // The local simulation is gone for this game: stop feeding it (and stop
  // queueing turns for a mirror that will never exist).
  private fail(title: string, detail: string): void {
    this.trace?.write({ type: "error", tick: this.mirror?.ticks() ?? null, title, detail });
    this.finished = true; // the agent's state is no longer worth summarizing
    this.mirror = null;
    this.agent = null;
    this.queuedTurns = [];
    this.block({ tone: "error", title, detail: `${detail} Jev stays off for this game.` });
  }

  // One trace per game, same format as the CLI's (harness/log/format.ts).
  private startTrace(start: Extract<ServerMessage, { type: "start" }>["gameStartInfo"]): void {
    void this.trace?.close();
    this.finished = false;
    this.trace = new ExtensionTraceSink(start.gameID);
    const { decisionInterval, minConfidence } = this.settings;
    this.trace.write({
      ...runHeader(start, {
        source: "extension",
        model: this.settings.model,
        config: { decisionInterval, minConfidence, maxIntentsPerStep: DEFAULTS.maxIntentsPerStep, intentsPerMinute: DEFAULTS.intentsPerMinute, openfrontUrl: location.origin },
        strategy: this.settings.strategy,
        harnessCommit: __JEV_HARNESS_COMMIT__,
        openfrontCommit: __JEV_OPENFRONT_COMMIT__,
      }),
      pageCommit: this.bootstrap?.gitCommit ?? null,
    });
  }

  private finish(reason: string): void {
    if (this.finished || this.agent === null) return;
    this.finished = true;
    this.agent.finish(reason);
    void this.trace?.flush();
  }

  private createAgent(mirror: Mirror): Agent {
    return new Agent({
      name: "Jev",
      mirror,
      jev: this.jev,
      config: { ...this.settings, maxIntentsPerStep: DEFAULTS.maxIntentsPerStep },
      bucket: new TokenBucket(DEFAULTS.intentsPerMinute),
      canAct: this.isEnabled,
      trace: this.trace ?? undefined,
      send: (intent) => {
        if (this.context === undefined) return;
        const bytes = encodeClientMessage({ type: "intent", intent }, this.context);
        const frame = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const message: BridgeSend = {
          bridge: BRIDGE,
          direction: "extension-to-page",
          type: "send",
          socketId: this.socketId,
          frame,
        };
        window.postMessage(message, location.origin, [frame]);
      },
      log: (line) => console.info(`[Jev extension] ${line}`),
      onEvent: (event) => this.panel.decision(event),
      strategy: this.settings.strategy ?? undefined,
    });
  }
}

// Tick errors carry a multi-line stack; the panel needs the first line.
function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0]!.trim();
}

async function main(): Promise<void> {
  let settings = normalizeSettings(await chrome.storage.local.get(PUBLIC_SETTINGS_DEFAULTS));
  const panel = new OverlayPanel((enabled) => void chrome.storage.local.set({ enabled }));
  const games = new Map<number, CapturedGame>();
  const jev = new BackgroundJev((message) => {
    console.error(`[Jev extension] Jev request failed: ${message}`);
    const status = jevFailureStatus(message);
    // A dead extension context never recovers: keep that on screen.
    if (status?.title === "Extension reloaded") panel.block(status);
    else panel.show(status ?? { tone: "warn", title: "Jev request failed", detail: message });
  }, () => panel.show({ tone: "ok", title: "Playing" }));

  const applySettings = (next: ExtensionSettings) => {
    settings = next;
    panel.setEnabled(settings.enabled);
    if (![...games.values()].some((game) => game.isGameSocket())) {
      panel.show(
        settings.enabled
          ? { tone: "idle", title: "Armed", detail: "Join a multiplayer match. Jev takes over when it starts." }
          : { tone: "idle", title: "Off", detail: "Switch Jev on, then join a multiplayer match." },
      );
    }
    for (const game of games.values()) game.reconfigure(settings);
  };
  applySettings(settings);

  chrome.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName !== "local") return;
    void chrome.storage.local.get(PUBLIC_SETTINGS_DEFAULTS).then((value) => applySettings(normalizeSettings(value)));
  });

  const bootstraps = new Map<number, BridgeBootstrap>();
  const detached = new Map<string, { game: CapturedGame; expiry: ReturnType<typeof setTimeout> }>();
  const gameFor = (socketId: number): CapturedGame => {
    let game = games.get(socketId);
    if (game === undefined) {
      game = new CapturedGame(socketId, jev, panel, settings, () => settings.enabled);
      games.set(socketId, game);
    }
    return game;
  };
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin || !isPageMessage(event.data)) return;
    const message = event.data;
    if (message.type === "bootstrap") {
      bootstraps.set(message.socketId, message);
      gameFor(message.socketId).setBootstrap(message);
      return;
    }
    if (message.type === "socket-close") {
      const closed = games.get(message.socketId);
      games.delete(message.socketId);
      bootstraps.delete(message.socketId);
      if (closed?.detach() && closed.gameID !== null) {
        // Wait for the page to reconnect; give up (and summarize) if it doesn't.
        const gameID = closed.gameID;
        const expiry = setTimeout(() => {
          detached.delete(gameID);
          closed.close();
        }, 120_000);
        detached.set(gameID, { game: closed, expiry });
      } else closed?.close();
      return;
    }
    if (!(message.frame instanceof ArrayBuffer)) return;
    const game = gameFor(message.socketId);
    const decoded = game.decode(message.frame);
    if (decoded === null) return;
    // A reconnect: this socket's start names a game we're already mirroring.
    const resumed = decoded.type === "start" ? detached.get(decoded.gameStartInfo.gameID) : undefined;
    if (resumed !== undefined && decoded.type === "start") {
      clearTimeout(resumed.expiry);
      detached.delete(decoded.gameStartInfo.gameID);
      resumed.game.rebind(message.socketId, bootstraps.get(message.socketId));
      games.set(message.socketId, resumed.game);
      resumed.game.accept(decoded);
      return;
    }
    game.accept(decoded);
  });

  // Leaving the page (the stream heads home after each match) may never close
  // the game socket: summarize and flush the traces while we still can.
  window.addEventListener("pagehide", () => {
    for (const game of games.values()) game.close();
    for (const { game } of detached.values()) game.close();
  });

  const hello: BridgeHello = { bridge: BRIDGE, direction: "extension-to-page", type: "hello" };
  window.postMessage(hello, location.origin);
}

void main().catch((error: unknown) => console.error("[Jev extension] failed to initialize", error));
