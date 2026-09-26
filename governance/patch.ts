// Prompt proposals: the edits a DAO vote carries, and how they land in
// questions.ts. An edit only ever replaces, inserts or removes one string
// literal, and the new text is written with JSON.stringify, so a proposal can
// change what Jev reads but never the code around it. Every edit names the
// text it expects to find; if the file moved on since the vote, applying
// reports a problem instead of guessing.

import type { PromptFile, Span } from "./prompts";

const PATCH_FENCE = "jeviatus-patch";
// The only file a proposal may touch.
export const QUESTIONS_FILE = "harness/decide/questions.ts";
export const APP = "jeviatus"; // Snapshot `app` tag on proposals made by the editor

export const LIMITS = { hint: 500, question: 400, edits: 30, title: 120, body: 9500 } as const;

export type Edit =
  | { op: "question"; prompt: string; from: string; to: string }
  | { op: "hint"; prompt: string; index: number; from: string; to: string }
  // `after` is the index of the existing hint it follows (-1: first); `anchor` is that hint's text.
  | { op: "add-hint"; prompt: string; after: number; anchor: string | null; to: string }
  | { op: "remove-hint"; prompt: string; index: number; from: string };

export interface Patch {
  v: 1;
  file: string;
  base: string; // commit the edits were written against
  edits: Edit[];
}

