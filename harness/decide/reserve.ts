// How many troops must stay home. Sending too much leaves me weaker than my
// neighbors, who then take my land (and my gold) for cheap. Mirrors the
// game's own Hard nations (AiAttackBehavior): keep most of the strongest
// hostile neighbor's army at home, and at least what is already coming at me.

import type { Player } from "src/core/game/Game";
import type { Observation } from "../observe/state";
import { kindOf } from "../observe/state";

// Share of the strongest non-allied neighbor's troops to keep home.
export const RESERVE_VS_NEIGHBOR = 0.75;
// Expansion into unclaimed land may always use this much: nobody defends it.
export const EXPAND_FLOOR = 0.05;
// Sends smaller than this share of my troops do nothing useful.
export const MIN_SEND = 0.03;

export interface Reserve {
  troops: number; // to keep home
  why: string | null; // who it is kept against
}

// Players I'm fighting (or about to) are excluded: their army is busy with
// mine, and opposing attacks cancel out. `share` varies with the stage of the
// game (playbook.ts).
export function homeReserve(me: Player, obs: Observation, fighting: ReadonlySet<Player>, share = RESERVE_VS_NEIGHBOR): Reserve {
  let strongest: { troops: number; name: string } | null = null;
  for (const o of obs.players) {
    const p = o.player;
    if (!o.bordersMe || fighting.has(p) || me.isFriendly(p) || kindOf(p) === "tribe") continue;
    if (strongest === null || p.troops() > strongest.troops) strongest = { troops: p.troops(), name: String(o.json.name) };
  }
  const incoming = me
    .incomingAttacks()
    .filter((a) => a.attacker().isAlive())
    .reduce((sum, a) => sum + a.troops(), 0);
  const vsNeighbor = (strongest?.troops ?? 0) * share;
  if (incoming >= vsNeighbor && incoming > 0) return { troops: incoming, why: "attacks coming at me" };
  if (strongest !== null && vsNeighbor > 0) return { troops: vsNeighbor, why: strongest.name };
  return { troops: 0, why: null };
}

// Shares of my current troops handed out across one step's sends: every
// attack, expansion and landing draws from the same pool above the reserve.
export class TroopBudget {
  private spent = 0;

  constructor(
    private readonly troops: number,
    private readonly reserve: number,
  ) {}

  get available(): number {
    if (this.troops <= 0) return 0;
    return Math.max(0, (this.troops - this.reserve) / this.troops - this.spent);
  }

  // Take up to `share`; returns what was granted (0 if below MIN_SEND).
  take(share: number, floor = 0): number {
    const granted = Math.min(share, Math.max(this.available, floor - this.spent));
    if (granted < MIN_SEND) return 0;
    this.spent += granted;
    return granted;
  }
}
