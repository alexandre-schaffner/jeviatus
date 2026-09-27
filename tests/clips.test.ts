import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseTrace as parseRecords } from "../harness/analyze/load";
import { archiveSegments, frozenSeconds, pruneArchive } from "../clips/archive";
import { changeNumber, diffSnippet, evolutionMoments, type LabCommit, labVerdict, parseLabLog, parseLabSessions } from "../clips/evolution";
import { evolutionDuration, labTerminal, renderEvolutionArgs, scoreRows } from "../clips/evorender";
import { type ClipFacts, SUBREDDITS, sidecar, specificHeadline } from "../clips/metadata";
import { compilationPicks, gameIdOf, nextBatches, standouts } from "../clips/pipeline";
import { coveredBy, segmentDurations } from "../tiktok/make";
import { parseTrace } from "../tiktok/moments";
import type { Pick } from "../tiktok/phrases";
import { syntheticTrace } from "./tiktokFixture";

const at = (hms: string) => Date.parse(`2026-09-27T${hms}Z`);

describe("footage", () => {
  test("segments cut short by a restart last until the next one; the unreadable are dropped", () => {
    const s = (hms: string, durationSec: number | null, readable = true) => ({ file: `${hms}.mkv`, startMs: at(hms), durationSec, readable });
    const out = segmentDurations([s("00:00:00", 300), s("00:05:00", null), s("00:08:51", null, false), s("00:09:00", 300), s("00:14:00", null)]);
    expect(out.map((x) => [x.file, x.durationSec])).toEqual([["00:00:00.mkv", 300], ["00:05:00.mkv", 230], ["00:09:00.mkv", 300]]);
  });

  test("a window across a gap in the recording has no footage", () => {
    const segs = [
      { file: "a", startMs: at("00:00:00"), durationSec: 300 },
      { file: "b", startMs: at("00:05:00"), durationSec: 100 },
      { file: "c", startMs: at("00:07:00"), durationSec: 300 },
    ];
    expect(coveredBy(segs, at("00:04:50"), at("00:05:10"))).toEqual({ files: ["a", "b"], offsetSec: 290 });
    expect(coveredBy(segs, at("00:06:30"), at("00:07:10"))).toBeNull();
    expect(coveredBy(segs, at("00:11:00"), at("00:11:59"))).toEqual({ files: ["c"], offsetSec: 240 });
    // Past the end of the last segment (still being written, or the stream stopped).
    expect(coveredBy(segs, at("00:11:59"), at("00:12:10"))).toBeNull();
  });

  test("freeze time adds up closed and still-open freezes", () => {
    const log = "lavfi.freezedetect.freeze_start: 1\nlavfi.freezedetect.freeze_duration: 2\nlavfi.freezedetect.freeze_end: 3\nlavfi.freezedetect.freeze_start: 8";
    expect(frozenSeconds(log, 10)).toBe(4);
    expect(frozenSeconds("", 10)).toBe(0);
  });

  test("finished segments are linked into the archive, never the live one; the archive has a cap", () => {
    const rec = mkdtempSync(path.join(tmpdir(), "jev-rec-"));
    const arch = path.join(mkdtempSync(path.join(tmpdir(), "jev-arch-")), "recordings");
    for (const n of ["20260927T000000Z.mkv", "20260927T000500Z.mkv", "20260927T001000Z.mkv"]) writeFileSync(path.join(rec, n), "x".repeat(100));
    expect(archiveSegments(rec, arch).map((f) => path.basename(f))).toEqual(["20260927T000000Z.mkv", "20260927T000500Z.mkv"]);
    expect(archiveSegments(rec, arch)).toEqual([]);
    expect(pruneArchive(arch, 150).map((f) => path.basename(f))).toEqual(["20260927T000000Z.mkv"]);
    expect(readdirSync(arch)).toEqual(["20260927T000500Z.mkv"]);
  });

  test("tick 0 is the first run header's start, even when the header is sent again", () => {
    const again = `${syntheticTrace()}${JSON.stringify({ type: "run", startedAt: "2026-09-26T20:30:00Z", map: "Other" })}\n`;
    const g = parseTrace(again);
    expect(g.startedAtMs).toBe(Date.parse("2026-09-26T20:10:00Z"));
    expect(g.map).toBe("World");
  });
});

const pick = (tick: number, epic: number, kind: Pick["moment"]["kind"] = "wipeout", phrase = `p${tick}`): Pick => ({
  moment: { kind, tick, fromTick: tick - 50, what: `thing at ${tick}`, facts: { target: `T${tick}` }, heat: epic },
  phrase,
  ranked: [phrase, `${phrase}-b`],
  epic,
  by: "jev",
});

