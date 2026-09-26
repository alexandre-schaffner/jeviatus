// What the driver reads from and does to the OpenFront page and the Jev
// overlay inside it. Selectors come from the pinned client source
// (vendor/OpenFrontIO/src/client); everything is read through the page DOM,
// the same things a person looks at.

import type { Cdp } from "./cdp";

export interface PageSnapshot {
  url: string;
  commit: string | null;
  // The public lobby modal is open (waiting for the game to start).
  inLobby: boolean;
  lobbyStatus: string | null;
  // <game-starting-modal> up: the server sent prestart; the lobby modal has
  // closed but the match isn't running yet.
  starting: boolean;
  // <body class="in-game">: the match is running in this page.
  inGame: boolean;
  // <win-modal> title, when it is up ("You died", "X has won!", ...).
  winTitle: string | null;
  // #error-modal or an open <confirm-dialog>: kicked, crashed, disconnected,
  // or a refused lobby.
  error: string | null;
  // Cloudflare Turnstile asking for interaction (the driver never answers it).
  turnstileVisible: boolean;
  // Cloudflare's whole-page check ("Performing security verification")
  // instead of the site. The driver waits it out; it never solves it.
  challenge: boolean;
  // From the page's running game view, when there is one.
  game: { ticks: number; spawnPhase: boolean; spawned: boolean; alive: boolean } | null;
  ffaCard: { x: number; y: number; players: string } | null;
  // Google's ad-consent dialog (EU visitors), covering the page until answered.
  consentDecline: { x: number; y: number } | null;
}

export const SNAPSHOT = `(() => {
  const q = (s) => document.querySelector(s);
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const text = (el) => (el ? el.innerText.replace(/\\s+/g, " ").trim().slice(0, 240) : null);
  const winPanel = q("win-modal > div");
  const winOpen = !!winPanel && !winPanel.classList.contains("hidden");
  const lobby = q("#page-join-lobby");
  const dialog = [...document.body.children].find((el) => el.tagName === "CONFIRM-DIALOG");
  const errorModal = q("#error-modal");
  let game = null;
  try {
    const g = q("build-menu")?.game;
    if (g) {
      const me = g.myPlayer();
      game = { ticks: g.ticks(), spawnPhase: g.inSpawnPhase(), spawned: !!me?.hasSpawned(), alive: !!me?.isAlive() };
    }
  } catch {}
  let ffaCard = null;
  const selector = q("game-mode-selector");
  const hasFfa = !!selector?.lobbies?.games?.ffa?.[0];
  const card = hasFfa ? q("game-mode-selector button.group") : null;
  if (card && !card.disabled && card.getAttribute("aria-disabled") !== "true" && !card.querySelector('[data-trust="locked"]') && shown(card)) {
    const r = card.getBoundingClientRect();
    ffaCard = { x: r.left + r.width / 2, y: r.top + r.height / 2, players: text(card) };
  }
  const decline = q(".fc-consent-root .fc-cta-do-not-consent");
  const dr = decline?.getBoundingClientRect();
  const consentDecline = dr && dr.height > 0 ? { x: dr.left + dr.width / 2, y: dr.top + dr.height / 2 } : null;
  const turnstile = q("#turnstile-container iframe");
  return {
    url: location.href,
    commit: window.BOOTSTRAP_CONFIG?.gitCommit ?? null,
    inLobby: !!lobby && !lobby.classList.contains("hidden"),
    lobbyStatus: lobby && !lobby.classList.contains("hidden") ? text(lobby) : null,
    starting: !!q("game-starting-modal > div.visible"),
    inGame: document.body.classList.contains("in-game"),
    winTitle: winOpen ? text(q("win-modal h2")) : null,
    error: errorModal ? text(errorModal) : dialog ? text(dialog) : null,
    turnstileVisible: !!turnstile && shown(turnstile) && turnstile.getBoundingClientRect().height > 30,
    challenge: !q("game-mode-selector") && /security verification|just a moment|verify you are human/i.test(document.title + " " + (document.body?.innerText ?? "").slice(0, 400)),
    game,
    ffaCard,
    consentDecline,
  };
})()`;

// The FFA card can sit below the fold of a short viewport: bring it to the
// middle before measuring it for a click.
export const REVEAL_FFA_CARD = `(() => { const c = document.querySelector("game-mode-selector button.group");
  if (!c) return false; c.scrollIntoView({ block: "center", behavior: "instant" }); return true; })()`;

// Viewport → screen offset, for pointers that work in screen coordinates.
export const VIEWPORT_ORIGIN = `({ x: window.screenX + (window.outerWidth - window.innerWidth), y: window.screenY + (window.outerHeight - window.innerHeight) })`;

// Local settings a viewer would pick once: a clean stream view (no per-game
// tutorial panel, no corner Twitch player, no collusion reminder), audible
// game audio, and a name that says this player is an AI. Values per
// src/core/game/UserSettings.ts and the components that read them.
export function prepareStorage(username: string, audio: boolean): string {
  const now = new Date();
  const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const values: Record<string, string> = {
    username,
    usernameIsGenerated: "false",
    "settings.tutorialDismissed": "true",
    hasClosedCollusionWarning: "true",
    purchaseNudgeShown: "1",
    "featured-stream-closed": today,
    "settings.helpMessages": "false",
    "settings.goToPlayer": "true",
    "settings.lobbyIdVisibility": "false",
    "settings.steamLobbyLinks": "browser",
    "settings.audio.resetVersion": "1",
    "settings.audio.muteOnBlur": "false",
    "settings.audio.master": audio ? "0.6" : "0",
    "settings.audio.music": "0.5",
    "settings.audio.effects": "0.7",
    "settings.audio.alerts": "0.4",
  };
  return `(() => { const v = ${JSON.stringify(values)}; let changed = false;
    for (const [k, x] of Object.entries(v)) if (localStorage.getItem(k) !== x) { localStorage.setItem(k, x); changed = true; }
    return changed; })()`;
}

