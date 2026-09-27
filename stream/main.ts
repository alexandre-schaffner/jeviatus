// 24/7 Kick and pump.fun stream of Jev playing public OpenFront matches.
//
//   bun stream/main.ts            (the container's entrypoint; see stream/README.md)
//   bun run stream:mac            (the same, on this Mac without Docker)
//
// Xvfb gives Chromium a screen, PulseAudio gives it speakers, ffmpeg films
// both and sends them to Kick and pump.fun with the vote band underneath, and
// the driver plays one public match after another through the Jev extension.
// Viewers steer it by voting on strategy PRs, or by bribing Jev with the
// stream's coin.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { GitHubBallot } from "./ballot";
import { Band, type BandState } from "./band";
import { bandDesign, bandLines, screenSize } from "./bandLayout";
import { type Bribe, shortAddress, SolanaBribes } from "./bribes";
import { Cdp } from "./cdp";
import { Character } from "./character";
import { Lab, secretValues } from "./lab";
import { ensureLofi } from "./lofi";
import { audioFiles, Playlist } from "./music";
import { Studio } from "./studio";
import { VoicePump } from "./voice";
import { loadStreamConfig } from "./config";
import { Driver } from "./driver";
import { describeOutputs, ffmpegArgs, slaveFailure } from "./encoder";
import { validUsername } from "./openfront";
import { CdpPointer, type Pointer, XdotoolPointer } from "./pointer";
import { startTraceSink } from "../harness/log/sink";
import { run, Supervised, waitFor } from "./procs";
import { pruneSegments } from "./recordings";
import { Screencast } from "./screencast";
import { bundledCommit, rebuildFor } from "./updater";

const cfg = loadStreamConfig();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
if (!validUsername(cfg.username)) throw new Error(`JEV_USERNAME "${cfg.username}" isn't a valid OpenFront name (3-20 letters, digits, space, _ . -)`);
const extensionDir = path.resolve(import.meta.dir, "..", cfg.extensionDir);
if (!existsSync(path.join(extensionDir, "manifest.json"))) throw new Error(`no built extension at ${extensionDir} (bun run build:extension)`);

const lines = bandLines(cfg.bribe !== null);
const screen = screenSize(cfg, lines);
const bandShape = { bribes: cfg.bribe !== null, lab: cfg.lab !== null };
const band = new Band(process.env.BAND_DIR ?? "/tmp/jev-band", bandDesign({ width: cfg.width, height: cfg.height, ...bandShape }));
const bribes = cfg.bribe ? new SolanaBribes({ ...cfg.bribe }) : null;
const bribeBand = (thanks: string | null = null): BandState["bribe"] =>
  bribes && cfg.bribe
    ? // pump.fun coins have 6 decimals; the real count arrives with the first refresh.
      { wallet: cfg.bribe.wallet, ticker: cfg.bribe.ticker, decimals: bribes.decimals ?? 6, pots: bribes.pots(), minPot: bribes.minPot, thanks }
    : null;
const bandState: BandState = {
  repo: cfg.ballot.repo,
  playing: null,
  playingPot: null,
  ballot: null,
  bribe: bribeBand(),
  status: "Starting up",
  clock: null,
  standing: null,
  games: 0,
  wins: 0,
  lastResult: null,
  lab: null,
};
const setBand = (patch: Partial<BandState>) => {
  Object.assign(bandState, patch);
  band.write(bandState);
};
setBand({});

const env = { DISPLAY: cfg.display };

// --- X server and audio -------------------------------------------------------------

const container = cfg.platform === "container";
const displayNum = cfg.display.replace(/^:/, "").split(".")[0];
const xvfb = !container
  ? null
  : new Supervised({
      name: "xvfb",
      cmd: () => {
        // A crashed server leaves its lock behind and the next one refuses to start.
        rmSync(`/tmp/.X${displayNum}-lock`, { force: true });
        return ["Xvfb", cfg.display, "-screen", "0", `${screen.width}x${screen.height}x24`, "-nolisten", "tcp", "-ac"];
      },
      log,
    });
