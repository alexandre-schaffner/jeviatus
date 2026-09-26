import { gsap } from "gsap";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { type Prompt, source } from "./source.ts" with { type: "macro" };
import { categoryUrl, forumLive, latestTopics, proposals, proposalUrl, readSpace, relativeTime, spaceUrl, topicUrl } from "./gov.ts";
import { TerritoryMap } from "./territory.ts";
import { CAMERA, EXAMPLE, EXAMPLE_ROUTE_P, commitFraction, fitBox, renderTree, type Stage } from "./tree.ts";
import { $, $$, esc, groupQuestions } from "./ui.ts";

gsap.registerPlugin(ScrollTrigger, DrawSVGPlugin);

const SRC = source();
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const pct = (n: number) => `${Math.round(n * 100)}%`;

// Prompt text: backticked state paths get their own styling.
const rich = (s: string) => esc(s).replace(/`([^`]+)`/g, '<span class="tick">$1</span>');

const blob = (line?: number) => `${SRC.repo}/blob/main/${SRC.file}${line ? `#L${line}` : ""}`;
const editor = (id?: string) => `./editor${id ? `?q=${encodeURIComponent(id)}` : ""}`;

// ---------- Facts from the source ----------

function fillFacts(): void {
  const c = SRC.constants;
  const seconds = (c.decisionInterval ?? 15) / 10;
  const facts: Record<string, string> = {
    interval: `${seconds} ${seconds === 1 ? "second" : "seconds"}`,
    routeCount: String(Object.keys(SRC.routes).length),
    goalCount: String(Object.keys(SRC.goals).length),
    minConfidence: String(c.minConfidence),
    fallback: pct(c.FALLBACK_MIN_P ?? 0.15),
    finishCap: pct(c.FINISH_CAP ?? 0.75),
    finishCapRaw: String(c.FINISH_CAP),
    underAttack: String(c.FINISH_CAP_UNDER_ATTACK),
    underAttackNext: String(Math.round(((c.FINISH_CAP_UNDER_ATTACK ?? 0.5) - 0.1) * 100) / 100),
    promptCount: String(Object.keys(SRC.prompts).length),
  };
  for (const el of $$("[data-src]")) {
    const v = facts[el.dataset.src!];
    if (v !== undefined) el.textContent = v;
  }
  const sha = $("[data-sha]");
  if (sha && SRC.sha) sha.innerHTML = `, commit <a href="${SRC.repo}/commit/${SRC.sha}"><code>${esc(SRC.sha)}</code></a>`;
  const model = $("[data-model]");
  if (model && SRC.model) model.textContent = ` (${SRC.model})`;
  const foot = $("[data-footer-sha]");
  if (foot) foot.textContent = SRC.sha ? `Prompts quoted from ${SRC.file} at ${SRC.sha}.` : `Prompts quoted from ${SRC.file}.`;
}

// ---------- Prompt rendering ----------

function considerList(items: string[]): string {
  return `<ul>${items.map((s) => `<li>${rich(s)}</li>`).join("")}</ul>`;
}

function renderQuote(el: HTMLElement): void {
  const p = SRC.prompts[el.dataset.quote!];
  if (!p) return el.remove();
  const limit = Number(el.dataset.limit ?? 3);
  const shown = p.consider.slice(0, limit);
  const more = p.consider.length - shown.length;
  el.innerHTML =
    (p.premise ? `<p class="quote-premise">${rich(p.premise)}</p>` : "") +
    `<p class="quote-q">${rich(p.question)}</p>` +
    (shown.length ? `<p class="quote-label">consider</p>${considerList(shown)}` : "") +
    `<button class="quote-more" type="button" data-open="${esc(p.id)}">${more > 0 ? `Read all ${p.consider.length} hints` : "Read the full prompt"}</button>`;
}

function promptBody(p: Prompt): string {
  const parts: string[] = [];
  if (p.premise) parts.push(`<p>${rich(p.premise)}</p>`);
  if (p.context) parts.push(`<p>${rich(p.context)}</p>`);
  if (p.rules) parts.push(`<p>${rich(p.rules)}</p>`);
  if (p.consider.length) parts.push(`<p class="quote-label">consider</p><ul class="dialog-list">${p.consider.map((s) => `<li>${rich(s)}</li>`).join("")}</ul>`);
  if (p.levels?.length) parts.push(`<p class="quote-label">answer levels</p><ul class="dialog-list">${p.levels.map((s) => `<li>${rich(s)}</li>`).join("")}</ul>`);
  if (p.options) parts.push(`<p class="quote-label">options</p><ul class="dialog-list">${Object.entries(p.options).map(([k, v]) => `<li><b>${esc(k)}</b>: ${rich(v)}</li>`).join("")}</ul>`);
  if (p.id === "route") parts.push(`<p class="quote-label">routes</p><ul class="dialog-list">${Object.entries(SRC.routes).map(([k, v]) => `<li><b>${esc(k)}</b>: ${rich(v)}</li>`).join("")}</ul>`);
  if (p.id === "goal") parts.push(`<p class="quote-label">goals</p><ul class="dialog-list">${Object.entries(SRC.goals).map(([k, v]) => `<li><b>${esc(k)}</b>: ${rich(v)}</li>`).join("")}</ul>`);
  if (!p.consider.length && !p.levels && !p.options && p.kind === "choice" && p.id !== "route" && p.id !== "goal") {
    parts.push(`<p class="small">Code builds its options every step from the players and sites that are legal right now.</p>`);
  }
  return parts.join("");
}

const dialog = $<HTMLDialogElement>("[data-dialog]")!;
function openPrompt(id: string): void {
  const body = $("[data-dialog-body]", dialog)!;
  if (id === "role") {
    body.innerHTML =
      `<div class="dialog-inner"><p class="dialog-meta">role <span>· ${esc(SRC.file)}</span></p>` +
      `<h2>The role most questions open with</h2><p>${rich(SRC.role)}</p>` +
      `<p class="small">The state object it points at (<span class="tick">me</span>, <span class="tick">players</span>, <span class="tick">game</span>, <span class="tick">memory</span>) is rebuilt from the simulation every step.</p>` +
      `<p class="dialog-links"><a href="${blob()}">View on GitHub ↗</a></p></div>`;
  } else {
    const p = SRC.prompts[id];
    if (!p) return;
    body.innerHTML =
      `<div class="dialog-inner"><p class="dialog-meta">${esc(p.id)} <span>· ${p.kind} · line ${p.line}</span></p>` +
      `<h2>${rich(p.question || "(question built per step)")}</h2>${promptBody(p)}` +
      `<p class="dialog-links"><a href="${editor(p.id)}">Rewrite it in the editor</a><a href="${blob(p.line)}">View line ${p.line} on GitHub ↗</a></p></div>`;
  }
  dialog.showModal();
  dialog.scrollTop = 0;
}
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});
document.addEventListener("click", (e) => {
  const t = (e.target as Element).closest<HTMLElement>("[data-open]");
  if (t) openPrompt(t.dataset.open!);
});

// ---------- Tree stage artifacts ----------

function renderArtifacts(): void {
  const bars = $("[data-route-bars]");
  if (bars) {
    const rows = Object.keys(SRC.routes)
      .map((r) => [r, EXAMPLE_ROUTE_P[r] ?? 0] as const)
      .sort((a, b) => b[1] - a[1]);
    bars.innerHTML = rows
      .map(([r, p], i) => `<div class="bar-row${i === 0 ? " is-pick" : ""}"><span>${esc(r)}</span><span class="bar-track"><span class="bar-fill" style="transform:scaleX(${p})" data-p="${p}"></span></span><span>${p.toFixed(2)}</span></div>`)
      .join("");
  }

  const levels = $("[data-levels]");
  const commit = SRC.commit.ATTACK_COMMIT;
  const lv = SRC.prompts.attack_commit?.levels;
  if (levels && commit && lv) {
    levels.style.setProperty("--n", String(lv.length));
    const frac = commitFraction(EXAMPLE.commitScore, commit);
    const at = ((EXAMPLE.commitScore + 0.5) / lv.length) * 100;
    levels.innerHTML =
      lv.map((text, i) => {
        const [name, ...rest] = text.split(":");
        return `<div class="level"><b>${esc(name)}</b>${esc(rest.join(":").trim())}<span>${pct(commit[i])}</span></div>`;
      }).join("") + `<p class="level-marker" style="--at:${at}%">expected ${EXAMPLE.commitScore} → ${pct(frac)}</p>`;
  }

  const gate = $("[data-gate]");
  if (gate) {
    const min = Math.min(EXAMPLE.routeConfidence, EXAMPLE.targetConfidence);
    gate.innerHTML =
      `<span class="gate-chip${EXAMPLE.routeConfidence === min ? " is-min" : ""}">route ${EXAMPLE.routeConfidence}</span>` +
      `<span class="gate-chip${EXAMPLE.targetConfidence === min ? " is-min" : ""}">attack_target ${EXAMPLE.targetConfidence}</span>` +
      `<span class="gate-op">min ${min} ≥ ${SRC.constants.minConfidence}</span><span class="gate-pass">act</span>`;
  }

  const intents = $("[data-intents]");
  if (intents && commit) {
    const asked = commitFraction(EXAMPLE.commitScore, commit);
    intents.innerHTML = [
      ["attack", `${EXAMPLE.target} with ${pct(EXAMPLE.trimmedTo)} of troops`, `trimmed from ${pct(asked)} to keep troops home against P7`],
      ["build", "city on the best-ranked site", "the purse, decided beside the main action"],
      ["ally", "accept P5's alliance request", "requests expire unanswered, so each gets a verdict"],
    ]
      .map(([k, v, why]) => `<li><span>${k}</span><span>${esc(v)}<em>${esc(why)}</em></span></li>`)
      .join("");
  }
  for (const q of $$("[data-quote]")) renderQuote(q);
}

// ---------- Question explorer ----------

function renderQuestions(): void {
  const root = $("[data-questions]");
  if (!root) return;
  root.innerHTML = groupQuestions(Object.keys(SRC.prompts))
    .filter((g) => g.ids.length)
    .map(
      ({ title, blurb, ids }) =>
        `<section class="q-group"><h3>${esc(title)}<small>${esc(blurb)}</small></h3><div class="q-list">` +
        ids
          .map((id) => SRC.prompts[id])
          .map(
            (p) =>
              `<details class="q"><summary><span class="q-id">${esc(p.id)}</span><span class="q-text">${rich(p.question || p.premise || "")}</span><span class="q-kind">${p.kind}</span></summary>` +
              `<div class="q-body">${promptBody(p)}<p class="q-links"><a href="${editor(p.id)}">Rewrite it in the editor</a><a href="${blob(p.line)}">Line ${p.line} on GitHub ↗</a></p></div></details>`,
          )
          .join("") +
        `</div></section>`,
    )
    .join("");
}

// ---------- Governance ----------

async function renderGovernance(): Promise<void> {
  const ballot = $("[data-ballot]");
  const topics = $("[data-topics]");
  const spaceLink = $<HTMLAnchorElement>("[data-space-link]");
  const forumLink = $<HTMLAnchorElement>("[data-forum-link]");
  const note = (text: string, action = "") => `<p class="govern-empty">${text}</p>${action}`;
  if (ballot) {
    if (!readSpace) {
      ballot.innerHTML = note(
        "Voting opens once the Jeviatus space is live on Snapshot. Proposals written in the editor will be voted on here.",
        `<a class="btn btn-ghost btn-small" href="${editor()}">Draft a proposal</a>`,
      );
      spaceLink?.remove();
    } else {
      if (spaceLink) spaceLink.href = spaceUrl(readSpace);
      ballot.innerHTML = `<p class="govern-empty">Loading proposals…</p>`;
      try {
        const list = await proposals(readSpace);
        ballot.innerHTML = list.length
          ? list.map(ballotRow).join("")
          : note("No proposals yet.", `<a class="btn btn-ghost btn-small" href="${editor()}">Draft a proposal</a>`);
      } catch {
        ballot.innerHTML = note(`Couldn't reach Snapshot just now. <a href="${spaceUrl(readSpace)}">See the proposals on Snapshot ↗</a>`);
      }
    }
  }
  if (topics) {
    if (!forumLive) {
      topics.innerHTML = note("The strategy forum isn't open yet. Until then, you can copy a draft from the editor and share it anywhere.");
      forumLink?.remove();
    } else {
      if (forumLink) forumLink.href = categoryUrl();
      try {
        const list = await latestTopics();
        topics.innerHTML = list.length
          ? list.map((t) => `<a class="govern-row" href="${topicUrl(t)}"><span class="govern-title">${esc(t.title)}</span><span class="govern-meta">${t.posts_count} ${t.posts_count === 1 ? "post" : "posts"}${t.last_posted_at ? ` · ${relativeTime(Date.parse(t.last_posted_at) / 1000)}` : ""}</span></a>`).join("")
          : note("No threads yet. Start the first debate.");
      } catch {
        topics.innerHTML = note(`<a href="${categoryUrl()}">Read the latest threads on the forum ↗</a>`);
      }
    }
  }
}

