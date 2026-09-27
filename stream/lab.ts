// Live coding between matches: every few games the stream cuts to Jev's lab
// (studio.ts), where the improvement loop (scripts/improve.ts, one step at a
// time) runs on camera:
//
//   1. analyze Jev's recent games (the same report as `bun run analyze`);
//   2. once a change has enough games of its own, judge it against the build
//      before it: keep it as the new baseline, or drop it;
//   3. ask Claude Code, headless, for one change to Jev's decision system,
//      its reads, edits and reasoning scrolling by in the terminal;
//   4. typecheck and test it (one fix-up round if they fail);
//   5. commit it on a local branch, build the extension from it and restart
//      the browser, so the next games play on it.
//
// All of it happens in a worktree of its own (data/lab/worktree), never in
// your checkout. The first session snapshots your working tree (uncommitted
// work included) as the baseline. Branches stay local unless STREAM_LAB_PRS
// is on, which needs a clean, pushed branch to open PRs against. Claude Code
// runs with the improve loop's narrow tool list, with no secrets in its
// environment but its own login (claudeEnv), and the screen masks any secret
// that shows up anyway.

import fs from "node:fs";
import path from "node:path";
import { type GameRecord, findTraces, parseTrace } from "../harness/analyze/load";
import { aggregate, buildReport, gameRow, renderMoment, renderReport } from "../harness/analyze/report";
import { comparisonMarkdown, gamesFor, isBetter, measure, outsideAllowlist } from "../harness/improve/measure";
import { checkCitations, describeProblems, type GroundingResult, parseCitations, referenceTexts } from "../harness/improve/grounding";
import { ANALYSIS_DIR, changePrompt, type PastAttempt, parseProposal, PROPOSAL_FILE } from "../harness/improve/prompt";
import { REFERENCES_DIR } from "../harness/improve/references";
import type { LabBand } from "./band";
import type { Mood } from "./avatar";
import type { Studio } from "./studio";

export interface LabOptions {
  repo: string;
  dir: string;
  traceDirs: string[];
  extensionDir: string;
  gamesPerBuild: number;
  // A session every this many games (for the band's "next session").
  everyGames: number;
  maxMinutes: number;
  model: string | null;
  prs: boolean;
  // The wikis and r/OpenFrontIO, saved by harness/improve/references.ts.
  references: string;
}

export interface LabDeps {
  studio: Studio;
  log: (line: string) => void;
  band: (status: string) => void;
  // A line for the commentator.
  announce: (key: string, facts: string, fallback: string, mood: Mood) => void;
  // Restart the browser so it loads the extension just built.
  restartBrowser: () => Promise<void>;
}

interface Build {
  sha: string;
  label: string;
  title?: string;
  branch?: string;
  pr?: string | null;
}

interface LabState {
  baseline: Build | null;
  candidate: Build | null;
  // The branch PRs go against (STREAM_LAB_PRS), when the baseline is a pushed commit.
  baseBranch: string | null;
  attempts: PastAttempt[];
  changes: number;
}

// The lab's commits are machine-made and local: never signed.
const UNSIGNED = ["-c", "commit.gpgsign=false"];

// Claude Code's tools: read and edit, run typecheck and tests, look at git. Nothing else.
const TOOLS = "Read,Edit,Write,Glob,Grep,Bash(bun run typecheck),Bash(bun test:*),Bash(git diff:*),Bash(git status:*)";
// Never handed to Claude Code, whatever it runs.
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|STREAM_URL|WALLET|MINT/i;

export function secretValues(env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV.test(k) && typeof v === "string" && v.length >= 8)
    .map(([, v]) => v!);
}

export function scrubbedEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => !SECRET_ENV.test(e[0]) && typeof e[1] === "string"));
}

