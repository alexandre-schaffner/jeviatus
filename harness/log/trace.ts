// JSONL trace per run: one line per decision step with the exact state,
// questions, answers, resulting intents and latency, so decisions can be
// audited after the game (runs/<ts>/trace.jsonl). Event format: log/format.ts.

import fs from "node:fs";
import path from "node:path";
import { jsonReplacer, type TraceSink } from "./format";

export type { RunHeader, TraceSink } from "./format";

export class Trace implements TraceSink {
  readonly dir: string;
  private readonly stream: fs.WriteStream | null;

  constructor(runsDir: string, name: string, enabled = true) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    this.dir = path.join(runsDir, `${ts}-${name}`);
    if (enabled) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.stream = fs.createWriteStream(path.join(this.dir, "trace.jsonl"), { flags: "a" });
    } else {
      this.stream = null;
    }
  }

  write(event: Record<string, unknown>): void {
    this.stream?.write(`${JSON.stringify(event, jsonReplacer)}\n`);
  }

  writeFile(name: string, content: string): void {
    if (this.stream !== null) fs.writeFileSync(path.join(this.dir, name), content);
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
  }
}

const ROOT = path.resolve(import.meta.dir, "..", "..");

// A checkout's commit, with "+dirty" for uncommitted changes to tracked files.
export async function gitCommit(cwd: string): Promise<string | null> {
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 ? out : null;
  };
  const sha = await git("rev-parse", "HEAD");
  if (sha === null) return null;
  // The submodule has its own commit; its checkout doesn't dirty this one.
  const dirty = await git("status", "--porcelain", "--untracked-files=no", "--", ".", ":!vendor");
  return dirty ? `${sha}+dirty` : sha;
}

// This repo's commit, for comparing play before and after a change. The
// stream image has no .git, so its build passes HARNESS_COMMIT instead.
export async function harnessCommit(): Promise<string> {
  return (await gitCommit(ROOT)) ?? (process.env.HARNESS_COMMIT?.trim() || "unknown");
}

export async function openfrontCommit(): Promise<string> {
  return (await gitCommit(path.join(ROOT, "vendor", "OpenFrontIO"))) ?? "unknown";
}
