// Clicks the stream can see. In the container, xdotool glides the real X
// pointer to the target and clicks (ffmpeg draws the pointer), so viewers
// watch the lobby pick and the Jev toggle happen. On the Mac path, CDP input
// events do the click and a drawn pointer in the page shows it.

import type { Cdp } from "./cdp";

export interface Pointer {
  click(x: number, y: number): Promise<void>;
  park(x: number, y: number): Promise<void>;
}

async function run(...args: string[]): Promise<string> {
  const p = Bun.spawn(["xdotool", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  if (code !== 0) throw new Error(`xdotool ${args.join(" ")}: ${err.trim()}`);
  return out;
}

export class XdotoolPointer implements Pointer {
  private async position(): Promise<{ x: number; y: number }> {
    const out = await run("getmouselocation", "--shell");
    const x = Number(/X=(\d+)/.exec(out)?.[1] ?? 0);
    const y = Number(/Y=(\d+)/.exec(out)?.[1] ?? 0);
    return { x, y };
  }

  // An eased glide, slow enough to follow on a stream.
  private async glide(x: number, y: number, ms = 700): Promise<void> {
    const from = await this.position();
    const steps = Math.max(8, Math.round(ms / 25));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await run("mousemove", String(Math.round(from.x + (x - from.x) * e)), String(Math.round(from.y + (y - from.y) * e)));
      await Bun.sleep(ms / steps);
    }
  }

  async click(x: number, y: number): Promise<void> {
    await this.glide(x, y);
    await Bun.sleep(250);
    await run("click", "1");
  }

  async park(x: number, y: number): Promise<void> {
    await this.glide(x, y, 500);
  }
}

// There's no OS pointer to film on the Mac path (the page itself is filmed),
// so the page gets a drawn one: an arrow that glides to the target and
// ripples on the click. It ignores events; the click itself is a CDP input
// event at the same spot.
const CURSOR = `(() => {
  let c = document.getElementById("jev-stream-cursor");
  if (!c) {
    c = document.createElement("div");
    c.id = "jev-stream-cursor";
    c.innerHTML = '<svg width="22" height="30" viewBox="0 0 22 30"><path d="M2 2 L2 24 L8 18 L12 28 L16 26 L12 16 L20 16 Z" fill="white" stroke="black" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none",
      transform: "translate(640px, 360px)", transition: "transform 0.7s cubic-bezier(0.45, 0, 0.55, 1)", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.5))" });
    (document.body ?? document.documentElement).append(c);
  }
  return c;
})()`;

export class CdpPointer implements Pointer {
  constructor(
    private readonly cdp: Cdp,
    private readonly page: string,
  ) {}

  private async glide(x: number, y: number, ms = 700): Promise<void> {
    await this.cdp.evaluate(
      this.page,
      `(() => { const c = ${CURSOR}; c.style.opacity = "1"; c.style.transitionProperty = "transform, opacity"; c.style.transitionDuration = "${ms}ms, 200ms";
        c.style.transform = "translate(${Math.round(x - 2)}px, ${Math.round(y - 2)}px)"; return true; })()`,
    );
    await Bun.sleep(ms + 100);
  }

  private async ripple(x: number, y: number): Promise<void> {
    await this.cdp.evaluate(
      this.page,
      `(() => { const r = document.createElement("div");
        Object.assign(r.style, { position: "fixed", left: "${Math.round(x - 18)}px", top: "${Math.round(y - 18)}px", width: "36px", height: "36px",
          borderRadius: "50%", border: "3px solid #53e3a6", zIndex: "2147483647", pointerEvents: "none", transition: "transform .45s ease-out, opacity .45s ease-out" });
        (document.body ?? document.documentElement).append(r);
        requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; });
        setTimeout(() => r.remove(), 600); return true; })()`,
    );
  }

  async click(x: number, y: number): Promise<void> {
    // The drawn pointer is cosmetic: never let it cost a click.
    await this.glide(x, y).catch(() => {});
    const session = await this.cdp.session(this.page);
    const base = { x, y, button: "left", clickCount: 1 };
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, session);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base }, session);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base }, session);
    await this.ripple(x, y).catch(() => {});
  }

  // Rest over a spot that isn't the map (the Jev panel): the real mouse goes
  // there too, or OpenFront keeps a hover card up for whatever tile the
  // camera slides under it. Then the drawn arrow fades out.
  async park(x: number, y: number): Promise<void> {
    await this.glide(x, y, 500).catch(() => {});
    const session = await this.cdp.session(this.page);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, session).catch(() => {});
    await Bun.sleep(1200);
    await this.cdp
      .evaluate(this.page, `(() => { const c = document.getElementById("jev-stream-cursor"); if (c) c.style.opacity = "0"; return true; })()`)
      .catch(() => {});
  }
}
