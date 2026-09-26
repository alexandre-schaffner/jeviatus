// Re-pins vendor/OpenFrontIO to the commit openfront.io is running, read from
// the upstream repo's GitHub Deployments (the release workflow records one per
// color). The extension's wire codec and simulation must match that commit
// exactly, so run this (then `bun run build:extension`) after every release.
//
//   bun scripts/pin-openfront.ts          # pin to live prod
//   bun scripts/pin-openfront.ts --check  # exit 1 if the pin is stale

import path from "node:path";

const REPO = "openfrontio/OpenFrontIO";
// openfront.io is served by blue and green; both carry the release that is live.
const ENVIRONMENTS = ["prod-blue", "prod-green"];

const root = path.resolve(import.meta.dir, "..");
const submodule = path.join(root, "vendor", "OpenFrontIO");
const checkOnly = process.argv.includes("--check");

interface Deployment {
  sha: string;
  ref: string;
  created_at: string;
}

async function latestDeployment(environment: string): Promise<Deployment> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const url = `https://api.github.com/repos/${REPO}/deployments?environment=${environment}&per_page=1`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub ${environment} deployments: HTTP ${response.status}`);
  const [latest] = (await response.json()) as Deployment[];
  if (latest === undefined) throw new Error(`no ${environment} deployments found`);
  return latest;
}

async function git(...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd: submodule, stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${err.trim()}`);
  return out.trim();
}

const deployments = await Promise.all(ENVIRONMENTS.map(latestDeployment));
const shas = new Set(deployments.map((d) => d.sha));
if (shas.size !== 1) {
  // Mid-rollout: blue and green disagree, so either build can meet players.
  const detail = deployments.map((d, i) => `${ENVIRONMENTS[i]}=${d.sha.slice(0, 9)} (${d.ref})`).join(", ");
  throw new Error(`prod colors disagree (${detail}); retry once the rollout settles`);
}
const live = deployments[0]!;
const pinned = await git("rev-parse", "HEAD");

if (pinned === live.sha) {
  console.log(`vendor/OpenFrontIO already at live prod ${live.ref} (${live.sha.slice(0, 9)})`);
  process.exit(0);
}
if (checkOnly) {
  console.error(`stale pin: vendor/OpenFrontIO at ${pinned.slice(0, 9)}, prod runs ${live.ref} (${live.sha.slice(0, 9)})`);
  process.exit(1);
}

await git("fetch", "--quiet", "origin", live.sha);
await git("checkout", "--quiet", live.sha);
console.log(`Pinned vendor/OpenFrontIO ${pinned.slice(0, 9)} → ${live.ref} (${live.sha.slice(0, 9)}, deployed ${live.created_at})`);
console.log("Now run: bun run build:extension");
