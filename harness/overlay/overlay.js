// Jev decision overlay UI, shared by two transports:
//
// - Harness mode (http://localhost:<port>/ from harness/overlay/server.ts):
//   events arrive over SSE at /events, and a "game" event points the embedded
//   spectate iframe at the match.
// - Extension in-page mode (chrome-extension://<id>/overlay.html in an iframe
//   injected by the content script): the same events arrive via postMessage
//   from the content script, and the overlay posts control messages back
//   (enable on/off, collapse, content height) since the page itself is the game.
"use strict";

const inpage = location.protocol === "chrome-extension:";
// The injecting content script passes the page's origin as ?host= (referrer
// is empty for extension iframe loads).
const hostOrigin = inpage ? new URLSearchParams(location.search).get("host") : location.origin;
const toHost = (msg) => {
  if (inpage && window.top && hostOrigin) window.top.postMessage({ __jevOverlayControl: true, ...msg }, hostOrigin);
};

if (inpage) document.body.classList.add("inpage");

const $ = (id) => document.getElementById(id);
const pct = (p) => `${Math.round(p * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const human = (key) => String(key).replaceAll("_", " ");
const clock = (minutes) => {
  const total = Math.max(0, Math.round(minutes * 60));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

// Per-viewer conveniences; storage can be unavailable, and that must not break the panel.
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`jev.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`jev.${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

const agents = new Map();
// The reasoning details start open in the harness (a debugging view) and
// closed in-page (a glance while playing), then follow the viewer's choice.
let detailsOpen = store.get(inpage ? "detailsOpen.inpage" : "detailsOpen", !inpage);
let lastDecisionAt = 0;
let build = null;

// ── Status ────────────────────────────────────────────────────────────────

function setStatus(status) {
  // Harness status events are bare text.
  const s = typeof status?.text === "string" ? { tone: "idle", title: status.text } : status;
  const tone = s.tone ?? "idle";
  const alarm = tone === "warn" || tone === "error";
  $("statusblock").dataset.tone = tone;
  $("chip").dataset.tone = tone;
  $("state").textContent = s.title ?? "";
  $("chipstate").textContent = s.title ?? "";
  $("statedetail").textContent = alarm ? "" : s.detail ?? "";
  $("notice").hidden = !alarm;
  $("notice").dataset.tone = tone;
  $("noticetext").textContent = alarm ? s.detail ?? "" : "";
  $("hint").hidden = !(alarm && s.hint);
  $("hintcode").textContent = s.hint ?? "";
  // Decisions from before a stop condition are history, not the current state.
  $("agents").classList.toggle("stale", tone === "error");
  syncEmpty();
}

// The empty-state hint teaches the idle panel; next to a warning it is noise.
function syncEmpty() {
  $("empty").hidden = agents.size > 0 || !$("notice").hidden;
}

$("copyhint").addEventListener("click", async () => {
  const button = $("copyhint");
  try {
    await navigator.clipboard.writeText($("hintcode").textContent);
    button.textContent = "Copied";
  } catch {
    // Clipboard access can be refused inside the page; select it for Cmd+C.
    getSelection()?.selectAllChildren($("hintcode"));
    button.textContent = "Selected";
  }
  setTimeout(() => (button.textContent = "Copy"), 1500);
});

function renderBuild() {
  const el = $("build");
  const parts = [];
  if (build) {
    const bundled = build.bundled?.slice(0, 9) ?? "unknown";
    const page = build.page?.slice(0, 9);
    parts.push(`<span>OpenFront ${esc(bundled)}${page && page !== bundled ? ` · page ${esc(page)}` : ""}</span>`);
  }
  if (lastDecisionAt) {
    const age = Math.round((Date.now() - lastDecisionAt) / 1000);
    parts.push(`<span>${age < 2 ? "updated now" : `updated ${age}s ago`}</span>`);
  }
  el.innerHTML = parts.join("");
}
setInterval(renderBuild, 1000);

// ── Collapse and enable ───────────────────────────────────────────────────

function setCollapsed(collapsed) {
  document.body.classList.toggle("collapsed", collapsed);
  store.set("collapsed", collapsed);
  toHost({ type: "collapsed", collapsed });
  if (!collapsed) reportSize();
}
$("collapse").onclick = () => setCollapsed(true);
$("chip").onclick = () => setCollapsed(false);

function setEnabled(enabled) {
  $("enabled").checked = enabled;
  $("enabledlabel").textContent = enabled ? "On" : "Off";
  $("enablewrap").title = enabled ? "Jev is playing. Switch off to stop sending moves." : "Switch on to let Jev play.";
}
if (inpage) {
  $("enablewrap").hidden = false;
  $("enabled").addEventListener("change", () => {
    setEnabled($("enabled").checked);
    toHost({ type: "set-enabled", enabled: $("enabled").checked });
  });
}

// In-page, the host sizes the iframe to the panel so the game underneath
// keeps its clicks. Report the unclamped content height whenever it changes.
function reportSize() {
  if (!inpage || document.body.classList.contains("collapsed")) return;
  const panel = $("panel");
  const border = panel.offsetHeight - panel.clientHeight;
  toHost({ type: "size", height: $("content").offsetHeight + border });
}
new ResizeObserver(reportSize).observe($("content"));

// ── Decisions ─────────────────────────────────────────────────────────────

// Bars re-render every step; start each at its previous width so the change
// animates instead of jumping.
const prevWidth = new Map();
let renderAgent = "";
function fill(key, p, cls = "") {
  const k = `${renderAgent}|${key}`;
  const w = (Math.max(0, Math.min(1, p)) * 100).toFixed(1);
  const from = prevWidth.get(k) ?? "0";
  prevWidth.set(k, w);
  return `<div class="fill ${cls}" data-w="${w}" style="width:${from}%"></div>`;
}

const CAPS = { bars: 4, detailBars: 5, spec: 6, side: 6, threats: 4, recent: 5 };

function bars(dist, { held = false, max = CAPS.bars } = {}) {
  return dist.probs.slice(0, max).map((o) => {
    const chosen = o.key === dist.chosen;
    return `<div class="bar ${chosen ? "chosen" : ""} ${chosen && held ? "held" : ""}">
      <div class="track">${fill(`${dist.id}:${o.key}`, o.p)}<div class="opt">${esc(o.label)}</div></div>
      <div class="pct">${pct(o.p)}</div></div>`;
  }).join("");
}

function section(label, body, aside = "") {
  return `<div class="section"><div class="label"><span>${label}</span><span class="aside">${aside}</span></div>${body}</div>`;
}

const gatedTag = `<span class="tag gate" title="Counts toward the confidence gate">gated</span>`;

function vitals(me) {
  const cell = (value, label) => `<div class="vital"><b>${value}</b><span>${label}</span></div>`;
  return `<div class="vitals">
    ${cell(me.land_share !== undefined ? `${(me.land_share * 100).toFixed(1)}%` : "–", `land${me.land_rank ? ` · #${me.land_rank}` : ""}`)}
    ${cell(me.tiles !== undefined ? compact(me.tiles) : "–", "tiles")}
    ${cell(me.troops !== undefined ? compact(me.troops) : "–", `troops${me.troop_fill !== undefined ? ` · ${pct(me.troop_fill)}` : ""}`)}
    ${cell(me.gold !== undefined ? compact(me.gold) : "–", "gold")}
  </div>`;
}

function details(e) {
  const used = e.args.filter((a) => a.used);
  const spec = e.args.filter((a) => !a.used);
  const chosenOf = (a) => a.probs.find((o) => o.key === a.chosen);
  const parts = [
    ...used.map((a) =>
      section(`${esc(a.label)}${a.score !== undefined ? ` · E=${a.score.toFixed(2)}` : ""}`, bars(a, { held: e.held, max: CAPS.detailBars }), a.gated ? gatedTag : `<span class="tag">preference</span>`),
    ),
    e.goal?.dist ? section(`Goal`, bars(e.goal.dist, { max: CAPS.detailBars }), `remembered: ${esc(human(e.goal.current))}`) : "",
    spec.length
      ? section("Other answers", spec.slice(0, CAPS.spec).map((a) => `<div class="spec">${esc(a.label)}: <b>${esc(chosenOf(a)?.label ?? a.chosen)}</b> ${pct(chosenOf(a)?.p ?? 0)}</div>`).join(""), "not used this step")
      : "",
    e.side.length
      ? section("Side decisions", e.side.slice(0, CAPS.side).map((s) => {
          const yes = !["no", "ignore", "refuse"].includes(s.decision);
          return `<div class="bar ${yes ? "chosen" : ""}"><div class="track">${fill(`side:${s.label}`, s.p)}<div class="opt">${esc(s.label)} → ${esc(s.decision)}</div></div><div class="pct">${pct(s.p)}</div></div>`;
        }).join(""))
      : "",
    e.threats.length
      ? section("Threats", e.threats.slice(0, CAPS.threats).map((t) => `<div class="bar ${t.score >= 2 ? "hot" : ""}"><div class="track">${fill(`threat:${t.label}`, t.score / 3)}<div class="opt">${esc(t.label)}</div></div><div class="pct">${t.score.toFixed(1)}</div></div>`).join(""), "0–3")
      : "",
    e.recent.length
      ? section("Recent actions", `<ul class="log">${e.recent.slice(-CAPS.recent).reverse().map((r) => `<li><span class="t">${r.min}m</span>${esc(r.action)}${r.target ? ` ${esc(r.target)}` : ""} <span class="muted">${esc(r.outcome)}</span></li>`).join("")}</ul>`)
      : "",
    e.calls.length
      ? `<div class="calls">${e.calls.map((c) => `${esc(c.label)} ${c.latencyMs} ms${c.inputTokens ? ` · ${c.inputTokens.toLocaleString()} tok` : ""}`).join(" · ")}</div>`
      : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  const chevron = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>`;
  return `<details class="more" ${detailsOpen ? "open" : ""}><summary>${chevron}Reasoning</summary>${parts.join("")}</details>`;
}

function agentBlock(e) {
  renderAgent = e.agent;
  const me = e.me || {};
  const sent = e.intents.filter((i) => i.sent);
  const routeLabel = e.route ? e.route.probs.find((o) => o.key === e.route.chosen)?.label ?? human(e.route.chosen) : "–";
  const action = e.type === "spawn" ? "Spawn" : e.held ? "Hold" : routeLabel;
  const target = !e.held && sent[0] ? sent[0].desc.split(" ").slice(1).join(" ") : "";
  const conf = e.confidence ?? 0;
  const low = conf < e.threshold;
  return `<div class="agent">
    <div class="row"><span class="name">${agents.size > 1 ? esc(e.agent) : "Last decision"}</span><span class="meta" title="tick ${e.tick}, ${e.latencyMs} ms to decide">${clock(e.minutes)}${e.stage ? ` · ${esc(e.stage)} game` : ""} · ${e.latencyMs} ms</span></div>
    <div class="action">
      <span class="pill ${e.held ? "hold" : ""}">${esc(action.charAt(0).toUpperCase() + action.slice(1))}${target ? ` · ${esc(target)}` : ""}</span>
      ${e.held && e.holdReason ? `<span class="why" title="${esc(e.holdReason)}">${esc(e.holdReason)}</span>` : ""}
    </div>
    ${e.intents.length ? `<ul class="intents">${e.intents.map((i) => `<li class="${i.sent ? "" : "no"}"><span>${esc(i.desc)}</span>${i.reason ? `<span class="muted">${esc(i.reason)}</span>` : ""}</li>`).join("")}</ul>` : ""}
    ${vitals(me)}
    ${e.type !== "spawn" ? section("Confidence", `<div class="gauge">${fill("confidence", conf, low ? "low" : "")}<div class="mark" style="left:${(e.threshold * 100).toFixed(1)}%" title="Minimum ${e.threshold}"></div></div>`, `${conf.toFixed(2)} · needs ${e.threshold}`) : ""}
    ${e.route ? section("Action", bars(e.route, { held: e.held }), gatedTag) : ""}
    ${details(e)}
  </div>`;
}

function render() {
  const root = $("agents");
  root.innerHTML = [...agents.values()].map(agentBlock).join("");
  syncEmpty();
  for (const d of root.querySelectorAll("details.more")) {
    d.addEventListener("toggle", () => {
      detailsOpen = d.open;
      store.set(inpage ? "detailsOpen.inpage" : "detailsOpen", detailsOpen);
      for (const other of root.querySelectorAll("details.more")) if (other !== d) other.open = d.open;
    });
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const el of root.querySelectorAll(".fill[data-w]")) el.style.width = `${el.dataset.w}%`;
  }));
  renderBuild();
}

