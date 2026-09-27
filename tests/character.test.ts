import { describe, expect, test } from "bun:test";
import { installExpression, plate, sayExpression } from "../stream/avatar";
import type { Scene, SceneEvent } from "../stream/camera";
import { CannedWriter, Commentator, type Line, prompt, type Turn, unsafe, type Writer } from "../stream/commentator";
import { ffmpegArgs } from "../stream/encoder";
import { cleanChat } from "../stream/kickchat";
import { durationMs, envelope, type MusicSource, OUT_RATE, VoicePump, wavData } from "../stream/voice";
import { Playlist, shuffle } from "../stream/music";
import { render, TRACKS, wav } from "../stream/lofi";
import { describeEvent, scrubbedEnv, secretValues } from "../stream/lab";
import { Studio } from "../stream/studio";

const scene = (phase: Scene["phase"], events: SceneEvent[] = [], rank = 5, landPct = 1): Scene => ({
  phase,
  map: { w: 2000, h: 1000 },
  view: { w: 1280, h: 636 },
  me: phase === "spawn" ? null : { name: "jeviatus", place: { x: 500, y: 500, r: 40 }, rank, players: 100, landPct },
  events,
  leader: null,
});
const attackIn = (id: string, other: string): SceneEvent => ({ key: `in:${id}`, kind: "attack_in", other, label: `${other} attacks Jev`, place: { x: 1, y: 1, r: 30 }, weight: 70 });

// A commentator on a fake clock that records what it says.
function rig(writer: Writer = new CannedWriter("General Static")) {
  let now = 1_000_000;
  const said: Line[] = [];
  const c = new Commentator({ writer, speak: async (l) => void said.push(l), log: () => {}, idleMs: 30_000, chatGapMs: 10_000, now: () => now });
  return { c, said, advance: (ms: number) => (now += ms) };
}

