// The improvement loop: real games → analysis → one change by Claude Code →
// a PR → real games on that change → a verdict on the PR → repeat.
//
//   bun run improve -- [flags]
//
//   --base <branch>        pushed branch to start from (default: the current branch)
//   --iterations <n>       changes to try (default 3)
//   --games <n>            finished games per build before judging it (default 6)
//   --traces <dir>         where game traces land; repeatable (default runs/)
//   --extension-out <dir>  where each build goes, i.e. the unpacked extension
//                          loaded in your browser (default dist/jev-openfront-extension)
//   --model <m>            Claude model for the change runs (default: Claude Code's)
//   --poll <s>             seconds between trace checks (default 30)
//   --dry-run              local branches only: no push, no PRs, no comments
//
// Each build is identified by its commit, which the extension stamps into
// every trace: the loop only counts games played on the build under test.
// Keep `bun run trace-sink` running and the extension's Trace URL set.
//
// Changes stack: a change that beats its baseline becomes the base of the
// next one; one that doesn't is left as a PR and the next change starts over
// from the last good build. Nothing merges without you.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { type GameRecord, findTraces, parseTrace } from "../harness/analyze/load";
import { buildReport, renderMoment, renderReport } from "../harness/analyze/report";
import { loadConfig } from "../harness/config";
import { type BuildResult, comparisonMarkdown, gamesFor, isBetter, measure, outsideAllowlist } from "../harness/improve/measure";
import { ANALYSIS_DIR, changePrompt, type PastAttempt, parseProposal, PROPOSAL_FILE, type Proposal } from "../harness/improve/prompt";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    iterations: { type: "string", default: "3" },
    games: { type: "string", default: "6" },
    traces: { type: "string", multiple: true },
    "extension-out": { type: "string", default: "dist/jev-openfront-extension" },
    model: { type: "string" },
    poll: { type: "string", default: "30" },
    "dry-run": { type: "boolean", default: false },
  },
  strict: true,
});

const repo = path.resolve(import.meta.dir, "..");
const iterations = Number(values.iterations);
const perBuild = Number(values.games);
const traceDirs = (values.traces ?? [loadConfig().runsDir]).map((d) => path.resolve(d));
const extensionOut = path.resolve(values["extension-out"]!);
const dryRun = values["dry-run"]!;
const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const loopDir = path.join(traceDirs[0], "loop", runId);
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} [loop] ${line}`);

async function sh(cmd: string[], opts: { cwd?: string; stdin?: string; allowFail?: boolean } = {}): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd ?? repo, stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const ok = (await p.exited) === 0;
  if (!ok && !opts.allowFail) throw new Error(`${cmd.slice(0, 3).join(" ")} failed:\n${(err || out).trim().slice(-2000)}`);
  return { ok, out: ok ? out.trim() : `${out}\n${err}`.trim() };
}

// --- preflight -----------------------------------------------------------------------

const base = values.base ?? (await sh(["git", "rev-parse", "--abbrev-ref", "HEAD"])).out;
const baseSha = (await sh(["git", "rev-parse", `${base}^{commit}`])).out;
if (!dryRun) {
  const remote = (await sh(["git", "ls-remote", "origin", `refs/heads/${base}`])).out.split(/\s/)[0];
  if (remote !== baseSha) {
    throw new Error(`origin/${base} is ${remote ? remote.slice(0, 7) : "missing"}, local ${base} is ${baseSha.slice(0, 7)}: push ${base} first (PRs are opened against it)`);
  }
  await sh(["gh", "auth", "status"]);
}
await sh(["claude", "--version"]);

// A worktree of its own, sharing this checkout's dependencies and OpenFront.
const wt = path.join(os.tmpdir(), `jev-loop-${runId}`);
await sh(["git", "worktree", "add", "--detach", wt, baseSha]);
fs.rmSync(path.join(wt, "vendor", "OpenFrontIO"), { recursive: true, force: true });
fs.symlinkSync(path.join(repo, "vendor", "OpenFrontIO"), path.join(wt, "vendor", "OpenFrontIO"));
fs.symlinkSync(path.join(repo, "node_modules"), path.join(wt, "node_modules"));
// The loop judges a change by its tests: they must pass before it.
{
  const check = await sh(["bun", "run", "typecheck"], { cwd: wt, allowFail: true });
  const tests = check.ok ? await sh(["bash", "-c", "bun test tests/*.test.ts"], { cwd: wt, allowFail: true }) : check;
  if (!tests.ok) {
    await sh(["git", "worktree", "remove", "--force", wt], { allowFail: true });
    throw new Error(`typecheck/tests fail on ${base} itself; fix them first:\n${tests.out.slice(-1500)}`);
  }
}
const cleanup = async () => void (await sh(["git", "worktree", "remove", "--force", wt], { allowFail: true }));
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});
fs.mkdirSync(loopDir, { recursive: true });

// --- builds and games ----------------------------------------------------------------

interface Build {
  label: string;
  branch: string;
  sha: string;
  pr: string | null;
  proposal?: Proposal;
}

async function install(build: Build): Promise<void> {
  await sh(["git", "checkout", "--quiet", "--detach", build.sha], { cwd: wt });
  await sh(["bun", "scripts/build-extension.ts", "--out", extensionOut], { cwd: wt });
  const stamped = /Harness: (\S+)/.exec(fs.readFileSync(path.join(extensionOut, "BUILD.txt"), "utf8"))?.[1];
  if (stamped !== build.sha) throw new Error(`the build is stamped ${stamped}, expected ${build.sha}: games couldn't be told apart`);
  log(`built ${build.label} (${build.sha.slice(0, 7)}) into ${extensionOut}`);
  log(`>>> reload the Jev extension in chrome://extensions, then play ${perBuild} games with Jev on <<<`);
}

