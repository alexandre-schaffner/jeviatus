// Epic-moment candidates from a game trace (harness/log/format.ts): the
// swings a viewer can see on screen, found from the state Jev was shown at
// each decision step. Pure; Jev picks which ones make the video (phrases.ts).

export const TICKS_PER_SEC = 10;

export type MomentKind = "conquest" | "wipeout" | "surge" | "top_rank" | "nuke" | "betrayal" | "underdog" | "last_stand" | "victory";

export interface Moment {
  kind: MomentKind;
  // The payoff: the clip cuts in on the beat here.
  tick: number;
  // Where the build-up starts (surges are shown sped up from here).
  fromTick: number;
  // What happened, in words, for Jev and for the captions.
  what: string;
  facts: Record<string, string | number>;
  // Rough excitement before Jev weighs in, 0..1.
  heat: number;
  // The call Jev made that led here, shown in the clip as "Jev's brain".
  brain?: Brain;
}

// One decision step, as the viewer should see it: what Jev chose, what else
// it weighed (its route probabilities), and how sure it was.
export interface Brain {
  tick: number;
  route: string;
  held: boolean;
  holdReason?: string;
  // Route options, most likely first.
  options: { key: string; p: number }[];
  // The player the action was aimed at, by name.
  target?: string;
  // e.g. "30% troops, sized to finish them (~3k gold)".
  detail?: string;
  goal?: string;
}

interface PlayerView {
  ref: string;
  name: string;
  land_share: number;
  troops_vs_mine?: number;
  is_ally?: boolean;
}

export interface Sample {
  tick: number;
  landShare: number;
  landRank: number | null;
  playersAlive: number | null;
  attacking: string[];
  players: Map<string, PlayerView>;
  record: { action: string; target?: string; detail?: string } | null;
  sent: string[];
  brain: Brain | null;
}

export interface GameTrace {
  // Wall-clock time of tick 0, when the header has it.
  startedAtMs: number | null;
  map: string | null;
  humans: number | null;
  strategy: string | null;
  samples: Sample[];
  death: { tick: number; landShareBefore: number | null; peakLandShare: number | null; attackers: string[] } | null;
  won: boolean;
  lastTick: number;
  // Share of decision steps whose Jev call failed (out of credits, timeouts).
  jevFailedShare: number;
}

type Json = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseTrace(jsonl: string): GameTrace {
  const g: GameTrace = { startedAtMs: null, map: null, humans: null, strategy: null, samples: [], death: null, won: false, lastTick: 0, jevFailedShare: 0 };
  let steps = 0;
  let failed = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: Json;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a line cut short by a crash
    }
    const tick = num(e.tick);
    if (tick !== null) g.lastTick = Math.max(g.lastTick, tick);
    // The extension can send its header again mid-game (after a reconnect):
    // tick 0 is the first one's start.
    if (e.type === "run" && g.startedAtMs === null) {
      const at = Date.parse(String(e.startedAt ?? e.at ?? ""));
      g.startedAtMs = Number.isFinite(at) ? at : null;
      g.map = typeof e.map === "string" ? e.map : null;
      g.humans = num(e.players);
      g.strategy = (e.strategy as Json | null)?.name as string | undefined ?? null;
    } else if (e.type === "step" && tick !== null) {
      steps++;
      if ((e.calls as Json[] | undefined)?.some((c) => c.label === "route" && c.error !== undefined)) failed++;
      const s = sample(e, tick);
      if (s) g.samples.push(s);
    } else if (e.type === "death" && tick !== null) {
      g.death = {
        tick,
        landShareBefore: num(e.landShareBefore),
        peakLandShare: num(e.peakLandShare),
        attackers: (Array.isArray(e.attackers) ? e.attackers : []).map((a: Json) => String(a?.name ?? a?.ref ?? "someone")),
      };
    } else if (e.type === "summary") {
      const agents = Array.isArray(e.agents) ? (e.agents as Json[]) : [];
      if (agents.some((a) => a.won === true)) g.won = true;
    } else if (e.type === "stream_result" && /JEV WON/.test(String(e.result))) {
      g.won = true;
    }
  }
  g.samples.sort((a, b) => a.tick - b.tick);
  g.jevFailedShare = steps > 0 ? failed / steps : 0;
  return g;
}

