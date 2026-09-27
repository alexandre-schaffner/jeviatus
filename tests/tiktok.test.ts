import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ffmpegArgs } from "../stream/encoder";
import { listSegments, pruneSegments, segmentStart, segmentsCovering } from "../stream/recordings";
import { brainCard } from "../tiktok/brain";
import { findMoments, type Moment, parseTrace } from "../tiktok/moments";
import { barSeconds, beatExpression, bpmFromName, chooseTrack } from "../tiktok/music";
import { direct, fill, options, PHRASES, select, statLine } from "../tiktok/phrases";
import { type Clip, fitCaption, renderArgs, type VideoPlan } from "../tiktok/render";
import { FakeJev } from "./helpers";
import { step, syntheticTrace } from "./tiktokFixture";

describe("epic moments", () => {
  const game = parseTrace(syntheticTrace());

  test("the trace yields its header, steps and death", () => {
    expect(game.startedAtMs).toBe(Date.parse("2026-09-26T20:10:00Z"));
    expect(game.map).toBe("World");
    expect(game.strategy).toBe("Blitz");
    expect(game.samples.length).toBeGreaterThan(90);
    expect(game.death?.attackers).toEqual(["Tsar"]);
    expect(game.won).toBe(false);
  });

  test("finds the surge, the crushed neighbor, the nuke and the fall, once each", () => {
    const ms = findMoments(game);
    expect(ms.map((m) => m.kind)).toEqual(["surge", "conquest", "nuke", "last_stand"]);
    const [surge, conquest, nuke, fall] = ms as [Moment, Moment, Moment, Moment];
    expect(surge.facts).toMatchObject({ from: "1%", to: "4%", secs: 60 });
    expect(conquest.facts.target).toBe("BigBob");
    expect(nuke.what).toBe("Jev launched an atom bomb at Tsar");
    expect(fall.facts).toMatchObject({ killer: "Tsar", time: "2:40" });
  });

  test("a crushed player is a conquest; one that's gone is a wipeout", () => {
    const events = [{ type: "run", startedAt: "2026-09-26T20:10:00Z" }];
    for (let tick = 600; tick <= 900; tick += 15) {
      const bob = { ref: "P2", name: "Bob", land_share: Math.max(0, 0.01 - (tick - 600) * 0.0001) };
      events.push(step(tick, { land_share: 0.02, land_rank: 3, attacking: ["P2"] }, bob.land_share > 0 ? [bob] : []) as never);
    }
    const ms = findMoments(parseTrace(events.map((e) => JSON.stringify(e)).join("\n")));
    expect(ms.map((m) => [m.kind, m.what])).toEqual([["wipeout", "Jev wiped Bob off the map"]]);
  });

  test("the climb to #1 counts from when Jev has land, not the spawn-phase tie", () => {
    const events = [{ type: "run", startedAt: "2026-09-26T20:10:00Z" }];
    const rank = (tick: number) => (tick < 300 ? 250 : tick < 700 ? 40 : 1);
    for (let tick = 150; tick <= 900; tick += 15) events.push(step(tick, { land_share: tick < 300 ? 0 : 0.001 * (tick / 100), land_rank: rank(tick) }, []) as never);
    const top = findMoments(parseTrace(events.map((e) => JSON.stringify(e)).join("\n"))).find((m) => m.kind === "top_rank");
    expect(top?.facts.from_rank).toBe(40);
  });

  test("no moments from a game where Jev's calls failed; no captions from missing facts", () => {
    const failing = syntheticTrace().replace(/"latencyMs":300/g, '"latencyMs":300,"error":"Error: 402 Your organization has no available TypeSafe API credits"');
    const g = parseTrace(failing);
    expect(g.jevFailedShare).toBe(1);
    expect(findMoments(g)).toEqual([]);
    const tiny = parseTrace(syntheticTrace().replace('"peakLandShare":0.049,"attackers":[{"ref":"P3","name":"Tsar"}]', '"peakLandShare":0.004,"attackers":[]'));
    const fall = findMoments(tiny).find((m) => m.kind === "last_stand")!;
    expect(Object.values(options(fall)).some((p) => /Peaked|Outplayed/.test(p))).toBe(false);
  });

  test("each moment carries the call behind it: the order to attack, the surge's expansion, the launch", () => {
    const [surge, conquest, nuke] = findMoments(game) as [Moment, Moment, Moment];
    expect(conquest.brain).toMatchObject({ tick: 1005, route: "attack_player", target: "BigBob", detail: "30% troops, sized to finish them" });
    expect(surge.brain?.route).toBe("expand");
    expect(nuke.brain).toMatchObject({ route: "nuke", target: "Tsar" });
    expect(conquest.brain!.options.map((o) => o.key)).toEqual(["attack_player", "expand", "hold"]);
  });

  test("the brain card says what Jev chose, what else it weighed, and how sure it was", () => {
    const base = { tick: 1005, route: "attack_player", held: false, options: [{ key: "attack_player", p: 0.59 }, { key: "hold", p: 0.25 }, { key: "expand", p: 0.14 }, { key: "propose_alliance", p: 0.02 }], target: "Kalmykia", detail: "30% troops" };
    expect(brainCard(base)).toEqual({
      title: "ATTACK KALMYKIA",
      options: [{ label: "Attack a player", p: 0.59, chosen: true }, { label: "Hold", p: 0.25, chosen: false }, { label: "Expand into free land", p: 0.14, chosen: false }],
      footer: "59% SURE · SENDING 30% OF ITS TROOPS",
    });
    const held = brainCard({ ...base, held: true, holdReason: "confidence 0.28 < 0.35", options: [{ key: "attack_player", p: 0.4 }, { key: "expand", p: 0.3 }, { key: "build", p: 0.2 }, { key: "hold", p: 0.1 }] });
    expect(held.title).toBe("HOLD");
    expect(held.footer).toBe("TOO UNSURE TO ACT (28% < 35%)");
    expect(held.options.at(-1)).toEqual({ label: "Hold", p: 0.1, chosen: true });
  });

  test("a truncated last line doesn't break parsing", () => {
    expect(parseTrace(`${syntheticTrace()}{"type":"step","tick":`).samples.length).toBe(game.samples.length);
  });
});