// ── Transport ─────────────────────────────────────────────────────────────

function dispatch(event, data) {
  if (event === "status") {
    setStatus(data);
  } else if (event === "game") {
    if (inpage) return; // the page itself is the game
    const f = $("game");
    if (f.src !== data.url) f.src = data.url;
    f.hidden = false;
    $("waiting").hidden = true;
  } else if (event === "decision") {
    agents.set(data.agent, data);
    lastDecisionAt = Date.now();
    render();
  } else if (event === "enabled") {
    setEnabled(!!data.enabled);
  } else if (event === "build") {
    build = data;
    renderBuild();
  }
}

if (store.get("collapsed", false)) setCollapsed(true);

if (inpage) {
  window.addEventListener("message", (ev) => {
    if (hostOrigin && ev.origin !== hostOrigin) return;
    if (ev.data?.__jevOverlay !== true) return;
    dispatch(ev.data.event, ev.data.data);
  });
  dispatch("status", { tone: "idle", title: "Attached" });
  toHost({ type: "ready" });
  reportSize();
} else {
  const es = new EventSource("/events");
  es.addEventListener("open", () => dispatch("status", { tone: "ok", title: "Connected" }));
  es.addEventListener("error", () => dispatch("status", { tone: "warn", title: "Disconnected", detail: "Reconnecting to the harness…" }));
  es.addEventListener("status", (m) => dispatch("status", JSON.parse(m.data)));
  es.addEventListener("game", (m) => dispatch("game", JSON.parse(m.data)));
  es.addEventListener("decision", (m) => dispatch("decision", JSON.parse(m.data)));
}