if (xvfb) {
  xvfb.start();
  if (!(await waitFor(() => existsSync(`/tmp/.X11-unix/X${displayNum}`), 10_000))) throw new Error("Xvfb didn't start");
}

if (container && cfg.audio) {
  const pulse = new Supervised({
    name: "pulse",
    cmd: () => [
      "pulseaudio", "--daemonize=no", "--exit-idle-time=-1", "--disallow-exit", "-n",
      "--load=module-native-protocol-unix",
      "--load=module-null-sink sink_name=stream sink_properties=device.description=stream",
      "--load=module-always-sink",
    ],
    log,
    quiet: /authentication key|cookie|Disabling realtime|dbus/i,
  });
  pulse.start();
  await waitFor(async () => (await run(["pactl", "info"])).length > 0, 10_000, 500);
  await run(["pactl", "set-default-sink", "stream"]).catch((e) => log(`[pulse] ${e.message}`));
}

// --- browser ------------------------------------------------------------------------

let cdp: Cdp | null = null;
// STREAM_PROXY sends the browser's traffic through a proxy: a residential or
// ISP one, when Cloudflare keeps challenging a server's datacenter IP
// (deploy/README.md). Loopback (the lab's screen, the trace sink) never uses it.
const proxyArgs = (): string[] => {
  const proxy = process.env.STREAM_PROXY?.trim();
  return proxy ? [`--proxy-server=${proxy}`] : [];
};
// Chrome for Testing, as Playwright installs it: unlike branded Chrome it
// still honors --load-extension.
function macChrome(): string {
  const root = `${process.env.HOME}/Library/Caches/ms-playwright`;
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
  const app = "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  for (const d of dirs.reverse()) if (existsSync(`${root}/${d}/${app}`)) return `${root}/${d}/${app}`;
  throw new Error("no Chrome for Testing found: run `bunx playwright install chromium`, or set CHROMIUM_BIN");
}

// The Mac path: an ordinary window with the real GPU. The page is pinned to
// the stream size and filmed over DevTools, so the window can sit anywhere,
// even behind others, as long as Chrome keeps painting it.
function macChromeArgs(): string[] {
  return [
    process.env.CHROMIUM_BIN ?? macChrome(),
    `--user-data-dir=${cfg.profileDir}`,
    `--remote-debugging-port=${cfg.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    "--window-position=40,40",
    `--window-size=${screen.width},${screen.height + 80}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-crash-restore-bubble",
    "--autoplay-policy=no-user-gesture-required",
    // MacWebContentsOcclusion: macOS tells Chrome when a window is covered or
    // hidden, and Chrome then stops painting it (the stream would freeze).
    "--disable-features=Translate,MediaRouter,OptimizationHints,MacWebContentsOcclusion",
    "--lang=en-US",
    // Keep painting while covered by other windows.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    ...proxyArgs(),
    ...(process.env.CHROMIUM_FLAGS?.split(/\s+/).filter(Boolean) ?? []),
    // Not headless: it would dodge macOS pausing hidden windows, but
    // openfront.io's Cloudflare check stops headless Chrome at the door.
    `--app=${cfg.openfrontUrl}`,
  ];
}