function ballotRow(p: import("./gov.ts").ProposalInfo): string {
  const total = p.scores_total || 0;
  const lead = p.scores.indexOf(Math.max(...p.scores));
  const bars = p.choices
    .slice(0, 3)
    .map((c, i) => {
      const share = total ? (p.scores[i] ?? 0) / total : 0;
      return `<span class="tally${i === lead && total ? " is-lead" : ""}"><span class="tally-label">${esc(c)}</span><span class="tally-track"><span style="width:${(share * 100).toFixed(1)}%"></span></span><span class="tally-pct">${pct(share)}</span></span>`;
    })
    .join("");
  const when = p.state === "active" ? `ends ${relativeTime(p.end)}` : p.state === "pending" ? "voting soon" : `closed ${relativeTime(p.end)}`;
  return `<a class="govern-row" href="${proposalUrl(readSpace, p.id)}"><span class="govern-state is-${p.state}">${p.state}</span><span class="govern-title">${esc(p.title)}</span><span class="govern-meta">${when}</span><span class="tallies">${bars}</span></a>`;
}

// ---------- Hero map ----------

const STEPS: Record<string, string[]> = {
  spawn: ["spawn_site → S4 · 0.66", "spawn_site → S2 · 0.71"],
  claim: ["expand · 35% troops", "expand · 20% troops", "build → city · S3", "propose_alliance → P2 · 0.52", "spend → port"],
  war: ["attack_player → P3 · 0.62", "also_attack.P6 · yes", "retreat.a41 · no", "attack_player → P5 · 0.57", "ally_accept.P2 · accept", "build → sam_launcher"],
  won: ["Jev holds the map · new game"],
};

