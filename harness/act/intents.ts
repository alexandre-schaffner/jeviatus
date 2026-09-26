// Decisions -> OpenFront intents. Jev answered against a state that is 1-3
// ticks old by the time we act, so every action is re-validated against the
// live sim first, then the intent is checked against OpenFront's IntentSchema.

import { type Game, type Player, UnitType } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import { type Intent, IntentSchema } from "src/core/Schemas";
import type { Buildable } from "../decide/candidates";
import { type NukeType, unsafeBlast } from "../decide/nukes";

export type Action =
  | { kind: "spawn"; tile: TileRef }
  | { kind: "expand"; fraction: number }
  | { kind: "attack"; targetID: string; fraction: number }
  | { kind: "boat"; targetID: string; dst: TileRef; fraction: number }
  | { kind: "build"; unit: Buildable; tile: TileRef }
  | { kind: "upgrade"; unit: Buildable; unitID: number }
  | { kind: "nuke"; unit: NukeType; tile: TileRef; targetID: string }
  | { kind: "ally_request"; targetID: string } // propose, or accept a pending request
  | { kind: "ally_reject"; targetID: string }
  | { kind: "ally_extend"; targetID: string }
  // `then` is sent by the agent as soon as the break has landed.
  | { kind: "break_alliance"; targetID: string; then?: Action }
  | { kind: "embargo_stop"; targetID: string }
  | { kind: "retreat"; attackID: string; targetID: string }
  | { kind: "donate"; targetID: string; fraction: number };

export type Resolved = { ok: true; intent: Intent } | { ok: false; reason: string };

function player(game: Game, id: string): Player | null {
  return game.hasPlayer(id) ? game.player(id) : null;
}

function troops(me: Player, fraction: number): number {
  return Math.floor(me.troops() * Math.max(0, Math.min(1, fraction)));
}