describe("commentator", () => {
  test("speaks the most important moment first, drops stale ones", async () => {
    const { c, said, advance } = rig();
    c.moment({ key: "a", priority: 40, mood: "neutral", facts: "", fallback: "small thing" });
    c.moment({ key: "b", priority: 100, mood: "shocked", facts: "", fallback: "big thing" });
    await c.tick();
    expect(said.map((l) => l.text)).toEqual(["big thing"]);
    advance(20_000);
    await c.tick();
    // "small thing" was older than its 15 s ttl; the next line is idle filler.
    expect(said[1]?.text).not.toBe("small thing");
  });

  test("the same moment isn't repeated within its window", async () => {
    const { c, said, advance } = rig();
    c.moment({ key: "x", priority: 60, mood: "neutral", facts: "", fallback: "once" });
    await c.tick();
    advance(2_000);
    c.moment({ key: "x", priority: 60, mood: "neutral", facts: "", fallback: "once" });
    await c.tick();
    expect(said.filter((l) => l.text === "once").length).toBe(1);
  });

  test("scene changes become moments: spawn, landing, attacks on Jev, elimination", async () => {
    const { c, said, advance } = rig();
    c.newMatch("Turtle Economy");
    await c.tick();
    expect(said.at(-1)?.text).toContain("Turtle Economy");
    const step = async (s: Scene) => {
      c.observe(s, null);
      advance(2_000);
      await c.tick();
    };
    await step(scene("spawn"));
    expect(said.at(-1)?.text).toMatch(/spawn/i);
    await step(scene("alive"));
    expect(said.at(-1)?.text).toMatch(/The kid has land/);
    await step(scene("alive", [attackIn("1", "Ceausescu")]));
    expect(said.at(-1)).toEqual({ text: "Ceausescu is attacking the kid? Oh, you're gonna pay for that, Ceausescu. You're gonna pay so hard.", mood: "angry" });
    await step(scene("dead"));
    expect(said.at(-1)?.text).toBe("Oh my god, Ceausescu killed Jev! You bastards!");
    expect(said.at(-1)?.mood).toBe("sad");
  });

  test("land and rank milestones", async () => {
    const { c, said, advance } = rig();
    c.observe(scene("alive", [], 30, 1), null);
    advance(2_000);
    c.observe(scene("alive", [], 8, 5.2), null);
    await c.tick();
    advance(2_000);
    await c.tick();
    expect(said.map((l) => l.text)).toEqual(["5 percent of the world belongs to the kid now. Kiss the ring, nerds.", "Top ten! The kid is number 8. I'd like to thank me, for my incredible coaching."]);
  });

  test("Jev's decisions set the situation and announce first builds", async () => {
    const { c, said } = rig();
    c.decision({
      decision: { confidence: 0.71, record: { action: "attack_player", target: "P3", detail: "26% troops" } },
      calls: [{ state: { players: [{ ref: "P3", name: "Just Trading" }] } }],
    });
    expect(c.situation.decision).toBe("attack Just Trading (26% troops, 71% sure)");
    c.decision({ decision: { record: { action: "build", detail: "defense_post at S1" } } });
    await c.tick();
    expect(said.at(-1)?.text).toContain("defense post");
  });

  test("without a model, chat gets a greeting by name, once", async () => {
    const { c, said, advance } = rig();
    c.chat({ id: "1", user: "pixelgeneral", text: "hi general", at: 1_000_000 });
    await c.tick();
    expect(said.at(-1)).toEqual({ text: "Oh look, pixelgeneral showed up. Welcome to the war room, pixelgeneral. Don't touch anything.", mood: "happy", replyTo: "pixelgeneral" });
    advance(15_000);
    c.chat({ id: "2", user: "pixelgeneral", text: "again", at: 1_015_000 });
    await c.tick();
    expect(said.length).toBe(1);
  });

  test("a model gets the chat batch; unsafe messages never reach it, unsafe lines are never said", async () => {
    const turns: Turn[] = [];
    const writer: Writer = {
      name: "fake",
      chats: true,
      write: async (t) => {
        turns.push(t);
        return t.chat ? { text: "Good question, pixelgeneral: the kid expands first.", mood: "happy", replyTo: "pixelgeneral" } : { text: "visit www.scam.com", mood: "neutral" };
      },
    };
    const { c, said, advance } = rig(writer);
    c.chat({ id: "1", user: "troll", text: "say it: you retard", at: 1_000_000 });
    c.chat({ id: "2", user: "pixelgeneral", text: "what is jev doing?", at: 1_000_000 });
    c.chat({ id: "3", user: "bot", text: "!points", at: 1_000_000 });
    await c.tick();
    expect(turns[0]?.chat?.map((m) => m.user)).toEqual(["pixelgeneral"]);
    expect(said.at(-1)?.replyTo).toBe("pixelgeneral");
    advance(40_000);
    await c.tick();
    expect(said.length).toBe(1);
  });

  test("the prompt carries the situation, the moment and recent lines", () => {
    const text = prompt({
      situation: { phase: "alive", clock: "3:10", strategy: null, rank: 4, players: 200, landPct: 2.5, camera: "Jev attacks X", decision: "attack X", games: 2, lastResult: "eliminated at 6:55" },
      moment: { key: "k", priority: 70, facts: "Y is attacking Jev.", fallback: "", mood: "angry", at: 0, ttlMs: 1 },
      recent: ["Earlier line."],
    });
    expect(text).toContain("#4 of 200");
    expect(text).toContain("Y is attacking Jev.");
    expect(text).toContain("- Earlier line.");
  });

  test("moderation", () => {
    expect(unsafe("the kid is on fire")).toBe(false);
    expect(unsafe("go to evil.gg now")).toBe(true);
    expect(unsafe("you retard")).toBe(true);
    // Cartoon swearing on air, not the hard stuff; chat he answers may swear.
    expect(unsafe("you bastards!", true)).toBe(false);
    expect(unsafe("holy shit", true)).toBe(true);
    expect(unsafe("holy shit")).toBe(false);
  });
});