function startMap(): void {
  const canvas = $<HTMLCanvasElement>("[data-map]");
  if (!canvas) return;
  const map = new TerritoryMap(canvas, innerWidth < 700 ? 4 : 5);
  const share = $("[data-hud-share]");
  const game = $("[data-hud-game]");
  const step = $("[data-hud-step]");
  let phase = "spawn";
  map.onStats = (s) => {
    phase = s.phase;
    if (share) share.textContent = pct(s.jevShare);
    if (game) game.textContent = `game ${String(s.game).padStart(2, "0")}`;
  };
  if (reduced) {
    map.settle();
    return;
  }
  let k = 0;
  setInterval(() => {
    const list = STEPS[phase];
    if (step) step.textContent = list[k++ % list.length];
  }, (SRC.constants.decisionInterval ?? 15) * 100);
  // Only run while the hero is on screen.
  new IntersectionObserver(([e]) => (e.isIntersecting ? map.start() : map.stop())).observe(canvas);
  let w = innerWidth;
  addEventListener("resize", () => {
    if (Math.abs(innerWidth - w) < 80) return;
    w = innerWidth;
    map.reset();
  });
}

// ---------- Motion ----------

function smoothScroll(): Lenis {
  const lenis = new Lenis({ lerp: 0.1, anchors: { offset: 0 } });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  return lenis;
}

