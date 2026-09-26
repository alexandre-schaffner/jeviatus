import type { OverlayEvent } from "../../harness/overlay/events";

type StatusTone = "idle" | "ok" | "warn" | "error";

export interface OverlayStatus {
  tone: StatusTone;
  title: string;
  detail?: string;
  // A shell command that resolves the problem, rendered copyable.
  hint?: string;
}

interface OverlayControl {
  __jevOverlayControl: true;
  type: "ready" | "set-enabled" | "collapsed" | "size";
  enabled?: boolean;
  collapsed?: boolean;
  height?: number;
}

function isOverlayControl(value: unknown): value is OverlayControl {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<OverlayControl>).__jevOverlayControl === true &&
    typeof (value as Partial<OverlayControl>).type === "string"
  );
}

// OpenFront's own top-right HUD (timer, settings, fullscreen, exit) is ~40px
// tall: sit below it so it stays clickable.
const TOP = 52;
const MARGIN = 12;
const WIDTH = 340;
const CHIP = { width: 132, height: 36 } as const;

// Hosts harness/overlay/index.html as an extension-page iframe inside the
// OpenFront page: the same decision UI the harness serves, fed by postMessage
// instead of SSE. The iframe is sized to the panel's content (the overlay
// reports its height), so the game below it keeps receiving clicks; collapsed,
// it shrinks to a chip.
export class OverlayPanel {
  private readonly iframe: HTMLIFrameElement;
  private readonly origin: string;
  private ready = false;
  private enabled = false;
  private collapsed = false;
  private contentHeight = 120;
  private blocked: OverlayStatus | null = null;
  private pending: { event: string; data: unknown }[] = [];

  constructor(private readonly onSetEnabled: (enabled: boolean) => void) {
    // The page origin travels in the URL: document.referrer is empty for
    // chrome-extension iframe loads, and the overlay needs it to scope its
    // postMessage control channel back to this page.
    const url = `${chrome.runtime.getURL("overlay.html")}?host=${encodeURIComponent(location.origin)}`;
    this.origin = new URL(url).origin;
    this.iframe = document.createElement("iframe");
    this.iframe.id = "jev-openfront-overlay";
    this.iframe.title = "Jev decisions";
    this.iframe.allow = "clipboard-write";
    this.iframe.src = url;
    Object.assign(this.iframe.style, {
      position: "fixed",
      top: `${TOP}px`,
      right: `${MARGIN}px`,
      border: "0",
      zIndex: "2147483647",
      background: "transparent",
      colorScheme: "dark",
    });
    this.layout();
    (document.documentElement ?? document).append(this.iframe);
    window.addEventListener("resize", () => this.layout());

    window.addEventListener("message", (event: MessageEvent) => {
      if (event.origin !== this.origin || event.source !== this.iframe.contentWindow) return;
      if (!isOverlayControl(event.data)) return;
      const message = event.data;
      if (message.type === "ready") {
        this.ready = true;
        this.post("enabled", { enabled: this.enabled });
        for (const pending of this.pending.splice(0)) this.post(pending.event, pending.data);
      } else if (message.type === "set-enabled") {
        this.onSetEnabled(message.enabled === true);
      } else if (message.type === "collapsed") {
        this.collapsed = message.collapsed === true;
        this.layout();
      } else if (message.type === "size" && typeof message.height === "number") {
        this.contentHeight = message.height;
        this.layout();
      }
    });
  }

  private layout(): void {
    const max = Math.max(CHIP.height, window.innerHeight - TOP - MARGIN);
    const size = this.collapsed
      ? { width: `${CHIP.width}px`, height: `${CHIP.height}px` }
      : { width: `${WIDTH}px`, height: `${Math.min(Math.ceil(this.contentHeight), max)}px` };
    Object.assign(this.iframe.style, size);
  }

  private post(event: string, data: unknown): void {
    if (!this.ready) {
      // Keep only the newest status: an older one replayed later would lie.
      if (event === "status") this.pending = this.pending.filter((p) => p.event !== "status");
      if (this.pending.length < 100) this.pending.push({ event, data });
      return;
    }
    this.iframe.contentWindow?.postMessage({ __jevOverlay: true, event, data }, this.origin);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.post("enabled", { enabled });
  }

  setBuild(bundled: string, page: string | undefined): void {
    this.post("build", { bundled, page });
  }

  // Ignored while blocked: a stop condition stays on screen until the game it
  // belongs to is gone.
  show(status: OverlayStatus): void {
    if (this.blocked !== null) return;
    this.post("status", status);
  }

  block(status: OverlayStatus): void {
    this.blocked = status;
    this.post("status", status);
  }

  unblock(): void {
    this.blocked = null;
  }

  decision(event: OverlayEvent): void {
    this.post("decision", event);
  }
}
