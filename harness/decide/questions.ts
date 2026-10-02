// Jev question builders. Instructions carry the judgment, criteria define the
// answers; question IDs are for code only and never reach the model. Paths in
// backticks point into the state object the question is asked against.

import { choice, noul, type Questions, score } from "@typesafe-ai/sdk";
import { GOALS } from "../strategy/memory";
import type { Stage } from "../strategy/stage";
import type { PlayerObs } from "../observe/state";
import { BUILD_PURPOSE, type BuildOption, type Candidates, ROUTES, type SiteCandidate, UPGRADE_PURPOSE } from "./candidates";

// What a build option buys, for the model: a new structure or an upgrade.
function optionText(b: BuildOption): string {
  const what = b.upgrade !== undefined ? UPGRADE_PURPOSE[b.type] : BUILD_PURPOSE[b.type];
  return `${what}. Now: ${b.why}. Costs ${b.cost.toLocaleString("en-US")} gold`;
}

export const NONE = "none";

// Hints that hold at one stage of the game only (`game.stage`, see
// strategy/stage.ts): Jev reads the current stage's list.
function forStage(stage: Stage, hints: Record<Stage, string[]>): string[] {
  return hints[stage];
}

// Commit levels: Score levels map to these troop fractions (interpolated on
// the expected score).
export const ATTACK_COMMIT = [0.1, 0.25, 0.45, 0.7] as const;
export const EXPAND_COMMIT = [0.1, 0.2, 0.35, 0.55] as const;

const WHO =
  "You are advising the player described in `me` in OpenFront, a real-time territory game. " +
  "Players grow by taking unclaimed land and conquering others; troops regrow fastest when the troop pool is about 40% full; " +
  "gold buys structures. The game is won by owning `game.win_land_share` of all land.";

function playerLine(o: PlayerObs): Record<string, unknown> {
  const j = o.json;
  const b = (j.business ?? {}) as Record<string, unknown>;
  return {
    name: j.name,
    kind: j.kind,
    troops_vs_mine: j.troops_vs_mine,
    land_share: j.land_share,
    attitude: j.their_attitude_to_me,
    attacking_me: j.attacking_me,
    direction: j.direction,
    trades_with_me: b.can_trade_with_me,
    their_ports: b.ports,
    their_stations_on_my_rail: b.rail_stations_linked_to_mine,
  };
}

function routeCriteria(c: Candidates, unclaimed: number, troops: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of c.routes) {
    let d: string = ROUTES[r];
    if (r === "expand") d += ` (${unclaimed} of my border tiles touch unclaimed land; my troops are ${troops})`;
    if (r === "attack_player") d += ` (${c.attackTargets.length} attackable neighbors${farmingNote(c.attackTargets)})`;
    if (r === "naval_invasion") d += ` (${c.boatTargets.length} players reachable by boat)`;
    if (r === "break_alliance") d += ` (${c.betrayTargets.length} allies share a land border with me)`;
    if (r === "build") d += ` (affordable: ${c.buildOptions.map((b) => b.key).join(", ")})`;
    out[r] = d;
  }
  return out;
}

// "; 2 I can finish now for 340k gold; P4 is being finished by someone else"
function farmingNote(targets: PlayerObs[]): string {
  const finishable = targets.filter((o) => o.conquest?.finishFraction != null);
  const loot = finishable.reduce((sum, o) => sum + (o.conquest?.loot ?? 0), 0);
  const races = targets.filter((o) => o.conquest?.stealRisk === "high" && o.conquest.finishFraction != null).map((o) => o.ref);
  let note = "";
  if (finishable.length > 0) note += `; ${finishable.length} I can finish now for ${Math.round(loot / 1000)}k gold in total`;
  if (races.length > 0) note += `; others are wearing down ${races.join(", ")}: taking the last tiles myself steals the gold`;
  return note;
}

function attackCommit() {
  return score(
    {
      premise: "Suppose I attack a neighboring player this step.",
      question: "How large a share of my troops should I commit to the attack?",
    },
    [
      "probe: about a tenth, a small raid",
      "moderate: about a quarter",
      "heavy: nearly half",
      "all-in: most of my troops, to break them",
    ],
  );
}

