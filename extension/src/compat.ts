// Can the bundled OpenFront codec and simulation talk to this page's server?
// The binary wire has no version negotiation, so the answer is "only on the
// exact same commit". The page's BOOTSTRAP_CONFIG.gitCommit names the build
// that rendered it, which the server enforces at join time.

export type BuildCheck =
  | { kind: "match"; commit: string }
  | { kind: "mismatch"; page: string; bundled: string }
  // A local dev server reports "DEV" (or nothing): there is nothing to compare
  // against, and the vendored server is by construction the bundled build.
  | { kind: "dev" }
  // A hosted page that names no commit. Proceeding is a gamble the codec will
  // lose silently, so the caller warns loudly.
  | { kind: "unknown"; page: string | undefined };

export function isRealCommit(commit: string | undefined): commit is string {
  return typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit);
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function checkBuild(page: string | undefined, bundled: string, hostname: string): BuildCheck {
  if (isRealCommit(page) && isRealCommit(bundled)) {
    return page === bundled ? { kind: "match", commit: page } : { kind: "mismatch", page, bundled };
  }
  if (isLoopbackHost(hostname)) return { kind: "dev" };
  return { kind: "unknown", page };
}

export const short = (commit: string | undefined): string => (commit === undefined ? "unknown" : commit.slice(0, 9));

// The shell command that fixes a stale bundle, shown verbatim in the panel.
export const REPIN_COMMAND = "bun run pin:openfront && bun run build:extension";