// One line of plain text: what a hint or question can be.
export function cleanText(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function validatePatch(x: unknown): { patch?: Patch; problems: string[] } {
  const problems: string[] = [];
  const o = x as Partial<Patch> | null;
  if (!o || typeof o !== "object") return { problems: ["not an object"] };
  if (o.v !== 1) problems.push("unknown patch version");
  if (o.file !== QUESTIONS_FILE) problems.push(`proposals may only change ${QUESTIONS_FILE}`);
  if (typeof o.base !== "string") problems.push("missing base");
  if (!Array.isArray(o.edits) || o.edits.length === 0) problems.push("no edits");
  else if (o.edits.length > LIMITS.edits) problems.push(`more than ${LIMITS.edits} edits`);
  const str = (v: unknown) => typeof v === "string";
  const int = (v: unknown) => Number.isInteger(v);
  for (const [i, e] of (Array.isArray(o.edits) ? o.edits : []).entries()) {
    const at = `edit ${i + 1}`;
    if (!e || typeof e !== "object" || !str(e.prompt)) {
      problems.push(`${at}: malformed`);
      continue;
    }
    const to = "to" in e ? e.to : undefined;
    if (to !== undefined) {
      if (!str(to) || cleanText(to) !== to || to.length < 3) problems.push(`${at}: text must be one line of at least 3 characters`);
      else if (to.length > (e.op === "question" ? LIMITS.question : LIMITS.hint)) problems.push(`${at}: text too long`);
    }
    if (e.op === "question" && str(e.from) && str(e.to)) continue;
    if (e.op === "hint" && int(e.index) && str(e.from) && str(e.to)) continue;
    if (e.op === "add-hint" && int(e.after) && (e.anchor === null || str(e.anchor)) && str(e.to)) continue;
    if (e.op === "remove-hint" && int(e.index) && str(e.from)) continue;
    problems.push(`${at}: malformed ${String((e as { op?: unknown }).op)}`);
  }
  return problems.length ? { problems } : { patch: o as Patch, problems };
}

interface Splice {
  start: number;
  end: number;
  insert: string;
}

// Apply a patch to the text `file` was parsed from.
export function applyPatch(text: string, file: PromptFile, patch: Patch): { text: string; problems: string[] } {
  const problems: string[] = [];
  const splices: Splice[] = [];
  const touched = new Set<string>();
  const inserts = new Map<number, { indent: string; afterComma: boolean; lines: string[] }>();
  const lit = (s: string) => JSON.stringify(s);

  patch.edits.forEach((e, i) => {
    const at = `edit ${i + 1} (${e.prompt})`;
    const p = file.prompts[e.prompt];
    if (!p) return problems.push(`${at}: no such question`);
    if (e.op === "question") {
      if (!p.questionSpan) return problems.push(`${at}: this question is built in code and can't be reworded here`);
      if (p.question !== e.from) return problems.push(`${at}: the question changed since this proposal was written`);
      if (!claim(`${e.prompt}:q`)) return problems.push(`${at}: edited twice`);
      splices.push({ ...p.questionSpan, insert: lit(e.to) });
      return;
    }
    if (e.op === "hint" || e.op === "remove-hint") {
      const h = p.hints[e.index];
      if (!h?.span) return problems.push(`${at}: hint ${e.index + 1} can't be edited here`);
      if (h.text !== e.from) return problems.push(`${at}: hint ${e.index + 1} changed since this proposal was written`);
      if (!claim(`${e.prompt}:${e.index}`)) return problems.push(`${at}: hint ${e.index + 1} edited twice`);
      if (e.op === "hint") splices.push({ ...h.span, insert: lit(e.to) });
      else if (!p.hintList) return problems.push(`${at}: this question has a single hint, which can be reworded but not removed`);
      else splices.push({ ...removal(text, h.span), insert: "" });
      return;
    }
    // add-hint
    if (!p.hintList) return problems.push(`${at}: this question takes no new hints`);
    let pos: number;
    let afterComma = true;
    if (e.after === -1) {
      if (e.anchor !== null) return problems.push(`${at}: malformed anchor`);
      pos = p.hintList.open;
    } else {
      const h = p.hints[e.after];
      if (!h?.span) return problems.push(`${at}: can't insert after hint ${e.after + 1}`);
      if (h.text !== e.anchor) return problems.push(`${at}: hint ${e.after + 1} changed since this proposal was written`);
      const comma = /^\s*,/.exec(text.slice(h.span.end));
      afterComma = comma !== null;
      pos = comma ? h.span.end + comma[0].length : h.span.end;
    }
    const slot = inserts.get(pos) ?? { indent: p.hintList.indent, afterComma, lines: [] };
    slot.lines.push(lit(e.to));
    inserts.set(pos, slot);
  });

  for (const [pos, slot] of inserts) {
    const body = slot.lines.map((l) => `\n${slot.indent}${l}`);
    // After a comma (or `[`), each new line brings its own trailing comma;
    // after a last element with none, commas go before each new line.
    const insert = slot.afterComma ? body.map((l) => `${l},`).join("") : body.map((l) => `,${l}`).join("");
    splices.push({ start: pos, end: pos, insert });
  }
  splices.sort((a, b) => b.start - a.start || b.end - a.end);
  for (let k = 1; k < splices.length; k++) {
    if (splices[k].end > splices[k - 1].start) problems.push("two edits overlap");
  }
  if (problems.length) return { text, problems };
  let out = text;
  for (const s of splices) out = out.slice(0, s.start) + s.insert + out.slice(s.end);
  return { text: out, problems };

  function claim(key: string): boolean {
    if (touched.has(key)) return false;
    touched.add(key);
    return true;
  }
}

// A hint on its own line goes with its line; otherwise with its comma.
function removal(text: string, span: Span): Span {
  const lineStart = text.lastIndexOf("\n", span.start - 1) + 1;
  const tail = /^\s*,?[ \t]*(\r?\n)/.exec(text.slice(span.end));
  if (/^\s*$/.test(text.slice(lineStart, span.start)) && tail) return { start: lineStart, end: span.end + tail[0].length };
  const comma = /^\s*,\s*/.exec(text.slice(span.end));
  return { start: span.start, end: span.end + (comma ? comma[0].length : 0) };
}

// ---------- Proposal text ----------

const quote = (s: string) => `"${s}"`;

export function describeEdits(file: PromptFile, patch: Patch): string {
  const byPrompt = new Map<string, Edit[]>();
  for (const e of patch.edits) byPrompt.set(e.prompt, [...(byPrompt.get(e.prompt) ?? []), e]);
  const out: string[] = [];
  for (const [id, edits] of byPrompt) {
    const p = file.prompts[id];
    out.push(`**\`${id}\`**${p?.question ? `: ${p.question}` : ""}`, "");
    for (const e of edits) {
      if (e.op === "question") out.push(`- Reworded the question`, `  - Before: ${quote(e.from)}`, `  - After: ${quote(e.to)}`);
      if (e.op === "hint") out.push(`- Changed hint ${e.index + 1}`, `  - Before: ${quote(e.from)}`, `  - After: ${quote(e.to)}`);
      if (e.op === "add-hint") out.push(`- Added a hint${e.after >= 0 ? ` after hint ${e.after + 1}` : " at the top"}: ${quote(e.to)}`);
      if (e.op === "remove-hint") out.push(`- Removed hint ${e.index + 1}: ${quote(e.from)}`);
    }
    out.push("");
  }
  return out.join("\n");
}

export function proposalBody(o: { why: string; discussion?: string; file: PromptFile; patch: Patch; editorUrl?: string }): string {
  return [
    o.why.trim(),
    "",
    `### Changes to Jev's prompts`,
    `\`${o.patch.file}\` at \`${o.patch.base}\``,
    "",
    describeEdits(o.file, o.patch),
    o.discussion ? `Discussion: ${o.discussion}\n` : "",
    "If this passes, a bot opens a pull request with exactly the change below, and a maintainer reviews it before Jev plays with it.",
    o.editorUrl ? `Written with the Jeviatus editor: ${o.editorUrl}` : "",
    "",
    "```" + PATCH_FENCE,
    JSON.stringify(o.patch),
    "```",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
}

export function extractPatch(body: string): { patch?: Patch; problems: string[] } {
  const m = new RegExp("```" + PATCH_FENCE + "\\s*\\n([\\s\\S]*?)\\n```").exec(body);
  if (!m) return { problems: ["no patch block"] };
  try {
    return validatePatch(JSON.parse(m[1]));
  } catch {
    return { problems: ["patch block is not valid JSON"] };
  }
}

// ---------- Line diff, for previews ----------

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
  line: number; // line number in the old file (add: the line it follows)
}

// Changed lines with `context` lines around them; gaps are marked with a null.
export function lineDiff(a: string, b: string, context = 2): (DiffLine | null)[] {
  const x = a.split("\n");
  const y = b.split("\n");
  // Trim the shared head and tail so the LCS table covers only the changes.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail);
  const ys = y.slice(head, y.length - tail);
  const n = xs.length;
  const m = ys.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xs[i] === ys[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const all: DiffLine[] = x.slice(0, head).map((text, i) => ({ kind: "ctx" as const, text, line: i + 1 }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) {
      all.push({ kind: "ctx", text: xs[i], line: head + i + 1 });
      i++;
      j++;
    } else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) all.push({ kind: "del", text: xs[i], line: head + ++i });
    else all.push({ kind: "add", text: ys[j++], line: head + i });
  }
  x.slice(x.length - tail).forEach((text, k) => all.push({ kind: "ctx", text, line: x.length - tail + k + 1 }));
  const keep = all.map((d, k) => all.slice(Math.max(0, k - context), k + context + 1).some((e) => e.kind !== "ctx"));
  const out: (DiffLine | null)[] = [];
  all.forEach((d, k) => {
    if (keep[k]) out.push(d);
    else if (out.length && out[out.length - 1] !== null) out.push(null);
  });
  if (out[out.length - 1] === null) out.pop();
  return out;
}
