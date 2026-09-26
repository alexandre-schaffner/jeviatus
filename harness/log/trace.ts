// JSONL trace per run: one line per decision step with the exact state,
// questions, answers, resulting intents and latency, so decisions can be
// audited after the game (runs/<ts>/trace.jsonl).

import fs from "node:fs";
import path from "node:path";

export class Trace {
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
    this.stream?.write(`${JSON.stringify(event, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}\n`);
  }

  writeFile(name: string, content: string): void {
    if (this.stream !== null) fs.writeFileSync(path.join(this.dir, name), content);
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.stream ? this.stream.end(resolve) : resolve()));
  }
}
