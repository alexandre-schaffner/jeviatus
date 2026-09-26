// The lab's screen: a page served on loopback that the stream's browser shows
// during a coding session (stream/lab.ts). Steps down the left, the build
// under test and Jev's recent record, and a terminal where Claude Code's work
// scrolls by live: what it reads, the edits as diffs, the tests.

export type LineKind = "head" | "text" | "tool" | "add" | "del" | "out" | "ok" | "err" | "dim";

export interface StudioLine {
  kind: LineKind;
  text: string;
}

export type StepStatus = "todo" | "active" | "done" | "skip" | "fail";

export interface StudioState {
  subtitle: string;
  steps: { name: string; status: StepStatus; note?: string }[];
  build: { label: string; sha: string; games: number; needed: number } | null;
  record: { games: number; wins: number; meanPlacement: number | null; medianMinutes: number } | null;
  recent: { result: string; minutes: number; peak: number }[];
  problems: { title: string; count: number }[];
  comparison: string[][] | null;
}

export const STEPS = ["Analyze Jev's games", "Judge the last change", "Write one change", "Typecheck and test", "Build and ship"] as const;

const MAX_LINES = 600;

export class Studio {
  private lines: StudioLine[] = [];
  private dropped = 0;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly secrets: string[];
  state: StudioState = Studio.fresh();

  constructor(secrets: string[] = []) {
    // Longest first, so a secret containing another is fully masked.
    this.secrets = secrets.filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
  }

  static fresh(): StudioState {
    return { subtitle: "", steps: STEPS.map((name) => ({ name, status: "todo" })), build: null, record: null, recent: [], problems: [], comparison: null };
  }

  get url(): string {
    if (!this.server) throw new Error("studio not started");
    return `http://127.0.0.1:${this.server.port}/studio`;
  }

