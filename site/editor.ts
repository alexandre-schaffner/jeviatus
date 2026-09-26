// The decision tree editor: reword Jev's questions and hints in plain
// English, preview the exact change, then take it to the forum and to a
// Snapshot vote. Drafts live in localStorage; nothing leaves the browser
// until the visitor opens the forum or signs a proposal.

import { applyPatch, cleanText, type Edit, LIMITS, type Patch, proposalBody, validatePatch, APP, lineDiff } from "../governance/patch";
import type { PromptNode } from "../governance/prompts";
import { forumLive, GOV, latestBlock, newTopicUrl, proposalUrl, spaceInfo, votingLive } from "./gov.ts";
import { promptFile, source } from "./source.ts" with { type: "macro" };
import { renderTree } from "./tree.ts";
import { $, $$, esc, groupQuestions } from "./ui.ts";

const SRC = source();
const PF = promptFile();
const FILE = PF.file;

const rich = (s: string) => esc(s).replace(/`([^`]+)`/g, '<span class="tick">$1</span>').replace(/&lt;([a-z …]+)&gt;/g, '<span class="slot">$1</span>');
const blob = (line?: number) => `${SRC.repo}/blob/main/${SRC.file}${line ? `#L${line}` : ""}`;

// ---------- Draft ----------

interface HintDraft {
  key: string;
  base?: number; // index of the hint in the file; unset for a new hint
  text: string;
  removed?: boolean;
}
interface PromptDraft {
  question: string;
  hints: HintDraft[];
}
interface Draft {
  v: 1;
  base: string;
  title: string;
  why: string;
  discussion: string;
  prompts: Record<string, PromptDraft>;
  published?: string;
}

const STORE = "jeviatus.editor.draft.v1";
const empty = (): Draft => ({ v: 1, base: PF.sha, title: "", why: "", discussion: "", prompts: {} });

function load(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(STORE) ?? "null") as Draft | null;
    if (d?.v === 1) return d;
  } catch {}
  return empty();
}
let draft = load();
const save = () => localStorage.setItem(STORE, JSON.stringify(draft));

function fresh(p: PromptNode): PromptDraft {
  return { question: p.question, hints: p.hints.map((h, i) => ({ key: `b${i}`, base: i, text: h.text })) };
}
const working = (id: string): PromptDraft => draft.prompts[id] ?? fresh(FILE.prompts[id]);
function touch(id: string): PromptDraft {
  draft.prompts[id] ??= fresh(FILE.prompts[id]);
  return draft.prompts[id];
}

// The draft as patch edits, in file order.
function editsFor(id: string): Edit[] {
  const p = FILE.prompts[id];
  const d = draft.prompts[id];
  if (!p || !d) return [];
  const out: Edit[] = [];
  const q = cleanText(d.question);
  if (p.questionSpan && q && q !== p.question) out.push({ op: "question", prompt: id, from: p.question, to: q });
  let anchor = -1;
  for (const h of d.hints) {
    const text = cleanText(h.text);
    if (h.base !== undefined) {
      const orig = p.hints[h.base];
      if (h.removed) out.push({ op: "remove-hint", prompt: id, index: h.base, from: orig.text });
      else {
        if (text && text !== orig.text) out.push({ op: "hint", prompt: id, index: h.base, from: orig.text, to: text });
        anchor = h.base; // new hints never anchor to a removed one
      }
    } else if (text) out.push({ op: "add-hint", prompt: id, after: anchor, anchor: anchor >= 0 ? p.hints[anchor].text : null, to: text });
  }
  return out;
}

function currentPatch(): Patch {
  return { v: 1, file: SRC.file, base: draft.base, edits: Object.keys(draft.prompts).flatMap(editsFor) };
}

function evaluate() {
  const patch = currentPatch();
  const problems = patch.edits.length ? validatePatch(patch).problems : [];
  const applied = patch.edits.length && !problems.length ? applyPatch(PF.text, FILE, patch) : { text: PF.text, problems: [] };
  const editorUrl = GOV.site ? `${GOV.site.replace(/\/$/, "")}/editor` : undefined;
  const body = proposalBody({ why: draft.why || "(Explain why this helps Jev.)", discussion: draft.discussion, file: FILE, patch, editorUrl });
  return { patch, problems: [...problems, ...applied.problems], text: applied.text, body };
}

// ---------- Selection ----------

const ids = Object.keys(FILE.prompts);
const params = new URLSearchParams(location.search);
let selected = FILE.prompts[params.get("q") ?? ""] ? params.get("q")! : "route";

function select(id: string, focus = false): void {
  if (!FILE.prompts[id] && id !== "role") return;
  selected = id;
  const url = new URL(location.href);
  url.searchParams.set("q", id);
  history.replaceState(null, "", url);
  renderList();
  renderEditor();
  markTree();
  if (focus) $("[data-editor]")?.focus({ preventScroll: false });
}

// ---------- Tree ----------

const svg = $<SVGSVGElement>("[data-tree]")!;
renderTree(svg, SRC, { example: false, onSelect: (id) => select(id, true) });
svg.setAttribute("viewBox", `-10 20 1300 650`);
for (const n of $$<SVGGElement>("[data-prompt]", svg)) n.setAttribute("aria-label", `Edit ${n.dataset.prompt}`);

function markTree(): void {
  const edited = new Set(Object.keys(draft.prompts).filter((id) => editsFor(id).length));
  for (const n of $$<SVGGElement>(".node", svg)) {
    const id = n.dataset.prompt;
    n.classList.toggle("is-selected", id === selected);
    n.classList.toggle("is-edited", id !== undefined && edited.has(id));
  }
}

// ---------- Question list ----------

function renderList(): void {
  const root = $("[data-list]")!;
  const filter = ($<HTMLInputElement>("[data-search]")?.value ?? "").toLowerCase();
  root.innerHTML = groupQuestions(ids)
    .map(({ title, ids: g }) => {
      const shown = g.filter((id) => !filter || id.toLowerCase().includes(filter) || FILE.prompts[id].question.toLowerCase().includes(filter));
      if (!shown.length) return "";
      return (
        `<p class="ed-group">${esc(title)}</p><ul>` +
        shown
          .map((id) => {
            const n = editsFor(id).length;
            return `<li><button type="button" class="ed-item${id === selected ? " is-selected" : ""}" data-select="${esc(id)}"${id === selected ? ' aria-current="true"' : ""}>` +
              `<span class="ed-item-id">${esc(id)}</span><span class="ed-item-q">${rich(FILE.prompts[id].question)}</span>` +
              (n ? `<span class="ed-badge" aria-label="${n} changes">${n}</span>` : "") +
              `</button></li>`;
          })
          .join("") +
        `</ul>`
      );
    })
    .join("") || `<p class="ed-empty">No question mentions “${esc(filter)}”.</p>`;
}

// ---------- Editor panel ----------

const KIND: Record<string, string> = {
  choice: "Jev picks one option",
  score: "Jev answers on a scale",
  noul: "Jev answers yes or no",
};

function answersHtml(p: PromptNode): string {
  const list = (entries: [string, string][]) => `<ul class="ed-answer-list">${entries.map(([k, v]) => `<li><b>${esc(k)}</b> ${rich(v)}</li>`).join("")}</ul>`;
  if (p.id === "route") return list(Object.entries(SRC.routes));
  if (p.id === "goal") return list(Object.entries(SRC.goals));
  if (p.levels) return list(p.levels.map((l) => { const [k, ...r] = l.split(":"); return [k, r.join(":").trim()] as [string, string]; }));
  if (p.options) return list(Object.entries(p.options));
  if (p.kind === "noul") return `<p>Yes or no, with how sure it is.</p>`;
  return `<p>Code builds the options every step from the players and sites that are legal right now.</p>`;
}

function renderEditor(): void {
  const root = $("[data-editor]")!;
  if (selected === "role") {
    root.innerHTML =
      `<header class="ed-head"><p class="ed-id">role</p><span class="ed-kind">Jev's brief</span></header>` +
      `<p class="ed-explain">Most questions open with this description of the game. Code assembles it, so changing it needs a developer.</p>` +
      `<p class="ed-locked">${rich(FILE.role)}</p>`;
    return;
  }
  const p = FILE.prompts[selected];
  const d = working(selected);
  const shown = d.hints.filter((h) => !h.removed).length;
  let num = 0;
  const hints = d.hints
    .map((h) => {
      const orig = h.base !== undefined ? p.hints[h.base] : undefined;
      const editable = h.base === undefined || orig?.span !== undefined;
      const state = h.removed ? "is-removed" : h.base === undefined ? "is-new" : cleanText(h.text) !== orig!.text ? "is-changed" : "";
      const label = h.removed ? "–" : String(++num);
      const actions = h.removed
        ? `<button type="button" class="ed-link" data-hint-action="restore" data-key="${h.key}">Restore</button>`
        : h.base === undefined
          ? `<button type="button" class="ed-link" data-hint-action="delete" data-key="${h.key}">Delete</button>`
          : state === "is-changed"
            ? `<button type="button" class="ed-link" data-hint-action="revert" data-key="${h.key}">Undo change</button>` + (p.hintList ? `<button type="button" class="ed-link" data-hint-action="remove" data-key="${h.key}">Remove</button>` : "")
            : p.hintList && editable ? `<button type="button" class="ed-link" data-hint-action="remove" data-key="${h.key}">Remove</button>` : "";
      const field = !editable
        ? `<p class="ed-hint-text is-locked">${rich(h.text)}</p>`
        : h.removed
          ? `<p class="ed-hint-text">${rich(orig!.text)}</p>`
          : `<textarea class="ed-hint-text" rows="1" maxlength="${LIMITS.hint}" data-hint="${h.key}" aria-label="Hint ${label}">${esc(h.text)}</textarea>`;
      const tag = state === "is-new" ? "New" : state === "is-changed" ? "Changed" : state === "is-removed" ? "Removed" : "";
      return `<li class="ed-hint ${state}"><span class="ed-hint-num" aria-hidden="true">${label}</span>${field}<div class="ed-hint-meta">${tag ? `<span class="ed-tag">${tag}</span>` : ""}${actions}</div></li>`;
    })
    .join("");
  const also = [p.premise, p.context, p.rules].filter(Boolean) as string[];
  root.innerHTML =
    `<header class="ed-head"><p class="ed-id">${esc(p.id)}</p><span class="ed-kind">${KIND[p.kind]}</span><a class="ed-line" href="${blob(p.line)}">line ${p.line} ↗</a></header>` +
    `<p class="ed-explain">Every time Jev makes this decision, it reads the question and weighs the hints below. Rewrite them the way you would advise a friend playing OpenFront.</p>` +
    `<div class="ed-field"><label class="ed-label" for="ed-question">The question</label>` +
    (p.questionSpan
      ? `<textarea id="ed-question" class="ed-question" rows="2" maxlength="${LIMITS.question}" data-question>${esc(d.question)}</textarea>`
      : `<p class="ed-locked" id="ed-question">${rich(p.question)}</p><p class="ed-note">This question includes live game values (the highlighted parts), so rewording it needs a developer. Its hints are yours to change.</p>`) +
    `</div>` +
    (also.length ? `<div class="ed-field"><p class="ed-label">Also shown to Jev</p>${also.map((a) => `<p class="ed-also">${rich(a)}</p>`).join("")}</div>` : "") +
    `<div class="ed-field"><p class="ed-label">Hints Jev weighs <span class="ed-count-inline">${shown}</span></p>` +
    (d.hints.length ? `<ol class="ed-hints">${hints}</ol>` : `<p class="ed-note">No hints yet.${p.hintList ? " Add the first one." : ""}</p>`) +
    (p.hintList ? `<button type="button" class="btn btn-ghost btn-small" data-action="add-hint">Add a hint</button>` : p.hints.length ? `<p class="ed-note">This decision takes a single hint. You can reword it, but not remove it or add more.</p>` : `<p class="ed-note">This decision has no hints to edit.</p>`) +
    `</div>` +
    `<details class="ed-field ed-answers"><summary class="ed-label">What Jev can answer</summary>${answersHtml(p)}</details>` +
    `<aside class="ed-tips"><p class="ed-label">Writing a hint that works</p><ul>` +
    `<li>Say when it applies: “when my troops are low…”, “early in the game…”.</li>` +
    `<li>Name the trade-off: what Jev gains and what it risks.</li>` +
    `<li>Point at something Jev can see, in backticks, like <span class="tick">me.troop_status</span> or <span class="tick">players</span>.</li></ul></aside>`;
  for (const t of $$<HTMLTextAreaElement>("textarea", root)) grow(t);
}

