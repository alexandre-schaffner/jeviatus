// The clip factory: vertical clips of Jev's games and of its evolution in the
// lab, each with per-platform post text (clips/README.md).
//
//   bun run clips [options]          one pass
//   bun run clips:watch [options]    a pass every --every minutes, forever
//
//   --data <dir>        the stream's data dir (default: $STREAM_DATA_DIR, or
//                       ~/Library/Application Support/jeviatus on a Mac, /data)
//   --out <dir>         clips root (default: <data>/clips); clips land in <out>/<YYYY-MM-DD>/
//   --log <file>        the stream's log, for when the lab was on screen
//                       (default: ~/Library/Logs/jeviatus-stream.log)
//   --every <min>       minutes between passes when watching (default 20)
//   --limit <n>         renders per pass (default 12)
//   --archive-gb <n>    footage kept in <out>/archive (default 120)
//   --only <text>       only clips whose id contains this
//   --env-from <file>   read TYPESAFE_API_KEY (and nothing else) from this .env
//   --no-jev            pick moments without Jev calls
//   --dry-run           plan, render nothing
//   --watch             keep going

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { JevClient } from "../harness/jev/client";
import { bandLines } from "../stream/encoder";
import { defaultFont } from "../tiktok/make";
import { Pipeline } from "./pipeline";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    out: { type: "string" },
    log: { type: "string" },
    every: { type: "string", default: "20" },
    limit: { type: "string", default: "12" },
    "archive-gb": { type: "string", default: "120" },
    only: { type: "string" },
    "env-from": { type: "string" },
    "no-jev": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
  },
});

const stamp = () => new Date().toISOString();
const log = (line: string) => console.log(`${stamp()} ${line}`);

const home = process.env.HOME ?? "";
const data = values.data ?? process.env.STREAM_DATA_DIR ?? (process.platform === "darwin" ? path.join(home, "Library/Application Support/jeviatus") : "/data");
const out = values.out ?? path.join(data, "clips");
const font = defaultFont();
if (!font) {
  console.error("no caption font found; set TIKTOK_FONT");
  process.exit(1);
}
const mono = ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/SFNSMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"].find((f) => existsSync(f)) ?? font;
// Only Jev's key is read from --env-from: the stream's .env also holds its
// stream keys, which this process has no business holding.
function keyFrom(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  const line = readFileSync(file, "utf8").split("\n").find((l) => /^\s*TYPESAFE_API_KEY\s*=/.test(l));
  return line?.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
}
const apiKey = (process.env.TYPESAFE_API_KEY ?? keyFrom(values["env-from"]))?.trim();
const jev = values["no-jev"] || !apiKey ? null : new JevClient(process.env.JEV_MODEL ?? "jev-1.13.0", apiKey, 15_000);
if (!jev) log(values["no-jev"] ? "picking moments without Jev (--no-jev)" : "no TYPESAFE_API_KEY: picking moments without Jev");

const pipeline = new Pipeline({
  recordings: process.env.STREAM_RECORD_DIR ?? path.join(data, "recordings"),
  runs: process.env.TRACE_DIR ?? path.join(data, "runs"),
  labDir: path.join(data, "lab"),
  streamLog: values.log ?? path.join(home, "Library/Logs/jeviatus-stream.log"),
  outRoot: out,
  archiveMaxGB: Number(values["archive-gb"]),
  repo: path.resolve(import.meta.dir, ".."),
  gamesPerBuild: Number(process.env.STREAM_LAB_GAMES_PER_BUILD ?? 4),
  jev,
  font,
  mono,
  bandLines: bandLines(Boolean(process.env.BRIBE_MINT?.trim())),
  limit: Number(values.limit),
  dryRun: values["dry-run"],
  only: values.only ?? null,
  log,
});

// One pass at a time on this machine, whoever starts it.
const lock = path.join(out, ".pass.lock");
function locked(): boolean {
  if (!existsSync(lock)) return false;
  const pid = Number(readFileSync(lock, "utf8"));
  try {
    process.kill(pid, 0);
    return pid !== process.pid;
  } catch {
    return false;
  }
}

async function once(): Promise<void> {
  if (locked()) {
    log("another pass is running; skipping this one");
    return;
  }
  writeFileSync(lock, String(process.pid));
  try {
    const r = await pipeline.pass();
    log(`pass done: ${r.archived} segment(s) archived, ${r.rendered.length} rendered, ${r.failed.length} failed, ${r.waiting.length} waiting for footage, ${r.pending} left for the next pass`);
  } catch (err) {
    log(`pass failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  } finally {
    rmSync(lock, { force: true });
  }
}

log(`clips from ${data} to ${out}${values.watch ? `, every ${values.every} min` : ""}${values["dry-run"] ? " (dry run)" : ""}`);
await once();
if (values.watch) {
  const every = Math.max(1, Number(values.every)) * 60_000;
  for (;;) {
    await Bun.sleep(every);
    await once();
  }
}
