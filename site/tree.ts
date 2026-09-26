// The decision graph of one step, laid out left to right in the order the
// pipeline runs (harness/decide/pipeline.ts): state -> Call A (route, goal,
// speculative arguments, side decisions) -> Call B (site) -> gate -> act.
// The highlighted path is an example step: attack P3.

import type { Source } from "./source";
import { esc } from "./ui.ts";

export const W = 1280;
export const H = 690;

const COL = { state: 75, ask: 235, route: 405, arg: 580, amount: 750, site: 915, gate: 1045, act: 1205 };
const rowY = (i: number) => 60 + i * 66;
const MID = rowY(3.5);
const BUS = 585;
const LANE = 632;

export type Stage = 1 | 2 | 3 | 4 | 5 | 6;

export interface TreeNode {
  id: string;
  label: string;
  sub?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  stage: Stage;
  prompt?: string; // key into Source.prompts, or "role"
  path?: boolean; // on the example step's path
  kind: "hub" | "route" | "arg" | "site" | "chip";
  p?: number; // route probability in the example step
}

export interface TreeEdge {
  id: string;
  d: string;
  stage: Stage;
  path?: boolean;
  dashed?: boolean;
}

// Example step: probabilities over the eight routes (illustrative).
export const EXAMPLE_ROUTE_P: Record<string, number> = {
  attack_player: 0.62,
  expand: 0.14,
  build: 0.09,
  propose_alliance: 0.06,
  naval_invasion: 0.04,
  hold: 0.03,
  break_alliance: 0.01,
  nuke: 0.01,
};
export const EXAMPLE = {
  routeConfidence: 0.58,
  target: "P3",
  targetConfidence: 0.71,
  commitScore: 1.8,
  trimmedTo: 0.36,
};

// Per route: [argument, amount/type, Call B site].
const ROWS: [route: string, arg?: string, amount?: string, site?: string][] = [
  ["expand", "expand_commit"],
  ["attack_player", "attack_target", "attack_commit"],
  ["naval_invasion", "boat_target", "attack_commit", "boat_site"],
  ["build", "build_unit", undefined, "build_site"],
  ["propose_alliance", "ally_propose"],
  ["break_alliance", "betray_target", "attack_commit"],
  ["nuke", "nuke_target", "nuke_type", "nuke_site"],
  ["hold"],
];

export const SIDE = ["goal", "spend", "threat.<player>", "also_attack.<player>", "retreat.<attack>", "ally_accept.<player>", "ally_extend.<player>", "embargo_lift.<player>", "donate.<player>"];
const SIDE_ON_PATH = new Set(["goal", "spend", "threat.<player>", "ally_accept.<player>"]);

export function commitFraction(expected: number, levels: readonly number[]): number {
  const x = Math.max(0, Math.min(levels.length - 1, expected));
  const lo = Math.floor(x);
  const hi = Math.min(levels.length - 1, lo + 1);
  return levels[lo] + (levels[hi] - levels[lo]) * (x - lo);
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(24, (x2 - x1) * 0.5);
  return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}

const short = (id: string) => id.replace(/\.<[^>]+>$/, "");

