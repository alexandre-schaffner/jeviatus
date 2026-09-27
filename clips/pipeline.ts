// One pass of the clip factory: keep the footage, find what's worth a clip,
// render what isn't rendered yet (one ffmpeg at a time, at the lowest
// priority, next to the live encoder), and write each clip's per-platform
// sidecar. Idempotent: the manifest remembers every clip by id.
//
// Clip kinds (ids are stable, so each clip is made once):
//   game-<gameID>              the game's 3 most epic moments (tiktok/)
//   moment-<gameID>-<tick>     one big moment with a longer run-up
//   bestof-<first>-<last>      the best moments of a batch of games
//   wipeouts-<first>-<last>    a batch's eliminations, back to back
//   evo-<sha>-proposed         the lab wrote a change (clips/evolution.ts)
//   evo-<sha>-verdict          ... and real games judged it

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type GameRecord, parseTrace as parseRecords } from "../harness/analyze/load";
import type { Jev } from "../harness/jev/client";
import type { Segment } from "../stream/recordings";
import { coveredBy, findTraceFiles, footage, type Locate, planClip, probe, runFfmpeg, segmentsWithDurations } from "../tiktok/make";
import { findMoments, type GameTrace, parseTrace, TICKS_PER_SEC } from "../tiktok/moments";
import { DEFAULT_BPM, type Music } from "../tiktok/music";
import { direct, OUTRO, type Pick, select } from "../tiktok/phrases";
import { type Clip, renderArgs, type Source } from "../tiktok/render";
import { archiveSegments, isFrozen, pruneArchive } from "./archive";
import { type EvolutionMoment, evolutionMoments, type LabAttempt, type LabCommit, parseLabLog, parseLabSessions } from "./evolution";
import { type EvolutionPlan, renderEvolutionArgs } from "./evorender";
import { type ClipFacts, pickFrom, sidecar } from "./metadata";

export interface PipelineConfig {
  recordings: string;
  runs: string;
  labDir: string;
  streamLog: string;
  outRoot: string;
  archiveMaxGB: number;
  repo: string;
  gamesPerBuild: number;
  jev: Jev | null;
  font: string;
  mono: string;
  bandLines: number;
  // At most this many renders per pass (the watcher comes back for the rest).
  limit: number;
  dryRun: boolean;
  // Only jobs whose id contains this.
  only: string | null;
  log: (line: string) => void;
}

interface Manifest {
  clips: Record<string, { file: string; kind: string; durationSec: number; renderedAt: string }>;
  // Jobs that will never render (no moments, no footage), and why.
  skipped: Record<string, string>;
  failed: Record<string, { count: number; error: string; at: string }>;
  // Freeze checks by footage window.
  frozen: Record<string, boolean>;
  // Games already grouped into compilations, so batches never shift.
  batches: string[][];
}

export interface PassResult {
  archived: number;
  rendered: string[];
  failed: string[];
  waiting: string[];
  pending: number;
}

interface Game {
  dir: string;
  id: string;
  trace: GameTrace;
  finished: boolean;
  endMs: number | null;
}

interface Renderable {
  args: string[];
  files: { path: string; content: string }[];
  durationSec: number;
  facts: Omit<ClipFacts, "id" | "kind" | "durationSec">;
  workDir: string;
}

// What a job needs to render; null = not yet (footage still being written);
// a string = never (and why).
type Plan = Renderable | null | string;

interface Job {
  id: string;
  kind: ClipFacts["kind"];
  plan: () => Promise<Plan>;
}

const HOOKS = ["AN AI IS PLAYING OPENFRONT VS REAL PEOPLE", "THIS AI PLAYS OPENFRONT 24/7 AGAINST HUMANS", "I LET AN AI LOOSE IN PUBLIC OPENFRONT LOBBIES"];
const BESTOF_HOOKS = ["ONE NIGHT OF AN AI PLAYING OPENFRONT", "AN AI VS REAL PEOPLE: THE BEST MOMENTS", "BEST OF JEV, THE AI THAT PLAYS OPENFRONT"];
const WIPEOUT_HOOKS = ["THIS AI KEEPS DELETING PEOPLE", "AN AI WIPING PLAYERS OFF THE MAP", "EVERYONE THIS AI TOUCHES DISAPPEARS"];
const BATCH = 6;
// One moment alone: a longer run-up (8 s at 120 bpm) and 4 s after the payoff.
const SINGLE = { leadBars: 4, tailBars: 2 } as const;
const MAX_FAILS = 2;
// How long a game's or session's footage may take to show up in the archive.
const FOOTAGE_WAIT_MS = 40 * 60_000;

