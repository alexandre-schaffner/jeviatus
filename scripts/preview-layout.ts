// Stills of the stream's layout, rendered offline with the stream's own code:
// no Kick, no live browser, nothing running is touched.
//
//   bun scripts/preview-layout.ts [--out DIR] [--scenes match,lobby,lab,bribe]
//                                 [--recording FILE.mkv] [--at SECONDS] [--frame GAME.png]
//
// For each scene it
//   1. takes a game picture: a still from a recording (the newest one in
//      STREAM_RECORD_DIR, else ~/Library/Application Support/jeviatus/recordings)
//      with the band that was on it cut off, or --frame (a bare game screenshot);
//   2. opens it, or the lab page (stream/studio.ts) with sample state, in a
//      throwaway headless Chrome (own profile, random DevTools port), draws the
//      commentator on it (stream/avatar.ts) with a sample line and screenshots it;
//   3. writes the band's text files (stream/band.ts) from a sample BandState and
//      runs ffmpeg with the broadcast's own filter graph (stream/encoder.ts) on
//      the screenshot, into DIR/<scene>.png (default DIR: .context/layout).

import { spawn } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { installExpression, sayExpression } from "../stream/avatar";
import type { BallotEntry } from "../stream/ballot";
import { Band, type BandState } from "../stream/band";
import { Cdp } from "../stream/cdp";
import { bandDesign, bandLines, screenSize } from "../stream/bandLayout";
import { ffmpegArgs } from "../stream/encoder";
import { Studio } from "../stream/studio";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: path.resolve(import.meta.dir, "..", ".context", "layout") },
    scenes: { type: "string", default: "match,lobby,lab,bribe" },
    recording: { type: "string" },
    at: { type: "string", default: "60" },
    frame: { type: "string" },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "720" },
  },
  strict: true,
});

const W = Number(values.width);
const H = Number(values.height);
const FFMPEG = process.env.FFMPEG_BIN ?? (existsSync("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg") ? "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" : "ffmpeg");
const out = path.resolve(values.out);
mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), "jev-preview-"));

async function sh(cmd: string[]): Promise<Uint8Array> {
  const p = spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).bytes(), new Response(p.stderr).text()]);
  if ((await p.exited) !== 0) throw new Error(`${path.basename(cmd[0]!)} failed: ${stderr.trim().slice(-800)}`);
  return stdout;
}

// --- the game picture ----------------------------------------------------------------

function newestRecording(): string {
  const dir = process.env.STREAM_RECORD_DIR ?? `${process.env.HOME}/Library/Application Support/jeviatus/recordings`;
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".mkv")).sort() : [];
  // The newest segment may still be recording: take the one before it.
  const pick = files.at(-2) ?? files.at(-1);
  if (!pick) throw new Error(`no recordings in ${dir}: pass --frame or --recording`);
  return path.join(dir, pick);
}