function heroMotion(): void {
  const lines = $$(".hero-title .line-inner");
  gsap
    .timeline({ defaults: { ease: "expo.out" } })
    .from("[data-hero-map]", { opacity: 0, scale: 1.08, duration: 2.4, ease: "power2.out" }, 0)
    .from(lines, { yPercent: 110, duration: 1.3, stagger: 0.12 }, 0.2)
    .fromTo(lines, { fontVariationSettings: '"wdth" 50' }, { fontVariationSettings: '"wdth" 112', duration: 1.9, stagger: 0.12 }, 0.2)
    .from("[data-hero-fade]", { y: 24, opacity: 0, duration: 1.1, stagger: 0.1 }, 0.75)
    .from("[data-hud]", { opacity: 0, y: -12, duration: 1 }, 1);

  // The map tilts away like a table as the page moves on.
  gsap
    .timeline({ scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true } })
    .to("[data-hero-map]", { rotateX: 42, scale: 1.2, yPercent: 8, filter: "brightness(0.45)", ease: "none" }, 0)
    .to(".hero-copy", { yPercent: -35, opacity: 0, ease: "none" }, 0)
    .to("[data-hud]", { y: -60, opacity: 0, ease: "none" }, 0);
}

function thesisMotion(): void {
  const el = $("[data-thesis]");
  if (!el) return;
  // Split into words, keeping inline elements (the interval span) intact.
  const words: HTMLElement[] = [];
  const wrap = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        for (const part of (child.textContent ?? "").split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) frag.append(part);
          else {
            const w = document.createElement("span");
            w.className = "word";
            w.textContent = part;
            words.push(w);
            frag.append(w);
          }
        }
        child.replaceWith(frag);
      } else if (child instanceof HTMLElement) {
        child.classList.add("word");
        words.push(child);
      }
    }
  };
  wrap(el);
  gsap.fromTo(
    words,
    { opacity: 0.16 },
    { opacity: 1, stagger: 0.1, ease: "none", scrollTrigger: { trigger: el, start: "top 80%", end: "bottom 45%", scrub: true } },
  );
  gsap.from(".file-link", { opacity: 0, x: -20, duration: 1, ease: "expo.out", scrollTrigger: { trigger: ".file-link", start: "top 90%" } });
}