// Traces are big and mostly other builds' games: read headers first, parse a
// matching trace only when it has grown.
const parsed = new Map<string, { size: number; records: GameRecord[] }>();
function tracesFor(sha: string): GameRecord[] {
  const out: GameRecord[] = [];
  for (const file of findTraces(traceDirs)) {
    const size = fs.statSync(file).size;
    let hit = parsed.get(file);
    if (hit === undefined || hit.size !== size) {
      const fd = fs.openSync(file, "r");
      const head = Buffer.alloc(8192);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      const first = head.subarray(0, n).toString("utf8").split("\n")[0];
      const matches = first.includes(`"harnessCommit":"${sha}"`);
      hit = { size, records: matches ? parseTrace(fs.readFileSync(file, "utf8"), path.dirname(file)) : [] };
      if (matches) parsed.set(file, hit);
    }
    out.push(...hit.records);
  }
  return gamesFor(out, sha);
}

async function waitForGames(build: Build): Promise<GameRecord[]> {
  let seen = -1;
  for (;;) {
    const games = tracesFor(build.sha);
    if (games.length !== seen) log(`${build.label} ${build.sha.slice(0, 7)}: ${games.length}/${perBuild} finished games`);
    seen = games.length;
    if (games.length >= perBuild) return games;
    await Bun.sleep(Number(values.poll) * 1000);
  }
}

function writeAnalysis(dir: string, games: GameRecord[]): ReturnType<typeof buildReport>["report"] {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "moments"), { recursive: true });
  const { report, moments } = buildReport(games);
  for (const m of moments) fs.writeFileSync(path.join(dir, "moments", m.file), renderMoment(m));
  fs.writeFileSync(path.join(dir, "report.md"), renderReport(report));
  return report;
}

// --- one change ----------------------------------------------------------------------

interface ClaudeRun {
  result: string;
  session_id: string;
  is_error: boolean;
  total_cost_usd?: number;
}

const TOOLS = "Read,Edit,Write,Glob,Grep,Bash(bun run typecheck),Bash(bun test:*),Bash(git diff:*),Bash(git status:*)";

async function claude(prompt: string, resume?: string): Promise<ClaudeRun> {
  const cmd = ["claude", "-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", TOOLS];
  if (values.model) cmd.push("--model", values.model);
  if (resume) cmd.push("--resume", resume);
  const { ok, out } = await sh(cmd, { cwd: wt, stdin: prompt, allowFail: true });
  const json = out.slice(out.indexOf("{"));
  let run: ClaudeRun;
  try {
    run = JSON.parse(json) as ClaudeRun;
  } catch {
    throw new Error(`claude returned no result${ok ? "" : ` (exit non-zero)`}: ${out.slice(-500)}`);
  }
  log(`claude: ${run.is_error ? "error" : "done"}${run.total_cost_usd ? ` ($${run.total_cost_usd.toFixed(2)})` : ""}: ${run.result.split("\n")[0].slice(0, 160)}`);
  return run;
}