describe("choosing clips", () => {
  test("standouts are the few moments strong enough alone", () => {
    expect(standouts([pick(1, 0.5), pick(2, 1), pick(3, 0.8), pick(4, 0.9)]).map((p) => p.moment.tick)).toEqual([2, 4]);
  });

  test("compilations take the best across games, a few per game, in play order, no line twice", () => {
    const batch = [
      { game: "A", startMs: 0, picks: [pick(100, 0.9, "wipeout", "RIP"), pick(200, 0.95, "wipeout", "RIP"), pick(300, 1)] },
      { game: "B", startMs: 3_600_000, picks: [pick(100, 0.6), pick(150, 0.3)] },
    ];
    const best = compilationPicks(batch, 3, 2);
    expect(best.map((b) => [b.game, b.pick.moment.tick])).toEqual([["A", 200], ["A", 300], ["B", 100]]);
    const wipes = compilationPicks(batch, 5, 3, (p) => p.phrase === "RIP");
    expect(wipes.map((w) => w.pick.phrase)).toEqual(["RIP", "RIP-b"]);
  });

  test("batches only form from whole groups of new games, and never reshuffle", () => {
    expect(nextBatches(["a", "b", "c", "d", "e"], [], 2)).toEqual([["a", "b"], ["c", "d"]]);
    expect(nextBatches(["a", "b", "c", "d", "e", "f"], [["a", "b"], ["c", "d"]], 2)).toEqual([["e", "f"]]);
    expect(gameIdOf("/runs/2026-09-26T21-35-17-555Z-extension-cULmSDX3Qs")).toBe("cULmSDX3Qs");
  });
});

const facts = (over: Partial<ClipFacts> = {}): ClipFacts => ({
  id: "game-abc",
  kind: "highlight",
  durationSec: 28,
  headline: "Wiped off the map",
  alts: ["RIP BigBob", "BigBob has left the chat"],
  names: ["BigBob"],
  moments: [{ kind: "wipeout", what: "Jev wiped BigBob off the map" }],
  map: "World",
  humans: 42,
  strategy: null,
  ...over,
});

describe("post metadata", () => {
  test("every platform gets text within its limits", () => {
    const s = sidecar(facts(), "game-abc.mp4", "2026-09-27T00:00:00Z");
    const p = s.platforms;
    expect(p.youtube.title.endsWith(" #Shorts")).toBe(true);
    expect(p.youtube.title.length).toBeLessThanOrEqual(100);
    expect(p.youtube.categoryId).toBe("20");
    expect(p.x.text.length).toBeLessThanOrEqual(280);
    // No link on X (billed ~13x), the stream by name instead.
    expect(p.x.text).not.toContain("https://");
    expect(p.x.text).toContain("Kick");
    expect(p.instagram.hashtags.length).toBeLessThanOrEqual(5);
    expect(p.tiktok.hashtags).toContain("#openfront");
    expect(p.reddit.subreddit).toBe("Openfront");
    expect(p.reddit.title.length).toBeLessThanOrEqual(300);
    expect(p.reddit.alternatives.map((a) => a.subreddit)).toContain("Kick");
    expect(p.youtube.description).toContain("Jev wiped BigBob off the map.");
  });

  test("titles prefer a line that names someone; the same clip always reads the same", () => {
    expect(specificHeadline(facts())).toBe("RIP BigBob");
    expect(specificHeadline(facts({ alts: [], names: [] }))).toBe("Wiped off the map");
    expect(specificHeadline(facts({ headline: "+2.8% of the map in 60s" }))).toBe("+2.8% of the map in 60s");
    const a = sidecar(facts(), "v.mp4", "t");
    expect(sidecar(facts(), "v.mp4", "t")).toEqual(a);
    expect(a.platforms.youtube.title).toBe("RIP BigBob #Shorts");
  });

  test("long names can't push X past 280", () => {
    const long = "A".repeat(400);
    const s = sidecar(facts({ headline: long, alts: [], names: [] }), "v.mp4", "t");
    expect(s.platforms.x.text.length).toBeLessThanOrEqual(280);
    expect(s.platforms.youtube.title.length).toBeLessThanOrEqual(100);
  });

  test("evolution clips say what changed and whether it helped, and go to AI subreddits too", () => {
    const b = { sha: "a", games: 4, wins: 0, meanPlacement: 30, medianMinutes: 5, meanPeakShare: 0.02 };
    const s = sidecar(
      facts({ id: "evo-1234567-verdict", kind: "evolution", headline: "Defend first", moments: [], evolution: { title: "Defend first", n: 1, stage: "verdict", verdict: "kept", before: b, after: { ...b, sha: "b", wins: 1 }, files: ["harness/decide/x.ts"] } }),
      "v.mp4",
      "t",
    );
    expect(s.platforms.youtube.title).toMatch(/0\/4 → 1\/4 wins|worked/);
    expect(s.platforms.youtube.description).toContain("Before: 0/4 wins");
    expect(s.platforms.youtube.tags).toContain("Claude Code");
    const subs = [s.platforms.reddit.subreddit, ...s.platforms.reddit.alternatives.map((a) => a.subreddit)];
    expect(subs).toEqual(SUBREDDITS.filter((x) => x.kinds.includes("evolution")).map((x) => x.name));
    expect(s.platforms.tiktok.hashtags).toContain("#claudecode");
  });
});