function grow(t: HTMLTextAreaElement): void {
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight + 2}px`;
}

const editorRoot = $("[data-editor]")!;
editorRoot.addEventListener("input", (e) => {
  const t = e.target as HTMLTextAreaElement;
  if (t.matches("[data-question]")) touch(selected).question = t.value;
  else if (t.dataset.hint) {
    const h = touch(selected).hints.find((x) => x.key === t.dataset.hint);
    if (h) h.text = t.value;
  } else return;
  grow(t);
  changed(false);
  // Re-mark this hint's state without re-rendering the field being typed in.
  const li = t.closest(".ed-hint");
  const h = working(selected).hints.find((x) => x.key === t.dataset.hint);
  if (li && h && h.base !== undefined) {
    const isChanged = cleanText(h.text) !== FILE.prompts[selected].hints[h.base].text;
    if (li.classList.contains("is-changed") !== isChanged) {
      const pos = t.selectionStart;
      renderEditor();
      const again = $<HTMLTextAreaElement>(`[data-hint="${h.key}"]`, editorRoot);
      again?.focus();
      again?.setSelectionRange(pos, pos);
    }
  }
});
editorRoot.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-hint-action], [data-action='add-hint']");
  if (!b) return;
  const d = touch(selected);
  if (b.dataset.action === "add-hint") {
    const key = `n${Date.now().toString(36)}`;
    d.hints.push({ key, text: "" });
    renderEditor();
    $<HTMLTextAreaElement>(`[data-hint="${key}"]`, editorRoot)?.focus();
    return;
  }
  const i = d.hints.findIndex((x) => x.key === b.dataset.key);
  const h = d.hints[i];
  if (!h) return;
  const p = FILE.prompts[selected];
  if (b.dataset.hintAction === "delete") d.hints.splice(i, 1);
  if (b.dataset.hintAction === "remove") h.removed = true;
  if (b.dataset.hintAction === "restore") h.removed = false;
  if (b.dataset.hintAction === "revert" && h.base !== undefined) h.text = p.hints[h.base].text;
  renderEditor();
  changed(true);
});

// ---------- Proposal panel ----------

let tab: "plain" | "code" = "plain";
let wallet: string | null = null;
let voteStatus: { tone: "info" | "error" | "ok"; text: string } | null = null;
let busy = false;

function changed(full: boolean): void {
  // Drop prompts the visitor has brought back to their original text.
  for (const id of Object.keys(draft.prompts)) if (!editsFor(id).length && !draft.prompts[id].hints.some((h) => h.base === undefined && !cleanText(h.text))) delete draft.prompts[id];
  save();
  renderProposal();
  markTree();
  if (full) renderList();
  else for (const b of $$("[data-select]")) {
    const n = editsFor(b.dataset.select!).length;
    const badge = $(".ed-badge", b);
    if (n && badge) badge.textContent = String(n);
    else if (n) b.insertAdjacentHTML("beforeend", `<span class="ed-badge">${n}</span>`);
    else badge?.remove();
  }
}

function preview(patch: Patch, text: string): string {
  if (!patch.edits.length) return `<p class="ed-empty">Your changes will appear here, first in plain English, then as the exact change to the code.</p>`;
  if (tab === "plain") {
    const byPrompt = new Map<string, Edit[]>();
    for (const e of patch.edits) byPrompt.set(e.prompt, [...(byPrompt.get(e.prompt) ?? []), e]);
    return [...byPrompt]
      .map(([id, edits]) => `<div class="ed-change"><button type="button" class="ed-change-id" data-select="${esc(id)}">${esc(id)}</button><ul>` +
        edits.map((e) =>
          e.op === "add-hint" ? `<li><span class="ed-tag is-new">Added</span><span class="ed-after">${rich(e.to)}</span></li>`
          : e.op === "remove-hint" ? `<li><span class="ed-tag is-removed">Removed</span><span class="ed-before">${rich(e.from)}</span></li>`
          : `<li><span class="ed-tag">${e.op === "question" ? "Question" : `Hint ${e.index + 1}`}</span><span class="ed-before">${rich(e.from)}</span><span class="ed-after">${rich(e.to)}</span></li>`,
        ).join("") + `</ul></div>`)
      .join("");
  }
  const lines = lineDiff(PF.text, text, 1);
  return `<pre class="ed-diff" tabindex="0"><code>${lines
    .map((l) => (l === null ? `<span class="gap">⋯</span>` : `<span class="${l.kind}"><i>${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</i>${esc(l.text)}</span>`))
    .join("")}</code></pre>`;
}

function readiness(patch: Patch, problems: string[], body: string): string[] {
  const need: string[] = [];
  if (!patch.edits.length) need.push("Change at least one hint or question.");
  if (cleanText(draft.title).length < 8) need.push("Give it a title of at least 8 characters.");
  if (cleanText(draft.why).length < 20) need.push("Explain why it helps, in a sentence or two.");
  if (body.length > LIMITS.body) need.push(`Shorten it: Snapshot takes up to ${LIMITS.body.toLocaleString("en-US")} characters.`);
  return [...need, ...problems];
}

function renderProposal(): void {
  const root = $("[data-proposal]")!;
  const { patch, problems, text, body } = evaluate();
  const n = patch.edits.length;
  const decisions = new Set(patch.edits.map((e) => e.prompt)).size;
  const need = readiness(patch, problems, body);
  const ready = need.length === 0;
  $("[data-count]", root)!.textContent = n ? `${n} ${n === 1 ? "change" : "changes"} across ${decisions} ${decisions === 1 ? "decision" : "decisions"}` : "No changes yet";
  $("[data-preview]", root)!.innerHTML = preview(patch, text);
  for (const t of $$("[data-tab]", root)) t.setAttribute("aria-selected", String(t.dataset.tab === tab));
  const needs = $("[data-needs]", root)!;
  needs.innerHTML = need.length ? `<p class="ed-label">Before it can go out</p><ul>${need.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="ed-ready">Ready to share.</p>`;

  const forum = $<HTMLButtonElement>("[data-action='forum']", root)!;
  forum.disabled = !forumLive || !ready;
  $("[data-forum-note]", root)!.textContent = forumLive
    ? "Opens a new thread on the Jeviatus forum with your proposal filled in. Paste the thread's link below so voters can read the debate."
    : "The Jeviatus forum isn't live yet. Copy your proposal and share it in the meantime; your draft stays saved in this browser.";

  const vote = $("[data-vote]", root)!;
  if (draft.published) {
    const space = GOV.snapshot.space;
    vote.innerHTML = `<p class="ed-status is-ok">Published. <a href="${proposalUrl(space, draft.published)}">See the vote on Snapshot ↗</a></p>`;
  } else if (!votingLive) {
    vote.innerHTML = `<p class="ed-note">Voting opens once the Jeviatus space is live on Snapshot. Until then, start the debate on the forum.</p>`;
  } else {
    vote.innerHTML =
      (wallet
        ? `<p class="ed-wallet">Signing as <code>${wallet.slice(0, 6)}…${wallet.slice(-4)}</code></p><button type="button" class="btn btn-jev" data-action="publish"${ready && !busy ? "" : " disabled"}>${busy ? "Waiting for your wallet…" : "Sign and publish on Snapshot"}</button>`
        : `<button type="button" class="btn btn-jev" data-action="connect"${busy ? " disabled" : ""}>Connect a wallet</button>`) +
      (voteStatus ? `<p class="ed-status is-${voteStatus.tone}" role="status">${esc(voteStatus.text)}</p>` : "");
  }
  for (const f of $$<HTMLInputElement | HTMLTextAreaElement>("[data-p]", root)) {
    const key = f.dataset.p as "title" | "why" | "discussion";
    if (document.activeElement !== f) f.value = draft[key];
  }
}

const proposalRoot = $("[data-proposal]")!;
proposalRoot.addEventListener("input", (e) => {
  const f = e.target as HTMLInputElement;
  const key = f.dataset.p as "title" | "why" | "discussion" | undefined;
  if (!key) return;
  draft[key] = f.value;
  save();
  renderProposal();
});
proposalRoot.addEventListener("click", async (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-tab], [data-action], [data-select]");
  if (!b) return;
  if (b.dataset.select) return select(b.dataset.select, true);
  if (b.dataset.tab) {
    tab = b.dataset.tab as typeof tab;
    return renderProposal();
  }
  const { body, patch } = evaluate();
  switch (b.dataset.action) {
    case "forum": {
      const full = `${body}\n`;
      // Long proposals don't fit in a URL: the full text goes to the clipboard.
      if (full.length > 6000) {
        await navigator.clipboard.writeText(full).catch(() => {});
        window.open(newTopicUrl(draft.title, "Paste the proposal from your clipboard here."), "_blank", "noopener");
        flash(b, "Proposal copied: paste it into the thread");
      } else window.open(newTopicUrl(draft.title, full), "_blank", "noopener");
      return;
    }
    case "copy":
      await navigator.clipboard.writeText(`# ${draft.title}\n\n${body}\n`);
      return flash(b, "Copied");
    case "download": {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(patch, null, 2)], { type: "application/json" }));
      a.download = "jeviatus-proposal.json";
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    case "reset":
      if (!confirm("Discard every change in this draft?")) return;
      draft = empty();
      save();
      voteStatus = null;
      renderAll();
      return;
    case "connect":
      return connectWallet();
    case "publish":
      return publishProposal();
  }
});