function treeMotion(svg: SVGSVGElement): void {
  const mobile = matchMedia("(max-width: 960px)");
  // Tighter framing on phones, one column at a time.
  const MOBILE: Record<number, [number, number, number, number]> = {
    1: [0, 190, 320, 210],
    2: [210, 30, 330, 400],
    3: [400, 30, 420, 400],
    4: [640, 30, 380, 400],
    5: [820, 30, 460, 520],
  };
  const camera = (s: Stage | 0) => {
    const box = mobile.matches && MOBILE[s] ? MOBILE[s] : CAMERA[s];
    const r = svg.getBoundingClientRect();
    return fitBox(box, r.width / Math.max(1, r.height));
  };
  // Initial states are set up front: a staggered fromTo inside a timeline
  // only renders its first target's start state.
  gsap.set($$(".edge:not(.dashed)", svg), { drawSVG: "0%" });
  gsap.set($$(".edge.dashed, .node, .note", svg), { opacity: 0 });
  gsap.set($$(".node", svg), { y: 8 });
  gsap.set($$(".bar", svg), { attr: { width: 0 } });
  const tl = gsap.timeline({ defaults: { ease: "power2.inOut" } });
  tl.set(svg, { attr: { viewBox: () => camera(1) } }, 0);
  for (const s of [1, 2, 3, 4, 5, 6] as Stage[]) {
    const at = s - 1;
    const edges = $$<SVGPathElement>(`.edge[data-stage="${s}"]`, svg);
    const solid = edges.filter((e) => !e.classList.contains("dashed"));
    const dashed = edges.filter((e) => e.classList.contains("dashed"));
    const nodes = $$<SVGGElement>(`.node[data-stage="${s}"], .note[data-stage="${s}"]`, svg);
    if (s > 1) tl.to(svg, { attr: { viewBox: () => camera(s) }, duration: 0.55 }, at);
    tl.to(solid, { drawSVG: "100%", duration: 0.45, stagger: 0.02, ease: "power1.inOut" }, at + 0.05);
    if (dashed.length) tl.to(dashed, { opacity: 1, duration: 0.3 }, at + 0.1);
    tl.to(nodes, { opacity: 1, y: 0, duration: 0.35, stagger: 0.02, ease: "expo.out" }, at + 0.25);
    const bars = $$<SVGRectElement>(`.node[data-stage="${s}"] .bar`, svg);
    if (bars.length) tl.to(bars, { attr: { width: (_: number, el: Element) => Number((el as SVGRectElement).dataset.w) }, duration: 0.4, stagger: 0.02, ease: "expo.out" }, at + 0.45);
  }
  // Pull back to the whole graph, then linger there.
  tl.to(svg, { attr: { viewBox: () => camera(0) }, duration: 0.6 }, 5.2).to({}, { duration: 0.4 });

  ScrollTrigger.create({
    trigger: ".stages",
    start: "top center",
    end: "bottom center",
    scrub: 0.8,
    animation: tl,
    invalidateOnRefresh: true,
  });

  const rail = $$("[data-rail]");
  const setStage = (s: number) => {
    rail.forEach((li) => {
      const n = Number(li.dataset.rail);
      li.classList.toggle("is-current", n === s);
      li.classList.toggle("is-done", n < s);
    });
    for (const n of $$(".node", svg)) n.classList.toggle("is-current", Number(n.dataset.stage) === s);
  };
  for (const a of $$("[data-stage-article]")) {
    const s = Number(a.dataset.stageArticle);
    ScrollTrigger.create({ trigger: a, start: "top 55%", end: "bottom 55%", onToggle: (st) => st.isActive && setStage(s) });
    gsap.from(a.children, { opacity: 0, y: 28, duration: 0.9, stagger: 0.06, ease: "expo.out", scrollTrigger: { trigger: a, start: "top 70%" } });
  }
  const barFills = $$("[data-route-bars] .bar-fill");
  gsap.fromTo(barFills, { scaleX: 0 }, { scaleX: (_: number, el: Element) => Number((el as HTMLElement).dataset.p), duration: 1.2, stagger: 0.05, ease: "expo.out", scrollTrigger: { trigger: "[data-route-bars]", start: "top 80%" } });
  gsap.from("[data-levels] .level-marker", { left: "0%", opacity: 0, duration: 1.4, ease: "expo.out", scrollTrigger: { trigger: "[data-levels]", start: "top 80%" } });
}

