// Keeps the extension on the commit openfront.io serves. The wire format and
// simulation are commit-specific (extension/README.md), and the site ships
// every few days; a 24/7 stream can't wait for someone to re-pin by hand. The
// page names its build in BOOTSTRAP_CONFIG.gitCommit, so that's the commit to
// check out and rebuild from.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { run } from "./procs";

const root = path.resolve(import.meta.dir, "..");
const vendor = path.join(root, "vendor", "OpenFrontIO");

export function bundledCommit(extensionDir: string): string | null {
  const file = path.join(path.resolve(root, extensionDir), "BUILD.txt");
  if (!existsSync(file)) return null;
  return /OpenFront submodule: ([0-9a-f]{40})/.exec(readFileSync(file, "utf8"))?.[1] ?? null;
}

function lockHash(): string {
  const file = path.join(vendor, "package-lock.json");
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "";
}

export async function rebuildFor(commit: string, log: (line: string) => void): Promise<void> {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`refusing to build for "${commit}": not a commit hash`);
  const before = lockHash();
  log(`[updater] fetching OpenFrontIO ${commit.slice(0, 9)}`);
  await run(["git", "fetch", "--quiet", "--depth=1", "origin", commit], vendor);
  await run(["git", "checkout", "--quiet", "--force", commit], vendor);
  if (lockHash() !== before) {
    log("[updater] OpenFront dependencies changed; reinstalling");
    // vendor/OpenFrontIO's .npmrc sets engine-strict and it requires npm 12; see `setup`.
    await run(["npm", "ci", "--ignore-scripts", "--engine-strict=false", "--no-audit", "--no-fund"], vendor);
  }
  log("[updater] rebuilding the extension");
  await run(["bun", "scripts/build-extension.ts"], root);
  log(`[updater] extension rebuilt for ${commit.slice(0, 9)}`);
}