// A lab change: parent = the build before, the commit = the change.
const commit = (over: Partial<LabCommit> = {}): LabCommit => ({
  sha: "c".repeat(40),
  parent: "p".repeat(40),
  branch: "jev-lab/3-defend-first",
  title: "Defend first",
  body: "why",
  committedAtMs: at("01:10:00"),
  files: ["harness/decide/pipeline.ts", "tests/decide.test.ts"],
  patch: "",
  ...over,
});

const gameOn = (sha: string, i: number) =>
  parseRecords(
    syntheticTrace()
      .replace('"source":"extension"', `"source":"extension","harnessCommit":"${sha}"`)
      .replaceAll('"alive":true', '"alive":true,"tiles":100,"troops":1000,"troop_fill":0.5,"gold":0,"under_attack_by":[],"allies":[],"unclaimed_land_on_border":0,"expanding_into_unclaimed":false'),
    `/runs/g-${sha.slice(0, 3)}-${i}`,
  )[0]!;

describe("evolution moments", () => {
  test("lab sessions come from the stream log: after every Nth game, until the next match", () => {
    const log = [
      "2026-09-27T00:00:00.000Z [lab] live coding every 2 games; a change is judged after 4 games on it",
      "2026-09-27T00:10:00.000Z [driver] game 1 over: eliminated at 2:25",
      "2026-09-27T00:10:05.000Z [driver] next game plays Jev's own judgment",
      "2026-09-27T00:20:00.000Z [driver] game 2 over: eliminated at 11:47",
      "2026-09-27T00:20:30.000Z [commentator] (smug) Back to the lab.",
      "2026-09-27T00:32:00.000Z [driver] next game plays Jev's own judgment",
      "2026-09-27T00:40:00.000Z [driver] game 4 over: eliminated",
      "2026-09-27T00:45:00.000Z shutting down",
      "2026-09-27T00:45:10.000Z [lab] live coding every 3 games",
      "2026-09-27T00:50:00.000Z [driver] game 2 over: eliminated",
    ].join("\n");
    expect(parseLabSessions(log)).toEqual([
      { startMs: at("00:20:04"), endMs: at("00:32:00") },
      { startMs: at("00:40:04"), endMs: at("00:45:00") },
    ]);
  });

  test("the diff keeps decision code first, changed lines with a little context, short lines", () => {
    const patch = [
      "diff --git a/tests/decide.test.ts b/tests/decide.test.ts",
      "--- a/tests/decide.test.ts",
      "+++ b/tests/decide.test.ts",
      "@@ -1,2 +1,3 @@",
      "+test('defends', () => {});",
      "diff --git a/harness/decide/pipeline.ts b/harness/decide/pipeline.ts",
      "index 1..2 100644",
      "--- a/harness/decide/pipeline.ts",
      "+++ b/harness/decide/pipeline.ts",
      "@@ -10,6 +10,6 @@ class X",
      " far away context",
      " const a = 1;",
      "-if (x < 0.35) {",
      `+if (x < 0.5 && !threatened) { ${"y".repeat(80)}`,
      " }",
      " more far context",
      " even more",
    ].join("\n");
    const d = diffSnippet(patch, 16, 46);
    expect(d.map((l) => l.kind)).toEqual(["file", "ctx", "del", "add", "ctx", "file", "add"]);
    expect(d[0]!.text).toBe("harness/decide/pipeline.ts");
    expect(d.every((l) => l.text.length <= 46)).toBe(true);
    expect(d[3]!.text.endsWith("…")).toBe(true);
  });

  test("a change is 'proposed' right away and gets a verdict once it has enough games", () => {
    const c = commit({ committedAtMs: at("00:25:00") });
    const before = [0, 1, 2, 3].map((i) => gameOn(c.parent, i));
    const sessions = [{ startMs: at("00:20:04"), endMs: at("00:32:00") }];
    const early = evolutionMoments({ commits: [c], sessions, games: [...before, gameOn(c.sha, 0)], gamesPerBuild: 4, attempts: [] });
    expect(early.map((m) => m.id)).toEqual(["evo-ccccccc-proposed"]);
    expect(early[0]!.session).toEqual(sessions[0]!);
    expect(early[0]!.n).toBe(3);
    expect(early[0]!.facts.before?.games).toBe(4);
    expect(early[0]!.facts.after).toBeNull();

    const after = [0, 1, 2, 3].map((i) => gameOn(c.sha, i));
    const judged = evolutionMoments({ commits: [c], sessions, games: [...before, ...after], gamesPerBuild: 4, attempts: [] });
    expect(judged.map((m) => m.id)).toEqual(["evo-ccccccc-proposed", "evo-ccccccc-verdict"]);
    const v = judged[1]!;
    // Same games before and after: not better, so dropped.
    expect(v.facts.verdict).toBe("dropped");
    expect(v.facts.after?.games).toBe(4);
    expect(v.afterGames.length).toBe(4);
    // The lab's own verdict wins when state.json has it.
    const kept = evolutionMoments({ commits: [c], sessions, games: [...before, ...after], gamesPerBuild: 4, attempts: [{ title: "Defend first", verdict: "helped; kept as the new baseline" }] });
    expect(kept[1]!.facts.verdict).toBe("kept");
  });

  test("lab verdicts, change numbers and git log records parse", () => {
    expect(labVerdict("A", [{ title: "A", verdict: "did not help" }])).toBe("dropped");
    expect(labVerdict("A", [{ title: "B", verdict: "helped" }])).toBeNull();
    expect(changeNumber("jev-lab/12-hold-less")).toBe(12);
    expect(changeNumber("main")).toBeNull();
    const rec = `${"a".repeat(40)}\x00${"b".repeat(40)}\x001790000000\x00HEAD -> jev-lab/1-x, origin/y\x00Title here\n\nBody line\x1e\n`;
    expect(parseLabLog(rec)).toEqual([{ sha: "a".repeat(40), parent: "b".repeat(40), branch: "jev-lab/1-x", title: "Title here", body: "Body line", committedAtMs: 1_790_000_000_000 }]);
  });

  test("the evolution video drops sections without footage and stamps the verdict", () => {
    const src = { width: 1280, height: 720, hasAudio: true, band: true, bandLines: 3, panel: false };
    const base = {
      hook: "H",
      hookSub: "S",
      lab: null,
      changeLabel: "CHANGE #1",
      title: "Defend first",
      files: ["harness/decide/pipeline.ts"],
      diff: [{ kind: "add" as const, text: "+ x" }],
      stage: "verdict" as const,
      verdict: "kept" as const,
      before: { sha: "a", games: 4, wins: 0, meanPlacement: 30, medianMinutes: 5, meanPeakShare: 0.02 },
      after: { sha: "b", games: 4, wins: 1, meanPlacement: 20, medianMinutes: 7, meanPeakShare: 0.03 },
      testing: 0,
      beforeClip: null,
      afterClip: null,
      outro: ["WATCH"],
      music: { file: null, bpm: 120, startSec: 0 },
      font: "/f/Impact.ttf",
      mono: "/f/Menlo.ttc",
      out: "/out/evo.mp4",
      workDir: "/w",
    };
    const cardsOnly = renderEvolutionArgs(base);
    expect(cardsOnly.durationSec).toBe(11);
    expect(cardsOnly.files.some((f) => f.content === "IT GOT BETTER")).toBe(true);
    const full = renderEvolutionArgs({ ...base, lab: { sources: ["/r/a.mkv"], seekSec: 5, spanSec: 600, speed: 100, source: src }, afterClip: { sources: ["/r/b.mkv"], seekSec: 1, spanSec: 8, speed: 1, source: { ...src, panel: true }, label: "NEW" } });
    expect(full.durationSec).toBe(evolutionDuration({ lab: {} as never, beforeClip: null, afterClip: {} as never }));
    const graph = full.args[full.args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("setpts=(PTS-STARTPTS)/100");
    expect(graph).toContain(`crop=900:576:368:40`);
    expect(graph).toContain("concat=n=4:v=1:a=0");
    expect(labTerminal({ width: 1920, height: 1080 })).toEqual({ x: 552, y: 60, w: 1350, h: 862 });
    expect(scoreRows(base.before, null)[1]).toEqual(["WINS", "0", "-"]);
    expect(full.files.find((f) => f.content === "IT DIDN'T HELP")).toBeUndefined();
    expect(existsSync("/w")).toBe(false);
  });
});