// Call A: route + goal + every branch's arguments, speculatively, in one request.
// Facts that decide an alliance request, gathered so Jev sees them in one place.
export interface AllianceContext {
  goal: string;
  warTargetRef: string | null;
  myAllies: number;
  hostileNeighbors: number; // bordering players attacking me or with threat >= 2
  winGap: number; // land share I still need to win
  alliedLand: number; // land share my allies hold
  facts: (o: PlayerObs) => Record<string, unknown>;
}

// With a viewer-proposed strategy in the state (`strategy`), route and goal lean on its doctrine.
const DOCTRINE =
  "`strategy.doctrine` is the playstyle a viewer proposed and the stream's creator picked: follow its spirit whenever doing so does not clearly risk losing";

export function routeQuestions(c: Candidates, unclaimed: number, troops: string, ally?: AllianceContext, doctrine = false, stage: Stage = "mid"): Questions {
  const q: Questions = {
    route: choice(
      {
        role: WHO,
        question: "Which one action should I take right now to best improve my position?",
        consider: [
          ...(doctrine ? [DOCTRINE] : []),
          "`memory.goal` is my current strategy; prefer actions that serve it unless the situation clearly changed",
          "`memory.recent_actions` shows what my last actions achieved",
          "`me.troop_status` says whether I have troops to spend; sending troops while low or depleted achieves little",
          "gold does nothing until spent: when a structure is affordable, building is usually better than holding",
          "business compounds: cities and ports on a factory's rail, and trade with many partners, raise income for the rest of the game (`me.economy`)",
          "cooperation pays: allies' train stations pay the most, allies cannot attack me, and attacking a trade partner makes them embargo me",
          "attacking a player much stronger than me (troops_vs_mine above 1) usually fails",
          "unclaimed land is the cheapest growth while it lasts",
          "a conquered player's gold goes to whoever takes the tile that drops them below 100 tiles: all of it from tribes and nations, half from humans. Finishing a weak neighbor myself (`conquest` in `players`) can pay many minutes of income",
          "tribes are the cheapest victims: few troops, slow regrowth, and attacks on them cost 30% fewer troops",
          "if I could be conquered soon, my unspent gold would go to my conqueror: spend it first",
          "allies' land never becomes mine: when `me.land_held_by_my_allies` covers much of `me.land_share_still_needed_to_win`, the win runs through an ally, by letting the alliance lapse or breaking it",
          "holding with troops full wastes their regrowth: spend them on land, a weak neighbor, or an invasion",
          "but never empty my army: a neighbor that sees me drained attacks me next. Code keeps `me.troops_kept_home_share` at home against my strongest neighbor, so a big commit may be trimmed",
          "one good attack at a time usually beats several weak ones: each front costs troops to hold",
          "once my land share nears half, nations start aiming nukes and MIRVs at me: have SAM launchers over my cities before that",
          ...forStage(stage, {
            early: [
              "unclaimed land goes to whoever reaches it first, and it never comes free again: while my border touches it, expanding usually beats every other action",
              "a war now costs the troops that would have claimed free land: attack only tribes, or a neighbor already attacking me",
              "alliances are cheapest now, since nations accept readily early: a secured border lets every troop go into free land",
            ],
            mid: [
              "the free land is mostly gone: growth comes from farming weaker neighbors and tribes, one at a time, finishing each before starting the next",
              "business bought now compounds for the rest of the game: factories on rail and ports with many trade partners",
              "the endgame is coming: by then have SAM launchers over my cities, and a silo if I can afford one",
            ],
            late: [
              "only land wins now: if I lead (`game.leader.player` is me), keep pushing, since a stalled leader is the one nations nuke and MIRV",
              "if someone else leads and is close to winning (`game.leader.share_of_land_needed_to_win`), hitting them by land, sea or nuke matters more than anything else: their win is my loss",
              "gold left when the game ends wins nothing: spend it",
            ],
          }),
        ],
      },
      routeCriteria(c, unclaimed, troops),
    ),
    goal: choice(
      {
        role: WHO,
        question: "Which overall strategy fits my situation best for the next few minutes?",
        consider: [
          ...(doctrine ? [DOCTRINE] : []),
          ...forStage(stage, {
            early: ["the land grab decides the rest of the game: grow_territory almost always fits, unless a neighbor is overrunning me"],
            mid: ["there is little free land left: conquer_neighbor and build_economy usually beat grow_territory"],
            late: ["push for the win if I lead or can catch the leader; otherwise fortify or survive, and help bring the leader down"],
          }),
        ],
      },
      { ...GOALS },
    ),
  };

  if (c.routes.includes("expand") || c.routes.includes("attack_player")) {
    q.expand_commit = score(
      {
        premise: "Suppose I send troops into adjacent unclaimed land now.",
        question: "How large a share of my current troops should go?",
        context: "`me.troop_fill` is how full my troop pool is; `me.under_attack_by` lists who is attacking me.",
        consider: [
          ...forStage(stage, {
            early: ["nobody defends unclaimed land and troops regrow fastest near 40% full: sending heavily is efficient unless someone is attacking me"],
            mid: [],
            late: [],
          }),
        ],
      },
      [
        "light: about a tenth, keep most troops home",
        "moderate: about a fifth",
        "heavy: about a third",
        "all-in: over half, nobody threatens me",
      ],
    );
  }
  if (c.routes.includes("attack_player") || c.routes.includes("break_alliance")) {
    q.attack_commit = attackCommit();
  }
  if (c.routes.includes("attack_player")) {
    const opts: Record<string, unknown> = {};
    for (const o of c.attackTargets) opts[o.ref] = { ...playerLine(o), conquest: o.json.conquest } as never;
    opts[NONE] = "none of them is a good target right now";
    q.attack_target = choice(
      {
        premise: "Suppose I attack a neighboring player over land this step.",
        question: "Which player in `players` should I attack?",
        consider: [
          "weaker (troops_vs_mine below 1), already attacking me, or traitors are better targets; allies cannot be attacked",
          "the cheapest moment to hit someone is right after they spent their troops (low `troop_fill`); nations save up to about half their capacity and then send it all at once",
          "a disconnected player fights back with nothing and can be farmed freely",
          "prefer a front I am already fighting on: opening a second war splits my troops",
          "land fully enclosed by me is annexed for free: wrapping around a small player or tribe beats grinding through it",
          "attacking a nation makes it retaliate against me first; tribes never retaliate",
          "the best farm is one I can finish now (`conquest.share_of_my_troops_to_finish_them` is set) that pays the most gold; I will send enough troops to finish them in one push",
          "if others are attacking the same player (`conquest.others_attacking_them`), their attack does the work: a well-timed push that takes the last tiles before the 100-tile line steals the whole reward. An attack that stops short only softens them for a rival",
          "a human who never attacked anyone pays no gold, but their land still counts",
          "attacking a trade partner makes them embargo me and cuts the trade and rail income shared with them",
          ...forStage(stage, {
            early: ["tribes are the target now: cheap, and they never retaliate. A nation hit this early fights back while I should be expanding"],
            mid: [],
            late: ["when someone else is close to winning, their land is the land that matters: every tile taken from them also delays their win"],
          }),
        ],
      },
      opts as never,
    );
  }
  if (c.routes.includes("naval_invasion")) {
    const opts: Record<string, unknown> = {};
    for (const b of c.boatTargets) opts[b.obs.ref] = playerLine(b.obs) as never;
    opts[NONE] = "none of them is worth a naval invasion right now";
    q.boat_target = choice(
      {
        premise: "Suppose I send a transport ship with troops across the water this step.",
        question: "Which player in `players` should the invasion land on?",
      },
      opts as never,
    );
  }
  if (c.routes.includes("break_alliance")) {
    const opts: Record<string, unknown> = {};
    for (const o of c.betrayTargets) opts[o.ref] = { ...playerLine(o), alliance: o.json.alliance, conquest: o.json.conquest } as never;
    opts[NONE] = "keep every alliance: none is worth betraying now";
    q.betray_target = choice(
      {
        premise: "Suppose I break an alliance this step and attack that ally right away.",
        question: "Which ally in `players`, if any, is worth betraying now?",
        consider: [
          "betray only for a big prize: an ally holding much of the land I still need to win (`alliance.share_of_my_win_gap_they_hold`), or a weak one I can finish now (`conquest.share_of_my_troops_to_finish_them`) for their land and gold",
          "an alliance about to expire (`alliance.expires_in_min`) can simply be left to lapse, with no traitor penalty: then choose none",
          "betraying a strong ally starts a war I may lose, and turns them and nearby players hostile",
          "keep allies that guard a border against a stronger rival or that trade with me, unless they are all that stands between me and the win",
        ],
      },
      opts as never,
    );
  }
  if (c.routes.includes("build")) {
    const opts: Record<string, string> = {};
    for (const b of c.buildOptions) opts[b.key] = optionText(b);
    q.build_unit = choice(
      {
        premise: "Suppose I spend gold on a structure this step.",
        question: "Which structure gives the best return for my situation?",
        context: "`me.structures` counts what I own, `me.economy` describes my income, rail links and trade partners.",
        consider: [
          "without a factory, cities and ports earn no train income",
          "defense only matters where a neighbor is actually threatening",
        ],
      },
      opts,
    );
  }
  if (c.routes.includes("nuke")) {
    const opts: Record<string, unknown> = {};
    for (const o of c.nukeTargets) opts[o.ref] = { ...playerLine(o), structures: o.json.structures } as never;
    opts[NONE] = "no one deserves a nuke right now";
    q.nuke_target = choice(
      {
        premise: "Suppose I launch a nuke this step.",
        question: "Which player in `players` should it hit?",
        consider: [
          "the best target is a rival that threatens me or leads the game, with valuable cities, factories or silos",
          "a nuke makes the victim hostile for good and cuts all business with them",
          "nuking a weak neighbor just before a land attack clears the way",
          "a player killed by a nuke loses all their gold to nobody: to collect it, finish them over land instead",
          "follow a nuke with a land attack on the crater, or someone else takes the emptied land",
        ],
      },
      opts as never,
    );
    if (c.nukeOptions.length > 1) {
      const kinds: Record<string, string> = {};
      for (const n of c.nukeOptions) {
        kinds[n.key] = `${n.key.replace("_", " ")}: blast radius ${n.radius} tiles, costs ${n.cost.toLocaleString("en-US")} gold`;
      }
      q.nuke_type = choice(
        {
          premise: "Suppose I launch a nuke this step.",
          question: "Which bomb is worth its cost against that target?",
        },
        kinds,
      );
    }
  }
  if (c.routes.includes("propose_alliance")) {
    const opts: Record<string, unknown> = {};
    for (const o of c.allyCandidates) opts[o.ref] = playerLine(o) as never;
    opts[NONE] = "no alliance proposal is worthwhile right now";
    q.ally_propose = choice(
      {
        premise: "Suppose I propose an alliance this step.",
        question: "Which player in `players` would make the best ally?",
        consider: [
          "allies cannot attack each other, so a strong neighbor as ally secures a border",
          "allied train stations pay 35k per stop to both of us, versus 25k for other foreigners",
          "players with ports and stations near my rail are the most valuable business partners",
          "nations usually accept a request from a player much stronger than them, and readily early in the game; they refuse traitors",
        ],
      },
      opts as never,
    );
  }

  // The purse, decided every step beside the main action, so spending never
  // has to compete with fighting for the one route.
  if (c.buildOptions.length > 0 || c.savingsGoals.length > 0) {
    const opts: Record<string, string> = {};
    for (const b of c.buildOptions) opts[b.key] = optionText(b);
    for (const s of c.savingsGoals) opts[s.key] = `save gold for this instead of spending it: ${s.why}. Needs ${s.cost.toLocaleString("en-US")} gold`;
    opts[NONE] = "buy nothing now and keep the gold";
    q.spend = choice(
      {
        role: WHO,
        premise: "Besides my main action this step, I can also spend spare gold.",
        question: "What should I buy with my gold right now, if anything?",
        context: "`me.gold` is what I have; `me.economy.income_per_min_by_source` shows where my income comes from, and the per-port and per-factory rates show what each one earns.",
        consider: [
          "gold does nothing until spent: when something useful is affordable, buying now usually beats waiting",
          "invest where the income actually comes from: compare what a port and a factory each earn per minute",
          "cities raise troop capacity: most useful when my troops are near capacity or I am at war",
          "upgrading an existing structure costs the same as a new one of that type and needs no new site",
          "save only for a specific big purchase that matters soon, like a SAM launcher when a rival owns a missile silo",
          "if I might be conquered soon, my unspent gold goes to my conqueror: spend it",
          ...forStage(stage, {
            early: ["cities first: more troop capacity is more land claimed while it is free. A factory pays little until I own several cities and ports"],
            mid: ["factories next to my cities and ports start the train income that pays for the rest of the game"],
            late: ["saving rarely pays now: gold left when the game ends wins nothing. SAM launchers over my cities, or a nuke on the leader, come first"],
          }),
        ],
      },
      opts,
    );
  }

  // Side decisions, applied regardless of the route.
  for (const o of c.sideAttacks) {
    q[`also_attack.${o.ref}`] = noul({
      role: WHO,
      question: `Besides my main action this step, should I also send a push at ${o.ref} (${String(o.json.name)})?`,
      target: { ...playerLine(o), conquest: o.json.conquest },
      consider: [
        "yes when one push can finish them (`conquest.share_of_my_troops_to_finish_them` is set): the kill pays their gold and their land",
        "yes when others are attacking them and they are close to falling: taking the last tiles steals the reward from the players who did the work",
        "a tribe is cheap to eat and never retaliates",
        "no when it would open a new war against someone strong, or when I am under attack and need my troops",
      ],
    } as never);
  }
  for (const r of c.retreats) {
    q[`retreat.${r.attack.id()}`] = noul({
      role: WHO,
      question: `My land attack on ${r.ref} (${r.target.displayName()}) is still running. Should I pull it back now?`,
      attack: r.facts,
      rules: "Retreating takes 2 seconds and loses a quarter of the troops still in the attack; the rest come home.",
      consider: [
        "pull back an attack that is stalling: it can take few more tiles (`tiles_it_can_still_take`) and will not finish them",
        "pull back when my home is in danger: I am being attacked (`attacked_by`) and my home troops are low",
        "keep an attack that will finish them (`it_will_finish_them`): the kill pays their gold, and retreating hands it to someone else",
        "keep an attack that still takes a lot of land cheaply",
      ],
    } as never);
  }
  for (const o of c.incomingRequests) {
    q[`ally_accept.${o.ref}`] = choice(
      {
        role: WHO,
        question: `Player ${o.ref} (${String(o.json.name)}) asked me for an alliance. Accept or refuse?`,
        requester: ally?.facts(o) ?? playerLine(o),
        my_situation: ally
          ? { goal: ally.goal, war_target: ally.warTargetRef, allies: ally.myAllies, hostile_neighbors: ally.hostileNeighbors }
          : undefined,
        consider: [
          "an alliance lasts about 5 minutes and can be extended; while it lasts neither side can attack the other",
          "accept a strong neighbor that could hurt me: it secures that border so I can focus elsewhere",
          "accept a trade partner: allied train stops pay 35k each to both of us, and there is no embargo",
          "refuse my current war target or a weaker neighbor I intend to conquer: allying would block my attacks",
          "refuse a traitor or someone who attacked me recently; they are likely to betray again",
          "more allies are safer when I have several hostile neighbors",
        ] as never,
      } as never,
      {
        accept: "accept the alliance: peace and better trade with them",
        refuse: "refuse: keep the freedom to attack them",
      },
    );
  }
  for (const o of c.threatSubjects) {
    q[`threat.${o.ref}`] = score(
      `How dangerous is player ${o.ref} (${String(o.json.name)}, see \`players\`) to me over the next few minutes?`,
      [
        "no threat: allied, much weaker, or not interested in me",
        "minor: could nibble at my border",
        "serious: strong enough to take a real share of my land",
        "severe: attacking me or likely to, and could overrun me",
      ],
    );
  }
  for (const o of c.allianceExtensions) {
    q[`ally_extend.${o.ref}`] = noul({
      role: WHO,
      question: `My alliance with ${o.ref} (${String(o.json.name)}, see \`players\`) is about to expire. Should I agree to extend it?`,
      ally: { ...playerLine(o), alliance: o.json.alliance, conquest: o.json.conquest },
      my_path_to_win: { land_share_still_needed: ally?.winGap, land_held_by_my_allies: ally?.alliedLand },
      consider: [
        "an expired alliance lets me attack them with no traitor penalty: if I want their land, let it lapse",
        "extend if they guard my border against a stronger rival, or our trade and rail income matters more than their land",
        "do not extend an ally whose land I need to win and who is weaker than me",
      ],
    } as never);
  }
  for (const o of c.embargoLifts) {
    q[`embargo_lift.${o.ref}`] = noul(
      `I have an embargo against ${o.ref} (${String(o.json.name)}, see \`players\`), which blocks all trade between us. ` +
        "Should I lift it to resume trade? They are not attacking me right now.",
    );
  }
  for (const o of c.donateTargets) {
    q[`donate.${o.ref}`] = noul(
      `My ally ${o.ref} (${String(o.json.name)}) is under attack. ` +
        "Should I send them some of my troops, given my own situation in `me`?",
    );
  }
  return q;
}