export const gameIdOf = (dir: string) => path.basename(dir).split("-").at(-1) ?? path.basename(dir);
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const rank = (p: Pick) => p.epic * 0.75 + p.moment.heat * 0.25;

// Standalone single-moment clips: the few moments that carry a video alone.
export function standouts(picks: Pick[], max = 2, min = 0.72): Pick[] {
  return picks
    .filter((p) => rank(p) >= min)
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, max);
}

// A compilation's moments: the best across the batch, at most `perGame` from
// one game, in play order. `fits` narrows the kinds (e.g. eliminations).
export function compilationPicks<G>(batch: { game: G; picks: Pick[]; startMs: number }[], max: number, perGame: number, fits: (p: Pick) => boolean = () => true): { game: G; pick: Pick }[] {
  const all = batch.flatMap((b) => select(b.picks.filter(fits), perGame, 0.4).map((pick) => ({ game: b.game, pick, at: b.startMs + pick.moment.tick * 100 })));
  const used = new Set<string>();
  return all
    .sort((a, b) => rank(b.pick) - rank(a.pick))
    .slice(0, max)
    .sort((a, b) => a.at - b.at)
    .map(({ game, pick }) => {
      // No line twice in one video.
      const phrase = pick.ranked.find((r) => !used.has(r)) ?? pick.phrase;
      used.add(phrase);
      return { game, pick: { ...pick, phrase } };
    });
}

// New batches from games not in any earlier batch: whole batches only.
export function nextBatches(gameIds: string[], batches: string[][], size = BATCH): string[][] {
  const taken = new Set(batches.flat());
  const free = gameIds.filter((id) => !taken.has(id));
  const out: string[][] = [];
  for (let i = 0; i + size <= free.length; i += size) out.push(free.slice(i, i + size));
  return out;
}

export class Pipeline {
  private manifest: Manifest;
  private readonly manifestFile: string;
  private segments: (Segment & { durationSec: number })[] = [];
  readonly archive: string;

  constructor(private readonly c: PipelineConfig) {
    this.archive = path.join(c.outRoot, "archive", "recordings");
    this.manifestFile = path.join(c.outRoot, "manifest.json");
    mkdirSync(c.outRoot, { recursive: true });
    const saved = existsSync(this.manifestFile) ? (JSON.parse(readFileSync(this.manifestFile, "utf8")) as Partial<Manifest>) : {};
    this.manifest = { clips: {}, skipped: {}, failed: {}, frozen: {}, batches: [], ...saved };
  }

  private save(): void {
    if (this.c.dryRun) return;
    writeFileSync(this.manifestFile, `${JSON.stringify(this.manifest, null, 2)}\n`);
  }

  // --- inputs -------------------------------------------------------------------------

  private loadGames(): Game[] {
    const out: Game[] = [];
    for (const file of findTraceFiles([this.c.runs])) {
      const dir = path.dirname(file);
      const text = readFileSync(file, "utf8");
      const trace = parseTrace(text);
      const ended = /"type":"(stream_result|summary|death)"/.test(text);
      const idleMin = (Date.now() - statSync(file).mtimeMs) / 60_000;
      const endMs = trace.startedAtMs === null ? null : trace.startedAtMs + (trace.lastTick / TICKS_PER_SEC) * 1000;
      out.push({ dir, id: gameIdOf(dir), trace, finished: ended || idleMin > 20, endMs });
    }
    return out.sort((a, b) => (a.trace.startedAtMs ?? 0) - (b.trace.startedAtMs ?? 0));
  }

  // Jev's picks for every candidate moment of a game, asked once and cached.
  private async picks(g: Game): Promise<Pick[]> {
    const cache = path.join(this.c.outRoot, ".cache", "picks", `${path.basename(g.dir)}.json`);
    if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Pick[];
    const candidates = findMoments(g.trace);
    const picks = candidates.length ? await direct(candidates, g.trace, this.c.jev, this.c.log) : [];
    if (!this.c.dryRun) {
      mkdirSync(path.dirname(cache), { recursive: true });
      writeFileSync(cache, JSON.stringify(picks));
    }
    return picks;
  }