function leverMotion(): void {
  const mm = gsap.matchMedia();
  mm.add("(min-width: 961px)", () => {
    const track = $("[data-levers-track]")!;
    const distance = () => track.scrollWidth - innerWidth;
    const scroll = gsap.to(track, {
      x: () => -distance(),
      ease: "none",
      scrollTrigger: { trigger: ".levers", start: "top top", end: () => `+=${distance()}`, pin: true, scrub: 0.6, invalidateOnRefresh: true },
    });
    $$(".lever:not(.lever-intro)").forEach((lever, i) => {
      // The first panel is already on screen when the pin starts, so it
      // keys off the section entering instead of the horizontal scroll.
      const trigger = (start: string) =>
        i === 0 ? { trigger: ".levers", start: "top 40%" } : { trigger: lever, containerAnimation: scroll, start };
      gsap.from($$(":scope > .lever-num, :scope > h3, :scope > p", lever), {
        opacity: 0,
        y: 30,
        fontVariationSettings: '"wdth" 150',
        stagger: 0.06,
        duration: 1,
        ease: "expo.out",
        scrollTrigger: trigger("left 85%"),
      });
      gsap.from($$(".diff .add, .diff .del", lever), {
        clipPath: "inset(0 100% 0 0)",
        duration: 1.1,
        stagger: 0.18,
        delay: i === 0 ? 0.5 : 0,
        ease: "power3.inOut",
        scrollTrigger: trigger("left 70%"),
      });
    });
  });
  mm.add("(max-width: 960px)", () => {
    for (const lever of $$(".lever:not(.lever-intro)")) {
      gsap.from($$(".diff .add, .diff .del", lever), { clipPath: "inset(0 100% 0 0)", duration: 1, stagger: 0.15, ease: "power3.inOut", scrollTrigger: { trigger: lever, start: "top 60%" } });
    }
  });
}

