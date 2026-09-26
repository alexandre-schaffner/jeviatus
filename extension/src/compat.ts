// Can the bundled OpenFront codec and simulation talk to this page's server?
// The binary wire has no version negotiation, so the answer is "only on the
// exact same commit". The page's BOOTSTRAP_CONFIG.gitCommit names the build
// that rendered it, which the server enforces at join time.
//
// "unverified": a hosted page that names no commit. Proceeding is a gamble the
// codec will lose silently, so the caller warns loudly. A local dev server
// reports "DEV" (or nothing), and it is by construction the bundled build.

const isCommit = (commit: string | undefined): commit is string => typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit);

export function checkBuild(page: string | undefined, bundled: string, hostname: string): "ok" | "mismatch" | "unverified" {
  if (isCommit(page) && isCommit(bundled)) return page === bundled ? "ok" : "mismatch";
  return hostname === "localhost" || hostname === "127.0.0.1" ? "ok" : "unverified";
}

export const short = (commit: string | undefined): string => (commit === undefined ? "unknown" : commit.slice(0, 9));

// The shell command that fixes a stale bundle, shown verbatim in the panel.
export const REPIN_COMMAND = "bun run pin:openfront && bun run build:extension";
