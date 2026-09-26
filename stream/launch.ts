// The whole stream in one command:
//
//   bun run live
//
// On a Mac: checks what the stream needs (ffmpeg-full, Chrome for Testing,
// the built extension, Claude Code for the lab), stops an instance that's
// already running, then runs stream/main.ts under `caffeinate` (the Mac must
// not sleep), restarting it if it ever crashes. Logs go to the terminal and
// to ~/Library/Logs/jeviatus-stream.log. Ctrl-C stops everything.
// Elsewhere: the Docker container (`bun run stream:up`).

import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dir, "..");
const say = (line: string) => console.log(`\x1b[32m[live]\x1b[0m ${line}`);
const fail = (line: string): never => {
  console.error(`\x1b[31m[live]\x1b[0m ${line}`);
  process.exit(1);
};

async function run(cmd: string[], opts: { cwd?: string; quiet?: boolean } = {}): Promise<boolean> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd ?? repo, stdout: opts.quiet ? "ignore" : "inherit", stderr: opts.quiet ? "ignore" : "inherit" });
  return (await p.exited) === 0;
}

const has = (bin: string) => Bun.which(bin) !== null;

if (process.platform !== "darwin") {
  say("not a Mac: starting the Docker container (bun run stream:up)");
  process.exit((await run(["bun", "run", "stream:up"])) ? 0 : 1);
}

// --- preflight --------------------------------------------------------------------------

if (!existsSync(path.join(repo, ".env"))) fail("no .env: copy .env.example and fill in TYPESAFE_API_KEY and KICK_STREAM_URL/KEY (stream/README.md)");
if (!existsSync("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg") && !process.env.FFMPEG_BIN) {
  say("installing ffmpeg-full (plain ffmpeg can't draw the band)");
  if (!has("brew") || !(await run(["brew", "install", "ffmpeg-full"]))) fail("couldn't install ffmpeg-full: brew install ffmpeg-full");
}
const pw = path.join(os.homedir(), "Library/Caches/ms-playwright");
const chrome = existsSync(pw) && readdirSync(pw).some((d) => /^chromium-\d+$/.test(d) && existsSync(path.join(pw, d, "chrome-mac-arm64")));
if (!chrome && !process.env.CHROMIUM_BIN) {
  say("installing Chrome for Testing (branded Chrome ignores --load-extension)");
  if (!(await run(["bunx", "playwright", "install", "chromium"]))) fail("couldn't install Chrome for Testing: bunx playwright install chromium");
}
if (!existsSync(path.join(repo, "dist/jev-openfront-extension/manifest.json"))) {
  say("building the Jev extension");
  if (!(await run(["bun", "run", "build:extension"]))) fail("the extension build failed");
}
if (process.env.STREAM_LAB !== "false" && !has("claude")) say("warning: no `claude` CLI, so the lab sessions can analyze but not write changes (https://claude.com/claude-code)");

// One stream at a time: stop the one that's running (it shuts down cleanly on SIGTERM).
const running = Bun.spawnSync(["pgrep", "-fx", "bun stream/main.ts"]).stdout.toString().trim().split("\n").filter(Boolean);
if (running.length) {
  say(`stopping the stream that's already running (pid ${running.join(", ")})`);
  for (const pid of running) process.kill(Number(pid), "SIGTERM");
  for (let i = 0; i < 40 && running.some((pid) => Bun.spawnSync(["kill", "-0", pid]).exitCode === 0); i++) await Bun.sleep(500);
  for (const pid of running) if (Bun.spawnSync(["kill", "-0", pid]).exitCode === 0) process.kill(Number(pid), "SIGKILL");
}

// --- run, and keep running ---------------------------------------------------------------

const logFile = path.join(os.homedir(), "Library/Logs/jeviatus-stream.log");
mkdirSync(path.dirname(logFile), { recursive: true });
say(`going live; logs also in ${logFile}. Ctrl-C to stop.`);

let child: ReturnType<typeof Bun.spawn> | null = null;
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  say("stopping the stream");
  child?.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function pipe(stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream): Promise<void> {
  for await (const chunk of stream) {
    out.write(chunk);
    appendFileSync(logFile, chunk);
  }
}

let backoff = 5_000;
while (!stopping) {
  const started = Date.now();
  // caffeinate -dis: no display, idle or system sleep while the stream runs.
  child = Bun.spawn(["caffeinate", "-dis", "bun", "stream/main.ts"], {
    cwd: repo,
    env: { ...process.env, STREAM_PLATFORM: "mac" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([pipe(child.stdout as ReadableStream<Uint8Array>, process.stdout), pipe(child.stderr as ReadableStream<Uint8Array>, process.stderr)]);
  const code = await child.exited;
  if (stopping) break;
  if (Date.now() - started > 10 * 60_000) backoff = 5_000;
  say(`the stream exited (${code}); restarting in ${backoff / 1000}s`);
  await Bun.sleep(backoff);
  backoff = Math.min(120_000, backoff * 2);
}
process.exit(0);
