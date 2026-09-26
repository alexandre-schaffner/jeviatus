// Long-lived child processes (X server, audio server, browser, encoder),
// restarted with backoff when they die so a 24/7 stream heals itself.

import { closeSync } from "node:fs";

export interface SupervisedOptions {
  name: string;
  cmd: () => string[];
  env?: Record<string, string | undefined>;
  log: (line: string) => void;
  // Called after every (re)start; e.g. reconnect to the browser.
  onStart?: () => void;
  // Lines to drop from the log (chatty, harmless).
  quiet?: RegExp;
  // Every output line, quiet or not.
  onLine?: (line: string) => void;
  // Keep stdin open for write() (e.g. frames piped into ffmpeg).
  stdin?: boolean;
  // A second input pipe on fd 3 for write3() (e.g. audio into ffmpeg's pipe:3).
  fd3?: boolean;
}

// Children don't die with the parent on their own: a crashed driver would
// orphan Chromium (holding the DevTools port and the profile lock) and ffmpeg.
const live = new Set<ReturnType<typeof Bun.spawn>>();
process.on("exit", () => {
  for (const p of live) p.kill("SIGKILL");
});

export class Supervised {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private fd3: import("bun").FileSink | null = null;
  private stopping = false;
  private backoffMs = 1000;
  private startedAt = 0;
  restarts = 0;

  constructor(private readonly o: SupervisedOptions) {}

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  start(): void {
    this.stopping = false;
    const cmd = this.o.cmd();
    this.startedAt = Date.now();
    const proc = Bun.spawn(cmd, {
      env: { ...process.env, ...this.o.env },
      stdio: [this.o.stdin ? "pipe" : "ignore", "pipe", "pipe", ...(this.o.fd3 ? ["pipe" as const] : [])],
    });
    this.proc = proc;
    // Our end of the fd-3 pipe, as a plain descriptor.
    const fd3 = this.o.fd3 ? (proc.stdio[3] as unknown as number) : null;
    const sink3 = fd3 === null ? null : Bun.file(fd3).writer();
    this.fd3 = sink3;
    live.add(proc);
    void this.pump(proc.stdout as ReadableStream<Uint8Array>);
    void this.pump(proc.stderr as ReadableStream<Uint8Array>);
    this.o.onStart?.();
    void proc.exited.then((code) => {
      live.delete(proc);
      // The writer never closes the descriptor itself; detach it first so
      // nothing writes to the number once the OS hands it out again.
      if (this.fd3 === sink3) this.fd3 = null;
      if (fd3 !== null) {
        try {
          closeSync(fd3);
        } catch {
          // already closed
        }
      }
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopping) return;
      // A process that ran a while earns a fresh backoff.
      if (Date.now() - this.startedAt > 60_000) this.backoffMs = 1000;
      this.o.log(`[${this.o.name}] exited with ${code}; restarting in ${Math.round(this.backoffMs / 1000)}s`);
      setTimeout(() => {
        if (this.stopping) return;
        this.restarts++;
        this.start();
      }, this.backoffMs);
      this.backoffMs = Math.min(30_000, this.backoffMs * 2);
    });
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (line) this.o.onLine?.(line);
        if (line && !this.o.quiet?.test(line)) this.o.log(`[${this.o.name}] ${line}`);
      }
    }
  }

  // Writes to the child's stdin (stdin: true). False while it's down or
  // restarting: callers drop the data rather than queue it.
  write(data: Uint8Array): boolean {
    const p = this.proc;
    if (p === null || p.exitCode !== null || typeof p.stdin !== "object" || p.stdin === null) return false;
    try {
      (p.stdin as import("bun").FileSink).write(data);
      (p.stdin as import("bun").FileSink).flush();
      return true;
    } catch {
      return false;
    }
  }

  // Writes to the child's fd 3 (fd3: true); same rules as write().
  write3(data: Uint8Array): boolean {
    const p = this.proc;
    if (p === null || p.exitCode !== null || this.fd3 === null) return false;
    try {
      this.fd3.write(data);
      this.fd3.flush();
      return true;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const p = this.proc;
    this.proc = null;
    if (p === null) return;
    p.kill("SIGTERM");
    const exited = await Promise.race([p.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!exited) p.kill("SIGKILL");
  }

  async restart(): Promise<void> {
    await this.stop();
    this.backoffMs = 1000;
    this.start();
  }
}

export async function run(cmd: string[], cwd?: string, env?: Record<string, string>): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}: ${(err || out).trim().split("\n").slice(-5).join(" / ")}`);
  return out;
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      // not yet
    }
    await Bun.sleep(stepMs);
  }
  return false;
}