// `example`: highlight the example step (attack P3) and show its numbers;
// off, the graph shows only the structure (the editor).
export function layout(src: Source, example = true): { nodes: TreeNode[]; edges: TreeEdge[] } {
  const nodes: TreeNode[] = [];
  const edges: TreeEdge[] = [];
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const attack = commitFraction(EXAMPLE.commitScore, src.commit.ATTACK_COMMIT ?? [0.1, 0.25, 0.45, 0.7]);
  const hub = (id: string, label: string, sub: string, x: number, stage: Stage, prompt?: string): TreeNode => ({ id, label, sub, x, y: MID, w: 130, h: 64, stage, prompt, path: example, kind: "hub" });

  nodes.push(hub("state", "state", "the game as JSON", COL.state, 1, "role"));
  nodes.push(hub("ask", "Call A", "one request", COL.ask, 1));
  nodes.push(hub("gate", "gate", `weakest link ≥ ${src.constants.minConfidence}`, COL.gate, 5));
  nodes.push(hub("act", "act", example ? `attack ${EXAMPLE.target} · ${pct(EXAMPLE.trimmedTo)}` : "intents sent", COL.act, 6));
  const edge = (id: string, d: string, stage: Stage, path = false, dashed = false) => edges.push({ id, d, stage, path: path && example, dashed });
  const R = (n: TreeNode) => n.x + n.w / 2;
  const L = (n: TreeNode) => n.x - n.w / 2;
  const state = nodes[0];
  const ask = nodes[1];
  const gate = nodes[2];
  const act = nodes[3];
  edge("state-ask", curve(R(state), MID, L(ask), MID), 1, true);

  ROWS.forEach(([route, arg, amount, site], i) => {
    const y = rowY(i);
    const onPath = example && route === "attack_player";
    const p = example ? (EXAMPLE_ROUTE_P[route] ?? 0) : undefined;
    const r: TreeNode = { id: `route.${route}`, label: route, x: COL.route, y, w: 150, h: 42, stage: 2, prompt: "route", path: onPath, kind: "route", p };
    nodes.push(r);
    edge(`ask-${route}`, curve(R(ask), MID, L(r), y), 2, onPath);
    let last = r;
    const step = (id: string | undefined, col: number, stage: Stage, kind: TreeNode["kind"], sub?: string) => {
      if (!id) return;
      const n: TreeNode = { id: `${route}.${id}`, label: id, sub, x: col, y, w: kind === "site" ? 120 : 140, h: 42, stage, prompt: id, path: onPath, kind };
      nodes.push(n);
      edge(`${last.id}-${n.id}`, curve(R(last), y, L(n), y), stage, onPath);
      last = n;
    };
    step(arg, COL.arg, 3, "arg", onPath ? `${EXAMPLE.target} · ${EXAMPLE.targetConfidence}` : src.prompts[arg ?? ""]?.kind);
    step(amount, COL.amount, 3, "arg", onPath ? `≈ ${pct(attack)} of troops` : src.prompts[amount ?? ""]?.kind);
    step(site, COL.site, 4, "site", "Call B");
    edge(`${last.id}-gate`, curve(R(last), y, L(gate), MID), 5, onPath, route === "hold");
  });
  edge("gate-act", curve(R(gate), MID, L(act), MID), 6, true);

  // Side decisions: asked in Call A, applied beside the main action, never gated.
  const bus = `M${COL.ask} ${MID + 32} L${COL.ask} ${BUS - 8} Q${COL.ask} ${BUS} ${COL.ask + 8} ${BUS} L${COL.act - 8} ${BUS} Q${COL.act} ${BUS} ${COL.act} ${BUS - 8} L${COL.act} ${MID + 32}`;
  edge("bus", bus, 2, true, true);
  const x0 = COL.ask + 20;
  const gap = (COL.gate + 40 - x0) / (SIDE.length - 1);
  SIDE.forEach((id, k) => {
    const x = x0 + k * gap;
    const sub = !example ? undefined : id === "spend" ? "city" : id.startsWith("ally_accept") ? "accept P5" : id === "goal" ? "conquer" : id.startsWith("threat") ? "P7 · serious" : undefined;
    const on = example && SIDE_ON_PATH.has(id);
    nodes.push({ id: `side.${id}`, label: short(id), sub, x, y: LANE, w: 100, h: sub ? 40 : 30, stage: 2, prompt: id, path: on, kind: "chip" });
    edge(`bus-${id}`, `M${x} ${BUS} L${x} ${LANE - (sub ? 20 : 15)}`, 2, on);
  });
  return { nodes, edges };
}