async function verify(): Promise<{ ok: boolean; out: string }> {
  const tc = await sh(["bun", "run", "typecheck"], { cwd: wt, allowFail: true });
  if (!tc.ok) return tc;
  return sh(["bash", "-c", "bun test tests/*.test.ts"], { cwd: wt, allowFail: true });
}

async function changedFiles(): Promise<string[]> {
  const scope = ["--", ".", ":!vendor", ":!node_modules", ":!.loop"];
  const tracked = (await sh(["git", "diff", "--name-only", "HEAD", ...scope], { cwd: wt })).out;
  const added = (await sh(["git", "ls-files", "--others", "--exclude-standard", ...scope], { cwd: wt })).out;
  return [...tracked.split("\n"), ...added.split("\n")].filter((f) => f !== "" && f !== "node_modules");
}

// Throws the attempt away, branch included.
async function discard(): Promise<void> {
  await sh(["git", "checkout", "--quiet", "--", "harness", "tests"], { cwd: wt, allowFail: true });
  await sh(["git", "clean", "-fdq", "--", "harness", "tests"], { cwd: wt, allowFail: true });
  const branch = (await sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt })).out;
  await sh(["git", "checkout", "--quiet", "--detach"], { cwd: wt });
  if (branch.startsWith("jev-loop/")) await sh(["git", "branch", "--quiet", "-D", branch], { cwd: wt, allowFail: true });
}

type Attempt = { kind: "build"; build: Build } | { kind: "none"; reason: string } | { kind: "failed"; title: string; reason: string };

