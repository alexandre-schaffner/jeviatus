// The instructions for the headless Claude Code run that proposes one change
// to Jev's decision system from the analysis of its recent games.

import { ALLOWED_PATHS } from "./measure";

export const PROPOSAL_FILE = ".loop/proposal.md";
export const ANALYSIS_DIR = ".loop/analysis";

export interface PastAttempt {
  title: string;
  verdict: string;
}

export function changePrompt(opts: { games: number; commit: string; past: PastAttempt[] }): string {
  const past = opts.past.length
    ? opts.past.map((p) => `- ${p.title}: ${p.verdict}`).join("\n")
    : "- none yet";
  return `You are improving Jev, an AI player of the game OpenFront, from evidence.

Jev played ${opts.games} real games on commit ${opts.commit.slice(0, 12)}. The analysis is in ${ANALYSIS_DIR}/:
- ${ANALYSIS_DIR}/report.md: per-game table, aggregates, and recurring bad and good patterns with evidence (game, tick, minute).
- ${ANALYSIS_DIR}/moments/*.md: the biggest land collapses and gains, each with the three decision steps leading in (state Jev saw, every answer with probabilities, intents sent, outcome).

How Jev decides (read before changing anything):
- harness/observe/state.ts builds the JSON state Jev sees each step.
- harness/decide/questions.ts holds the questions and "consider" hints Jev answers (route, goal, targets, commits).
- harness/decide/pipeline.ts turns answers into actions, with deterministic guards (confidence gate, fallbacks, troop reserve).
- harness/decide/candidates.ts decides which options exist at all.

Your task: pick the ONE recurring bad pattern with the strongest evidence, confirm it in the moment dumps, and make the lightest change that should fix it. In order of preference:
1. a new or reworded hint in harness/decide/questions.ts;
2. a state field in harness/observe/state.ts so Jev can see what it is missing;
3. a deterministic guard in harness/decide/pipeline.ts next to the existing hold and fallback logic;
4. a new question layer (for example a yes/no gate before the route).

Rules:
- Change only files under: ${ALLOWED_PATHS.join(", ")}. Match the surrounding style and comment density.
- One focused change. No refactors, no unrelated fixes.
- A deterministic guard needs a test in tests/.
- Run \`bun run typecheck\` and \`bun test tests/*.test.ts\`; both must pass.
- Do not commit. Do not touch git.
- Do not repeat an idea that was already tried and did not help.

Already tried in this loop:
${past}

When done, write ${PROPOSAL_FILE}:
- line 1: a PR title, 70 characters at most, no trailing period;
- then a blank line and a short PR description with these sections: "Pattern" (what goes wrong, how often, 2-3 evidence links as game + minute), "Change" (what you changed and why it should help), "Measure" (which report numbers should move).
If the evidence is too thin to justify any change, write line 1 as "NO CHANGE" and explain why below it.`;
}

export interface Proposal {
  title: string;
  body: string;
  noChange: boolean;
}

export function parseProposal(text: string): Proposal | null {
  const [first, ...rest] = text.trim().split("\n");
  const title = first?.replace(/^#+\s*/, "").trim() ?? "";
  if (title === "") return null;
  return { title: title.slice(0, 70), body: rest.join("\n").trim(), noChange: /^NO CHANGE\b/i.test(title) };
}