function sample(e: Json, tick: number): Sample | null {
  const calls = Array.isArray(e.calls) ? (e.calls as Json[]) : [];
  const state = calls.find((c) => c.label === "route")?.state as Json | undefined;
  const me = state?.me as Json | undefined;
  if (!me) return null;
  const players = new Map<string, PlayerView>();
  for (const p of (state?.players ?? []) as Json[]) {
    const share = num(p.land_share);
    if (typeof p.ref !== "string" || share === null) continue;
    players.set(p.ref, { ref: p.ref, name: String(p.name ?? p.ref), land_share: share, troops_vs_mine: num(p.troops_vs_mine) ?? undefined, is_ally: p.is_ally === true });
  }
  const decision = e.decision as Json | undefined;
  const record = decision?.record as Sample["record"] | undefined;
  const intents = Array.isArray(e.intents) ? (e.intents as Json[]) : [];
  const route = (calls.find((c) => c.label === "route")?.answers as Json | undefined)?.route as { probabilities?: Record<string, number> } | undefined;
  const probs = Object.entries(route?.probabilities ?? {})
    .filter((kv): kv is [string, number] => typeof kv[1] === "number")
    .map(([key, p]) => ({ key, p }))
    .sort((a, b) => b.p - a.p);
  const targetRef = typeof record?.target === "string" ? record.target : undefined;
  const brain: Brain | null =
    typeof decision?.route === "string" && probs.length > 0
      ? {
          tick,
          route: decision.route,
          held: decision.held === true,
          ...(typeof decision.holdReason === "string" ? { holdReason: decision.holdReason } : {}),
          options: probs,
          ...(targetRef ? { target: players.get(targetRef)?.name ?? targetRef } : {}),
          ...(typeof record?.detail === "string" ? { detail: record.detail } : {}),
          ...(typeof (e.memory as Json | undefined)?.goal === "string" ? { goal: (e.memory as Json).goal as string } : {}),
        }
      : null;
  return {
    tick,
    landShare: num(me.land_share) ?? 0,
    landRank: num(me.land_rank),
    playersAlive: num((state?.game as Json | undefined)?.players_alive),
    attacking: strs(me.attacking),
    players,
    record: record && typeof record.action === "string" ? record : null,
    sent: intents.filter((i) => i.sent === true).map((i) => String(i.desc ?? "")),
    brain,
  };
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const clock = (tick: number) => {
  const s = Math.floor(tick / TICKS_PER_SEC);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const SURGE_WINDOW = 60 * TICKS_PER_SEC;
const CONQUEST_WINDOW = 180 * TICKS_PER_SEC;
const WIPE_WAIT = 30 * TICKS_PER_SEC;

// Past this, Jev wasn't really playing (its calls failed and it held), so
// nothing that happened is Jev's doing: no clips.
export const MAX_JEV_FAILED_SHARE = 0.25;

export function findMoments(g: GameTrace): Moment[] {
  if (g.jevFailedShare > MAX_JEV_FAILED_SHARE) return [];
  const out: Moment[] = [];
  const s = g.samples;
  const name = (ref: string | undefined, at: Sample) => (ref ? (at.players.get(ref)?.name ?? ref) : "someone");

  // Surges: the biggest land gains over a minute, non-overlapping.
  const surges: Moment[] = [];
  for (let j = 0; j < s.length; j++) {
    let i = j;
    while (i > 0 && s[j]!.tick - s[i - 1]!.tick <= SURGE_WINDOW) i--;
    const a = s[i]!;
    const b = s[j]!;
    const gain = b.landShare - a.landShare;
    const rel = gain / Math.max(a.landShare, 0.002);
    if (gain < 0.01 || rel < 0.35) continue;
    const secs = Math.max(1, Math.round((b.tick - a.tick) / TICKS_PER_SEC));
    surges.push({
      kind: "surge",
      tick: b.tick,
      fromTick: a.tick,
      what: `Jev's land went from ${pct(a.landShare)} to ${pct(b.landShare)} of the map in ${secs} seconds`,
      facts: { gain: pct(gain), from: pct(a.landShare), to: pct(b.landShare), secs, x: Math.round((b.landShare / Math.max(a.landShare, 0.001)) * 10) / 10 },
      heat: clamp01(0.3 + gain * 6 + Math.min(rel, 3) * 0.1),
    });
  }
  surges.sort((x, y) => y.heat - x.heat);
  for (const m of surges) if (!out.some((o) => overlaps(o, m))) out.push(m);

  // Conquests: someone Jev attacked lost most of their land, or vanished.
  const done = new Set<string>();
  for (let i = 0; i < s.length; i++) {
    for (const ref of s[i]!.attacking) {
      const start = s[i]!.players.get(ref);
      if (done.has(ref) || !start || start.land_share < 0.003) continue;
      let lastSeen = s[i]!;
      let end: Sample | null = null;
      for (let j = i + 1; j < s.length && s[j]!.tick - s[i]!.tick <= CONQUEST_WINDOW; j++) {
        const p = s[j]!.players.get(ref);
        if (p) lastSeen = s[j]!;
        if (p && p.land_share <= start.land_share * 0.2) {
          end = s[j]!;
          break;
        }
      }
      // Gone from view right after a crushing loss counts as wiped out.
      const wiped = !end && lastSeen !== s[i] && (lastSeen.players.get(ref)?.land_share ?? 1) <= start.land_share * 0.5 && s.at(-1)!.tick > lastSeen.tick && !s.at(-1)!.players.has(ref);
      if (!end && !wiped) continue;
      done.add(ref);
      // Crushed; wait up to 30 s more to see whether they vanish outright.
      let finish: Sample | null = null;
      if (end) {
        for (let j = s.indexOf(end); j < s.length && s[j]!.tick - end.tick <= WIPE_WAIT; j++) {
          const p = s[j]!.players.get(ref);
          if (!p || p.land_share < 0.0005) {
            finish = s[j]!;
            break;
          }
        }
      }
      const endShare = end?.players.get(ref)?.land_share;
      const at = finish ?? end ?? lastSeen;
      const who = start.name;
      // Only a player who's really gone gets "wiped out" phrases.
      const gone = wiped || finish !== null;
      out.push({
        kind: gone ? "wipeout" : "conquest",
        tick: at.tick,
        fromTick: s[i]!.tick,
        what: gone ? `Jev wiped ${who} off the map` : `Jev crushed ${who}: their land fell from ${pct(start.land_share)} to ${pct(endShare ?? 0)}`,
        facts: { target: who, their_land_before: pct(start.land_share), jev_land: pct(at.landShare), secs: Math.round((at.tick - s[i]!.tick) / TICKS_PER_SEC) },
        heat: clamp01(0.55 + start.land_share * 8 + (start.troops_vs_mine ?? 0) * 0.1),
      });
    }
  }

  // Top of the leaderboard, first time after the opening. Ranks only mean
  // something once Jev has land (during spawn everyone ties at zero).
  const ranked = s.filter((x) => x.landShare > 0 && x.landRank !== null);
  const firstTop = ranked.find((x, k) => x.landRank === 1 && x.tick > 60 * TICKS_PER_SEC && ranked.slice(0, k).some((y) => y.landRank! > 1));
  if (firstTop) {
    const worst = Math.max(...ranked.filter((x) => x.tick < firstTop.tick).map((x) => x.landRank!));
    out.push({
      kind: "top_rank",
      tick: firstTop.tick,
      fromTick: firstTop.tick - 8 * TICKS_PER_SEC,
      what: `Jev took the #1 spot on the leaderboard, up from #${worst}${firstTop.playersAlive ? ` with ${firstTop.playersAlive} players alive` : ""}`,
      facts: { from_rank: worst, players_alive: firstTop.playersAlive ?? "?", jev_land: pct(firstTop.landShare) },
      heat: clamp01(0.5 + Math.min(worst, 20) * 0.02),
    });
  }

  for (const x of s) {
    const rec = x.record;
    if (!rec) continue;
    if (rec.action === "nuke" && x.sent.some((d) => d.startsWith("nuke"))) {
      const bomb = /nuke (\w+)/.exec(x.sent.find((d) => d.startsWith("nuke"))!)?.[1] ?? "nuke";
      const pretty = { AtomBomb: "an atom bomb", HydrogenBomb: "a hydrogen bomb", MIRV: "a MIRV" }[bomb] ?? "a nuke";
      out.push({
        kind: "nuke",
        tick: x.tick + 12 * TICKS_PER_SEC, // the missile's flight
        fromTick: x.tick - 3 * TICKS_PER_SEC,
        what: `Jev launched ${pretty} at ${name(rec.target, x)}`,
        facts: { target: name(rec.target, x), bomb: pretty },
        heat: bomb === "MIRV" ? 1 : bomb === "HydrogenBomb" ? 0.9 : 0.8,
      });
    } else if (rec.action === "break_alliance" && x.sent.some((d) => d.startsWith("break_alliance"))) {
      out.push({
        kind: "betrayal",
        tick: x.tick,
        fromTick: x.tick - 5 * TICKS_PER_SEC,
        what: `Jev broke its alliance with ${name(rec.target, x)} and attacked them`,
        facts: { target: name(rec.target, x) },
        heat: 0.75,
      });
    } else if (rec.action === "attack_player" && x.sent.some((d) => d.startsWith("attack"))) {
      const t = rec.target ? x.players.get(rec.target) : undefined;
      if (t?.troops_vs_mine !== undefined && t.troops_vs_mine >= 1.5) {
        out.push({
          kind: "underdog",
          tick: x.tick + 5 * TICKS_PER_SEC,
          fromTick: x.tick - 3 * TICKS_PER_SEC,
          what: `Jev attacked ${t.name}, who had ${Math.round(t.troops_vs_mine * 10) / 10}x its troops`,
          facts: { target: t.name, x: Math.round(t.troops_vs_mine * 10) / 10 },
          heat: clamp01(0.35 + t.troops_vs_mine * 0.1),
        });
      }
    }
  }

  if (g.death) {
    const d = g.death;
    const peak = d.peakLandShare ?? 0;
    out.push({
      kind: "last_stand",
      tick: d.tick,
      fromTick: d.tick - 10 * TICKS_PER_SEC,
      what: `Jev was eliminated at ${clock(d.tick)}${d.attackers.length ? ` by ${d.attackers.join(" and ")}` : ""}${peak > 0 ? `, after peaking at ${pct(peak)} of the map` : ""}`,
      // Facts left out drop the phrases that need them ("Peaked at 0%").
      facts: { ...(d.attackers[0] ? { killer: d.attackers[0] } : {}), ...(peak >= 0.01 ? { peak: pct(peak) } : {}), time: clock(d.tick) },
      heat: clamp01(0.35 + peak * 4),
    });
  }
  if (g.won) {
    out.push({
      kind: "victory",
      tick: g.lastTick,
      fromTick: g.lastTick - 10 * TICKS_PER_SEC,
      what: `Jev won the whole match against real players${g.humans ? ` (${g.humans} humans in the lobby)` : ""}`,
      facts: { humans: g.humans ?? "?", time: clock(g.lastTick) },
      heat: 1,
    });
  }

  return dedupe(out)
    .map((m) => {
      const brain = keyDecision(m, s);
      return brain ? { ...m, brain } : m;
    })
    .sort((a, b) => a.tick - b.tick);
}

const AIMED = new Set(["attack_player", "break_alliance", "naval_invasion", "nuke"]);

// The decision behind a moment: the order that started it (the attack on the
// player who fell, the launch, the betrayal), the most confident expansion of
// a surge, or simply Jev's last call before the payoff (its last one alive,
// for a last stand).
export function keyDecision(m: Moment, samples: Sample[]): Brain | null {
  const upTo = samples.filter((x) => x.brain && x.tick <= m.tick);
  const window = upTo.filter((x) => x.tick >= m.fromTick - 10 * TICKS_PER_SEC).map((x) => x.brain!);
  const acted = window.filter((b) => !b.held);
  const target = typeof m.facts.target === "string" ? m.facts.target : undefined;
  let pick: Brain | undefined;
  if (m.kind === "surge") {
    pick = acted.filter((b) => b.route === "expand").sort((a, b) => b.options[0]!.p - a.options[0]!.p)[0];
  } else if (target) {
    pick = acted.find((b) => AIMED.has(b.route) && b.target === target);
  }
  if (m.kind === "last_stand") pick = upTo.at(-1)?.brain ?? undefined;
  return pick ?? acted.at(-1) ?? upTo.at(-1)?.brain ?? null;
}

// The footage a moment's clip would show: its build-up (6 s, or the whole
// surge) and a few seconds after the payoff.
function footage(m: Moment): [number, number] {
  return [m.kind === "surge" ? m.fromTick : m.tick - 6 * TICKS_PER_SEC, m.tick + 4 * TICKS_PER_SEC];
}

function overlaps(a: Moment, b: Moment): boolean {
  const [a0, a1] = footage(a);
  const [b0, b1] = footage(b);
  return a0 < b1 && b0 < a1;
}

// Candidates that would show the same footage make one clip: keep the hotter.
function dedupe(ms: Moment[]): Moment[] {
  const kept: Moment[] = [];
  for (const m of [...ms].sort((a, b) => b.heat - a.heat)) if (!kept.some((k) => overlaps(k, m))) kept.push(m);
  return kept;
}