// Claude Code's environment: the scrubbed one plus its own login, when it
// comes from env rather than a local `claude` login (a Mac's keychain). On a
// server that's CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`, billed to a
// Claude subscription), else LAB_ANTHROPIC_API_KEY (billed to the API key's
// organization; kept apart from the commentator's ANTHROPIC_API_KEY so the lab
// never spends it by accident). It's still masked on screen like every secret.
export function claudeEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out = scrubbedEnv(env);
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const apiKey = env.LAB_ANTHROPIC_API_KEY?.trim();
  if (oauth) out.CLAUDE_CODE_OAUTH_TOKEN = oauth;
  else if (apiKey) out.ANTHROPIC_API_KEY = apiKey;
  return out;
}

// One line per Claude Code stream-json event, for the terminal.
export function describeEvent(e: { type?: string; message?: { content?: unknown[] }; result?: string; total_cost_usd?: number }): { kind: "text" | "tool" | "add" | "del" | "out" | "ok" | "err"; text: string }[] {
  const out: ReturnType<typeof describeEvent> = [];
  const content = (e.message?.content ?? []) as { type: string; text?: string; name?: string; input?: Record<string, unknown>; content?: unknown; is_error?: boolean }[];
  if (e.type === "assistant") {
    for (const c of content) {
      if (c.type === "text" && c.text?.trim()) out.push({ kind: "text", text: c.text.trim() });
      if (c.type !== "tool_use") continue;
      const i = c.input ?? {};
      const file = typeof i.file_path === "string" ? i.file_path.replace(/^.*?\/(harness|tests|extension|stream|scripts|\.loop)\//, "$1/") : "";
      if (c.name === "Read") out.push({ kind: "tool", text: `> read ${file}` });
      else if (c.name === "Grep" || c.name === "Glob") out.push({ kind: "tool", text: `> ${c.name.toLowerCase()} ${String(i.pattern ?? "")}${i.path ? ` in ${String(i.path).replace(/^.*\//, "")}` : ""}` });
      else if (c.name === "Bash") out.push({ kind: "tool", text: `$ ${String(i.command ?? "")}` });
      else if (c.name === "Edit" || c.name === "Write") {
        out.push({ kind: "tool", text: `> ${c.name === "Edit" ? "edit" : "write"} ${file}` });
        const lines = (s: unknown) => (typeof s === "string" ? s.split("\n") : []);
        for (const l of lines(i.old_string).slice(0, 14)) out.push({ kind: "del", text: `- ${l}` });
        for (const l of lines(i.new_string ?? i.content).slice(0, 24)) out.push({ kind: "add", text: `+ ${l}` });
      } else if (c.name) out.push({ kind: "tool", text: `> ${c.name}` });
    }
  } else if (e.type === "user") {
    for (const c of content) {
      if (c.type !== "tool_result") continue;
      const text = typeof c.content === "string" ? c.content : Array.isArray(c.content) ? c.content.map((x: { text?: string }) => x.text ?? "").join("\n") : "";
      const first = text.split("\n").filter((l) => l.trim()).slice(0, c.is_error ? 4 : 2);
      for (const l of first) out.push({ kind: c.is_error ? "err" : "out", text: `  ${l.slice(0, 160)}` });
    }
  } else if (e.type === "result") {
    out.push({ kind: "ok", text: `done${typeof e.total_cost_usd === "number" ? ` ($${e.total_cost_usd.toFixed(2)})` : ""}` });
  }
  return out;
}

export class Lab {
  private readonly wt: string;
  private readonly stateFile: string;
  private state: LabState;
  private readonly headers = new Map<string, { size: number; commit: string | null }>();
  // A new build waits for the browser restart at the end of the session.
  private restart = false;

  constructor(
    private readonly o: LabOptions,
    private readonly d: LabDeps,
  ) {
    this.wt = path.join(o.dir, "worktree");
    this.stateFile = path.join(o.dir, "state.json");
    fs.mkdirSync(o.dir, { recursive: true });
    this.state = fs.existsSync(this.stateFile)
      ? (JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as LabState)
      : { baseline: null, candidate: null, baseBranch: null, attempts: [], changes: 0 };
  }

  private save(): void {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  private async sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; allowFail?: boolean } = {}): Promise<{ ok: boolean; out: string }> {
    const p = Bun.spawn(cmd, { cwd: opts.cwd ?? this.o.repo, env: opts.env ?? scrubbedEnv(), stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const ok = (await p.exited) === 0;
    if (!ok && !opts.allowFail) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${(err || out).trim().slice(-600)}`);
    return { ok, out: ok ? out.trim() : `${out}\n${err}`.trim() };
  }

  // The build the browser runs right now, as stamped by the extension build.
  private installedSha(): string | null {
    try {
      return /Harness: (\S+)/.exec(fs.readFileSync(path.join(this.o.extensionDir, "BUILD.txt"), "utf8"))?.[1] ?? null;
    } catch {
      return null;
    }
  }

  // Games whose trace header names `sha` (headers are read once per size).
  private gamesOn(sha: string): GameRecord[] {
    const out: GameRecord[] = [];
    for (const file of findTraces(this.o.traceDirs)) {
      const size = fs.statSync(file).size;
      let h = this.headers.get(file);
      if (!h || h.size !== size) {
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const commit = /"harnessCommit":"([^"]+)"/.exec(buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "")?.[1] ?? null;
        h = { size, commit };
        this.headers.set(file, h);
      }
      if (h.commit === sha) out.push(...parseTrace(fs.readFileSync(file, "utf8"), path.dirname(file)));
    }
    return gamesFor(out, sha);
  }

  private recentGames(n: number): GameRecord[] {
    const files = findTraces(this.o.traceDirs)
      .sort((a, b) => path.basename(path.dirname(b)).localeCompare(path.basename(path.dirname(a))))
      .slice(0, n);
    return files.flatMap((f) => parseTrace(fs.readFileSync(f, "utf8"), path.dirname(f))).filter((g) => g.steps.length > 0);
  }

  // For the band: the build the games are measuring and how its games went.
  summary(): LabBand {
    const s = this.state;
    const build = s.candidate ?? s.baseline;
    const base = { needed: this.o.gamesPerBuild, everyGames: this.o.everyGames };
    if (!build) return { build: null, title: null, games: 0, wins: 0, meanPlacement: null, ...base };
    const games = this.gamesOn(build.sha);
    const a = aggregate(build.label, games.map(gameRow));
    return { build: build.label, title: build.title ?? null, games: games.length, wins: a.wins, meanPlacement: a.meanPlacement, ...base };
  }

  // --- worktree -----------------------------------------------------------------------

  private async ensureWorktree(): Promise<void> {
    await this.sh(["git", "worktree", "prune"], { allowFail: true });
    // In the container the repository is part of the image, the worktree is
    // on the volume: after a redeploy the worktree points at a repository
    // that's gone, and is made again.
    if (fs.existsSync(path.join(this.wt, ".git")) && (await this.sh(["git", "rev-parse", "--git-dir"], { cwd: this.wt, allowFail: true })).ok) return;
    fs.rmSync(this.wt, { recursive: true, force: true });
    await this.sh(["git", "worktree", "add", "--detach", this.wt, "HEAD"]);
    this.link();
  }

  // Builds whose commits this repository doesn't have (the lab's commits
  // lived in a previous container's image): measuring starts over from a new
  // baseline. Past attempts are kept, for the prompt.
  private async forgetLostBuilds(): Promise<void> {
    const s = this.state;
    const lost = async (b: Build | null) => b !== null && !(await this.sh(["git", "cat-file", "-e", `${b.sha}^{commit}`], { allowFail: true })).ok;
    if (!(await lost(s.baseline)) && !(await lost(s.candidate))) return;
    this.d.log("[lab] the saved builds aren't in this repository (a redeploy?); starting over from a new baseline");
    s.baseline = null;
    s.candidate = null;
    s.baseBranch = null;
    this.save();
  }

  // The worktree shares this checkout's dependencies and OpenFront. A checkout
  // turns the submodule path back into an empty folder, so this runs after each.
  private link(): void {
    for (const rel of ["vendor/OpenFrontIO", "node_modules"]) {
      const at = path.join(this.wt, rel);
      const st = fs.lstatSync(at, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) continue;
      if (st?.isDirectory() && fs.readdirSync(at).length > 0) throw new Error(`${at} is a real folder; not replacing it`);
      fs.rmSync(at, { recursive: true, force: true });
      fs.symlinkSync(path.join(this.o.repo, rel), at);
    }
  }

  private async checkout(sha: string): Promise<void> {
    await this.sh(["git", "checkout", "--quiet", "--force", "--detach", sha], { cwd: this.wt });
    this.link();
  }

  // A commit of your working tree as it is (uncommitted and untracked work
  // included, .gitignore respected), made with a scratch index: your index,
  // branches and files are untouched.
  private async snapshot(): Promise<string> {
    const index = path.join(this.o.dir, "snapshot.index");
    const env = { ...scrubbedEnv(), GIT_INDEX_FILE: index };
    await this.sh(["git", "read-tree", "HEAD"], { env });
    await this.sh(["git", "add", "-A", "--", ".", ":!vendor"], { env });
    const tree = (await this.sh(["git", "write-tree"], { env })).out;
    const commit = (await this.sh(["git", ...UNSIGNED, "commit-tree", tree, "-p", "HEAD", "-m", "Jev's lab: baseline (snapshot of the working tree)"])).out;
    // A ref keeps it from being garbage-collected.
    await this.sh(["git", "update-ref", "refs/jev-lab/baseline", commit]);
    fs.rmSync(index, { force: true });
    return commit;
  }

  private async install(build: Build): Promise<void> {
    this.d.studio.line("tool", `$ bun scripts/build-extension.ts   # ${build.label} ${build.sha.slice(0, 7)}`);
    await this.checkout(build.sha);
    await this.sh(["bun", "scripts/build-extension.ts", "--out", this.o.extensionDir], { cwd: this.wt });
    const stamped = this.installedSha();
    if (stamped !== build.sha) throw new Error(`the build is stamped ${stamped}, expected ${build.sha}`);
    this.d.studio.line("ok", `built ${build.label}: the next games play on it`);
    this.restart = true;
  }

  // --- one session ----------------------------------------------------------------------

  async session(): Promise<void> {
    const { studio } = this.d;
    const started = Date.now();
    studio.reset("Claude Code studies Jev's last games and rewrites one piece of its brain. The next games test the change.");
    this.d.band("LIVE CODING: Jev's lab is analyzing the last games");
    this.d.announce("lab", "The stream cut to Jev's lab: Claude Code will analyze Jev's recent games live and change one piece of its decision code; the next games test it.", "Alright, recess is over. Back to the lab. Let's cut open the kid's brain and see what's wrong with it.", "smug");
    try {
      await this.ensureWorktree();
      await this.forgetLostBuilds();
      await this.analyze();
      await this.advance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.d.log(`[lab] ${msg}`);
      studio.line("err", msg.slice(0, 400));
    }
    // Leave the result on screen for a beat.
    await Bun.sleep(Math.max(8_000, 30_000 - (Date.now() - started)));
    if (this.restart) {
      this.restart = false;
      await this.d.restartBrowser();
    }
  }

  private async analyze(): Promise<void> {
    const { studio } = this.d;
    studio.step(0, "active");
    studio.line("tool", "$ bun run analyze");
    const games = this.recentGames(20);
    if (games.length === 0) {
      studio.line("out", "  no games logged yet");
      studio.step(0, "done", "no games yet");
      return;
    }
    const { report } = buildReport(games);
    const o = report.overall;
    studio.state.record = { games: o.games, wins: o.wins, meanPlacement: o.meanPlacement, medianMinutes: o.medianMinutes };
    studio.state.recent = games.slice(0, 5).map((g) => {
      const r = gameRow(g);
      return { result: r.streamResult ?? r.outcome, minutes: Math.round(r.minutesSurvived), peak: r.peakShare };
    });
    const bad = report.findings.filter((f) => f.kind === "bad" && f.count > 0).sort((a, b) => b.count - a.count);
    studio.state.problems = bad.slice(0, 5).map((f) => ({ title: f.title, count: f.count }));
    studio.line("out", `  ${o.games} game(s): ${o.wins} won, mean placement ${o.meanPlacement ?? "-"}, median ${o.medianMinutes} min survived`);
    for (const f of bad.slice(0, 6)) {
      studio.line("out", `  ${f.count}x ${f.title} (${f.games} game(s))`);
      await Bun.sleep(600);
    }
    studio.step(0, "done", `${o.games} games, ${o.wins} won`);
    const worst = bad[0];
    this.d.announce(
      "lab_analysis",
      `Analysis of Jev's last ${o.games} games: ${o.wins} won, median ${o.medianMinutes} minutes survived.${worst ? ` Most frequent problem: "${worst.title}" (${worst.count} times).` : ""}`,
      worst ? `Oh great. The kid's worst habit: ${worst.title.toLowerCase()}. ${worst.count} times! I am so embarrassed right now.` : "The numbers are in, and there's basically no numbers. Cool. Cool cool cool.",
      "neutral",
    );
  }

  // Judge, propose, test, ship: as far as this session's evidence allows.
  private async advance(): Promise<void> {
    const { studio } = this.d;
    const s = this.state;
    if (s.baseline === null) {
      studio.step(1, "skip", "first session: nothing to judge");
      studio.step(2, "skip");
      studio.step(3, "skip");
      studio.step(4, "active");
      const clean = (await this.sh(["git", "status", "--porcelain"], { allowFail: true })).out === "";
      let sha: string;
      if (this.o.prs && clean) {
        sha = (await this.sh(["git", "rev-parse", "HEAD"])).out;
        s.baseBranch = (await this.sh(["git", "rev-parse", "--abbrev-ref", "HEAD"])).out;
      } else {
        if (this.o.prs) studio.line("out", "  uncommitted work: pull requests stay off, branches stay local");
        sha = await this.snapshot();
        s.baseBranch = null;
      }
      s.baseline = { sha, label: "baseline" };
      this.save();
      studio.line("text", `Baseline set: ${sha.slice(0, 7)}. The next ${this.o.gamesPerBuild} games measure it before any change.`);
      await this.install(s.baseline);
      studio.step(4, "done", `baseline ${sha.slice(0, 7)} is live`);
      return;
    }

    const underTest = s.candidate ?? s.baseline;
    // An OpenFront update rebuilt the extension from your checkout: put the build back.
    const installed = this.installedSha();
    const games = this.gamesOn(underTest.sha);
    studio.state.build = { label: underTest.label, sha: underTest.sha, games: games.length, needed: this.o.gamesPerBuild };
    if (games.length < this.o.gamesPerBuild) {
      studio.step(1, "skip", `${underTest.label}: ${games.length}/${this.o.gamesPerBuild} games so far`);
      for (const i of [2, 3, 4]) studio.step(i, "skip");
      studio.line("text", `Still measuring ${underTest.label} (${underTest.sha.slice(0, 7)}): ${games.length} of ${this.o.gamesPerBuild} games played on it. No new change until it's judged.`);
      if (installed !== underTest.sha) await this.install(underTest);
      this.d.announce("lab_wait", `Jev's lab is still measuring ${underTest.title ? `the change "${underTest.title}"` : "the baseline"}: ${games.length} of ${this.o.gamesPerBuild} games played on it.`, `Still testing this build, ${games.length} of ${this.o.gamesPerBuild} games. Science takes time, people. Back to the war.`, "neutral");
      return;
    }

    if (s.candidate) {
      studio.step(1, "active");
      const base = measure("before", s.baseline.sha, this.gamesOn(s.baseline.sha));
      const cand = measure("after", s.candidate.sha, games);
      const better = isBetter(cand.aggregate, base.aggregate);
      const md = comparisonMarkdown(base, cand);
      studio.state.comparison = md
        .split("\n")
        .filter((l) => l.startsWith("| ") && !l.startsWith("| ---"))
        .slice(0, 8)
        .map((l) => l.split("|").slice(1, -1).map((c) => c.trim().replace(/`/g, "")));
      studio.line("head", `Verdict on "${s.candidate.title}"`);
      studio.line(better ? "ok" : "err", better ? "  better than before: it becomes the new baseline" : "  not better: dropped, back to the previous build");
      s.attempts.push({ title: s.candidate.title ?? s.candidate.label, verdict: better ? "helped; kept as the new baseline" : "did not help" });
      if (s.candidate.pr) await this.sh(["gh", "pr", "comment", s.candidate.pr, "--body", `## Measured live on stream, ${games.length} games\n\n${md}`], { allowFail: true });
      this.d.announce(
        "lab_verdict",
        `Verdict on the change "${s.candidate.title}": ${better ? "it beat the previous build and is kept" : "it did not beat the previous build and is dropped"} (${cand.aggregate.wins}/${cand.aggregate.games} wins vs ${base.aggregate.wins}/${base.aggregate.games}).`,
        better ? "The change actually worked! Science, you guys! I totally called it." : "That change was garbage. Throw it in the trash where it belongs.",
        better ? "happy" : "sad",
      );
      if (better) s.baseline = { ...s.candidate, label: "baseline" };
      s.candidate = null;
      this.save();
      studio.step(1, better ? "done" : "fail", better ? "kept" : "dropped");
      await Bun.sleep(4_000);
    } else studio.step(1, "skip", "baseline measured");

    await this.propose(s.baseline, this.gamesOn(s.baseline.sha));
  }

  private async claude(prompt: string, resume: string | null): Promise<{ sessionId: string | null; ok: boolean }> {
    const cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", TOOLS];
    if (this.o.model) cmd.push("--model", this.o.model);
    if (resume) cmd.push("--resume", resume);
    // OpenFront's code is a symlink out of the worktree: let the file tools read it.
    cmd.push("--add-dir", fs.realpathSync(path.join(this.o.repo, "vendor", "OpenFrontIO")));
    const p = Bun.spawn(cmd, { cwd: this.wt, env: claudeEnv(), stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), this.o.maxMinutes * 60_000);
    let sessionId: string | null = null;
    let buf = "";
    const decoder = new TextDecoder();
    for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!raw) continue;
        try {
          const e = JSON.parse(raw) as Parameters<typeof describeEvent>[0] & { session_id?: string };
          sessionId = e.session_id ?? sessionId;
          for (const l of describeEvent(e)) this.d.studio.line(l.kind, l.text);
        } catch {
          // not an event
        }
      }
    }
    clearTimeout(timer);
    const code = await p.exited;
    if (code !== 0) this.d.studio.line("err", `claude exited ${code}: ${(await new Response(p.stderr).text()).trim().split("\n").at(-1) ?? ""}`);
    return { sessionId, ok: code === 0 };
  }

  private async verify(): Promise<{ ok: boolean; out: string }> {
    const { studio } = this.d;
    studio.line("tool", "$ bun run typecheck");
    const tc = await this.sh(["bun", "run", "typecheck"], { cwd: this.wt, allowFail: true });
    if (!tc.ok) {
      for (const l of tc.out.split("\n").filter((l) => /error/i.test(l)).slice(0, 6)) studio.line("err", `  ${l}`);
      return tc;
    }
    studio.line("ok", "  no type errors");
    studio.line("tool", "$ bun test tests/*.test.ts");
    const t = await this.sh(["bash", "-c", "bun test tests/*.test.ts"], { cwd: this.wt, allowFail: true });
    const summary = t.out.split("\n").filter((l) => /^\s*\d+ (pass|fail)$/.test(l));
    for (const l of summary) studio.line(/fail/.test(l) && !/ 0 fail/.test(l) ? "err" : "ok", `  ${l.trim()}`);
    return t;
  }

  private async changedFiles(): Promise<string[]> {
    const scope = ["--", ".", ":!vendor", ":!node_modules", ":!.loop"];
    const tracked = (await this.sh(["git", "diff", "--name-only", "HEAD", ...scope], { cwd: this.wt })).out;
    const added = (await this.sh(["git", "ls-files", "--others", "--exclude-standard", ...scope], { cwd: this.wt })).out;
    return [...tracked.split("\n"), ...added.split("\n")].filter((f) => f !== "" && f !== "node_modules");
  }

  private async discard(): Promise<void> {
    await this.sh(["git", "checkout", "--quiet", "--force", "--", "."], { cwd: this.wt, allowFail: true });
    await this.sh(["git", "clean", "-fdq", "--", "harness", "tests"], { cwd: this.wt, allowFail: true });
    this.link();
  }

  // Checks the proposal's citations and shows them on screen.
  private ground(body: string): GroundingResult {
    const r = checkCitations(parseCitations(body), { root: this.wt, references: referenceTexts(path.join(this.wt, REFERENCES_DIR)) });
    const { studio } = this.d;
    studio.line("tool", "> checking the Grounding citations");
    for (const c of r.ok) studio.line("ok", `  ok  ${c.kind}: ${c.ref}${c.lines ? `:L${c.lines[0]}-L${c.lines[1]}` : ""}  "${c.quote.slice(0, 90)}"`);
    for (const b of r.bad) studio.line("err", `  bad ${b.citation.kind}: ${b.citation.ref}: ${b.why}`);
    if (r.ok.length === 0 && r.bad.length === 0) studio.line("err", "  no citations");
    return r;
  }

  private async propose(from: Build, games: GameRecord[]): Promise<void> {
    const { studio } = this.d;
    const s = this.state;
    const n = ++s.changes;
    this.save();
    studio.step(2, "active");
    this.d.band("LIVE CODING: Claude Code is writing a change to Jev's brain");
    await this.checkout(from.sha);
    await this.discard();
    // The same analysis files the improve loop hands Claude Code.
    const dir = path.join(this.wt, ANALYSIS_DIR);
    fs.rmSync(path.join(this.wt, ".loop"), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "moments"), { recursive: true });
    const { report, moments } = buildReport(games);
    for (const m of moments) fs.writeFileSync(path.join(dir, "moments", m.file), renderMoment(m));
    fs.writeFileSync(path.join(dir, "report.md"), renderReport(report));
    // What the change must be grounded in, besides OpenFront's code.
    if (fs.existsSync(this.o.references)) fs.cpSync(this.o.references, path.join(this.wt, REFERENCES_DIR), { recursive: true });
    studio.line("head", `Change ${n}: Claude Code, from ${games.length} games on ${from.sha.slice(0, 7)}`);

    let run = await this.claude(changePrompt({ games: games.length, commit: from.sha, past: s.attempts, references: REFERENCES_DIR }), null);
    studio.step(2, run.ok ? "done" : "fail");
    studio.step(3, "active");
    let check = await this.verify();
    if (!check.ok && run.sessionId) {
      studio.line("head", "Tests fail: one round to fix them");
      run = await this.claude(`Typecheck or tests fail after your change:\n\n${check.out.slice(-6000)}\n\nFix it without widening the change, then update ${PROPOSAL_FILE} if needed.`, run.sessionId);
      check = await this.verify();
    }
    const file = path.join(this.wt, PROPOSAL_FILE);
    let proposal = fs.existsSync(file) ? parseProposal(fs.readFileSync(file, "utf8")) : null;
    // Grounded, or not at all: every citation must check out against its source.
    let grounding: GroundingResult | null = null;
    if (proposal && !proposal.noChange && check.ok) {
      grounding = this.ground(proposal.body);
      if (!grounding.grounded && run.sessionId) {
        studio.line("head", "Citations don't check out: one round to fix them");
        run = await this.claude(
          `The Grounding section of ${PROPOSAL_FILE} doesn't check out:\n\n${describeProblems(grounding)}\n\nFix the citations: quote verbatim from the cited lines, page or post (URL from the file's first line). If the evidence doesn't support the change, revert the change and write "NO CHANGE" instead. Keep typecheck and tests passing.`,
          run.sessionId,
        );
        check = await this.verify();
        proposal = fs.existsSync(file) ? parseProposal(fs.readFileSync(file, "utf8")) : null;
        grounding = proposal && !proposal.noChange ? this.ground(proposal.body) : null;
      }
    }
    const files = await this.changedFiles();
    const reason = !proposal
      ? `no ${PROPOSAL_FILE} written`
      : proposal.noChange
        ? null
        : files.length === 0
          ? "no files changed"
          : outsideAllowlist(files).length
            ? `changed files outside the decision system: ${outsideAllowlist(files).join(", ")}`
            : !check.ok
              ? "typecheck/tests still fail"
              : !grounding?.grounded
                ? `not grounded in OpenFront's code, the wikis or r/OpenFrontIO (${grounding ? describeProblems(grounding).split("\n")[0] : "no citations"})`
                : null;
    if (proposal?.noChange) {
      studio.step(3, "skip");
      studio.step(4, "skip");
      studio.line("text", `No change: ${proposal.body.split("\n")[0] ?? ""}`);
      s.attempts.push({ title: "no change", verdict: proposal.body.split("\n")[0] ?? "" });
      this.save();
      await this.discard();
      this.d.announce("lab_nochange", "Claude Code looked at the evidence and decided no change is justified yet.", "The robot says there's not enough evidence to change anything. Lazy robot. Typical.", "neutral");
      if (this.installedSha() !== from.sha) await this.install(from);
      return;
    }
    if (reason !== null || !proposal) {
      studio.step(3, "fail", reason ?? "");
      studio.step(4, "skip");
      studio.line("err", `Dropped: ${reason}`);
      s.attempts.push({ title: proposal?.title ?? `change ${n}`, verdict: `dropped (${reason})` });
      this.save();
      await this.discard();
      this.d.announce(
        "lab_failed",
        `Claude Code's change was dropped: ${reason}.`,
        reason?.startsWith("not grounded") ? "The robot tried to rewire the kid's brain with zero evidence. Made-up facts! Dropped!" : "The robot's change broke the tests. Great job, robot. Really great job.",
        "angry",
      );
      if (this.installedSha() !== from.sha) await this.install(from);
      return;
    }
    studio.step(3, "done");
    studio.step(4, "active");
    const slug = proposal.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const branch = `jev-lab/${n}-${slug}`;
    await this.sh(["git", "add", "--", ...files], { cwd: this.wt });
    // Unsigned: nobody is at the keyboard to unlock a signing key (1Password's
    // SSH signing fails unattended, and every change was lost to it).
    await this.sh(["git", ...UNSIGNED, "commit", "--quiet", "-m", proposal.title, "-m", proposal.body, "-m", "Co-Authored-By: Claude Code <noreply@anthropic.com>"], { cwd: this.wt });
    const sha = (await this.sh(["git", "rev-parse", "HEAD"], { cwd: this.wt })).out;
    // The branch only once the commit exists: a failed commit leaves no empty branch behind.
    await this.sh(["git", "branch", "--force", branch, sha], { cwd: this.wt });
    studio.line("ok", `committed ${sha.slice(0, 7)} on ${branch}: ${proposal.title}`);
    let pr: string | null = null;
    if (this.o.prs && s.baseBranch && from.sha === s.baseline?.sha) {
      const pushed = await this.sh(["git", "push", "--quiet", "-u", "origin", branch], { cwd: this.wt, allowFail: true });
      if (pushed.ok) {
        const body = `${proposal.body}\n\nWritten live on stream by Jev's lab from ${games.length} games on \`${from.sha.slice(0, 7)}\`. The next ${this.o.gamesPerBuild} games play on this change; the verdict is posted here.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
        const made = await this.sh(["gh", "pr", "create", "--base", s.baseBranch, "--head", branch, "--title", proposal.title, "--body", body], { cwd: this.wt, allowFail: true });
        pr = made.ok ? (made.out.split("\n").at(-1) ?? null) : null;
        if (pr) studio.line("ok", `opened ${pr}`);
      }
    }
    s.candidate = { sha, label: `change ${n}`, title: proposal.title, branch, pr };
    this.save();
    this.d.announce("lab_shipped", `Claude Code wrote a change to Jev's brain, "${proposal.title}"; it passed the tests and is live for the next games.`, `Brain surgery complete: ${proposal.title}. Tests pass. What could possibly go wrong?`, "happy");
    await this.install(s.candidate);
    studio.step(4, "done", `${sha.slice(0, 7)} is live`);
  }
}