// Call S: pick a spawn site.
export function spawnQuestion(sites: SiteCandidate[], recheck = false): Questions {
  const opts: Record<string, unknown> = {};
  for (const s of sites) opts[s.id] = s.features as never;
  return {
    site: choice(
      {
        role: WHO,
        question: recheck
          ? "The spawn phase is ending and I can still move. Should I stay at my spawn (S0) or move to a better site?"
          : "The game is starting. Where should I place my starting territory?",
        consider: [
          "land_i_would_likely_claim_first is land closer to the site than to any rival: the best predictor of early growth",
          "plains are fastest to expand over; highland and especially mountains slow expansion",
          "one or two rivals nearby are fine (and later trade partners); three or more close rivals mean early wars on several fronts",
          "an island is safe early but growth stops once it is full, until boats",
          "some coast helps later with ports and trade",
          ...(recheck ? ["moving is only worth it if another site is clearly better, since other players have now placed"] : []),
        ],
      },
      opts as never,
    ),
  };
}

// Call B: pick a site for the chosen structure.
export function buildSiteQuestion(option: BuildOption, sites: SiteCandidate[]): Questions {
  const opts: Record<string, unknown> = {};
  for (const s of sites) opts[s.id] = s.features as never;
  return {
    site: choice(
      {
        role: WHO,
        question: `I am building a ${option.key.replace("_", " ")} (${BUILD_PURPOSE[option.type]}). Which site is best?`,
        consider: "interior_depth is how far the site is from any foreign land; threat is 0 (none) to 3 (severe)",
      },
      opts as never,
    ),
  };
}