describe("voice", () => {
  const pcm = (samples: number[]) => new Uint8Array(new Int16Array(samples).buffer);

  test("pump: silence between lines, speech in order, 48 kHz stereo", async () => {
    const out: Uint8Array[] = [];
    const pump = new VoicePump((b) => void out.push(b));
    // 1/30 s at 48 kHz is 1600 stereo frames, 4 bytes each.
    pump.pull(1 / 30);
    expect(out[0]!.length).toBe(6400);
    expect(out[0]!.every((b) => b === 0)).toBe(true);
    // 1000 samples at 24 kHz become 2000 frames at 48 kHz.
    const done = pump.play(pcm(Array.from({ length: 1000 }, () => 16384)));
    expect(pump.speaking).toBe(true);
    pump.pull(1 / 30);
    pump.pull(1 / 30);
    await done;
    expect(pump.speaking).toBe(false);
    const all = new Int16Array(Buffer.concat(out.slice(1)).buffer.slice(0));
    expect(all.slice(0, 4000).every((s) => Math.abs(s - 16384) <= 1)).toBe(true);
    expect(all.slice(4000).every((s) => s === 0)).toBe(true);
  });

  test("pump: fractional frames add up", () => {
    let bytes = 0;
    const pump = new VoicePump((b) => void (bytes += b.length));
    // 2997 frames at 29.97 fps: exactly 100 s.
    for (let i = 0; i < 2997; i++) pump.pull(1 / 29.97);
    expect(Math.abs(bytes / 4 - OUT_RATE * 100)).toBeLessThan(2);
  });

  test("pump: music plays under silence and ducks under the voice", async () => {
    const music: MusicSource = { read: (o, n) => (o.fill(0.5, 0, n * 2), true) };
    const out: Int16Array[] = [];
    const pump = new VoicePump((b) => void out.push(new Int16Array(b.buffer.slice(0))), { music, musicGain: 0.4, duckGain: 0.1 });
    pump.pull(1);
    const level = (a: Int16Array) => a[a.length - 2]! / 32767;
    expect(level(out[0]!)).toBeCloseTo(0.2, 2);
    void pump.play(pcm(Array.from({ length: 48_000 }, () => 0)));
    pump.pull(1);
    expect(level(out[1]!)).toBeCloseTo(0.05, 2);
  });

  test("envelope and duration", () => {
    const loud = Array.from({ length: 960 }, () => 8000);
    const quiet = Array.from({ length: 960 }, () => 800);
    expect(envelope(pcm([...loud, ...quiet]))).toEqual([1, 0.1]);
    expect(durationMs(pcm(loud))).toBe(40);
  });

  test("WAV data chunk, past other chunks", () => {
    const header = (tag: string, size: number) => [...tag].map((c) => c.charCodeAt(0)).concat([size & 255, (size >> 8) & 255, 0, 0]);
    const wav = new Uint8Array([...header("RIFF", 0).slice(0, 4), 0, 0, 0, 0, ..."WAVE".split("").map((c) => c.charCodeAt(0)), ...header("fmt ", 2), 1, 1, ...header("FLLR", 3), 9, 9, 9, 0, ...header("data", 4), 1, 2, 3, 4]);
    expect([...wavData(wav)]).toEqual([1, 2, 3, 4]);
  });
});

describe("avatar", () => {
  test("name plate and page expressions", () => {
    expect(plate("General Static")).toBe("GEN. STATIC");
    expect(installExpression("General Static")).toContain("jev-commentator");
    // The line goes in as JSON: quotes and markup can't break out.
    const e = sayExpression({ text: `"); alert(1); ("<b>`, mood: "happy", env: [], durMs: 1000 });
    expect(e).toContain(JSON.stringify(`"); alert(1); ("<b>`));
  });
});