describe("catchphrases", () => {
  const m: Moment = { kind: "conquest", tick: 1200, fromTick: 1000, what: "Jev crushed Bob", facts: { target: "Bob" }, heat: 0.7 };

  test("placeholders fill from the facts; phrases missing a fact are dropped", () => {
    expect(fill("{target} has left the chat", { target: "Bob" })).toBe("Bob has left the chat");
    expect(fill("From #{from_rank} to #1", { from_rank: "?" })).toBeNull();
    expect(Object.values(options({ ...m, kind: "surge", facts: {} }))).toEqual(PHRASES.surge.filter((p) => !p.includes("{")));
    expect(statLine(m)).toBe("JEV VS BOB");
  });

  test("Jev scores each moment and picks its phrase; failures fall back", async () => {
    const jev = new FakeJev();
    jev.score.epic = 4;
    jev.prefer.phrase = "p2";
    const [p] = await direct([m], { map: "World", strategy: null }, jev);
    expect(p).toMatchObject({ phrase: "Your land is my land, Bob", epic: 1, by: "jev" });
    expect(p!.ranked[0]).toBe(p!.phrase);
    expect(p!.ranked.length).toBe(Object.keys(options(m)).length);
    const q = jev.asked[0]!;
    expect(Object.keys(q.questions)).toEqual(["epic", "phrase"]);
    expect(JSON.stringify(q.state)).toContain("Jev crushed Bob");

    const broken = { ask: async () => Promise.reject(new Error("down")) };
    const [f] = await direct([m], { map: null, strategy: null }, broken);
    expect(f!.by).toBe("fallback");
    expect(Object.values(options(m))).toContain(f!.phrase);
  });

  test("the video keeps the most epic moments, in game order, never repeating a line", () => {
    const at = (tick: number, epic: number) => ({ moment: { ...m, tick }, phrase: "x", ranked: ["x", "y", "z"], epic, by: "jev" as const });
    const picked = select([at(100, 0.5), at(200, 1), at(300, 0.9), at(400, 0.2)], 3);
    expect(picked.map((p) => [p.moment.tick, p.phrase])).toEqual([[100, "x"], [200, "y"], [300, "z"]]);
    expect(select([at(100, 0.2)], 3)).toEqual([]);
  });
});