  private async frozen(sources: string[], seekSec: number, spanSec: number): Promise<boolean> {
    const key = `${sources.map((s) => path.basename(s)).join("+")}@${seekSec.toFixed(2)}+${spanSec.toFixed(2)}`;
    const known = this.manifest.frozen[key];
    if (known !== undefined) return known;
    const work = path.join(this.c.outRoot, ".cache", `freeze-${process.pid}.ffconcat`);
    mkdirSync(path.dirname(work), { recursive: true });
    const f = await isFrozen(sources, seekSec, spanSec, work);
    this.manifest.frozen[key] = f;
    return f;
  }

  private async sourceFor(file: string): Promise<Source | null> {
    const p = await probe(file);
    return p && { width: p.width, height: p.height, hasAudio: p.hasAudio, band: true, bandLines: this.c.bandLines, panel: true };
  }

  // Footage state of a game: in the archive, still coming, or never.
  private footageState(g: Game): "ready" | "wait" | "gone" {
    if (g.endMs === null) return "gone";
    if (this.segments.length > 0 && coveredBy(this.segments, g.endMs - 1000, g.endMs) !== null) return "ready";
    // The game's start may be covered even when its end isn't (the stream restarted).
    if (Date.now() - g.endMs > FOOTAGE_WAIT_MS) return this.segments.some((s) => s.startMs <= g.endMs! && s.startMs + s.durationSec * 1000 >= (g.trace.startedAtMs ?? 0)) ? "ready" : "gone";
    return "wait";
  }

  private music(): Music {
    return { file: null, bpm: DEFAULT_BPM, startSec: 0 };
  }

  // Cuts moments (from one or many games) into a tiktok/ video.
  private async momentsVideo(id: string, list: { pick: Pick; game: Game }[], opts: { hook: string; leadBars?: number; tailBars?: number; compilation?: boolean }): Promise<Plan> {
    const music = this.music();
    const clips: Clip[] = [];
    const used: { pick: Pick; game: Game }[] = [];
    for (const item of list) {
      const f = await footage(item.game.trace, this.archive, { segments: this.segments });
      if (typeof f === "string") continue;
      const c = planClip(item.pick, clips.length, music.bpm, f.locate, opts);
      if (!c) continue;
      if (await this.frozen(c.sources, c.seekSec, c.spanSec)) {
        this.c.log(`  ${id}: frozen footage at ${item.pick.moment.kind}@${item.pick.moment.tick}, skipped`);
        continue;
      }
      // Compilations say where each moment is from.
      const teaser = opts.compilation && clips.length > 0 && item.game.trace.map ? item.game.trace.map.toUpperCase() : c.teaser;
      clips.push({ ...c, teaser });
      used.push(item);
    }
    if (clips.length === 0) return "no usable footage";
    // A lone moment gets the single-clip run-up, so the outro doesn't cover its payoff.
    if (clips.length === 1 && !opts.leadBars) {
      const f = await footage(used[0]!.game.trace, this.archive, { segments: this.segments });
      const long = typeof f === "string" ? null : planClip(used[0]!.pick, 0, music.bpm, f.locate, { ...opts, ...SINGLE });
      if (long && !(await this.frozen(long.sources, long.seekSec, long.spanSec))) clips[0] = long;
    }
    const source = await this.sourceFor(clips[0]!.sources[0]!);
    if (!source) return "can't probe the footage";
    const workDir = path.join(this.c.outRoot, ".work", id);
    const plan = renderArgs({ clips, source, music, font: this.c.font, outro: OUTRO, out: this.outFile(id), workDir });
    const g0 = used[0]!.game.trace;
    const best = [...used].sort((a, b) => rank(b.pick) - rank(a.pick))[0]!.pick;
    return {
      ...plan,
      workDir,
      facts: {
        headline: best.phrase,
        alts: best.ranked.filter((r) => r !== best.phrase),
        names: [...new Set(used.flatMap((u) => [u.pick.moment.facts.target, u.pick.moment.facts.killer].filter((n): n is string => typeof n === "string")))],
        moments: used.map((u) => ({ kind: u.pick.moment.kind, what: u.pick.moment.what })),
        map: opts.compilation ? null : g0.map,
        humans: opts.compilation ? null : g0.humans,
        strategy: opts.compilation ? null : g0.strategy,
        ...(opts.compilation ? { games: new Set(used.map((u) => u.game.dir)).size } : {}),
      },
    };
  }

