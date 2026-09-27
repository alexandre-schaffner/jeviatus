// Evolution moments: Jev's lab (stream/lab.ts) proposing a change to Jev's
// decision code on camera, and the verdict once real games have measured it.
// Pure: the pipeline (clips/pipeline.ts) reads git, the lab state, the stream
// log and the traces, and renders what this picks (clips/evorender.ts).
//
// Sources:
// - each change is a commit on a local `jev-lab/<n>-<slug>` branch whose
//   parent is the build it was written against (the "before");
// - games count toward a build when their trace header names its commit
//   (harness/improve/measure.ts, the same rule the lab judges by);
// - the lab's state.json lists past attempts with the lab's own verdict;
// - the stream log shows when each lab session was on screen.

import type { GameRecord } from "../harness/analyze/load";
import { gamesFor, isBetter, measure } from "../harness/improve/measure";
import type { BuildStats, EvolutionFacts } from "./metadata";

export interface LabCommit {
  sha: string;
  parent: string;
  branch: string;
  title: string;
  body: string;
  committedAtMs: number;
  files: string[];
  patch: string;
}

export interface LabSession {
  startMs: number;
  endMs: number;
}

export interface LabAttempt {
  title: string;
  verdict: string;
}

export interface DiffLine {
  kind: "file" | "hunk" | "add" | "del" | "ctx";
  text: string;
}

export interface EvolutionMoment {
  id: string;
  stage: "proposed" | "verdict";
  commit: LabCommit;
  n: number | null;
  facts: EvolutionFacts;
  diff: DiffLine[];
  // When the lab was on screen writing it, if the log shows it.
  session: LabSession | null;
  // Game directories played on the build before and on the change.
  beforeGames: string[];
  afterGames: string[];
}

// The stream log: "<iso> [driver] game N over: ..." ends a match; when N is a
// multiple of the lab's rhythm ("[lab] live coding every K games") the lab
// session follows, until the driver looks for the next match. A restart
// ("shutting down", a new "[lab] live coding" line) resets the game count.
export function parseLabSessions(log: string): LabSession[] {
  const out: LabSession[] = [];
  let every: number | null = null;
  let open: number | null = null;
  const close = (at: number) => {
    if (open !== null && at > open) out.push({ startMs: open, endMs: at });
    open = null;
  };
  for (const line of log.split("\n")) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line);
    if (!m) continue;
    const at = Date.parse(m[1]!);
    const text = m[2]!;
    const rhythm = /^\[lab\] live coding every (\d+) games?/.exec(text);
    if (rhythm) {
      close(at);
      every = Number(rhythm[1]);
      continue;
    }
    if (text === "shutting down") {
      close(at);
      continue;
    }
    const over = /^\[driver\] game (\d+) over:/.exec(text);
    if (over && every !== null && Number(over[1]) % every === 0) {
      close(at);
      // The driver holds the result on screen for 4 s before cutting to the lab.
      open = at + 4_000;
      continue;
    }
    if (open !== null && /^\[driver\] (next game plays|connected to Chromium)/.test(text)) close(at);
  }
  return out;
}

// "jev-lab/3-hold-less-when-attacked" -> 3
export function changeNumber(branch: string): number | null {
  const m = /jev-lab\/(\d+)-/.exec(branch);
  return m ? Number(m[1]) : null;
}

// The part of the diff worth showing: decision code before tests, changed
// lines with a little context, each line short enough for a phone.
export function diffSnippet(patch: string, maxLines = 16, maxChars = 46): DiffLine[] {
  type FileDiff = { file: string; lines: DiffLine[] };
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const raw of patch.split("\n")) {
    const header = /^diff --git a\/(\S+) b\//.exec(raw);
    if (header) {
      cur = { file: header[1]!, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|\\ No newline)/.test(raw)) continue;
    const clip = (s: string) => {
      const t = s.replace(/\t/g, "  ").trimEnd();
      return t.length > maxChars ? `${t.slice(0, maxChars - 1)}…` : t;
    };
    if (raw.startsWith("@@")) cur.lines.push({ kind: "hunk", text: clip(raw.replace(/^@@[^@]*@@\s*/, "") || "…") });
    else if (raw.startsWith("+")) cur.lines.push({ kind: "add", text: clip(`+ ${raw.slice(1).trim()}`) });
    else if (raw.startsWith("-")) cur.lines.push({ kind: "del", text: clip(`- ${raw.slice(1).trim()}`) });
    else if (raw.trim()) cur.lines.push({ kind: "ctx", text: clip(`  ${raw.slice(1).trim()}`) });
  }
  // Only lines near a change, and no blank-ish context runs.
  for (const f of files) {
    const near = (i: number) => f.lines.slice(Math.max(0, i - 1), i + 2).some((l) => l.kind === "add" || l.kind === "del");
    f.lines = f.lines.filter((l, i) => l.kind !== "ctx" || near(i)).filter((l) => l.kind !== "hunk");
  }
  files.sort((a, b) => Number(a.file.startsWith("tests/")) - Number(b.file.startsWith("tests/")));
  const out: DiffLine[] = [];
  for (const f of files) {
    if (f.lines.length === 0) continue;
    if (out.length + 2 > maxLines) break;
    out.push({ kind: "file", text: f.file.length > maxChars ? `…${f.file.slice(-(maxChars - 1))}` : f.file });
    for (const l of f.lines) {
      if (out.length >= maxLines) break;
      out.push(l);
    }
  }
  return out;
}