describe("music", () => {
  test("tempo from the file name; a bar is four beats", () => {
    expect(bpmFromName("music/drop_128bpm.mp3")).toBe(128);
    expect(bpmFromName("music/drop.mp3")).toBeNull();
    expect(barSeconds(120)).toBe(2);
    expect(chooseTrack("song.mp3", 5)).toBe("song.mp3");
  });

  test("the built-in beat only uses ffmpeg's ten expression variables", () => {
    const vars = [...beatExpression(120).matchAll(/(?:st|ld|random)\((\d+)/g)].map((x) => Number(x[1]));
    expect(Math.max(...vars)).toBeLessThanOrEqual(9);
  });
});

describe("recordings", () => {
  test("segment names are UTC start times", () => {
    expect(segmentStart("/data/recordings/20260926T201500Z.mkv")).toBe(Date.parse("2026-09-26T20:15:00Z"));
    expect(segmentStart("dry-run.mkv")).toBeNull();
  });

  test("finds the segments covering a window, and prunes old ones but never the live one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-rec-"));
    for (const n of ["20260926T200000Z.mkv", "20260926T200500Z.mkv", "20260926T201000Z.mkv", "notes.txt"]) writeFileSync(path.join(dir, n), "");
    const segs = listSegments(dir);
    expect(segs.length).toBe(3);
    const at = (hms: string) => Date.parse(`2026-09-26T${hms}Z`);
    expect(segmentsCovering(segs, at("20:04:30"), at("20:05:10"))).toEqual({ files: [segs[0]!.file, segs[1]!.file], offsetSec: 270 });
    expect(segmentsCovering(segs, at("20:11:00"), at("20:11:10"))?.files).toEqual([segs[2]!.file]);
    expect(segmentsCovering(segs, at("19:59:00"), at("20:00:10"))).toBeNull();
    expect(pruneSegments(dir, 1, at("23:00:00")).length).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["20260926T201000Z.mkv", "notes.txt"]);
  });

  test("the broadcast tees into segments without risking the live output", () => {
    const cfg = { outputs: [{ name: "kick" as const, url: "rtmps://ingest.example:443/app/key" }], width: 1280, height: 720, fps: 30, videoKbps: 4500, audio: false, display: ":99" };
    const band = { dir: "/b", bribes: false, lab: true };
    const args = ffmpegArgs(cfg, band, { dir: "/data/recordings/", segmentSeconds: 300 });
    expect(args.slice(-5)).toEqual([
      "-flags", "+global_header", "-f", "tee",
      "[f=flv:onfail=abort]rtmps://ingest.example:443/app/key|[f=segment:segment_time=300:segment_format=matroska:strftime=1:reset_timestamps=1:onfail=ignore]/data/recordings/%Y%m%dT%H%M%SZ.mkv",
    ]);
    expect(ffmpegArgs(cfg, band).slice(-2)).toEqual(["flv", "rtmps://ingest.example:443/app/key"]);
  });
});