  // --- jobs ---------------------------------------------------------------------------

  private async gameJobs(games: Game[], waiting: string[]): Promise<Job[]> {
    const jobs: Job[] = [];
    const withPicks: { game: Game; picks: Pick[]; startMs: number }[] = [];
    for (const g of games.filter((x) => x.finished && x.trace.startedAtMs !== null)) {
      const state = this.footageState(g);
      if (state === "wait") {
        waiting.push(`game-${g.id}`);
        continue;
      }
      if (state === "gone") continue;
      const picks = await this.picks(g);
      withPicks.push({ game: g, picks, startMs: g.trace.startedAtMs! });
      jobs.push({
        id: `game-${g.id}`,
        kind: "highlight",
        plan: async () => {
          const chosen = select(picks, 3);
          return chosen.length ? this.momentsVideo(`game-${g.id}`, chosen.map((pick) => ({ pick, game: g })), { hook: pickFrom(HOOKS, g.id) }) : "no epic moments";
        },
      });
      // A game with one moment is already a single-moment clip.
      if (select(picks, 3).length < 2) continue;
      for (const p of standouts(picks)) {
        const id = `moment-${g.id}-${p.moment.tick}`;
        jobs.push({ id, kind: "moment", plan: () => this.momentsVideo(id, [{ pick: p, game: g }], { hook: pickFrom(HOOKS, id), ...SINGLE }) });
      }
    }

    // Compilations over batches of games that have footage.
    const ids = withPicks.map((w) => w.game.id);
    for (const batch of nextBatches(ids, this.manifest.batches)) this.manifest.batches.push(batch);
    for (const batch of this.manifest.batches) {
      const members = withPicks.filter((w) => batch.includes(w.game.id));
      if (members.length < batch.length / 2) continue; // footage pruned since
      const tag = `${batch[0]}-${batch.at(-1)}`;
      const best = compilationPicks(members, 5, 2);
      if (best.length >= 3) jobs.push({ id: `bestof-${tag}`, kind: "compilation", plan: () => this.momentsVideo(`bestof-${tag}`, best, { hook: pickFrom(BESTOF_HOOKS, tag), compilation: true }) });
      const wipes = compilationPicks(members, 4, 1,(p) => p.moment.kind === "wipeout" || p.moment.kind === "conquest");
      if (wipes.length >= 4) jobs.push({ id: `wipeouts-${tag}`, kind: "compilation", plan: () => this.momentsVideo(`wipeouts-${tag}`, wipes, { hook: pickFrom(WIPEOUT_HOOKS, tag), compilation: true }) });
    }
    return jobs;
  }

