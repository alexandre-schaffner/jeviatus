// A minimal Chrome DevTools Protocol client over the browser endpoint. The
// driver needs little: evaluate in the OpenFront page and in the extension's
// overlay frame, navigate, and (outside the container) inject clicks and film
// the page (stream/screencast.ts). Raw CDP keeps it to exactly those calls;
// nothing enables whole domains.

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  attached: boolean;
}

export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<string, string>(); // targetId -> sessionId
  private closedWith: Error | null = null;
  private readonly listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: unknown;
        sessionId?: string;
      };
      if (msg.id === undefined) {
        if (msg.method) for (const l of this.listeners.get(msg.method) ?? []) l(msg.params, msg.sessionId);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    ws.addEventListener("close", () => {
      this.closedWith = new Error("DevTools connection closed");
      for (const p of this.pending.values()) p.reject(this.closedWith);
      this.pending.clear();
    });
  }

  static async connect(port: number, timeoutMs = 30_000): Promise<Cdp> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl: string };
        const ws = new WebSocket(webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", () => reject(new Error("DevTools websocket failed")), { once: true });
        });
        return new Cdp(ws);
      } catch (err) {
        lastError = err;
        await Bun.sleep(500);
      }
    }
    throw new Error(`Chrome DevTools not reachable on port ${port}: ${String(lastError)}`);
  }

  // Protocol events (e.g. Page.screencastFrame); returns an unsubscribe.
  on<T>(method: string, listener: (params: T, sessionId?: string) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    const l = listener as (params: unknown, sessionId?: string) => void;
    set.add(l);
    return () => set.delete(l);
  }

  get closed(): boolean {
    return this.closedWith !== null;
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  async targets(): Promise<TargetInfo[]> {
    const { targetInfos } = await this.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    return targetInfos;
  }

  async session(targetId: string): Promise<string> {
    const known = this.sessions.get(targetId);
    if (known) return known;
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    this.sessions.set(targetId, sessionId);
    return sessionId;
  }

  forget(targetId: string): void {
    this.sessions.delete(targetId);
  }

  // Evaluates an expression and returns its JSON value (promises awaited).
  async evaluate<T = unknown>(targetId: string, expression: string, timeoutMs = 30_000): Promise<T> {
    const sessionId = await this.session(targetId);
    let res: { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    try {
      res = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sessionId, timeoutMs);
    } catch (err) {
      // A navigated-away or crashed target drops its session.
      this.forget(targetId);
      throw err;
    }
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    }
    return res.result.value as T;
  }

  close(): void {
    this.ws.close();
  }
}