  start(): void {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/studio") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (url.pathname === "/state") {
          const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) - this.dropped);
          return Response.json({ state: this.state, lines: this.lines.slice(since), total: this.dropped + this.lines.length });
        }
        return new Response("not found", { status: 404 });
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
  }

  reset(subtitle: string): void {
    this.state = { ...Studio.fresh(), subtitle };
    this.line("head", subtitle);
  }

  step(i: number, status: StepStatus, note?: string): void {
    const s = this.state.steps[i];
    if (s) {
      s.status = status;
      s.note = note === undefined ? undefined : this.redact(note);
    }
  }

  line(kind: LineKind, text: string): void {
    for (const t of this.redact(text).split("\n")) {
      this.lines.push({ kind, text: t.slice(0, 220) });
    }
    const over = this.lines.length - MAX_LINES;
    if (over > 0) {
      this.lines.splice(0, over);
      this.dropped += over;
    }
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("[redacted]");
    return out;
  }
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Jev's lab</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #0d1117; color: #e6edf3; font: 14px/1.4 "Helvetica Neue", Arial, sans-serif; height: 100vh; overflow: hidden;
    background-image: radial-gradient(circle at 20% 0%, #13241d 0, transparent 55%), radial-gradient(circle at 100% 100%, #161b2e 0, transparent 50%); }
  header { display: flex; align-items: center; gap: 14px; padding: 14px 22px 10px; }
  .rec { width: 12px; height: 12px; border-radius: 50%; background: #ff4d4d; box-shadow: 0 0 10px #ff4d4d; animation: blink 1.4s infinite; }
  @keyframes blink { 50% { opacity: .25 } }
  h1 { font: 900 22px/1 "Arial Black", Arial, sans-serif; letter-spacing: .5px; }
  h1 span { color: #53e3a6; }
  .sub { color: #9aa4b2; font-size: 13px; margin-left: auto; max-width: 640px; text-align: right; }
  main { display: grid; grid-template-columns: 330px 1fr; gap: 16px; padding: 0 22px 16px; height: calc(100vh - 54px); }
  .left { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
  .card { background: rgba(22, 27, 34, .92); border: 1px solid #2a313c; border-radius: 12px; padding: 12px 14px; }
  .card h2 { font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: #7d8793; margin-bottom: 8px; }
  .step { display: flex; gap: 10px; align-items: baseline; padding: 3px 0; color: #7d8793; }
  .step i { font-style: normal; width: 16px; text-align: center; }
  .step.active { color: #e6edf3; font-weight: 700; } .step.active i { color: #53e3a6; animation: blink 1s infinite; }
  .step.done { color: #c9d1d9; } .step.done i { color: #53e3a6; }
  .step.fail i { color: #ff6b6b; } .step.skip { opacity: .55; }
  .note { display: block; font-size: 11.5px; color: #9aa4b2; font-weight: 400; }
  .big { display: flex; gap: 16px; } .big div b { display: block; font-size: 22px; color: #fff; } .big div { font-size: 11px; color: #7d8793; }
  .build { font-size: 12.5px; color: #c9d1d9; margin-bottom: 8px; } .build code { color: #ffd166; }
  .bar { height: 5px; background: #2a313c; border-radius: 3px; margin-top: 4px; overflow: hidden; } .bar div { height: 100%; background: #53e3a6; }
  .prob { font-size: 12.5px; display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; color: #c9d1d9; } .prob b { color: #ff6b6b; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; } td { padding: 2px 4px; border-bottom: 1px solid #222a33; } td:not(:first-child) { text-align: right; font-variant-numeric: tabular-nums; }
  .term { background: #0a0e14; border: 1px solid #2a313c; border-radius: 12px; display: flex; flex-direction: column; min-height: 0; box-shadow: 0 12px 40px rgba(0,0,0,.45); }
  .bar-top { display: flex; align-items: center; gap: 7px; padding: 9px 12px; border-bottom: 1px solid #1d242d; color: #7d8793; font: 12px Menlo, monospace; }
  .dot { width: 11px; height: 11px; border-radius: 50%; } .bar-top span:last-child { margin-left: 8px; }
  #log { flex: 1; overflow: hidden; padding: 10px 14px; font: 13px/1.45 "SF Mono", Menlo, monospace; white-space: pre-wrap; word-break: break-word; display: flex; flex-direction: column; justify-content: flex-end; }
  #log div { min-height: 1.45em; flex-shrink: 0; }
  .k-head { color: #53e3a6; font-weight: 700; margin-top: 6px; } .k-text { color: #e6edf3; } .k-tool { color: #79c0ff; } .k-add { color: #7ee787; background: rgba(46,160,67,.12); }
  .k-del { color: #ffa198; background: rgba(248,81,73,.12); } .k-out { color: #8b949e; } .k-ok { color: #53e3a6; } .k-err { color: #ff6b6b; } .k-dim { color: #57606a; }
  .cursor { display: inline-block; width: 8px; height: 15px; background: #53e3a6; vertical-align: -2px; animation: blink 1s infinite; }
</style></head>
<body>
<header><div class="rec"></div><h1>JEV'S <span>LAB</span></h1><div class="sub" id="sub"></div></header>
<main>
  <div class="left">
    <div class="card"><h2>This session</h2><div id="steps"></div></div>
    <div class="card" id="buildcard"><h2>Jev's record</h2><div id="build"></div><div class="big" id="big"></div></div>
    <div class="card" id="probcard"><h2>What goes wrong most</h2><div id="probs"></div></div>
  </div>
  <div class="term">
    <div class="bar-top"><span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span><span>claude code — jeviatus/harness</span></div>
    <div id="log"></div>
  </div>
</main>
<script>
  const ICON = { todo: "○", active: "◉", done: "✓", skip: "–", fail: "✗" };
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  let total = 0;
  const pending = [];
  const log = document.getElementById("log");
  function render(st) {
    document.getElementById("sub").textContent = st.subtitle;
    document.getElementById("steps").innerHTML = st.steps.map((s) => '<div class="step ' + s.status + '"><i>' + ICON[s.status] + '</i><span>' + esc(s.name) + (s.note ? '<span class="note">' + esc(s.note) + '</span>' : '') + '</span></div>').join("");
    const b = st.build, r = st.record;
    document.getElementById("build").innerHTML = b ? '<div class="build">Testing <b>' + esc(b.label) + '</b> <code>' + esc(b.sha.slice(0, 7)) + '</code>: ' + b.games + '/' + b.needed + ' games<div class="bar"><div style="width:' + Math.min(100, (b.games / Math.max(1, b.needed)) * 100) + '%"></div></div></div>' : "";
    document.getElementById("big").innerHTML = r ? '<div><b>' + r.games + '</b>games</div><div><b>' + r.wins + '</b>wins</div><div><b>' + (r.meanPlacement ?? "–") + '</b>avg place</div><div><b>' + r.medianMinutes + 'm</b>survived</div>' : "";
    const cmp = st.comparison;
    document.getElementById("probs").innerHTML = cmp
      ? '<table>' + cmp.map((row) => '<tr>' + row.map((c) => '<td>' + esc(c) + '</td>').join("") + '</tr>').join("") + '</table>'
      : st.problems.map((p) => '<div class="prob"><span>' + esc(p.title) + '</span><b>' + p.count + '×</b></div>').join("") || '<div class="prob">No games yet</div>';
    document.querySelector("#probcard h2").textContent = cmp ? "Last change vs. before" : "What goes wrong most";
  }
  // New lines type in one at a time, so the terminal reads like live work.
  setInterval(() => {
    if (!pending.length) return;
    const burst = pending.length > 40 ? 6 : pending.length > 12 ? 3 : 1;
    for (let i = 0; i < burst && pending.length; i++) {
      const l = pending.shift();
      const d = document.createElement("div");
      d.className = "k-" + l.kind;
      d.textContent = l.text;
      log.querySelector(".cursor")?.remove();
      log.append(d);
    }
    const c = document.createElement("span"); c.className = "cursor"; log.lastChild.append(c);
    while (log.children.length > 80) log.firstChild.remove();
  }, 70);
  async function poll() {
    try {
      const r = await fetch("/state?since=" + total);
      const j = await r.json();
      total = j.total;
      pending.push(...j.lines);
      render(j.state);
    } catch {}
    setTimeout(poll, 400);
  }
  poll();
</script>
</body></html>`;