// Call B, nuke branch: pick a blast site on the target.
export function nukeSiteQuestion(targetRef: string, bomb: string, sites: SiteCandidate[]): Questions {
  const opts: Record<string, unknown> = {};
  for (const s of sites) opts[s.id] = s.features as never;
  return {
    site: choice(
      {
        role: WHO,
        question: `I am launching a ${bomb.replace("_", " ")} at player ${targetRef}. Where should it land?`,
        consider: [
          "destroying cities, factories and silos hurts them for the rest of the game",
          "enemy SAM launchers covering a site may shoot the missile down",
          "hitting other players' land turns them hostile too",
        ],
      },
      opts as never,
    ),
  };
}

// Call B, naval branch: pick a landing site on the target's coast.
export function boatSiteQuestion(targetRef: string, sites: SiteCandidate[]): Questions {
  const opts: Record<string, unknown> = {};
  for (const s of sites) opts[s.id] = s.features as never;
  return {
    site: choice(
      {
        role: WHO,
        question: `My transport ship will invade player ${targetRef}. Where should it land?`,
        consider: [
          "undefended coast near their land is best; a long sea trip gives them time to react",
          "defense posts only slow land attacks: a landing near their cities avoids their border defenses",
        ],
      },
      opts as never,
    ),
  };
}

// Expected Score position -> fraction, interpolating between level fractions.
export function commitFraction(expected: number, levels: readonly number[]): number {
  const x = Math.max(0, Math.min(levels.length - 1, expected));
  const lo = Math.floor(x);
  const hi = Math.min(levels.length - 1, lo + 1);
  return levels[lo] + (levels[hi] - levels[lo]) * (x - lo);
}
