// Kick chat, read-only: the channel's public chatroom over Kick's Pusher
// websocket (the same feed kick.com's own chat uses; no login, no key). The
// commentator answers from it on stream; nothing is ever posted back.

export interface ChatMessage {
  id: string;
  user: string;
  text: string;
  at: number;
}

// Kick's public Pusher app (kick.com's web client).
const PUSHER = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false";

// "[emote:37226:KEKW]" → "KEKW"; control/bidi characters out; one line.
export function cleanChat(text: string): string {
  return text
    .replace(/\[emote:\d+:([^\]]*)\]/g, "$1")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function chatroomId(channel: string): Promise<number> {
  const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`kick.com/api/v2/channels/${channel}: HTTP ${res.status}`);
  const id = ((await res.json()) as { chatroom?: { id?: unknown } }).chatroom?.id;
  if (typeof id !== "number") throw new Error(`Kick channel ${channel} has no chatroom`);
  return id;
}

export class KickChat {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 2_000;

  constructor(
    private readonly channel: string,
    private readonly onMessage: (m: ChatMessage) => void,
    private readonly log: (line: string) => void,
  ) {}

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private retry(why: string): void {
    if (this.stopped) return;
    this.log(`[chat] ${why}; reconnecting in ${Math.round(this.retryMs / 1000)}s`);
    setTimeout(() => void this.connect(), this.retryMs);
    this.retryMs = Math.min(60_000, this.retryMs * 2);
  }

  private async connect(): Promise<void> {
    let room: number;
    try {
      room = await chatroomId(this.channel);
    } catch (err) {
      return this.retry(err instanceof Error ? err.message : String(err));
    }
    const ws = new WebSocket(PUSHER);
    this.ws = ws;
    let ping: ReturnType<typeof setInterval> | null = null;
    ws.onmessage = (e) => {
      let m: { event?: string; data?: string };
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.event === "pusher:connection_established") {
        ws.send(JSON.stringify({ event: "pusher:subscribe", data: { auth: "", channel: `chatrooms.${room}.v2` } }));
        ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ event: "pusher:ping", data: {} })), 60_000);
      } else if (m.event === "pusher_internal:subscription_succeeded") {
        this.retryMs = 2_000;
        this.log(`[chat] reading kick.com/${this.channel} chat`);
      } else if (m.event === "App\\Events\\ChatMessageEvent" && m.data) {
        try {
          const d = JSON.parse(m.data) as { id?: string; content?: string; sender?: { username?: string } };
          const text = cleanChat(d.content ?? "");
          const user = cleanChat(d.sender?.username ?? "");
          if (text && user) this.onMessage({ id: d.id ?? crypto.randomUUID(), user, text, at: Date.now() });
        } catch {
          // a malformed event; skip it
        }
      }
    };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      if (this.ws === ws) this.retry("chat connection closed");
    };
    ws.onerror = () => ws.close();
  }
}
