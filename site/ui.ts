// DOM helpers and the question grouping shared by the landing page and the editor.

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const GROUPS: { title: string; blurb: string; match: (id: string) => boolean }[] = [
  { title: "The main route", blurb: "One action per step, and the strategy it serves.", match: (id) => id === "route" || id === "goal" },
  {
    title: "Arguments",
    blurb: "Asked speculatively, in the same request as the route.",
    match: (id) => /^(expand_commit|attack_target|attack_commit|boat_target|betray_target|build_unit|nuke_target|nuke_type|ally_propose)$/.test(id),
  },
  { title: "The purse", blurb: "Spare gold, decided every step beside the main action.", match: (id) => id === "spend" },
  { title: "Side decisions", blurb: "One per player or running attack, applied without the gate.", match: (id) => id.includes(".<") },
  { title: "Sites", blurb: "Call B: a concrete tile, only when the route needs one.", match: (id) => id.endsWith("_site") },
];

// Question ids by group, in order; ids no group claims land in "More".
export function groupQuestions(ids: string[]): { title: string; blurb: string; ids: string[] }[] {
  const used = new Set<string>();
  const groups = GROUPS.map(({ title, blurb, match }) => {
    const g = ids.filter((id) => !used.has(id) && match(id));
    for (const id of g) used.add(id);
    return { title, blurb, ids: g };
  });
  const rest = ids.filter((id) => !used.has(id));
  if (rest.length) groups.push({ title: "More", blurb: "Questions added since this page's groups were written.", ids: rest });
  return groups;
}