// The band's top edge: the accent line across the whole width, found as the
// topmost row whose pixels are all that green in a column sample.
async function bandTop(png: string, h: number): Promise<number> {
  const col = await sh([FFMPEG, "-loglevel", "error", "-i", png, "-vf", "crop=1:ih:iw/3:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const green = (y: number) => {
    const [r, g, b] = [col[y * 3]!, col[y * 3 + 1]!, col[y * 3 + 2]!];
    return Math.abs(r - 0x53) < 40 && Math.abs(g - 0xe3) < 40 && Math.abs(b - 0xa6) < 40;
  };
  for (let y = Math.floor(h * 0.6); y < h; y++) if (green(y)) return y;
  return h;
}

async function gameFrame(screen: { width: number; height: number }): Promise<string> {
  const target = path.join(work, `game-${screen.height}.png`);
  if (existsSync(target)) return target;
  let src = values.frame;
  if (!src) {
    src = path.join(work, "still.png");
    await sh([FFMPEG, "-loglevel", "error", "-y", "-ss", values.at!, "-i", values.recording ?? newestRecording(), "-frames:v", "1", "-vf", `scale=${W}:${H}`, src]);
    const top = await bandTop(src, H);
    // Cut the old band off and fit what's left to the browser's size now (a
    // page on the stream lays itself out again; a still can only stretch).
    await sh([FFMPEG, "-loglevel", "error", "-y", "-i", src, "-vf", `crop=iw:${top}:0:0,scale=${screen.width}:${screen.height}`, target]);
  } else {
    await sh([FFMPEG, "-loglevel", "error", "-y", "-i", src, "-vf", `scale=${screen.width}:${screen.height}`, target]);
  }
  return target;
}

// --- a throwaway browser ---------------------------------------------------------------

function headlessChrome(): string {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  const root = `${process.env.HOME}/Library/Caches/ms-playwright`;
  const dirs = existsSync(root) ? readdirSync(root).sort().reverse() : [];
  const bins = [
    ...dirs.filter((d) => d.startsWith("chromium_headless_shell-")).map((d) => `${root}/${d}/chrome-headless-shell-mac-arm64/chrome-headless-shell`),
    ...dirs.filter((d) => /^chromium-\d+$/.test(d)).map((d) => `${root}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`),
  ];
  const bin = bins.find((b) => existsSync(b));
  if (!bin) throw new Error("no headless Chrome: run `bunx playwright install chromium-headless-shell`, or set CHROMIUM_BIN");
  return bin;
}

// Never the stream's own DevTools (9222) or trace sink (9231) port.
const port = 29_000 + Math.floor(Math.random() * 3000);
const chrome = spawn(
  [headlessChrome(), "--headless", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${path.join(work, "profile")}`, "--hide-scrollbars", "--no-first-run", "--allow-file-access-from-files", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);

async function shoot(cdp: Cdp, url: string, size: { width: number; height: number }, line: string | null, file: string): Promise<void> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const session = await cdp.session(targetId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false }, session);
  await cdp.send("Page.navigate", { url }, session);
  await Bun.sleep(2500);
  await cdp.evaluate(targetId, installExpression("General Static"));
  if (line) {
    await cdp.evaluate(targetId, sayExpression({ text: line, mood: "smug", env: [], durMs: 600 }));
    await Bun.sleep(1200);
  }
  const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, session);
  writeFileSync(file, Buffer.from(data, "base64"));
  await cdp.send("Target.closeTarget", { targetId });
}

// --- sample state ------------------------------------------------------------------------

const entry = (number: number, name: string, author: string, votes: number): BallotEntry => ({
  number,
  title: name,
  author,
  url: `https://github.com/alexandre-schaffner/jeviatus/pull/${number}`,
  votes,
  strategy: { name, doctrine: "" },
});
const ballot = [entry(14, "Turtle up, then nuke the leader", "ann", 9), entry(11, "Befriend everyone, betray late", "bo", 4), entry(9, "Rush the nearest bot", "cy", 2)];
const base: BandState = {
  repo: "alexandre-schaffner/jeviatus",
  playing: ballot[0]!,
  playingPot: null,
  ballot: { entries: ballot, rejected: [], fetchedAt: 0 },
  bribe: null,
  status: "UncleFred attacks Jev",
  clock: "14:32",
  standing: "#4 of 23  ·  6.2% land",
  games: 12,
  wins: 1,
  lastResult: "eliminated at 21:07",
  lab: { build: "change 3", title: "Gate attacks on the troop ratio", games: 2, wins: 0, meanPlacement: 6.5, needed: 4, everyGames: 2 },
};

interface Scene {
  band: BandState;
  page: "game" | "lab";
  line: string | null;
}

const SCENES: Record<string, Scene> = {
  match: { band: base, page: "game", line: "UncleFred is attacking the kid? With THAT army? Oh, this is gonna be beautiful." },
  lobby: {
    band: { ...base, playing: null, ballot: null, status: "Jev is armed. Starting in 12s", clock: null, standing: null, games: 0, wins: 0, lastResult: null, lab: { build: null, title: null, games: 0, wins: 0, meanPlacement: null, needed: 4, everyGames: 2 } },
    page: "game",
    line: null,
  },
  lab: { band: { ...base, status: "LIVE CODING: Claude Code is writing a change to Jev's brain", clock: null, standing: null }, page: "lab", line: "Brain surgery time. Hand me the wrench, robot." },
  bribe: {
    band: {
      ...base,
      playingPot: 25_000_000_000n,
      bribe: { wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", ticker: "JEV", decimals: 6, pots: new Map([[11, 4_000_000_000n]]), minPot: 1_000_000n, thanks: null },
    },
    page: "game",
    line: null,
  },
};

function sampleStudio(): Studio {
  const studio = new Studio();
  studio.start();
  studio.reset("Claude Code studies Jev's last games and rewrites one piece of its brain. The next games test the change.");
  studio.step(0, "done", "20 games, 1 won");
  studio.step(1, "done", "kept");
  studio.step(2, "active");
  studio.state.build = { label: "change 3", sha: "4be1c0ffee", games: 4, needed: 4 };
  studio.state.record = { games: 20, wins: 1, meanPlacement: 7.4, medianMinutes: 11 };
  studio.state.problems = [
    { title: "Attacked a much stronger neighbor", count: 9 },
    { title: "Sat on full troops for minutes", count: 6 },
    { title: "Broke an alliance while outnumbered", count: 3 },
  ];
  const lines: [Parameters<Studio["line"]>[0], string][] = [
    ["tool", "$ bun run analyze"],
    ["out", "  20 game(s): 1 won, mean placement 7.4, median 11 min survived"],
    ["out", "  9x Attacked a much stronger neighbor (7 game(s))"],
    ["head", "Change 3: Claude Code, from 4 games on 4be1c0f"],
    ["text", "The attacks that lose the most troops start below 40% of the target's army. I'll gate attack_player on the troop ratio."],
    ["tool", "> read harness/decide/gates.ts"],
    ["tool", "> edit harness/decide/gates.ts"],
    ["del", "-   if (target.troops > me.troops * 1.2) return null;"],
    ["add", "+   const ratio = me.troops / Math.max(1, target.troops);"],
    ["add", "+   if (ratio < MIN_ATTACK_RATIO) return { gate: \"too strong\", ratio };"],
    ["tool", "$ bun run typecheck"],
    ["ok", "  no type errors"],
  ];
  for (const [kind, text] of lines) studio.line(kind, text);
  return studio;
}

// --- render ---------------------------------------------------------------------------------

const cdp = await Cdp.connect(port, 20_000);
const studio = sampleStudio();
try {
  for (const name of values.scenes!.split(",").map((s) => s.trim()).filter(Boolean)) {
    const scene = SCENES[name];
    if (!scene) throw new Error(`no scene "${name}" (${Object.keys(SCENES).join(", ")})`);
    const bribes = scene.band.bribe !== null;
    const lines = bandLines(bribes);
    const screen = screenSize({ width: W, height: H }, lines);
    let url = studio.url;
    if (scene.page === "game") {
      const html = path.join(work, `game-${screen.height}.html`);
      writeFileSync(html, `<!doctype html><body style="margin:0;height:100vh;background:url('file://${await gameFrame(screen)}') 0 0/100% 100%"></body>`);
      url = `file://${html}`;
    }
    const page = path.join(work, `${name}-page.png`);
    await shoot(cdp, url, screen, scene.line, page);

    const dir = path.join(work, `band-${name}`);
    new Band(dir, bandDesign({ width: W, height: H, bribes, lab: true })).write(scene.band);
    const args = ffmpegArgs(
      { outputs: [{ name: "file", url: "/dev/null" }], width: W, height: H, fps: 30, videoKbps: 4500, audio: false, display: ":0", source: "pipe", voice: false },
      { dir, bribes, lab: true },
    );
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    const target = path.join(out, `${name}.png`);
    await sh([FFMPEG, "-loglevel", "error", "-y", "-i", page, "-filter_complex", graph, "-map", "[v]", "-frames:v", "1", target]);
    console.log(target);
  }
} finally {
  studio.stop();
  cdp.close();
  chrome.kill();
  await chrome.exited;
  rmSync(work, { recursive: true, force: true });
}
