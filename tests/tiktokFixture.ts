// A synthetic stream-game trace with one of each big swing: a land surge, a
// neighbor crushed, a nuke, and Jev's elimination. Shapes follow the real
// trace events (harness/agent.ts, harness/log/format.ts).

const START = "2026-09-26T20:10:00.000Z";

interface P {
  ref: string;
  name: string;
  land_share: number;
  troops_vs_mine?: number;
}

export function step(tick: number, me: { land_share: number; land_rank: number; attacking?: string[] }, players: P[], record?: { action: string; target?: string; detail?: string }, sent: string[] = []) {
  const route = record?.action ?? "hold";
  // Jev's route answer: the chosen route most likely, then the rest.
  const probabilities: Record<string, number> = { [route]: 0.7, ...Object.fromEntries(["expand", "hold", "attack_player"].filter((k) => k !== route).map((k, i) => [k, i === 0 ? 0.2 : 0.05])) };
  return {
    type: "step",
    agent: "jev",
    tick,
    decision: { route, held: false, confidence: 0.8, used: {}, record },
    calls: [{ label: "route", state: { game: { tick, players_alive: 30 }, me: { alive: true, attacking: [], ...me }, players }, answers: { route: { type: "choice", choice: route, confidence: 0.7, probabilities } }, latencyMs: 300 }],
    intents: sent.map((desc) => ({ desc, sent: true })),
  };
}

export function syntheticTrace(): string {
  const events: unknown[] = [
    { type: "run", source: "extension", gameID: "abc123", map: "World", players: 42, gameType: "Public", strategy: { name: "Blitz" }, startedAt: START },
  ];
  for (let tick = 150; tick <= 1600; tick += 15) {
    // Slow start, then a surge from 1.0% to 4.0% between ticks 300 and 900.
    const land = tick < 300 ? 0.01 : tick < 900 ? 0.01 + ((tick - 300) / 600) * 0.03 : 0.04 + (tick - 900) * 0.00001;
    // BigBob (P2) is attacked from tick 1000 and collapses by 1200.
    const bob = tick < 1000 ? 0.012 : Math.max(0.0005, 0.012 - ((tick - 1000) / 200) * 0.0115);
    const players: P[] = [
      { ref: "P2", name: "BigBob", land_share: bob, troops_vs_mine: 0.6 },
      { ref: "P3", name: "Tsar", land_share: 0.08, troops_vs_mine: 2.1 },
    ];
    const attacking = tick >= 1000 && tick < 1200 ? ["P2"] : [];
    const nuke = tick === 1290;
    // The order that starts BigBob's collapse, and the expansion of the surge.
    const order = tick === 1005 ? { action: "attack_player", target: "P2", detail: "30% troops, sized to finish them" } : tick > 300 && tick < 900 ? { action: "expand", detail: "20% troops" } : undefined;
    events.push(
      step(tick, { land_share: land, land_rank: tick < 900 ? 9 : 2, attacking }, players, nuke ? { action: "nuke", target: "P3" } : order, nuke ? ["nuke AtomBomb abc@123"] : order ? ["x"] : []),
    );
  }
  events.push({ type: "death", agent: "jev", tick: 1600, minutes: 2.7, landShareBefore: 0.03, peakLandShare: 0.049, attackers: [{ ref: "P3", name: "Tsar" }] });
  events.push({ type: "summary", tick: 1600, agents: [{ name: "jev", won: false }], reason: "socket closed" });
  return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

export const SYNTHETIC_START_MS = Date.parse(START);