function flash(b: HTMLElement, text: string): void {
  const was = b.textContent;
  b.textContent = text;
  setTimeout(() => (b.textContent = was), 2200);
}

async function connectWallet(): Promise<void> {
  busy = true;
  voteStatus = null;
  renderProposal();
  try {
    const s = await import("./snapshot-sign.ts");
    wallet = await s.connect();
  } catch (err) {
    voteStatus = { tone: "error", text: message(err) };
  }
  busy = false;
  renderProposal();
}

async function publishProposal(): Promise<void> {
  if (!wallet) return;
  const { body } = evaluate();
  busy = true;
  voteStatus = { tone: "info", text: "Reading the space's voting rules…" };
  renderProposal();
  try {
    const space = await spaceInfo(GOV.snapshot.space);
    if (!space) throw new Error(`The Snapshot space ${GOV.snapshot.space} doesn't exist yet.`);
    const snapshot = await latestBlock(space.network);
    const now = Math.floor(Date.now() / 1000);
    const start = now + (space.voting.delay ?? 0);
    const end = start + (space.voting.period || GOV.snapshot.votingDays * 86_400);
    voteStatus = { tone: "info", text: "Check your wallet. Signing is free and sends no transaction." };
    renderProposal();
    const s = await import("./snapshot-sign.ts");
    const id = await s.publish(GOV.snapshot.sequencer, {
      from: wallet,
      space: space.id,
      timestamp: now,
      type: space.voting.type || "basic",
      title: cleanText(draft.title).slice(0, LIMITS.title),
      body,
      discussion: draft.discussion.trim(),
      choices: ["For", "Against", "Abstain"],
      labels: [],
      start,
      end,
      snapshot,
      plugins: "{}",
      privacy: "",
      app: APP,
    });
    draft.published = id;
    save();
    voteStatus = null;
  } catch (err) {
    voteStatus = { tone: "error", text: message(err) };
  }
  busy = false;
  renderProposal();
}

function message(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/rejected|denied/i.test(m)) return "You cancelled the signature. Nothing was published.";
  if (/validation/i.test(m)) return `Snapshot refused it: ${m}. The space may require a minimum token balance to propose.`;
  return m;
}

// ---------- Boot ----------

function renderAll(): void {
  renderList();
  renderEditor();
  renderProposal();
  markTree();
}

$("[data-search]")!.addEventListener("input", renderList);
$("[data-list]")!.addEventListener("click", (e) => {
  const b = (e.target as Element).closest<HTMLElement>("[data-select]");
  if (b) select(b.dataset.select!, innerWidth < 960);
});
for (const [sel, live, on, off] of [
  ["[data-status-forum]", forumLive, "Forum live", "Forum not live yet"],
  ["[data-status-vote]", votingLive, "Voting live", "Voting not live yet"],
] as const) {
  const el = $(sel);
  if (!el) continue;
  el.textContent = live ? on : off;
  el.classList.toggle("is-live", live);
}
for (const a of $$<HTMLAnchorElement>("[data-edit]")) a.href = `${SRC.repo}/edit/main/${SRC.file}`;
if (draft.base !== PF.sha && Object.keys(draft.prompts).length) {
  $("[data-stale]")!.hidden = false;
}
renderAll();
