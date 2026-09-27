// Every change the improvement loop makes to Jev's strategy must rest on how
// OpenFront actually works: the game's source (vendor/OpenFrontIO), the
// community wikis, or r/OpenFrontIO (references.ts). The proposal cites them
// in a "Grounding" section, one per line:
//
//   - source: vendor/OpenFrontIO/src/core/execution/AttackExecution.ts:L120-L134 "exact quote"
//   - wiki: https://openfront.miraheze.org/wiki/Attacking_Guide "exact quote"
//   - reddit: https://www.reddit.com/r/OpenFrontIO/comments/abc123/... "exact quote"
//
// and this checks each quote against the text it cites: the file's lines
// (give or take a few), or the saved page or post. A change passes only when it
// has at least one citation and every citation checks out.

import fs from "node:fs";
import path from "node:path";

export type CitationKind = "source" | "wiki" | "reddit";

export interface Citation {
  kind: CitationKind;
  ref: string;
  lines: [number, number] | null;
  quote: string;
}

export interface GroundingResult {
  ok: Citation[];
  bad: { citation: Citation; why: string }[];
  grounded: boolean;
}

const MIN_QUOTE = 20;
// Lines either side of a cited range the quote may come from.
const SLACK = 5;

const LINE = /^\s*[-*]?\s*(source|wiki|reddit)\s*:\s*`?(\S+?)`?\s+["“](.+)["”]\s*$/i;

export function parseCitations(text: string): Citation[] {
  const out: Citation[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const kind = m[1]!.toLowerCase() as CitationKind;
    let ref = m[2]!;
    let lines: [number, number] | null = null;
    if (kind === "source") {
      const r = /^(.*?):L?(\d+)(?:-L?(\d+))?$/.exec(ref);
      if (r) {
        ref = r[1]!;
        lines = [Number(r[2]), Number(r[3] ?? r[2])];
      }
    }
    out.push({ kind, ref, lines, quote: m[3]! });
  }
  return out;
}

// Case, whitespace, quote marks and markdown emphasis don't count.
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[`"'‘’“”*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.host.replace(/^(www|old)\./, "").toLowerCase()}${decodeURI(url.pathname).replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return u.toLowerCase().replace(/\/+$/, "");
  }
}

// URL → saved text, for every reference file under `dir`.
export function referenceTexts(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        const text = fs.readFileSync(p, "utf8");
        const url = /^URL: (\S+)/.exec(text)?.[1];
        if (url) out.set(normalizeUrl(url), text);
      }
    }
  };
  walk(dir);
  return out;
}

export function checkCitations(citations: Citation[], opts: { root: string; references: Map<string, string> }): GroundingResult {
  const ok: Citation[] = [];
  const bad: GroundingResult["bad"] = [];
  for (const c of citations) {
    const quote = normalize(c.quote);
    const fail = (why: string) => bad.push({ citation: c, why });
    if (quote.length < MIN_QUOTE) {
      fail(`quote shorter than ${MIN_QUOTE} characters`);
      continue;
    }
    let text: string | undefined;
    if (c.kind === "source") {
      const rel = path.normalize(c.ref).replace(/^\.\//, "");
      if (!rel.startsWith("vendor/OpenFrontIO/") || rel.includes("..")) {
        fail("source citations must point into OpenFront's code (vendor/OpenFrontIO/)");
        continue;
      }
      const file = path.join(opts.root, rel);
      if (!fs.existsSync(file)) {
        fail(`no such file ${rel}`);
        continue;
      }
      const all = fs.readFileSync(file, "utf8").split("\n");
      text = (c.lines ? all.slice(Math.max(0, c.lines[0] - 1 - SLACK), c.lines[1] + SLACK) : all).join("\n");
    } else {
      const host = normalizeUrl(c.ref).split("/")[0] ?? "";
      if (c.kind === "reddit" && host !== "reddit.com") {
        fail("reddit citations must be reddit.com links");
        continue;
      }
      text = opts.references.get(normalizeUrl(c.ref));
      if (text === undefined) {
        fail(`${c.ref} isn't one of the saved references (cite the URL on the file's first line)`);
        continue;
      }
    }
    if (normalize(text).includes(quote)) ok.push(c);
    else fail(c.lines ? `quote not found in ${c.ref} around lines ${c.lines[0]}-${c.lines[1]}` : `quote not found in ${c.ref}`);
  }
  return { ok, bad, grounded: ok.length > 0 && bad.length === 0 };
}

export function describeProblems(r: GroundingResult): string {
  if (r.ok.length === 0 && r.bad.length === 0) return "the proposal has no Grounding citations";
  return r.bad.map((b) => `- ${b.citation.kind}: ${b.citation.ref}${b.citation.lines ? `:L${b.citation.lines[0]}-L${b.citation.lines[1]}` : ""}: ${b.why}`).join("\n");
}
