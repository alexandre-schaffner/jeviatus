// One public match after another, on camera: open openfront.io, apply the
// newest merged strategy, click into the public FFA lobby, flip the Jev switch in the
// overlay so viewers see it happen, then watch the match until it ends and go
// again. Every wait is bounded; any surprise sends the page home and retries.

import type { Ballot, GitHubBallot } from "./ballot";
import type { BandState } from "./band";
import type { Cdp } from "./cdp";
import type { TraceSinkServer } from "../harness/log/sink";
import type { StreamConfig } from "./config";
import {
  extensionEnabled,
  installGpuShim,
  overlayStatus,
  overlayTarget,
  type PageSnapshot,
  prepareStorage,
  REVEAL_FFA_CARD,
  SNAPSHOT,
  setExtensionSettings,
  togglePoint,
  VIEWPORT_ORIGIN,
} from "./openfront";
import type { Pointer } from "./pointer";
import { Director, framing, gotoExpression, SCENE, type Scene } from "./camera";
import type { Commentator } from "./commentator";
import { waitFor } from "./procs";

export interface DriverDeps {
  cfg: StreamConfig;
  cdp: () => Cdp;
  pointer: (page: string) => Pointer;
  ballot: GitHubBallot;
  band: (patch: Partial<BandState>) => void;
  log: (line: string) => void;
  bundledCommit: () => string | null;
  // Rebuild the extension for the page's commit and restart the browser.
  rebuild: (commit: string) => Promise<void>;
  // Where the extension logs each game; the driver adds its own read of the result.
  traces?: Pick<TraceSinkServer, "url" | "token" | "latest" | "annotate">;
  // The on-screen commentator follows the match through these.
  commentator?: Pick<Commentator, "newMatch" | "matchOver" | "observe" | "update">;
  // Live coding every few games (stream/lab.ts), shown on the lab page.
  lab?: { url: string; session: () => Promise<void> };
}

class Retry extends Error {
  constructor(
    message: string,
    readonly waitMs = 5_000,
  ) {
    super(message);
  }
}

const TICKS_PER_MIN = 600;

