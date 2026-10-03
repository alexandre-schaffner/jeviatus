// Watches a Kick channel and runs the whole pipeline (cli.ts all) on every
// VOD that finishes, one at a time. What the container runs (vodclips/README.md).
//
//   bun vodclips/watch.ts [options]
//
//   --channel <slug>     Kick channel (or VODCLIPS_CHANNEL; required)
//   --streamer <file>    streamer profile (or VODCLIPS_STREAMER; default vodclips/streamers/<channel>.json, else a generic one)
//   --data <dir>         one work dir per VOD under <data>/<channel>/<vod id> (default /data)
//   --every <minutes>    how often to look for a new VOD (default 30)
//   --top <n>            clips per VOD (default 8)
//   --once               look once, process what's new, exit (for an outside scheduler)
//   --backfill           also process VODs that finished before the first run
//
// The first run only marks the VODs already on the channel as seen, so it
// starts with the next stream instead of rendering the whole back catalog.
// After a VOD's clips are rendered, the 160p segments, the audio and the
// chunks are deleted (about 3 GB a day of stream); the JSON and out/ stay.
//
// Sealed secrets: on start it makes an age keypair in <data>/secrets and logs
// the public key. Any <data>/secrets/*.env.age encrypted to it is decrypted
// before each VOD and its KEY=value lines go into the pipeline's environment
// (how the Hermes agent hands over its LLM provider; vodclips/README.md).
// Values are never logged.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { listVods } from "./kick";

const { values } = parseArgs({
  options: {
    channel: { type: "string", default: process.env.VODCLIPS_CHANNEL },
    streamer: { type: "string", default: process.env.VODCLIPS_STREAMER },
    data: { type: "string", default: "/data" },
    every: { type: "string", default: "30" },
    top: { type: "string", default: "8" },
    once: { type: "boolean", default: false },
    backfill: { type: "boolean", default: false },
  },
});

if (!values.channel) {
  console.error("pass --channel <kick slug> (or set VODCLIPS_CHANNEL)");
  process.exit(2);
}
const channel = values.channel;
const root = path.join(values.data!, channel);
const stateFile = path.join(root, "state.json");
mkdirSync(root, { recursive: true });
const log = (l: string) => console.log(`${new Date().toISOString().slice(0, 19)} [watch] ${l}`);

const secrets = path.join(values.data!, "secrets");
const identity = path.join(secrets, "identity.txt");

function sealedSetup(): string {
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  if (!existsSync(identity) && Bun.spawnSync(["age-keygen", "-o", identity], { stderr: "ignore" }).exitCode !== 0) throw new Error("age-keygen failed");
  return readFileSync(identity, "utf8").match(/public key: (age1\w+)/)?.[1] ?? "";
}

// KEY=value lines from every sealed file; a file that won't decrypt is skipped.
function unseal(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const f of readdirSync(secrets).filter((f) => f.endsWith(".env.age")).sort()) {
    const r = Bun.spawnSync(["age", "-d", "-i", identity, path.join(secrets, f)], { stderr: "ignore" });
    if (r.exitCode !== 0) {
      log(`sealed ${f}: can't decrypt (not encrypted to this container's key?)`);
      continue;
    }
    const keys: string[] = [];
    for (const line of r.stdout.toString().split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) {
        env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
        keys.push(m[1]!);
      }
    }
    log(`sealed ${f}: ${keys.join(", ") || "no KEY=value lines"}`);
  }
  return env;
}

interface State {
  done: number[];
  failed: Record<string, number>; // vod id -> attempts
}
const MAX_ATTEMPTS = 3;

const readState = (): State | null => (existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, "utf8")) as State) : null);
const writeState = (s: State) => writeFileSync(stateFile, JSON.stringify(s, null, 1));

async function processVod(id: number, state: State) {
  const work = path.join(root, String(id));
  log(`VOD ${id}: starting (${work})`);
  const env = { ...process.env, ...unseal() };
  const p = Bun.spawn(["bun", path.join(import.meta.dir, "cli.ts"), "all", "--channel", channel, "--vod", String(id), "--work", work, "--top", values.top!, ...(values.streamer ? ["--streamer", values.streamer] : [])], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await p.exited) === 0) {
    for (const f of ["seg160", "chunks", "day.wav", "concat.txt"]) rmSync(path.join(work, f), { recursive: true, force: true });
    state.done.push(id);
    delete state.failed[id];
    log(`VOD ${id}: done, clips in ${path.join(work, "out")}`);
  } else {
    state.failed[id] = (state.failed[id] ?? 0) + 1;
    log(`VOD ${id}: failed (attempt ${state.failed[id]}/${MAX_ATTEMPTS})`);
    if (state.failed[id]! >= MAX_ATTEMPTS) state.done.push(id);
  }
  writeState(state);
}

async function tick() {
  const vods = await listVods(channel);
  let state = readState();
  if (!state) {
    state = { done: values.backfill ? [] : vods.map((v) => v.id), failed: {} };
    writeState(state);
    log(values.backfill ? `first run: backfilling ${vods.length} VODs` : `first run: ${vods.length} existing VODs marked seen; waiting for the next stream`);
  }
  // Oldest first, so clips come out in stream order.
  const todo = vods.filter((v) => !state!.done.includes(v.id)).reverse();
  if (!todo.length) log("no new VOD");
  for (const v of todo) await processVod(v.id, state);
}

log(`sealed secrets: encrypt KEY=value lines to ${sealedSetup()} and put them in ${secrets}/<name>.env.age`);
unseal();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (;;) {
  try {
    await tick();
  } catch (e) {
    log(`check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (values.once) break;
  await sleep(Number(values.every) * 60_000);
}