function timelineMotion(): void {
  const list = $("[data-timeline]");
  if (!list) return;
  gsap.fromTo(list, { "--fill": 0 }, { "--fill": 1, ease: "none", scrollTrigger: { trigger: list, start: "top 60%", end: "bottom 60%", scrub: true } });
  for (const li of $$("li", list)) {
    ScrollTrigger.create({ trigger: li, start: "top 62%", onToggle: (st) => li.classList.toggle("is-lit", st.isActive), end: () => `bottom+=${innerHeight} top` });
    gsap.from(li.children, { opacity: 0, x: 24, duration: 0.9, stagger: 0.08, ease: "expo.out", scrollTrigger: { trigger: li, start: "top 78%" } });
  }
}

function ctaMotion(): void {
  gsap.fromTo(
    "[data-cta-title]",
    { fontVariationSettings: '"wdth" 50', yPercent: 20 },
    { fontVariationSettings: '"wdth" 100', yPercent: 0, ease: "none", scrollTrigger: { trigger: ".cta", start: "top 90%", end: "top 25%", scrub: true } },
  );
}

const HINTS = [
  "never open a second war while the first one is still running",
  "a tribe with a port is worth more than its land suggests",
  "ask the strongest neighbor for an alliance before a rival's silo is ready",
  "your line here",
];

function typeHints(): void {
  const el = $("[data-typed]");
  if (!el) return;
  if (reduced) {
    el.textContent = `"${HINTS[HINTS.length - 1]}",`;
    return;
  }
  let hint = 0;
  let i = 0;
  let deleting = false;
  let active = false;
  const tick = () => {
    if (!active) return;
    const full = `"${HINTS[hint]}",`;
    el.textContent = full.slice(0, i);
    let wait = deleting ? 18 : 42 + Math.random() * 50;
    if (!deleting && i === full.length) {
      deleting = true;
      wait = 2200;
    } else if (deleting && i === 0) {
      deleting = false;
      hint = (hint + 1) % HINTS.length;
      wait = 400;
    } else i += deleting ? -1 : 1;
    setTimeout(tick, wait);
  };
  new IntersectionObserver(([e]) => {
    const was = active;
    active = e.isIntersecting;
    if (active && !was) tick();
  }).observe(el);
}

function chrome(lenis: Lenis | null): void {
  const nav = $("[data-nav]")!;
  const bar = $(".progress span");
  let last = 0;
  const onScroll = (y: number, limit: number) => {
    nav.classList.toggle("is-solid", y > 40);
    nav.classList.toggle("is-hidden", y > innerHeight * 0.8 && y > last + 2);
    if (y < last - 2) nav.classList.remove("is-hidden");
    last = y;
    if (bar) bar.style.transform = `scaleX(${limit > 0 ? y / limit : 0})`;
  };
  if (lenis) lenis.on("scroll", (l: Lenis) => onScroll(l.scroll, l.limit));
  else addEventListener("scroll", () => onScroll(scrollY, document.documentElement.scrollHeight - innerHeight), { passive: true });
  nav.addEventListener("focusin", () => nav.classList.remove("is-hidden"));

  const links = $$<HTMLAnchorElement>(".nav nav a");
  for (const a of links) {
    const section = $(a.getAttribute("href")!);
    if (!section) continue;
    // A pinned section's own box stays one screen tall; its spacer spans the pin.
    const target = section.parentElement?.classList.contains("pin-spacer") ? section.parentElement : section;
    ScrollTrigger.create({
      trigger: target,
      start: "top 50%",
      end: "bottom 50%",
      onToggle: (st) => (st.isActive ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")),
    });
  }
}

// ---------- Boot ----------

fillFacts();
renderArtifacts();
void renderGovernance();
renderQuestions();
startMap();
typeHints();

const svg = $<SVGSVGElement>("[data-tree]")!;
renderTree(svg, SRC, { onSelect: openPrompt });

if (reduced) {
  chrome(null);
} else {
  const lenis = smoothScroll();
  new MutationObserver(() => (dialog.open ? lenis.stop() : lenis.start())).observe(dialog, { attributes: true, attributeFilter: ["open"] });
  heroMotion();
  thesisMotion();
  treeMotion(svg);
  leverMotion();
  timelineMotion();
  ctaMotion();
  // After the pinned sections, so section triggers account for pin spacing.
  chrome(lenis);
  document.fonts.ready.then(() => ScrollTrigger.refresh());
}