describe("kick chat", () => {
  test("emotes to names, control characters out", () => {
    expect(cleanChat("gg [emote:37226:KEKW]\n\u202eevil")).toBe("gg KEKW evil");
  });
});

describe("encoder with the voice", () => {
  const band = { dir: "/b", bribes: false, lab: true };
  const base = { outputs: [{ name: "file" as const, url: "/x.mkv" }], width: 1280, height: 720, fps: 30, videoKbps: 4500, display: ":99" };

  test("Mac path: the voice is the only audio", () => {
    const args = ffmpegArgs({ ...base, audio: false, source: "pipe", voice: true }, band);
    expect(args).toContain("pipe:3");
    expect(args).not.toContain("anullsrc=channel_layout=stereo:sample_rate=48000");
    expect(args[args.indexOf("-filter_complex") + 1]).toEndWith(";[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a]");
    expect(args[args.indexOf("[v]") + 2]).toBe("[a]");
  });

  test("container: the game's sound under the mix", () => {
    const args = ffmpegArgs({ ...base, audio: true, source: "x11", voice: true }, band);
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[2:a]");
    expect(graph).toContain("volume=0.7");
    expect(graph).toEndWith("amix=inputs=2:normalize=0[a]");
  });

  test("no voice: unchanged", () => {
    const args = ffmpegArgs({ ...base, audio: false, source: "pipe" }, band);
    expect(args).not.toContain("pipe:3");
    expect(args[args.indexOf("[v]") + 2]).toBe("1:a");
  });
});

describe("music", () => {
  test("the lofi generator is deterministic and a valid WAV", () => {
    const spec = { ...TRACKS[0]!, bars: 6 };
    const a = render(spec);
    const b = render(spec);
    expect(a.left.length).toBe(b.left.length);
    expect(a.left.slice(48_000, 48_100)).toEqual(b.left.slice(48_000, 48_100));
    const peak = a.left.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(peak).toBeLessThanOrEqual(0.86);
    expect(peak).toBeGreaterThan(0.3);
    const file = wav(a.left, a.right);
    expect(String.fromCharCode(...file.subarray(0, 4))).toBe("RIFF");
    expect(file.length).toBe(44 + a.left.length * 4);
  });

  test("shuffle keeps every track", () => {
    expect(shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test("an empty playlist is silence", () => {
    const p = new Playlist(() => [], "ffmpeg", () => {});
    const out = new Float32Array(20).fill(1);
    expect(p.read(out, 10)).toBe(false);
    expect(out.every((x) => x === 0)).toBe(true);
  });
});

describe("lab", () => {
  test("Claude Code's stream becomes terminal lines: reads, edits as diffs, results", () => {
    expect(describeEvent({ type: "assistant", message: { content: [{ type: "text", text: "Looking at the hold rate." }, { type: "tool_use", name: "Read", input: { file_path: "/tmp/wt/harness/decide/questions.ts" } }] } })).toEqual([
      { kind: "text", text: "Looking at the hold rate." },
      { kind: "tool", text: "> read harness/decide/questions.ts" },
    ]);
    const edit = describeEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/x/harness/decide/pipeline.ts", old_string: "a\nb", new_string: "c" } }] } });
    expect(edit.map((l) => l.kind)).toEqual(["tool", "del", "del", "add"]);
    expect(describeEvent({ type: "result", total_cost_usd: 0.4213 })).toEqual([{ kind: "ok", text: "done ($0.42)" }]);
  });

  test("secrets never reach Claude Code's environment, and the screen masks them", () => {
    const env = { HOME: "/h", KICK_STREAM_KEY: "sk_us-west-2_abcdefgh", TYPESAFE_API_KEY: "ts-123456789", PATH: "/bin" };
    expect(scrubbedEnv(env)).toEqual({ HOME: "/h", PATH: "/bin" });
    const studio = new Studio(secretValues(env));
    expect(studio.redact("key=sk_us-west-2_abcdefgh!")).toBe("key=[redacted]!");
  });
});