// Re-validate `action` at the current tick and build its intent.
export function resolve(game: Game, me: Player, action: Action): Resolved {
  const no = (reason: string): Resolved => ({ ok: false, reason });
  if (action.kind !== "spawn" && !me.isAlive()) return no("dead");
  let intent: Intent;
  switch (action.kind) {
    case "spawn":
      if (!game.inSpawnPhase()) return no("spawn phase over");
      if (!game.isLand(action.tile) || game.hasOwner(action.tile)) return no("spawn tile taken");
      intent = { type: "spawn", tile: action.tile };
      break;
    case "expand": {
      if (game.inSpawnPhase()) return no("spawn phase");
      if (!me.sharesBorderWith(game.terraNullius())) return no("no unclaimed land on border");
      const n = troops(me, action.fraction);
      if (n < 1) return no("no troops");
      intent = { type: "attack", targetID: null, troops: n };
      break;
    }
    case "attack": {
      const t = player(game, action.targetID);
      if (t === null || !t.isAlive()) return no("target gone");
      if (!me.sharesBorderWith(t)) return no("no shared border");
      if (me.isFriendly(t) || !me.canAttackPlayer(t)) return no("cannot attack target");
      const n = troops(me, action.fraction);
      if (n < 1) return no("no troops");
      intent = { type: "attack", targetID: t.id(), troops: n };
      break;
    }
    case "boat": {
      const t = player(game, action.targetID);
      if (t === null || !t.isAlive()) return no("target gone");
      if (!me.canAttackPlayer(t)) return no("cannot attack target");
      if (me.unitCount(UnitType.TransportShip) >= game.config().boatMaxNumber()) return no("no boats free");
      if (game.owner(action.dst) !== t) return no("landing tile changed owner");
      if (me.canBuild(UnitType.TransportShip, action.dst) === false) return no("cannot reach landing tile");
      const n = troops(me, action.fraction);
      if (n < 1) return no("no troops");
      intent = { type: "boat", troops: n, dst: action.dst };
      break;
    }
    case "build":
      if (me.canBuild(action.unit, action.tile) === false) return no("cannot build there now");
      intent = { type: "build_unit", unit: action.unit, tile: action.tile };
      break;
    case "upgrade": {
      const u = me.units(action.unit).find((x) => x.id() === action.unitID);
      if (u === undefined) return no("structure gone");
      if (!me.canUpgradeUnit(u)) return no("cannot upgrade now");
      if (me.gold() < game.unitInfo(action.unit).cost(game, me)) return no("cannot afford");
      intent = { type: "upgrade_structure", unit: action.unit, unitId: action.unitID };
      break;
    }
    case "nuke": {
      const t = player(game, action.targetID);
      if (t === null || !t.isAlive()) return no("target gone");
      if (me.isFriendly(t)) return no("target became friendly");
      if (me.canBuild(action.unit, action.tile) === false) return no("no ready silo or cannot afford");
      const unsafe = unsafeBlast(game, me, action.tile, action.unit);
      if (unsafe !== null) return no(unsafe);
      intent = { type: "build_unit", unit: action.unit, tile: action.tile };
      break;
    }
    case "ally_request": {
      const t = player(game, action.targetID);
      if (t === null || !t.isAlive()) return no("target gone");
      if (!me.canSendAllianceRequest(t)) return no("cannot request alliance");
      intent = { type: "allianceRequest", recipient: t.id() };
      break;
    }
    case "ally_reject": {
      const t = player(game, action.targetID);
      if (t === null) return no("target gone");
      if (!me.incomingAllianceRequests().some((r) => r.requestor() === t)) return no("request expired");
      intent = { type: "allianceReject", requestor: t.id() };
      break;
    }
    case "ally_extend": {
      const t = player(game, action.targetID);
      const info = t === null ? null : me.allianceInfo(t);
      if (t === null || info === null) return no("no alliance");
      if (!info.inExtensionWindow || !info.canExtend) return no("cannot extend now");
      intent = { type: "allianceExtension", recipient: t.id() };
      break;
    }
    case "break_alliance": {
      const t = player(game, action.targetID);
      if (t === null || !t.isAlive()) return no("target gone");
      if (!me.isAlliedWith(t)) return no("not allied");
      intent = { type: "breakAlliance", recipient: t.id() };
      break;
    }
    case "retreat": {
      const running = me.outgoingAttacks().find((x) => x.id() === action.attackID);
      if (running === undefined) return no("attack already over");
      if (running.retreating()) return no("already retreating");
      intent = { type: "cancel_attack", attackID: action.attackID };
      break;
    }
    case "embargo_stop": {
      const t = player(game, action.targetID);
      if (t === null || !me.hasEmbargoAgainst(t)) return no("no embargo to lift");
      intent = { type: "embargo", targetID: t.id(), action: "stop" };
      break;
    }
    case "donate": {
      const t = player(game, action.targetID);
      if (t === null || !me.canDonateTroops(t)) return no("cannot donate");
      const n = troops(me, action.fraction);
      if (n < 1) return no("no troops");
      intent = { type: "donate_troops", recipient: t.id(), troops: n };
      break;
    }
  }
  const parsed = IntentSchema.safeParse(intent);
  if (!parsed.success) return no(`schema: ${parsed.error.message.slice(0, 200)}`);
  return { ok: true, intent: parsed.data as Intent };
}

export function describe(action: Action): string {
  switch (action.kind) {
    case "spawn":
      return `spawn@${action.tile}`;
    case "expand":
      return `expand ${Math.round(action.fraction * 100)}%`;
    case "attack":
      return `attack ${action.targetID} ${Math.round(action.fraction * 100)}%`;
    case "boat":
      return `boat ${action.targetID}@${action.dst} ${Math.round(action.fraction * 100)}%`;
    case "build":
      return `build ${action.unit}@${action.tile}`;
    case "upgrade":
      return `upgrade ${action.unit} #${action.unitID}`;
    case "nuke":
      return `nuke ${action.unit} ${action.targetID}@${action.tile}`;
    case "ally_request":
      return `ally_request ${action.targetID}`;
    case "ally_reject":
      return `ally_reject ${action.targetID}`;
    case "ally_extend":
      return `ally_extend ${action.targetID}`;
    case "embargo_stop":
      return `embargo_stop ${action.targetID}`;
    case "break_alliance":
      return `break_alliance ${action.targetID}`;
    case "retreat":
      return `retreat from ${action.targetID}`;
    case "donate":
      return `donate ${action.targetID} ${Math.round(action.fraction * 100)}%`;
  }
}