describe("render", () => {
  const clip = (over: Partial<Clip> = {}): Clip => ({ sources: ["/rec/a.mkv"], seekSec: 100, spanSec: 8, speed: 1, punchSec: 6, teaser: "wait for it", phrase: "The AI chose violence", stat: "JEV VS BOB", ...over });
  const plan = (over: Partial<VideoPlan> = {}): VideoPlan => ({
    clips: [clip(), clip({ sources: ["/rec/a.mkv", "/rec/b.mkv"], spanSec: 32, speed: 4, punchSec: 4 })],
    source: { width: 1280, height: 720, hasAudio: true, band: true, panel: true },
    music: { file: null, bpm: 120, startSec: 0 },
    font: "/fonts/Bold.ttf",
    outro: ["VOTE"],
    out: "/out/tiktok.mp4",
    workDir: "/work",
    ...over,
  });

  test("one graph: clips cut, reframed to 9:16, punched in on the payoff, concatenated over the beat", () => {
    const { args, files, durationSec } = renderArgs(plan());
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(durationSec).toBe(16);
    expect(graph).toContain("concat=n=2:v=1:a=1");
    expect(graph).toContain("overlay=0:450:enable='gte(t,6)'");
    expect(graph).toContain("setpts=(PTS-STARTPTS)/4");
    // The whole game view, only the vote band cut off; without a card, the
    // extension's own panel stands in for Jev's brain.
    expect(graph).toContain("crop=1280:612:0:0");
    expect(graph).toContain("crop=340:366:928:52");
    // Sped-up clips play silence, not chipmunk audio.
    expect(graph).toContain("anullsrc=r=48000:cl=stereo,atrim=0:8");
    expect(args.some((a) => a.startsWith("aevalsrc="))).toBe(true);
    // Two segments play through the concat demuxer.
    expect(args.slice(args.indexOf("concat") - 1, args.indexOf("concat") + 7)).toEqual(["-f", "concat", "-safe", "0", "-ss", "100", "-t", "32"]);
    expect(files.find((f) => f.path === "/work/clip1.ffconcat")?.content).toContain("file '/rec/b.mkv'");
    expect(files.filter((f) => /clip0-line\d/.test(f.path)).map((f) => f.content).join(" ")).toBe("THE AI CHOSE VIOLENCE");
    expect(args.at(-1)).toBe("/out/tiktok.mp4");
  });

  test("a clip with Jev's call gets the brain card instead of the cut-out panel", () => {
    const brain = { title: "ATTACK KALMYKIA", options: [{ label: "Attack a player", p: 0.59, chosen: true }, { label: "Hold", p: 0.25, chosen: false }], footer: "59% SURE", clock: "2:10" };
    const { args, files } = renderArgs(plan({ clips: [clip({ brain })] }));
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).not.toContain("crop=340:366");
    expect(files.find((f) => f.path.endsWith("clip0-brain-title.txt"))?.content).toBe("ATTACK KALMYKIA");
    expect(files.find((f) => f.path.endsWith("clip0-brain-clock.txt"))?.content).toBe("DECIDED AT 2:10");
    expect(files.find((f) => f.path.endsWith("clip0-brain-p0.txt"))?.content).toBe("59%");
    // Each bar grows in ten steps to its share of the 888 px track.
    expect(graph).toContain(`w=${Math.round(888 * 0.59)}:h=18:color=0x53e3a6:t=fill:enable='gte(t,0.84)'`);
  });

  test("a music file loops from its start point", () => {
    const { args } = renderArgs(plan({ music: { file: "/m/song.mp3", bpm: 128, startSec: 12 } }));
    expect(args.slice(args.indexOf("-stream_loop"), args.indexOf("/m/song.mp3") + 1)).toEqual(["-stream_loop", "-1", "-ss", "12", "-i", "/m/song.mp3"]);
  });

  test("captions shrink to fit their box", () => {
    const box = { maxSize: 100, minSize: 48, widthPx: 980, heightPx: 250, charEm: 0.75 };
    const short = fitCaption("GG", box);
    const long = fitCaption("AN AI JUST BEAT FORTY TWO REAL PLAYERS ON THE WORLD MAP", box);
    expect(short).toEqual({ size: 100, lines: ["GG"] });
    expect(long.size).toBeLessThan(100);
    expect(long.lines.length * long.size * 1.12).toBeLessThanOrEqual(250);
    for (const l of long.lines) expect(l.length * long.size * 0.75).toBeLessThanOrEqual(980);
  });
});