function chromiumArgs(): string[] {
  if (!container) return macChromeArgs();
  return [
    process.env.CHROMIUM_BIN ?? "chromium",
    `--user-data-dir=${cfg.profileDir}`,
    `--remote-debugging-port=${cfg.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    "--kiosk",
    "--window-position=0,0",
    `--window-size=${screen.width},${screen.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--autoplay-policy=no-user-gesture-required",
    "--password-store=basic",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--lang=en-US",
    "--disable-dev-shm-usage",
    // No GPU in the container: WebGL runs on the CPU through Mesa's llvmpipe
    // (about 10x SwiftShader's frame rate on OpenFront's renderer), which
    // Chromium blocklists unless told otherwise. Compositing stays in
    // software: GPU compositing never reaches the Xvfb window, so ffmpeg
    // would film a blank screen. OpenFront itself refuses CPU WebGL; the
    // driver's GPU_SHIM (openfront.ts) gets it past that.
    "--use-gl=angle",
    "--use-angle=gl",
    "--ignore-gpu-blocklist",
    "--disable-gpu-compositing",
    ...proxyArgs(),
    ...(process.env.CHROMIUM_FLAGS?.split(/\s+/).filter(Boolean) ?? []),
    cfg.openfrontUrl,
  ];
}

const chromium = new Supervised({
  name: "chromium",
  env,
  cmd: () => {
    // The profile lives on the volume; a previous container (another
    // hostname) leaves its singleton lock behind and Chromium refuses to start.
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(path.join(cfg.profileDir, f), { force: true });
    return chromiumArgs();
  },
  log,
  quiet: /dbus|Fontconfig|ALSA|libva|gcm|fcm|Floss|bluez|DEPRECATED_ENDPOINT|sandbox|p2p\/socket_manager|stun|FIDO|touch_id|GL Driver Message/i,
  onStart: () => {
    cdp?.close();
    cdp = null;
  },
});
chromium.start();

async function connect(): Promise<Cdp> {
  if (cdp && !cdp.closed) return cdp;
  cdp = await Cdp.connect(cfg.cdpPort, 60_000);
  log("[driver] connected to Chromium");
  return cdp;
}
await connect();

// --- encoder ------------------------------------------------------------------------

const record = cfg.record;
if (record) mkdirSync(record.dir, { recursive: true });
// A secondary platform that drops (pump.fun ending the session, a network
// blip) leaves the others streaming; the encoder restarts later to reconnect
// it, backing off while it keeps failing. The restart blips every platform.
let redial: ReturnType<typeof setTimeout> | null = null;
let redialMs = 60_000;
let lastDropAt = 0;
const onDrop = (line: string) => {
  const dropped = slaveFailure(line, cfg.outputs);
  if (dropped === null || redial !== null) return;
  if (Date.now() - lastDropAt > 30 * 60_000) redialMs = 60_000;
  lastDropAt = Date.now();
  log(`[ffmpeg] lost ${dropped.name}; the others keep streaming, reconnecting in ${Math.round(redialMs / 1000)}s`);
  redial = setTimeout(() => {
    redial = null;
    void ffmpeg.restart();
  }, redialMs);
  redialMs = Math.min(15 * 60_000, redialMs * 2);
};
// Homebrew's plain ffmpeg lacks drawtext (the band); ffmpeg-full has it.
const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const ffmpegBin = process.env.FFMPEG_BIN ?? (!container && existsSync(FFMPEG_FULL) ? FFMPEG_FULL : "ffmpeg");
// --- the stream's own audio: lofi, and the commentator's voice over it --------------

// Your own tracks if MUSIC_DIR has any; else the original lofi, composed on first run.
if (cfg.music) mkdirSync(cfg.music.dir, { recursive: true });
const ownTracks = cfg.music ? audioFiles(cfg.music.dir) : [];
if (cfg.music && ownTracks.length === 0) await ensureLofi(cfg.music.generatedDir, log);
const music = cfg.music
  ? new Playlist(() => {
      const own = audioFiles(cfg.music!.dir);
      return own.length ? own : audioFiles(cfg.music!.generatedDir);
    }, process.env.FFMPEG_BIN ?? (!container && existsSync("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg") ? "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" : "ffmpeg"), log)
  : null;
if (cfg.music) log(`[music] ${ownTracks.length ? `${ownTracks.length} track(s) from ${cfg.music.dir}` : `original lofi from ${cfg.music.generatedDir}`}`);
const voice = cfg.character !== null || music !== null;
const ffmpeg = new Supervised({
  name: "ffmpeg",
  // Segment names are UTC start times (stream/recordings.ts).
  env: { ...env, TZ: "UTC" },
  stdin: !container,
  fd3: voice,
  cmd: () => [
    ffmpegBin,
    ...ffmpegArgs(
      { ...cfg, source: container ? "x11" : "pipe", voice },
      { dir: band.dir, ...bandShape },
      record ?? undefined,
    ),
  ],
  log,
  // Screencast JPEGs are full-range YUV; swscale says so on every restart.
  quiet: /deprecated pixel format/,
  onLine: onDrop,
});
log(`[ffmpeg] streaming ${cfg.width}x${cfg.height}@${cfg.fps} ${cfg.videoKbps}kbps to ${describeOutputs(cfg.outputs)}`);
ffmpeg.start();

// The mix is the encoder's pipe:3 audio.
const mix = voice ? new VoicePump((pcm) => void ffmpeg.write3(pcm), { music, musicGain: cfg.music?.volume }) : null;
music?.start();
// The lab's screen, and the pages worth filming (and drawing the commentator on).
const studio = cfg.lab ? new Studio(secretValues()) : null;
studio?.start();
const studioBase = studio ? studio.url.replace(/\/studio$/, "") : null;
const filmable = (url: string) => url.startsWith(cfg.openfrontUrl) || (studioBase !== null && url.startsWith(studioBase));
const character = cfg.character && mix ? new Character({ cfg: cfg.character, filmable, cdp: () => cdp, pump: mix, log }) : null;
const screencast = container
  ? null
  : new Screencast({
      cdp: () => cdp,
      width: screen.width,
      height: screen.height,
      fps: cfg.fps,
      filmable,
      write: (jpeg) => void ffmpeg.write(jpeg),
      onFrames: mix ? (n) => mix.pull(n / cfg.fps) : undefined,
      log,
    });
screencast?.start();
// In the container nothing else paces the mix: it keeps its own clock.
if (mix && container) mix.startClock();
character?.start();
if (record) {
  log(`[ffmpeg] recording ${record.segmentSeconds}s segments to ${record.dir}, keeping ${record.keepHours}h`);
  setInterval(() => {
    for (const f of pruneSegments(record.dir, record.keepHours)) log(`[record] pruned ${path.basename(f)}`);
  }, 60_000);
}

// --- bribes ------------------------------------------------------------------------

if (bribes && cfg.bribe) {
  const { wallet, mint, refreshSeconds } = cfg.bribe;
  log(`[bribe] counting $${cfg.bribe.ticker} (${mint}) sent to ${wallet}`);
  let thanksUntil = 0;
  const thanks = (b: Bribe): string => {
    const entry = b.pr === null ? undefined : bandState.ballot?.entries.find((e) => e.number === b.pr);
    const what = b.pr === null ? "a tip, thank you" : entry ? `for PR #${b.pr} "${entry.strategy.name}"` : `for PR #${b.pr} (it plays once it's on the ballot)`;
    return `NEW BRIBE  >  ${shortAddress(b.from)} sent ${bribes.format(b.amount)} ${what}`;
  };
  let latest: string | null = null;
  const poll = async () => {
    try {
      const found = await bribes.refresh();
      for (const b of found) {
        log(`[bribe] ${b.from} sent ${bribes.format(b.amount)} ${b.pr === null ? "(no PR)" : `for PR #${b.pr}`}${b.memo ? ` memo=${JSON.stringify(b.memo.slice(0, 80))}` : ""} ${b.signature}`);
        latest = thanks(b);
        thanksUntil = Date.now() + 30_000;
      }
    } catch (err) {
      // Keep the last pots; the RPC being down mustn't stop the stream.
      log(`[bribe] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setBand({ bribe: bribeBand(Date.now() < thanksUntil ? latest : null) });
  };
  void poll();
  setInterval(() => void poll(), refreshSeconds * 1000);
}

// --- game traces --------------------------------------------------------------------

const traces = startTraceSink({
  ...cfg.trace,
  onEvent: (_gameID, e) => {
    if (e.type !== "step" || !character) return;
    try {
      character.brain.decision(e);
    } catch (err) {
      log(`[commentator] ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
log(`[trace] logging games to ${cfg.trace.dir}`);

// --- driver -------------------------------------------------------------------------

const live = (): Cdp => {
  if (!cdp || cdp.closed) throw new Error("browser connection lost");
  return cdp;
};
const xdotool = new XdotoolPointer();
const driver = new Driver({
  cfg,
  cdp: live,
  pointer: (page): Pointer => (cfg.pointer === "cdp" ? new CdpPointer(live(), page) : xdotool),
  ballot: new GitHubBallot({ repo: cfg.ballot.repo, token: cfg.ballot.token, requireApproval: cfg.ballot.requireApproval }),
  bribes: bribes ?? undefined,
  // A match starting (the build it plays on) or ending (a game for the build
  // under test): the lab's row catches up.
  band: (patch) => setBand("playing" in patch || "games" in patch ? { ...patch, lab: labBand() } : patch),
  log,
  bundledCommit: () => bundledCommit(cfg.extensionDir),
  traces,
  commentator: character?.brain,
  lab:
    cfg.lab && studio
      ? {
          url: studio.url,
          session: () => lab!.session(),
        }
      : undefined,
  rebuild: async (commit) => {
    await rebuildFor(commit, log);
    await chromium.restart();
    await connect();
  },
});

// Reconnect whenever Chromium restarted under us.
setInterval(() => {
  if (chromium.running && (!cdp || cdp.closed)) void connect().catch((e) => log(`[driver] reconnect failed: ${e.message}`));
}, 2000);
const lab =
  cfg.lab && studio
    ? new Lab(
        {
          repo: path.resolve(import.meta.dir, ".."),
          dir: cfg.lab.dir,
          traceDirs: [cfg.trace.dir],
          extensionDir,
          gamesPerBuild: cfg.lab.gamesPerBuild,
          everyGames: cfg.lab.everyGames,
          maxMinutes: cfg.lab.maxMinutes,
          model: cfg.lab.model,
          prs: cfg.lab.prs,
        },
        {
          studio,
          log,
          band: (status) => setBand({ status }),
          announce: (key, facts, fallback, mood) => character?.brain.moment({ key, priority: 70, facts, fallback, mood, ttlMs: 60_000, repeatMs: 0 }),
          restartBrowser: async () => {
            await chromium.restart();
            await connect();
          },
        },
      )
    : null;
// The band's lab row: what the lab is testing (read from the games' traces).
function labBand(): BandState["lab"] {
  try {
    return lab?.summary() ?? null;
  } catch (err) {
    log(`[lab] ${err instanceof Error ? err.message : String(err)}`);
    return bandState.lab;
  }
}
setBand({ lab: labBand() });
if (cfg.lab) log(`[lab] live coding every ${cfg.lab.everyGames} games; a change is judged after ${cfg.lab.gamesPerBuild} games on it${cfg.lab.prs ? "; opens PRs" : "; branches stay local"}`);
// The container has no `claude` login of its own: it comes from .env.
if (cfg.lab && container && !process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() && !process.env.LAB_ANTHROPIC_API_KEY?.trim()) {
  log("[lab] warning: no CLAUDE_CODE_OAUTH_TOKEN or LAB_ANTHROPIC_API_KEY, so Claude Code can't log in and every change fails (deploy/README.md); STREAM_LAB=false turns the lab off");
}

const shutdown = async () => {
  log("shutting down");
  // Never hang on the way out (a stuck connection, a child that won't die).
  setTimeout(() => process.exit(1), 15_000).unref();
  character?.stop();
  mix?.stop();
  studio?.stop();
  await traces.stop();
  screencast?.stop();
  await ffmpeg.stop();
  await chromium.stop();
  await xvfb?.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await driver.run();
