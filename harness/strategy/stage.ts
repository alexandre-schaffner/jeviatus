// The stage of the game: early (land grab), mid (land is gone, growth comes
// from neighbors and business), late (someone is closing in on the win). The
// stage picks the hints Jev reads (decide/questions.ts) and the code's
// tuning (decide/playbook.ts). It only ever moves forward.

import type { Game, Player } from "src/core/game/Game";

export const STAGES = {
  early: "land grab: unclaimed land is still plentiful and the cheapest growth; nobody can nuke yet",
  mid: "the free land is mostly gone: growth comes from weaker neighbors and tribes, income from business",
  late: "the endgame: a player is closing in on the win, or the game has run long; nations nuke and MIRV whoever leads",
} as const;
export type Stage = keyof typeof STAGES;
const ORDER: Stage[] = ["early", "mid", "late"];

// Early lasts while more than this share of the land is unclaimed...
export const EARLY_UNCLAIMED = 0.25;
// ...and no longer than this.
export const EARLY_MAX_MINUTES = 12;
// Late once a player holds this share of the land needed to win (40% of the
// land at the usual 80% bar): Hard nations start denying the win with MIRVs
// from 55%, and nuke a leader that is 20 points ahead of them.
export const LATE_LEADER_PROGRESS = 0.5;
// Or once the game has run this long; overtime (when enabled) starts here too.
export const LATE_MINUTES = 30;

export interface StageSignals {
  minutes: number;
  unclaimedShare: number; // land nobody owns
  winShare: number; // land share that wins right now
  leader: Player | null; // most land, me included
  leaderShare: number;
  myShare: number;
  overtime: boolean; // the win bar has started to sink
}

export function stageSignals(game: Game, me: Player): StageSignals {
  const total = Math.max(1, game.numLandTiles());
  let owned = 0;
  let leader: Player | null = null;
  for (const p of game.players()) {
    if (!p.isAlive()) continue;
    owned += p.numTilesOwned();
    if (leader === null || p.numTilesOwned() > leader.numTilesOwned()) leader = p;
  }
  const seconds = game.elapsedGameSeconds();
  const winShare = game.config().percentageTilesOwnedToWin(seconds) / 100;
  return {
    minutes: game.ticks() / 600,
    unclaimedShare: Math.max(0, 1 - owned / total),
    winShare,
    leader,
    leaderShare: leader === null ? 0 : leader.numTilesOwned() / total,
    myShare: me.numTilesOwned() / total,
    overtime: winShare < game.config().percentageTilesOwnedToWin(0) / 100,
  };
}

// Share of the land needed to win that `share` already covers.
export function winProgress(share: number, winShare: number): number {
  return winShare > 0 ? Math.min(1, share / winShare) : 1;
}

// The stage these signals point to, ignoring history.
export function detectStage(s: StageSignals): Stage {
  if (s.overtime || s.minutes >= LATE_MINUTES || winProgress(s.leaderShare, s.winShare) >= LATE_LEADER_PROGRESS) return "late";
  if (s.unclaimedShare > EARLY_UNCLAIMED && s.minutes < EARLY_MAX_MINUTES) return "early";
  return "mid";
}

// The later of two stages: land that was claimed is fought over, never freed.
export function laterStage(a: Stage, b: Stage): Stage {
  return ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a;
}
