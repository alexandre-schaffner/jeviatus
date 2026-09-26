// Turn passed Snapshot proposals into pull requests. Runs on a schedule in
// .github/workflows/dao-proposals.yml; a maintainer reviews every PR it
// opens, and nothing here merges.
//
// A proposal is acted on when it was made with the editor (app "jeviatus"),
// its vote is closed, it met the space's quorum, and "For" beat "Against".
// Its patch block is applied to the current main branch; if the file moved
// on and an edit no longer lands exactly, an issue is opened instead.
//
//   bun scripts/snapshot-to-pr.ts               act on every passed proposal
//   bun scripts/snapshot-to-pr.ts --dry-run     report only, change nothing
//   bun scripts/snapshot-to-pr.ts --space ens.eth --dry-run
//   bun scripts/snapshot-to-pr.ts --proposal 0xabc…

import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import config from "../governance/config.json";
import { APP, applyPatch, describeEdits, extractPatch, type Patch } from "../governance/patch";
import { parsePromptFile, type PromptFile } from "../governance/prompts";

interface Proposal {
  id: string;
  title: string;
  body: string;
  author: string;
  app: string;
  choices: string[];
  scores: number[];
  scores_total: number;
  quorum: number;
  discussion: string;
  end: number;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");
const space = flag("--space") ?? process.env.SNAPSHOT_SPACE ?? config.snapshot.space;
const only = flag("--proposal");
const branchBase = config.branch;

async function closedProposals(): Promise<Proposal[]> {
  const where = only ? `{ id: "${only.replace(/[^\w]/g, "")}" }` : `{ space: "${space.replace(/[^\w.-]/g, "")}", state: "closed" }`;
  const res = await fetch(`${config.snapshot.hub}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `{ proposals(first: 100, where: ${where}, orderBy: "end", orderDirection: desc) {
        id title body author app choices scores scores_total quorum discussion end } }`,
    }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`Snapshot: ${json.errors?.[0]?.message ?? res.status}`);
  return json.data.proposals;
}

function outcome(p: Proposal): { passed: boolean; why: string } {
  const at = (name: string) => p.choices.findIndex((c) => c.toLowerCase() === name);
  const yes = p.scores[at("for")] ?? 0;
  const no = p.scores[at("against")] ?? 0;
  if (at("for") < 0) return { passed: false, why: "no For choice" };
  if (p.quorum > 0 && p.scores_total < p.quorum) return { passed: false, why: `quorum not met (${Math.round(p.scores_total)} of ${p.quorum})` };
  return yes > no ? { passed: true, why: `For ${Math.round(yes)} vs Against ${Math.round(no)}` } : { passed: false, why: `rejected (For ${Math.round(yes)} vs Against ${Math.round(no)})` };
}

const short = (id: string) => id.replace(/^0x/, "").slice(0, 10);
const link = (p: Proposal) => `${config.snapshot.ui}/#/${space}/proposal/${p.id}`;

async function exists(branch: string, title: string): Promise<boolean> {
  const remote = await $`git ls-remote --heads origin ${branch}`.quiet().nothrow();
  if (remote.stdout.toString().trim()) return true;
  // A merged or closed PR whose branch was deleted still counts.
  const prs = await $`gh pr list --state all --head ${branch} --json number`.quiet().nothrow();
  if (prs.exitCode === 0 && JSON.parse(prs.stdout.toString() || "[]").length > 0) return true;
  const issues = await $`gh issue list --state all --search ${`${title} in:title`} --json number`.quiet().nothrow();
  return issues.exitCode === 0 && JSON.parse(issues.stdout.toString() || "[]").length > 0;
}

async function openIssue(p: Proposal, problems: string[]): Promise<void> {
  const title = `DAO proposal ${short(p.id)} needs a hand: ${p.title}`;
  const body = [
    `The vote on [${p.title}](${link(p)}) passed, but its change no longer applies cleanly to \`${branchBase}\`:`,
    "",
    ...problems.map((x) => `- ${x}`),
    "",
    "A maintainer can apply the intent by hand, or the author can re-draft it in the editor against the current prompts.",
  ].join("\n");
  if (dryRun) return console.log(`  would open issue: ${title}`);
  await $`gh issue create --title ${title} --body ${body}`;
}

async function openPr(p: Proposal, patch: Patch, text: string, branch: string, file: PromptFile): Promise<void> {
  const body = [
    `Opened automatically: [this proposal passed on Snapshot](${link(p)}) (${outcome(p).why}).`,
    p.discussion ? `Forum discussion: ${p.discussion}` : "",
    `Proposed by \`${p.author}\`.`,
    "",
    "### What changes",
    "",
    describeEdits(file, patch),
    "### For the reviewer",
    "",
    "- The diff touches only string literals in `" + patch.file + "`; the bot writes the voted text with `JSON.stringify` and verified it re-parses.",
    "- Approve to let Jev play with it; request changes or close if it shouldn't ship as voted.",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
  const title = `DAO: ${p.title}`.slice(0, 120);
  if (dryRun) return console.log(`  would open PR ${branch}: ${title}`);
  await $`git checkout -B ${branch} origin/${branchBase}`;
  writeFileSync(patch.file, text);
  await $`git add ${patch.file}`;
  await $`git -c user.name=${"Jeviatus DAO bot"} -c user.email=${"dao-bot@users.noreply.github.com"} commit -m ${`${title}\n\nSnapshot proposal ${p.id}\n${link(p)}`}`;
  await $`git push origin ${branch}`;
  await $`gh label create dao-proposal --color C51B7D --description ${"Opened from a passed Snapshot vote"} --force`.quiet().nothrow();
  await $`gh pr create --base ${branchBase} --head ${branch} --title ${title} --body ${body} --label dao-proposal`;
  await $`git checkout ${branchBase}`.quiet().nothrow();
}

async function main(): Promise<void> {
  if (!space && !only) {
    console.log("No Snapshot space configured (governance/config.json snapshot.space): nothing to do.");
    return;
  }
  const list = await closedProposals();
  console.log(`${list.length} closed proposal(s) in ${space || "(by id)"}`);
  for (const p of list) {
    const tag = `${short(p.id)} "${p.title}"`;
    if (p.app !== APP) {
      console.log(`- ${tag}: not made with the editor, skipped`);
      continue;
    }
    const verdict = outcome(p);
    if (!verdict.passed) {
      console.log(`- ${tag}: ${verdict.why}`);
      continue;
    }
    const { patch, problems } = extractPatch(p.body);
    const branch = `dao/proposal-${short(p.id)}`;
    if (await exists(branch, short(p.id))) {
      console.log(`- ${tag}: already handled (${branch})`);
      continue;
    }
    if (!patch) {
      console.log(`- ${tag}: passed but unusable: ${problems.join("; ")}`);
      await openIssue(p, problems);
      continue;
    }
    await $`git fetch origin ${branchBase}`.quiet().nothrow();
    const current = (await $`git show ${`origin/${branchBase}:${patch.file}`}`.quiet().nothrow()).stdout.toString() || readFileSync(patch.file, "utf8");
    const file = parsePromptFile(current);
    const result = applyPatch(current, file, patch);
    // The voted text must be exactly what the file now says.
    const after = parsePromptFile(result.text);
    const check = result.problems.length ? result.problems : verify(after, patch);
    if (check.length) {
      console.log(`- ${tag}: passed but doesn't apply: ${check.join("; ")}`);
      await openIssue(p, check);
      continue;
    }
    console.log(`- ${tag}: passed (${verdict.why}), opening a pull request`);
    await openPr(p, patch, result.text, branch, file);
  }
}

function verify(after: PromptFile, patch: Patch): string[] {
  const problems: string[] = [];
  for (const e of patch.edits) {
    const p = after.prompts[e.prompt];
    if (!p) problems.push(`${e.prompt} disappeared`);
    else if (e.op === "question" && p.question !== e.to) problems.push(`${e.prompt}: question didn't land`);
    else if ((e.op === "hint" || e.op === "add-hint") && !p.hints.some((h) => h.text === e.to)) problems.push(`${e.prompt}: hint didn't land`);
  }
  return problems;
}

await main();