async function propose(n: number, from: Build, baseGames: GameRecord[], past: PastAttempt[]): Promise<Attempt> {
  const branch = `jev-loop/${runId}-${n}`;
  await sh(["git", "checkout", "--quiet", "-B", branch, from.sha], { cwd: wt });
  fs.rmSync(path.join(wt, ".loop"), { recursive: true, force: true });
  const report = writeAnalysis(path.join(wt, ANALYSIS_DIR), baseGames);
  log(`change ${n}: asking Claude Code (analysis of ${baseGames.length} games on ${from.sha.slice(0, 7)})`);

  let run = await claude(changePrompt({ games: baseGames.length, commit: from.sha, past }));
  let check = await verify();
  if (!check.ok) {
    log(`change ${n}: typecheck/tests fail; asking for a fix`);
    run = await claude(`Typecheck or tests fail after your change:\n\n${check.out.slice(-6000)}\n\nFix it without widening the change, then update ${PROPOSAL_FILE} if needed.`, run.session_id);
    check = await verify();
  }
  const file = path.join(wt, PROPOSAL_FILE);
  const proposal = fs.existsSync(file) ? parseProposal(fs.readFileSync(file, "utf8")) : null;
  const files = await changedFiles();
  const fail = async (reason: string): Promise<Attempt> => {
    // Kept for the record: what was tried and why it was dropped.
    const diff = (await sh(["git", "diff", "HEAD"], { cwd: wt, allowFail: true })).out;
    fs.writeFileSync(path.join(loopDir, `change-${n}-dropped.md`), `# ${proposal?.title ?? `change ${n}`}\n\nDropped: ${reason}\n\n${proposal?.body ?? ""}\n\n\`\`\`diff\n${diff}\n\`\`\`\n`);
    await discard();
    return { kind: "failed", title: proposal?.title ?? `change ${n}`, reason };
  };
  if (proposal === null) return fail(`no ${PROPOSAL_FILE} written`);
  if (proposal.noChange) {
    await discard();
    return { kind: "none", reason: proposal.body };
  }
  if (files.length === 0) return fail("no files changed");
  const outside = outsideAllowlist(files);
  if (outside.length > 0) return fail(`changed files outside the decision system: ${outside.join(", ")}`);
  if (!check.ok) return fail(`typecheck/tests still fail:\n${check.out.slice(-1500)}`);

  await sh(["git", "add", "--", ...files], { cwd: wt });
  await sh(["git", "commit", "--quiet", "-m", proposal.title, "-m", proposal.body, "-m", "Co-Authored-By: Claude Code <noreply@anthropic.com>"], { cwd: wt });
  const sha = (await sh(["git", "rev-parse", "HEAD"], { cwd: wt })).out;
  const top = report.findings
    .filter((f) => f.kind === "bad" && f.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((f) => `- ${f.title}: ${f.count}× in ${f.games} game(s)`);
  const body = [
    proposal.body,
    "",
    "## Evidence",
    "",
    `Proposed by the improvement loop (\`bun run improve\`, run ${runId}) from ${baseGames.length} real games on \`${from.sha.slice(0, 7)}\`. Most frequent problems there:`,
    "",
    ...top,
    "",
    "## Measuring",
    "",
    `The loop rebuilt the extension from this branch. Once ${perBuild} games have been played on it, it comments here with the comparison against \`${from.sha.slice(0, 7)}\`.`,
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n");
  let pr: string | null = null;
  if (dryRun) {
    fs.writeFileSync(path.join(loopDir, `pr-${n}.md`), `# ${proposal.title}\n\nbase: ${from.branch}\n\n${body}`);
    log(`change ${n}: committed ${sha.slice(0, 7)} on ${branch} (dry run: PR text in ${loopDir}/pr-${n}.md)`);
  } else {
    await sh(["git", "push", "--quiet", "-u", "origin", branch], { cwd: wt });
    pr = (await sh(["gh", "pr", "create", "--base", from.branch, "--head", branch, "--title", proposal.title, "--body", body], { cwd: wt })).out.split("\n").at(-1)!;
    log(`change ${n}: ${pr}`);
  }
  return { kind: "build", build: { label: `change ${n}`, branch, sha, pr, proposal } };
}

// --- the loop --------------------------------------------------------------------------

const gamesBy = new Map<string, GameRecord[]>();
const results = new Map<string, BuildResult>();
const past: PastAttempt[] = [];
let baseline: Build = { label: "baseline", branch: base, sha: baseSha, pr: null };
let candidate: Build | null = baseline;
let changes = 0;

try {
  log(`run ${runId}: ${iterations} change(s), ${perBuild} games per build, from ${base} (${baseSha.slice(0, 7)})${dryRun ? ", dry run" : ""}`);
  log(`watching ${traceDirs.join(", ")}; notes in ${loopDir}`);
  while (candidate !== null) {
    await install(candidate);
    const games = await waitForGames(candidate);
    gamesBy.set(candidate.sha, games);
    const result = measure(candidate.label, candidate.sha, games);
    results.set(candidate.sha, result);
    writeAnalysis(path.join(loopDir, candidate.label.replace(/\s+/g, "-")), games);

    if (candidate !== baseline) {
      const md = comparisonMarkdown(results.get(baseline.sha)!, result);
      const better = isBetter(result.aggregate, results.get(baseline.sha)!.aggregate);
      past.push({ title: candidate.proposal!.title, verdict: better ? "helped; kept as the new baseline" : "did not help" });
      const comment = `## Measured on ${games.length} real games\n\n${md}\n\n${better ? "The loop builds the next change on top of this one." : `The loop's next change starts again from \`${baseline.sha.slice(0, 7)}\`.`}`;
      fs.writeFileSync(path.join(loopDir, `${candidate.label.replace(/\s+/g, "-")}-verdict.md`), comment);
      if (candidate.pr && !dryRun) await sh(["gh", "pr", "comment", candidate.pr, "--body", comment], { cwd: wt });
      log(`${candidate.label}: ${better ? "better, kept" : "not better"}\n${md}`);
      if (better) baseline = candidate;
    }

    candidate = null;
    while (candidate === null && changes < iterations) {
      changes++;
      const attempt = await propose(changes, baseline, gamesBy.get(baseline.sha)!, past);
      if (attempt.kind === "build") candidate = attempt.build;
      else if (attempt.kind === "none") {
        log(`Claude Code sees nothing worth changing: ${attempt.reason.split("\n")[0]}`);
        changes = iterations;
      } else {
        log(`change ${changes} dropped: ${attempt.reason}`);
        past.push({ title: attempt.title, verdict: `dropped (${attempt.reason.split("\n")[0]})` });
      }
    }
  }
  log(`done. Best build: ${baseline.label} ${baseline.sha.slice(0, 7)} on ${baseline.branch}`);
  for (const [sha, r] of results) log(`  ${r.label} ${sha.slice(0, 7)}: ${r.aggregate.wins}/${r.aggregate.games} won, mean placement ${r.aggregate.meanPlacement ?? "–"}`);
} finally {
  await cleanup();
}
process.exit(0);
