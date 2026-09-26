// Live overlay: a page that shows the game (spectate view, in an iframe) with
// Jev's probabilities drawn on top, fed by Server-Sent Events.

import path from "node:path";
import type { OverlayEvent } from "./events";

const PAGE = path.join(import.meta.dir, "index.html");
const SCRIPT = path.join(import.meta.dir, "overlay.js");

export class OverlayServer {
  private readonly clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly latest = new Map<string, OverlayEvent>();
  private readonly enc = new TextEncoder();
  private gameUrl: string | null = null;

  constructor(readonly port: number) {}

  start(): void {
    Bun.serve({
      port: this.port,
      idleTimeout: 0, // SSE streams stay open
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/") return new Response(Bun.file(PAGE), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (url.pathname === "/overlay.js") return new Response(Bun.file(SCRIPT), { headers: { "content-type": "text/javascript; charset=utf-8" } });
        if (url.pathname === "/events") return this.stream();
        return new Response("not found", { status: 404 });
      },
    });
  }

  url(): string {
    return `http://localhost:${this.port}/`;
  }

  setGame(spectateUrl: string): void {
    this.gameUrl = spectateUrl;
    this.broadcast("game", { url: spectateUrl });
  }

  publish(e: OverlayEvent): void {
    this.latest.set(e.agent, e);
    this.broadcast("decision", e);
  }

  status(text: string): void {
    this.broadcast("status", { text });
  }

  private stream(): Response {
    let ctl: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctl = c;
        this.clients.add(c);
        if (this.gameUrl) c.enqueue(this.frame("game", { url: this.gameUrl }));
        for (const e of this.latest.values()) c.enqueue(this.frame("decision", e));
      },
      cancel: () => {
        this.clients.delete(ctl);
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  private frame(event: string, data: unknown): Uint8Array {
    return this.enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcast(event: string, data: unknown): void {
    const f = this.frame(event, data);
    for (const c of this.clients) {
      try {
        c.enqueue(f);
      } catch {
        this.clients.delete(c);
      }
    }
  }
}