// Camera per stage, in content coordinates: what each stage is about.
export const CAMERA: Record<Stage | 0, [x: number, y: number, w: number, h: number]> = {
  0: [0, 0, W, H],
  1: [0, 200, 330, 190],
  2: [130, 20, 560, 660],
  3: [310, 20, 560, 540],
  4: [480, 20, 560, 540],
  5: [640, 20, 640, 540],
  6: [0, 0, W, H],
};

// Fit a content box into the element's aspect ratio, centered.
export function fitBox([x, y, w, h]: readonly number[], aspect: number): string {
  let bw = w;
  let bh = h;
  if (bw / bh > aspect) bh = bw / aspect;
  else bw = bh * aspect;
  return `${x + (w - bw) / 2} ${y + (h - bh) / 2} ${bw} ${bh}`;
}

// `onSelect` fires with a node's prompt id on click, Enter or Space.
export function renderTree(svg: SVGSVGElement, src: Source, opts: { example?: boolean; onSelect: (prompt: string) => void }): void {
  const example = opts.example ?? true;
  const { nodes, edges } = layout(src, example);
  const e = edges
    .map((x) => `<path class="edge${x.path ? " on" : ""}${x.dashed ? " dashed" : ""}" data-stage="${x.stage}" data-id="${esc(x.id)}" d="${x.d}"/>`)
    .join("");
  const n = nodes
    .map((x) => {
      const readable = x.prompt && (x.prompt === "role" || src.prompts[x.prompt]);
      const attrs = readable ? ` tabindex="0" role="button" data-prompt="${esc(x.prompt!)}" aria-label="Read the prompt behind ${esc(x.label)}"` : ` aria-hidden="true"`;
      const top = x.y - x.h / 2;
      const left = x.x - x.w / 2;
      const hasSub = x.sub !== undefined || x.p !== undefined;
      const ly = hasSub ? x.y - (x.kind === "hub" ? 6 : 4) : x.y + 4;
      let sub = "";
      if (x.p !== undefined) {
        const bw = x.w - 56;
        sub =
          `<rect class="bar-bg" x="${left + 12}" y="${x.y + 7}" width="${bw}" height="4"/>` +
          `<rect class="bar" x="${left + 12}" y="${x.y + 7}" width="${bw * x.p}" height="4" data-w="${bw * x.p}"/>` +
          `<text class="p" x="${x.x + x.w / 2 - 12}" y="${x.y + 12}" text-anchor="end">${x.p.toFixed(2)}</text>`;
      } else if (x.sub) sub = `<text class="sub" x="${x.x}" y="${x.y + (x.kind === "hub" ? 16 : 13)}" text-anchor="middle">${esc(x.sub)}</text>`;
      const labelX = x.p !== undefined ? left + 12 : x.x;
      const anchor = x.p !== undefined ? "start" : "middle";
      return (
        `<g class="node ${x.kind}${x.path ? " on" : ""}" data-stage="${x.stage}" data-id="${esc(x.id)}"${attrs}>` +
        `<rect class="box" x="${left}" y="${top}" width="${x.w}" height="${x.h}" rx="3"/>` +
        `<text class="label" x="${labelX}" y="${ly}" text-anchor="${anchor}">${esc(x.label)}</text>${sub}</g>`
      );
    })
    .join("");
  const notes =
    `<text class="note" x="${COL.ask + 20}" y="${BUS - 12}" data-stage="2">side decisions · applied beside the main action, never gated</text>` +
    `<text class="note" x="${COL.site}" y="${rowY(7) + 4}" text-anchor="middle" data-stage="4">Call B only when a route needs a tile</text>`;
  svg.innerHTML = `<g class="edges">${e}</g>${notes}<g class="nodes">${n}</g>`;
  const pick = (e: Event) => (e.target as Element).closest<SVGGElement>("[data-prompt]")?.dataset.prompt;
  svg.addEventListener("click", (e) => {
    const id = pick(e);
    if (id) opts.onSelect(id);
  });
  svg.addEventListener("keydown", (e) => {
    const id = pick(e);
    if (id && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      opts.onSelect(id);
    }
  });
}