function clock(ticks: number): string {
  const s = Math.floor(ticks / 10);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class Driver {
  private ballotState: Ballot | null = null;
  private ballotAt = 0;
  private games = 0;
  private wins = 0;
  private failedRebuildFor: string | null = null;

  constructor(private readonly d: DriverDeps) {}

  private get cdp(): Cdp {
    return this.d.cdp();
  }

  async run(): Promise<never> {
    for (;;) {
      try {
        await this.match();
      } catch (err) {
        const wait = err instanceof Retry ? err.waitMs : 10_000;
        const msg = err instanceof Error ? err.message : String(err);
        this.d.log(`[driver] ${msg}; retrying in ${Math.round(wait / 1000)}s`);
        this.d.band({ status: err instanceof Retry ? msg : "Hiccup; getting back to the lobby list", clock: null, standing: null });
        await Bun.sleep(wait);
      }
    }
  }

  private async page(): Promise<string> {
    const pages = (await this.cdp.targets()).filter((t) => t.type === "page");
    const page = pages.find((t) => t.url.startsWith(this.d.cfg.openfrontUrl)) ?? pages[0];
    if (!page) {
      const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", { url: this.d.cfg.openfrontUrl });
      return targetId;
    }
    // A stray new tab (a keyboard shortcut, a crash-restore) backgrounds the
    // game's tab: it stops painting and ignores clicks. Close it, bring the game forward.
    for (const t of pages) {
      if (t.targetId !== page.targetId && /^(chrome:\/\/new-?tab|about:blank)/.test(t.url)) {
        await this.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      }
    }
    await this.cdp.send("Target.activateTarget", { targetId: page.targetId }).catch(() => {});
    return page.targetId;
  }

  private snapshot(page: string): Promise<PageSnapshot> {
    return this.cdp.evaluate<PageSnapshot>(page, SNAPSHOT, 10_000);
  }

  private async goHome(page: string): Promise<void> {
    const session = await this.cdp.session(page);
    await this.cdp.send("Page.navigate", { url: `${this.d.cfg.openfrontUrl}/` }, session);
    let snap: PageSnapshot | null = null;
    const loaded = await waitFor(async () => {
      snap = await this.snapshot(page);
      return !snap.inGame && !snap.challenge && snap.url.startsWith(this.d.cfg.openfrontUrl) && snap.ffaCard !== null;
    }, 30_000, 500);
    if (!loaded && (snap as PageSnapshot | null)?.challenge) throw new Retry("Cloudflare is checking this browser; trying again in a few minutes", 5 * 60_000);
    if (!loaded && !(snap as PageSnapshot | null)?.url.startsWith(this.d.cfg.openfrontUrl)) throw new Retry("openfront.io didn't load", 30_000);
  }

  private async screenPoint(page: string, x: number, y: number): Promise<{ x: number; y: number }> {
    if (this.d.cfg.pointer === "cdp") return { x, y };
    const o = await this.cdp.evaluate<{ x: number; y: number }>(page, VIEWPORT_ORIGIN);
    return { x: Math.round(o.x + x), y: Math.round(o.y + y) };
  }

  // EU visitors get Google's ad-consent dialog over the page, a few seconds
  // after load; it swallows clicks until answered. Answer it the privacy-
  // preserving way (the choice persists in the profile), then click.
  private async click(page: string, at: { x: number; y: number }): Promise<void> {
    let snap = await this.snapshot(page);
    if (snap.consentDecline) {
      this.d.log("[driver] declining the ad-consent dialog");
      const p = await this.screenPoint(page, snap.consentDecline.x, snap.consentDecline.y);
      await this.d.pointer(page).click(p.x, p.y);
      await waitFor(async () => (snap = await this.snapshot(page)).consentDecline === null, 5000, 250);
      await Bun.sleep(500);
    }
    const p = await this.screenPoint(page, at.x, at.y);
    await this.d.pointer(page).click(p.x, p.y);
  }

  private async refreshBallot(): Promise<void> {
    if (Date.now() - this.ballotAt < this.d.cfg.ballot.refreshSeconds * 1000) return;
    try {
      this.ballotState = await this.d.ballot.refresh();
      this.ballotAt = Date.now();
      for (const r of this.ballotState.rejected) this.d.log(`[ballot] PR #${r.number} isn't a proposal: ${r.reason}`);
      this.d.band({ ballot: this.ballotState });
    } catch (err) {
      // Keep the last good ballot; GitHub being down mustn't stop the stream.
      this.d.log(`[ballot] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      this.ballotAt = Date.now();
    }
  }

  private async match(): Promise<void> {
    const { cfg } = this.d;
    const page = await this.page();
    this.d.commentator?.update({ phase: "between" });
    await installGpuShim(this.cdp, page);
    this.d.band({ status: "Heading to openfront.io", clock: null, standing: null });
    await this.goHome(page);
    if (await this.cdp.evaluate<boolean>(page, prepareStorage(cfg.username, cfg.audio))) await this.goHome(page);

    // A new OpenFront release: rebuild before playing on it.
    const home = await this.snapshot(page);
    const bundled = this.d.bundledCommit();
    if (home.commit && bundled && home.commit !== bundled && /^[0-9a-f]{40}$/.test(home.commit)) {
      if (this.failedRebuildFor === home.commit) throw new Retry("OpenFront updated; Jev's rebuild failed, retrying soon", 10 * 60_000);
      this.d.band({ status: `OpenFront just shipped an update (${home.commit.slice(0, 7)}): rebuilding Jev for it` });
      try {
        await this.d.rebuild(home.commit);
        this.failedRebuildFor = null;
      } catch (err) {
        this.failedRebuildFor = home.commit;
        throw err;
      }
      throw new Retry("Jev rebuilt for the new OpenFront release", 3_000);
    }

    let overlay: string | null = null;
    await waitFor(async () => (overlay = await overlayTarget(this.cdp)) !== null, 20_000, 500);
    if (overlay === null) throw new Retry("the Jev overlay didn't appear", 15_000);

    await this.refreshBallot();
    // The newest strategy the maintainer merged.
    const entry = this.ballotState?.live ?? null;
    this.d.band({ playing: entry });
    await setExtensionSettings(this.cdp, overlay, {
      apiKey: cfg.typesafeApiKey,
      model: cfg.model,
      enabled: false,
      strategy: entry?.strategy ?? null,
      traceUrl: this.d.traces?.url ?? "",
      traceToken: this.d.traces?.token ?? "",
    });
    this.d.log(`[driver] next game plays ${entry ? `"${entry.strategy.name}" (${entry.file}, merged from PR #${entry.number} by @${entry.author})` : "Jev's own judgment"}`);

    // Pick the public FFA lobby.
    this.d.band({ status: "Finding the next public free-for-all lobby" });
    let snap = home;
    const found = await waitFor(async () => (snap = await this.snapshot(page)).ffaCard !== null, 90_000, 1000);
    if (!found || snap.ffaCard === null) throw new Retry("no joinable public FFA lobby right now", 20_000);
    await this.cdp.evaluate(page, REVEAL_FFA_CARD);
    await Bun.sleep(400);
    snap = await this.snapshot(page);
    if (snap.ffaCard === null) throw new Retry("the FFA lobby card went away", 5_000);
    await this.click(page, snap.ffaCard);

    const joined = await waitFor(async () => {
      snap = await this.snapshot(page);
      return snap.inLobby || snap.starting || snap.inGame || snap.error !== null || snap.turnstileVisible;
    }, 20_000, 500);
    if (snap.turnstileVisible) throw new Retry("Cloudflare wants a human check before joining; trying again in a few minutes", 5 * 60_000);
    if (!joined || snap.error) throw new Retry(`couldn't join the lobby${snap.error ? `: ${snap.error}` : ""}`, 15_000);

    // The showcase: flip Jev on in its own overlay, on camera.
    this.d.band({ status: "In the lobby. Switching Jev on" });
    await Bun.sleep(1500);
    await this.switchOn(page, overlay);
    this.d.commentator?.newMatch(entry?.strategy.name ?? null);
    this.d.band({ status: "Jev is armed. Waiting for the match to start" });

    // Lobby → (prestart modal) → in game. The modals hand over with gaps, so
    // only a lobby that stays gone counts as closed.
    let goneSince: number | null = null;
    const started = await waitFor(async () => {
      snap = await this.snapshot(page);
      if (snap.lobbyStatus) this.d.band({ status: `Jev is armed. ${snap.lobbyStatus.replace(/^.*?(Starting in|Waiting for players|Started)/, "$1").slice(0, 80)}` });
      if (snap.starting) this.d.band({ status: "Jev is armed. The match is starting" });
      const waiting = snap.inLobby || snap.starting;
      goneSince = waiting || snap.inGame ? null : (goneSince ?? Date.now());
      return snap.inGame || snap.error !== null || (goneSince !== null && Date.now() - goneSince > 8000);
    }, cfg.lobbyTimeoutSeconds * 1000, 1000);
    if (!snap.inGame) throw new Retry(snap.error ? `lobby closed: ${snap.error}` : started ? "the lobby closed before the match started" : "the match never started", 5_000);

    const tracedBefore = this.d.traces?.latest() ?? null;
    const startedAt = Date.now();
    const result = await this.watch(page, overlay);
    this.games++;
    if (/JEV WON/.test(result)) this.wins++;
    this.d.log(`[driver] game ${this.games} over: ${result}`);
    this.d.commentator?.matchOver(result, this.games);
    this.annotate(tracedBefore, { type: "stream_result", result, strategy: entry?.strategy ?? null, pr: entry?.number ?? null, wallMs: Date.now() - startedAt });
    this.d.band({ games: this.games, wins: this.wins, lastResult: result, status: `Match over: ${result}`, clock: null, standing: null });
    await Bun.sleep(4000);
    if (this.d.lab && cfg.lab && this.games % cfg.lab.everyGames === 0) await this.labSession(page);
  }

  // Cut to the lab page for a coding session; the next match starts from the homepage as usual.
  private async labSession(page: string): Promise<void> {
    const lab = this.d.lab!;
    this.d.commentator?.update({ phase: "lab", camera: null });
    const session = await this.cdp.session(page);
    await this.cdp.send("Page.navigate", { url: lab.url }, session);
    try {
      await lab.session();
    } finally {
      this.d.commentator?.update({ phase: "between" });
    }
  }

  // The page's own verdict (JEV WON / eliminated / never spawned), next to the
  // harness summary in this game's trace. Only if this game posted a trace:
  // "latest" alone could still be the previous game.
  private annotate(tracedBefore: string | null, event: Record<string, unknown>): void {
    const traces = this.d.traces;
    if (traces === undefined) return;
    const gameID = traces.latest();
    if (gameID === null || gameID === tracedBefore) {
      this.d.log("[trace] this game left no trace to annotate");
      return;
    }
    traces.annotate(gameID, event);
  }

  private async switchOn(page: string, overlay: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const point = await togglePoint(this.cdp, page, overlay);
      if (point?.on) return;
      if (point !== null) {
        await this.click(page, point);
        if (await waitFor(() => extensionEnabled(this.cdp, overlay), 3000)) {
          // Rest on OpenFront's clock bar (top right): off Jev's panel (its
          // tooltip would cover the decisions) and off the map (OpenFront
          // shows a hover card for whatever tile the camera slides under it).
          const spot = await this.cdp.evaluate<{ x: number; y: number }>(
            page,
            `(() => { const r = document.querySelector("game-right-sidebar")?.getBoundingClientRect();
              return r && r.width > 0 ? { x: r.left + 24, y: r.top + 18 } : { x: innerWidth - 150, y: 18 }; })()`,
          );
          const rest = await this.screenPoint(page, spot.x, spot.y);
          await this.d.pointer(page).park(rest.x, rest.y);
          return;
        }
      }
      await Bun.sleep(1000);
    }
    // The switch didn't take a click: don't lose the game over it.
    this.d.log("[driver] the overlay switch didn't respond; enabling Jev through settings");
    await setExtensionSettings(this.cdp, overlay, { enabled: true });
  }

  private async watch(page: string, overlay: string): Promise<string> {
    const { cfg } = this.d;
    const startedAt = Date.now();
    let deadAt: number | null = null;
    let wonAt: number | null = null;
    let result = "left the match";
    const director = new Director();
    let aimed: { key: string; x: number; y: number; scale: number } | null = null;
    for (;;) {
      await Bun.sleep(2000);
      const snap = await this.snapshot(page);
      if (snap.error) return `disconnected (${snap.error.slice(0, 60)})`;
      if (!snap.inGame) return result;
      const g = snap.game;
      const t = g ? clock(g.ticks) : "";
      if (snap.winTitle && /died/i.test(snap.winTitle) && deadAt === null) {
        deadAt = Date.now();
        result = `eliminated at ${t}`;
      } else if (snap.winTitle && /won|cancel/i.test(snap.winTitle) && wonAt === null) {
        wonAt = Date.now();
        result = /you won/i.test(snap.winTitle) ? `JEV WON at ${t}` : `${snap.winTitle} (Jev ${deadAt ? "out" : "survived"})`;
      }
      if (wonAt !== null && Date.now() - wonAt > 20_000) return result;
      if (deadAt !== null && Date.now() - deadAt > cfg.spectateAfterDeathSeconds * 1000) return result;
      if (g && !g.spawnPhase && !g.spawned && g.ticks > 2 * TICKS_PER_MIN) return "never spawned";
      if (Date.now() - startedAt > cfg.maxGameMinutes * 60_000) return `time limit (${t})`;

      let jev = "";
      try {
        jev = await overlayStatus(this.cdp, overlay);
      } catch {
        // the overlay frame can briefly detach; the band just skips it
      }
      const phase = g?.spawnPhase ? "picking a spawn" : deadAt ? "eliminated, spectating" : "playing";
      // The strategy has its own row on the band: the caption is what's on camera.
      let caption = `Jev is ${phase} a public free-for-all`;
      let standing: string | null = g?.spawnPhase ? "picking a spawn" : deadAt ? "out, spectating" : null;
      const commentator = this.d.commentator;
      commentator?.update({ clock: t });
      if (cfg.camera || commentator) {
        try {
          const scene = await this.cdp.evaluate<Scene>(page, SCENE, 5_000);
          const shot = cfg.camera ? director.next(scene, Date.now()) : null;
          commentator?.observe(scene, shot?.caption ?? null);
          if (shot) {
            const f = framing(shot, scene);
            // Re-aim only when the shot changed or its subject moved: every
            // goto restarts the client's easing.
            const moved = !aimed || aimed.key !== shot.key || Math.hypot(aimed.x - f.x, aimed.y - f.y) > 8 || Math.abs(aimed.scale - f.scale) / aimed.scale > 0.15;
            if (moved && (await this.cdp.evaluate<boolean>(page, gotoExpression(f, f.scale)))) aimed = { key: shot.key, ...f };
            caption = shot.caption;
          }
          const me = scene.me;
          if (me && scene.phase === "alive") standing = `#${me.rank} of ${me.players}  ·  ${me.landPct.toFixed(1)}% land`;
        } catch (err) {
          this.d.log(`[camera] ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        }
      }
      this.d.band({ status: `${caption}${jev && jev !== "Playing" ? `  ·  Jev: ${jev}` : ""}`, clock: t || null, standing });
    }
  }
}
