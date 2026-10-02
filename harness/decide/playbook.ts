// What code does differently at each stage of the game (strategy/stage.ts).
// Jev's judgment shifts through the stage hints in questions.ts; this is the
// part code decides on its own: what is worth offering at all, and how many
// troops stay home.

import { UnitType } from "src/core/game/Game";
import type { Stage } from "../strategy/stage";
import type { Buildable } from "./candidates";
import { EXPAND_FLOOR, RESERVE_VS_NEIGHBOR } from "./reserve";

export interface Playbook {
  // Share of the strongest neighbor's troops kept home (reserve.ts).
  reserveVsNeighbor: number;
  // Share of my troops expansion may always use, reserve or not.
  expandFloor: number;
  // Structures and savings goals not worth gold at this stage.
  buildsOff: readonly Buildable[];
  savingsOff: readonly string[];
}

export const PLAYBOOKS: Record<Stage, Playbook> = {
  // Neighbors are busy taking free land too, and every troop not expanding
  // is land a rival claims first. Nobody can afford a nuke yet: a silo, or
  // saving for one, is gold not spent on growth.
  early: {
    reserveVsNeighbor: 0.5,
    expandFloor: 0.15,
    buildsOff: [UnitType.MissileSilo],
    savingsOff: ["save_for_silo_and_atom_bomb", "save_for_hydrogen_bomb"],
  },
  mid: { reserveVsNeighbor: RESERVE_VS_NEIGHBOR, expandFloor: EXPAND_FLOOR, buildsOff: [], savingsOff: [] },
  late: { reserveVsNeighbor: RESERVE_VS_NEIGHBOR, expandFloor: EXPAND_FLOOR, buildsOff: [], savingsOff: [] },
};

// Late, within this share of the land needed to win: troops at home win
// nothing, and every minute the leader stalls, nations nuke it down.
export const CLOSING_PROGRESS = 0.85;
export const CLOSING_RESERVE = 0.4;

export function playbook(stage: Stage, myWinProgress: number): Playbook {
  const book = PLAYBOOKS[stage];
  return stage === "late" && myWinProgress >= CLOSING_PROGRESS ? { ...book, reserveVsNeighbor: CLOSING_RESERVE } : book;
}
