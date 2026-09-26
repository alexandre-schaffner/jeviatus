// Filming the page without an X server (STREAM_PLATFORM=mac): Chrome streams
// its own rendering over DevTools (Page.startScreencast: a JPEG each time the
// page repaints), and a steady clock hands ffmpeg the latest frame at the
// stream's fps, so the output stays constant-rate while the page sits idle.
// The page is pinned to the stream's size (Emulation.setDeviceMetricsOverride)
// so the window on screen can be any size, or behind other windows.

import type { Cdp } from "./cdp";

export interface ScreencastOptions {
  cdp: () => Cdp | null;
  width: number;
  height: number;
  fps: number;
  // Which page to film (the game, the lab).
  filmable: (url: string) => boolean;
  write: (jpeg: Uint8Array) => void;
  // After each batch of frames: the audio for the same span goes out with
  // them, so sound and picture share one clock.
  onFrames?: (frames: number) => void;
  log: (line: string) => void;
}

interface Frame {
  data: string;
  sessionId: number;
}

// Restart the screencast when it's been this quiet: a fresh start always
// sends a frame, so an idle page costs one restart per interval.
const STALE_MS = 5_000;

export class Screencast {
  private latest: Uint8Array | null = null;
  private lastFrameAt = 0;
  private session: string | null = null;
  private attachedTo: Cdp | null = null;
  private starting = false;
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly o: ScreencastOptions) {}

  start(): void {
    // Frame pacing by count, not by timer ticks, so jitter never drifts the
    // stream's clock away from real time.
    const t0 = performance.now();
    let sent = 0;
    this.timers.push(
      setInterval(() => {
        if (this.latest === null) return;
        const due = Math.floor(((performance.now() - t0) / 1000) * this.o.fps);
        // After a stall (sleep, a slow tick), skip ahead instead of bursting.
        if (due - sent > this.o.fps) sent = due - 1;
        const batch = due - sent;
        while (sent < due) {
          this.o.write(this.latest);
          sent++;
        }
        if (batch > 0) this.o.onFrames?.(batch);
      }, 1000 / this.o.fps / 2),
      setInterval(() => void this.ensure(), 1000),
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  private async ensure(): Promise<void> {
    const cdp = this.o.cdp();
    if (cdp === null || cdp.closed || this.starting) return;
    const fresh = cdp === this.attachedTo && this.session !== null && Date.now() - this.lastFrameAt < STALE_MS;
    if (fresh) return;
    this.starting = true;
    try {
      const pages = (await cdp.targets()).filter((t) => t.type === "page");
      const page = pages.find((t) => this.o.filmable(t.url)) ?? pages[0];
      if (!page) return;
      if (cdp !== this.attachedTo) {
        cdp.on<Frame>("Page.screencastFrame", (frame, sessionId) => {
          if (sessionId !== this.session) return;
          this.latest = Buffer.from(frame.data, "base64");
          this.lastFrameAt = Date.now();
          void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }, sessionId).catch(() => {});
        });
        this.attachedTo = cdp;
      }
      const session = await cdp.session(page.targetId);
      this.session = session;
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: this.o.width, height: this.o.height, deviceScaleFactor: 1, mobile: false },
        session,
      );
      await cdp.send("Page.stopScreencast", {}, session).catch(() => {});
      await cdp.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 85, maxWidth: this.o.width, maxHeight: this.o.height, everyNthFrame: 1 },
        session,
      );
      // Count the restart as a frame, so an idle page isn't restarted every tick.
      this.lastFrameAt = Math.max(this.lastFrameAt, Date.now() - STALE_MS / 2);
    } catch (err) {
      this.session = null;
      this.o.log(`[screencast] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.starting = false;
    }
  }
}