  private async git(args: string[]): Promise<string> {
    const p = Bun.spawn(["git", ...args], { cwd: this.c.repo, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : "";
  }

  // The lab's changes: one commit per jev-lab/* branch, its parent the build before.
  private async labCommits(): Promise<LabCommit[]> {
    const branches = (await this.git(["for-each-ref", "--format=%(refname:short)", "refs/heads/jev-lab/"])).split("\n").filter(Boolean);
    const out: LabCommit[] = [];
    for (const b of branches) {
      const [c] = parseLabLog(await this.git(["log", "-1", "--format=%H%x00%P%x00%ct%x00%D%x00%B%x1e", b]));
      if (!c || !c.parent) continue;
      const files = (await this.git(["diff", "--name-only", c.parent, c.sha])).split("\n").filter(Boolean);
      const patch = await this.git(["diff", "--no-color", "-U2", c.parent, c.sha]);
      out.push({ ...c, branch: c.branch || b, files, patch });
    }
    return out;
  }

  private labAttempts(): LabAttempt[] {
    try {
      return (JSON.parse(readFileSync(path.join(this.c.labDir, "state.json"), "utf8")) as { attempts?: LabAttempt[] }).attempts ?? [];
    } catch {
      return [];
    }
  }

  private async evolutionJobs(games: Game[], waiting: string[]): Promise<Job[]> {
    const commits = await this.labCommits();
    if (commits.length === 0) return [];
    const records: GameRecord[] = [];
    for (const g of games) records.push(...parseRecords(readFileSync(path.join(g.dir, "trace.jsonl"), "utf8"), g.dir));
    const sessions = existsSync(this.c.streamLog) ? parseLabSessions(readFileSync(this.c.streamLog, "utf8")) : [];
    const moments = evolutionMoments({ commits, sessions, games: records, gamesPerBuild: this.c.gamesPerBuild, attempts: this.labAttempts() });
    const byDir = new Map(games.map((g) => [g.dir, g]));
    const jobs: Job[] = [];
    for (const m of moments) {
      // Wait for the lab's footage while it may still be recording.
      const s = m.session;
      const labEnd = s ? Math.min(s.endMs, m.commit.committedAtMs + 15_000) : null;
      if (s && labEnd !== null && !coveredBy(this.segments, s.startMs, labEnd) && Date.now() - labEnd < FOOTAGE_WAIT_MS) {
        waiting.push(m.id);
        continue;
      }
      jobs.push({ id: m.id, kind: "evolution", plan: () => this.evolutionVideo(m, byDir) });
    }
    return jobs;
  }

  // The best non-frozen 8-second moment from some games, as versus footage.
  private async showcase(dirs: string[], byDir: Map<string, Game>, label: string) {
    const music = this.music();
    const options: { pick: Pick; game: Game }[] = [];
    for (const d of dirs) {
      const g = byDir.get(d);
      if (!g || this.footageState(g) !== "ready") continue;
      for (const pick of await this.picks(g)) options.push({ pick, game: g });
    }
    options.sort((a, b) => rank(b.pick) - rank(a.pick));
    for (const { pick, game } of options.slice(0, 6)) {
      const f = await footage(game.trace, this.archive, { segments: this.segments });
      if (typeof f === "string") continue;
      const c = planClip(pick, 0, music.bpm, f.locate, { leadBars: 3, tailBars: 1 });
      if (!c || (await this.frozen(c.sources, c.seekSec, c.spanSec))) continue;
      const source = await this.sourceFor(c.sources[0]!);
      if (source) return { sources: c.sources, seekSec: c.seekSec, spanSec: c.spanSec, speed: c.speed, source, label: `${label} · ${pick.phrase}` };
    }
    return null;
  }

  private async evolutionVideo(m: EvolutionMoment, byDir: Map<string, Game>): Promise<Plan> {
    const c = m.commit;
    let lab: EvolutionPlan["lab"] = null;
    const s = m.session;
    if (s) {
      const end = Math.min(s.endMs, c.committedAtMs + 15_000);
      const cov = coveredBy(this.segments, s.startMs, end);
      const source = cov ? await this.sourceFor(cov.files[0]!) : null;
      const spanSec = (end - s.startMs) / 1000;
      if (cov && source && spanSec > 10) lab = { sources: cov.files, seekSec: cov.offsetSec, spanSec, speed: Math.max(1, spanSec / 6), source: { ...source, panel: false } };
    }
    const beforeClip = await this.showcase(m.beforeGames, byDir, "OLD BRAIN");
    const afterClip = m.stage === "verdict" ? await this.showcase(m.afterGames, byDir, "NEW BRAIN") : null;
    const workDir = path.join(this.c.outRoot, ".work", m.id);
    const minutes = s ? Math.max(1, Math.round((Math.min(s.endMs, c.committedAtMs) - s.startMs) / 60_000)) : null;
    const plan = renderEvolutionArgs({
      hook: m.stage === "proposed" ? "CLAUDE CODE IS REWRITING AN AI'S BRAIN, LIVE" : "AN AI REWROTE ITS OWN BRAIN. DID IT WORK?",
      hookSub: minutes ? `${minutes} MINUTES OF LIVE CODING IN 6 SECONDS` : "LIVE ON STREAM",
      lab,
      changeLabel: `${m.n ? `CHANGE #${m.n}` : "A CHANGE"} · WRITTEN BY CLAUDE CODE`,
      title: c.title,
      files: c.files,
      diff: m.diff,
      stage: m.stage,
      verdict: m.facts.verdict,
      before: m.facts.before,
      after: m.facts.after,
      testing: Math.max(1, this.c.gamesPerBuild - m.afterGames.length),
      beforeClip,
      afterClip,
      outro: ["WATCH IT EVOLVE LIVE", "KICK.COM/JEVIATUS"],
      music: this.music(),
      font: this.c.font,
      mono: this.c.mono,
      out: this.outFile(m.id),
      workDir,
    });
    return { ...plan, workDir, facts: { headline: c.title, moments: [], map: null, humans: null, strategy: null, evolution: m.facts } };
  }

  private outFile(id: string): string {
    return this.manifest.clips[id]?.file ?? path.join(this.c.outRoot, localDate(), `${id}.mp4`);
  }

  // --- run ----------------------------------------------------------------------------

  private async render(job: Job, r: Renderable): Promise<boolean> {
    const out = this.outFile(job.id);
    mkdirSync(path.dirname(out), { recursive: true });
    mkdirSync(r.workDir, { recursive: true });
    for (const f of r.files) writeFileSync(f.path, f.content);
    const tmp = out.replace(/\.mp4$/, ".part.mp4");
    const args = [...r.args.slice(0, -1), tmp];
    const res = await runFfmpeg(args, { quiet: true });
    rmSync(r.workDir, { recursive: true, force: true });
    const made = res.ok && existsSync(tmp) && statSync(tmp).size > 100_000;
    if (!made) {
      rmSync(tmp, { force: true });
      const prev = this.manifest.failed[job.id];
      this.manifest.failed[job.id] = { count: (prev?.count ?? 0) + 1, error: res.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500), at: new Date().toISOString() };
      return false;
    }
    await Bun.write(out, Bun.file(tmp));
    rmSync(tmp, { force: true });
    const now = new Date().toISOString();
    const facts: ClipFacts = { id: job.id, kind: job.kind, durationSec: r.durationSec, ...r.facts };
    writeFileSync(out.replace(/\.mp4$/, ".json"), `${JSON.stringify(sidecar(facts, path.basename(out), now), null, 2)}\n`);
    this.manifest.clips[job.id] = { file: out, kind: job.kind, durationSec: r.durationSec, renderedAt: now };
    delete this.manifest.failed[job.id];
    return true;
  }

  async pass(): Promise<PassResult> {
    const result: PassResult = { archived: 0, rendered: [], failed: [], waiting: [], pending: 0 };
    if (existsSync(this.c.recordings) && !this.c.dryRun) result.archived = archiveSegments(this.c.recordings, this.archive).length;
    if (!this.c.dryRun) for (const f of pruneArchive(this.archive, this.c.archiveMaxGB * 1024 ** 3)) this.c.log(`[archive] pruned ${path.basename(f)}`);
    this.segments = await segmentsWithDurations(this.archive);
    const games = this.loadGames();
    const jobs = [...(await this.evolutionJobs(games, result.waiting)), ...(await this.gameJobs(games, result.waiting))];
    this.save();
    const todo = jobs.filter((j) => !this.manifest.clips[j.id] && !this.manifest.skipped[j.id] && (this.manifest.failed[j.id]?.count ?? 0) < MAX_FAILS && (!this.c.only || j.id.includes(this.c.only)));
    // Evolution first, then the newest games, then compilations.
    const order = (j: Job) => ({ evolution: 0, highlight: 1, moment: 2, compilation: 3 })[j.kind];
    todo.sort((a, b) => order(a) - order(b) || b.id.localeCompare(a.id));
    this.c.log(`${jobs.length} clip(s) known, ${Object.keys(this.manifest.clips).length} rendered, ${todo.length} to do, ${result.waiting.length} waiting for footage${result.waiting.length ? ` (${result.waiting.join(", ")})` : ""}`);
    let done = 0;
    for (const job of todo) {
      if (done >= this.c.limit) {
        result.pending++;
        continue;
      }
      const plan = await job.plan();
      if (plan === null) {
        result.waiting.push(job.id);
        continue;
      }
      if (typeof plan === "string") {
        this.c.log(`  ${job.id}: ${plan}`);
        if (!this.c.dryRun) this.manifest.skipped[job.id] = plan;
        this.save();
        continue;
      }
      if (this.c.dryRun) {
        this.c.log(`  would render ${job.id} (${plan.durationSec.toFixed(1)} s): ${plan.facts.headline}`);
        done++;
        continue;
      }
      const t0 = Date.now();
      this.c.log(`  rendering ${job.id} (${plan.durationSec.toFixed(1)} s): ${plan.facts.headline}`);
      const ok = await this.render(job, plan);
      this.save();
      if (ok) {
        result.rendered.push(job.id);
        this.c.log(`  wrote ${this.outFile(job.id)} in ${Math.round((Date.now() - t0) / 1000)} s`);
      } else {
        result.failed.push(job.id);
        this.c.log(`  ${job.id} failed: ${this.manifest.failed[job.id]?.error ?? ""}`);
      }
      done++;
    }
    return result;
  }
}