// OpenFront usernames: 3–20 of letters, digits, space, _ . - (src/core/validations/username.ts).
export function validUsername(name: string): boolean {
  return /^[\p{L}\d _.-]{3,20}$/u.test(name.trim());
}

// --- software WebGL -----------------------------------------------------------------

// The container has no GPU, so WebGL runs on the CPU (llvmpipe; see the
// Chromium flags in main.ts). OpenFront refuses
// software contexts (src/client/render/gl/initGL.ts): it asks for
// failIfMajorPerformanceCaveat and checks the renderer name, then shows a
// "Hardware acceleration is off" gate instead of the map. In the stream's own
// browser only, this runs before the page's scripts, drops that flag and
// masks the name, so the map renders on the CPU. It also caps animation at
// the stream's frame rate.
const STREAM_FPS_CAP = 30;
export const GPU_SHIM = `(() => {
  if (window.__jevGpuShim) return;
  window.__jevGpuShim = true;
  const UNMASKED_RENDERER = 0x9246;
  for (const C of [window.HTMLCanvasElement, window.OffscreenCanvas]) {
    if (!C) continue;
    const getContext = C.prototype.getContext;
    C.prototype.getContext = function (type, attrs) {
      if (attrs && attrs.failIfMajorPerformanceCaveat) attrs = { ...attrs, failIfMajorPerformanceCaveat: false };
      return getContext.call(this, type, attrs);
    };
  }
  for (const R of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!R) continue;
    const getParameter = R.prototype.getParameter;
    R.prototype.getParameter = function (p) {
      const v = getParameter.call(this, p);
      return p === UNMASKED_RENDERER && typeof v === "string" ? v.replace(/swiftshader|llvmpipe|software/gi, "cpu") : v;
    };
  }
  // The page animates at 60 fps; the stream films 30. On the CPU renderer the
  // extra frames cost ~2 cores that ffmpeg and the page need. Every callback
  // of an allowed frame runs; the frames in between are skipped.
  const FRAME_MS = 1000 / ${STREAM_FPS_CAP};
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  let seq = 0, openAt = -1, nextAt = 0;
  window.requestAnimationFrame = (cb) => {
    const id = ++seq;
    const run = (t) => {
      if (t !== openAt && t < nextAt) return pending.set(id, raf(run));
      if (t !== openAt) { openAt = t; nextAt = t + FRAME_MS - 4; }
      pending.delete(id);
      cb(t);
    };
    pending.set(id, raf(run));
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const inner = pending.get(id);
    if (inner !== undefined) caf(inner);
    pending.delete(id);
  };
})()`;

// Once per page session (a new session means Chromium restarted or the tab
// was replaced); it applies from the next navigation on.
const shimmed = new WeakMap<Cdp, Set<string>>();
export async function installGpuShim(cdp: Cdp, page: string): Promise<void> {
  const session = await cdp.session(page);
  const done = shimmed.get(cdp) ?? new Set<string>();
  shimmed.set(cdp, done);
  if (done.has(session)) return;
  await cdp.send("Page.enable", {}, session);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: GPU_SHIM }, session);
  done.add(session);
}

// --- the Jev overlay (an extension frame the content script injects) -------------

export async function overlayTarget(cdp: Cdp): Promise<string | null> {
  const t = (await cdp.targets()).find((x) => x.type === "iframe" && x.url.startsWith("chrome-extension://") && x.url.includes("/overlay.html"));
  return t?.targetId ?? null;
}

// Extension storage, written from the overlay frame (an extension page, so it
// has chrome.storage). The content script and background worker pick it up.
export async function setExtensionSettings(cdp: Cdp, overlay: string, settings: Record<string, unknown>): Promise<void> {
  await cdp.evaluate(overlay, `chrome.storage.local.set(${JSON.stringify(settings)}).then(() => true)`);
}

export async function extensionEnabled(cdp: Cdp, overlay: string): Promise<boolean> {
  return cdp.evaluate<boolean>(overlay, `chrome.storage.local.get({ enabled: false }).then((v) => v.enabled === true)`);
}

// The On/Off switch in the overlay header, in page viewport coordinates.
export async function togglePoint(cdp: Cdp, page: string, overlay: string): Promise<{ x: number; y: number; on: boolean } | null> {
  const frame = await cdp.evaluate<{ left: number; top: number } | null>(
    page,
    `(() => { const f = document.getElementById("jev-openfront-overlay"); if (!f) return null; const r = f.getBoundingClientRect(); return { left: r.left, top: r.top }; })()`,
  );
  if (frame === null) return null;
  const inner = await cdp.evaluate<{ x: number; y: number; on: boolean } | null>(
    overlay,
    `(() => { const w = document.getElementById("enablewrap"); if (!w || w.hidden) return null; const r = w.querySelector("i").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, on: document.getElementById("enabled").checked }; })()`,
  );
  return inner === null ? null : { x: frame.left + inner.x, y: frame.top + inner.y, on: inner.on };
}

export async function overlayStatus(cdp: Cdp, overlay: string): Promise<string> {
  return cdp.evaluate<string>(overlay, `document.getElementById("state")?.textContent ?? ""`);
}