export function buildStats(sha: string, games: GameRecord[]): BuildStats | null {
  if (games.length === 0) return null;
  const a = measure(sha.slice(0, 7), sha, games).aggregate;
  return { sha, games: a.games, wins: a.wins, meanPlacement: a.meanPlacement === null ? null : Math.round(a.meanPlacement * 10) / 10, medianMinutes: Math.round(a.medianMinutes * 10) / 10, meanPeakShare: a.meanPeakShare };
}

// The lab's own verdict for a change, when state.json has it.
export function labVerdict(title: string, attempts: LabAttempt[]): "kept" | "dropped" | null {
  const a = [...attempts].reverse().find((x) => x.title === title);
  if (!a) return null;
  if (/helped|kept/i.test(a.verdict)) return "kept";
  if (/did not help|dropped/i.test(a.verdict)) return "dropped";
  return null;
}

export function evolutionMoments(input: { commits: LabCommit[]; sessions: LabSession[]; games: GameRecord[]; gamesPerBuild: number; attempts: LabAttempt[] }): EvolutionMoment[] {
  const out: EvolutionMoment[] = [];
  const dirs = (gs: GameRecord[]) => [...new Set(gs.map((g) => g.dir))];
  for (const c of [...input.commits].sort((a, b) => a.committedAtMs - b.committedAtMs)) {
    const n = changeNumber(c.branch);
    const beforeGames = gamesFor(input.games, c.parent);
    const afterGames = gamesFor(input.games, c.sha);
    const before = buildStats(c.parent, beforeGames);
    const after = buildStats(c.sha, afterGames);
    // The session that wrote it: the last one to start before the commit.
    const session = [...input.sessions].reverse().find((s) => s.startMs <= c.committedAtMs && c.committedAtMs <= s.endMs + 120_000) ?? null;
    const diff = diffSnippet(c.patch);
    const base = { commit: c, n, diff, session, beforeGames: dirs(beforeGames), afterGames: dirs(afterGames) };
    const facts = (stage: "proposed" | "verdict", verdict: "kept" | "dropped" | null): EvolutionFacts => ({ title: c.title, n, stage, verdict, before, after: stage === "verdict" ? after : null, files: c.files });
    out.push({ ...base, id: `evo-${c.sha.slice(0, 7)}-proposed`, stage: "proposed", facts: facts("proposed", null) });
    if (afterGames.length >= input.gamesPerBuild && beforeGames.length > 0) {
      const verdict = labVerdict(c.title, input.attempts) ?? (isBetter(measure("after", c.sha, afterGames).aggregate, measure("before", c.parent, beforeGames).aggregate) ? "kept" : "dropped");
      out.push({ ...base, id: `evo-${c.sha.slice(0, 7)}-verdict`, stage: "verdict", facts: facts("verdict", verdict) });
    }
  }
  return out;
}

// Parses `git log --format=%H%x00%P%x00%ct%x00%D%x00%B%x1e` output for the
// lab's branches: one record per commit.
export function parseLabLog(text: string): Omit<LabCommit, "files" | "patch">[] {
  const out: Omit<LabCommit, "files" | "patch">[] = [];
  for (const rec of text.split("\x1e")) {
    const [sha, parents, ct, refs, message] = rec.replace(/^\n+/, "").split("\x00");
    if (!sha || !/^[0-9a-f]{40}$/.test(sha.trim())) continue;
    const branch = (refs ?? "").split(",").map((r) => r.trim().replace(/^HEAD -> /, "")).find((r) => r.startsWith("jev-lab/")) ?? "";
    const [first, ...rest] = (message ?? "").trim().split("\n");
    out.push({ sha: sha.trim(), parent: (parents ?? "").trim().split(" ")[0] ?? "", branch, title: (first ?? "").trim(), body: rest.join("\n").trim(), committedAtMs: Number(ct) * 1000 });
  }
  return out;
}
