// A headless OpenFront game-socket client: join, ping, zbin framing, intents.
// Frames are zbin binary encoded with the vendored OpenFront commit, so this
// client only talks to a server built from the same commit.

import type {
  ClientMessage,
  Intent,
  ServerMessage,
} from "src/core/Schemas";
import {
  createGameWireContext,
  decodeServerMessage,
  encodeClientMessage,
} from "src/core/ZbinWire";

type ZbContext = ReturnType<typeof createGameWireContext>;

export interface JoinOptions {
  gameID: string;
  // A UUID; the dev server accepts it as the token and derives persistentID.
  token: string;
  username: string;
  // Dev servers run with GIT_COMMIT=DEV.
  gitCommit?: string;
}

type Listener = (msg: ServerMessage) => void;

export class GameSocket {
  private ws: WebSocket | null = null;
  private ctx: ZbContext | undefined = undefined;
  private listeners: Listener[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closeListeners: ((code: number, reason: string) => void)[] = [];
  bytesSent = 0;
  intentsSent = 0;

  constructor(private readonly url: string) {}

  onMessage(fn: Listener): void {
    this.listeners.push(fn);
  }

  onClose(fn: (code: number, reason: string) => void): void {
    this.closeListeners.push(fn);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        this.pingTimer = setInterval(() => this.send({ type: "ping", sentAt: Math.floor(performance.now()) }), 5_000);
        resolve();
      };
      ws.onerror = (e) => reject(new Error(`websocket error on ${this.url}: ${String((e as ErrorEvent).message ?? e)}`));
      ws.onclose = (e) => {
        this.stopPing();
        for (const fn of this.closeListeners) fn(e.code, e.reason);
      };
      ws.onmessage = (e) => {
        const bytes = new Uint8Array(e.data as ArrayBuffer);
        let msg: ServerMessage;
        try {
          msg = decodeServerMessage(bytes, this.ctx);
        } catch (err) {
          console.error(`[net] failed to decode ${bytes.byteLength}-byte frame:`, err);
          return;
        }
        if (msg.type === "start") {
          // Seed the clientID dictionary from the same roster, in the same
          // order, the server used (ZbinWire.ts).
          this.ctx = createGameWireContext(msg.gameStartInfo.players);
        }
        for (const fn of this.listeners) fn(msg);
      };
    });
  }

  join(opts: JoinOptions): void {
    this.send({
      type: "join",
      token: opts.token,
      gameID: opts.gameID,
      username: opts.username,
      clanTag: null,
      turnstileToken: null,
      gitCommit: opts.gitCommit ?? "DEV",
      platform: "web",
    });
  }

  sendIntent(intent: Intent): void {
    this.intentsSent++;
    this.send({ type: "intent", intent });
  }

  sendHash(turnNumber: number, hash: number): void {
    this.send({ type: "hash", turnNumber, hash });
  }

  send(msg: ClientMessage): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
    const frame = encodeClientMessage(msg, this.ctx);
    this.bytesSent += frame.byteLength;
    this.ws.send(frame);
  }

  close(): void {
    this.stopPing();
    this.ws?.close(1000, "done");
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
