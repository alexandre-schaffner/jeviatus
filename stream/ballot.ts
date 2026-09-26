// The strategy ballot. Viewers vote with 👍 on pull requests; a PR is on the
// ballot when it is open, adds or edits exactly one strategies/<slug>.json
// file that validates, and (by default) a maintainer approved its current head
// commit. Approval pins the reviewed content: a push after approval takes the
// PR off the ballot until it is approved again. The top-voted entry plays the
// next game, unless viewers bribed for one (stream/bribes.ts).

import { isStrategyFile, parseStrategy, STRATEGY_FILE, type Strategy } from "../harness/strategy/doctrine";

export interface BallotEntry {
  number: number;
  title: string;
  author: string;
  url: string;
  votes: number;
  strategy: Strategy;
}

export interface Ballot {
  entries: BallotEntry[]; // ranked, best first
  // PRs touching strategies/ that aren't on the ballot, and why (for logs).
  rejected: { number: number; reason: string }[];
  fetchedAt: number;
}

export interface BallotOptions {
  repo: string;
  token?: string;
  requireApproval: boolean;
  fetch?: typeof fetch;
}

const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

interface PullJson {
  number: number;
  title: string;
  draft: boolean;
  html_url: string;
  user: { login: string };
  head: { sha: string };
}

type Candidate = { ok: true; strategy: Strategy } | { ok: false; reason: string };

export class GitHubBallot {
  private readonly fetch: typeof fetch;
  // Content and approval are properties of a commit: fetch them once per head
  // (null: that head isn't a strategy proposal).
  private readonly byHead = new Map<string, Candidate | null>();
  private readonly approvedHeads = new Set<string>();

  constructor(private readonly o: BallotOptions) {
    this.fetch = o.fetch ?? fetch;
  }

  private async api<T>(path: string, accept = "application/vnd.github+json"): Promise<T> {
    const headers: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "jeviatus-stream" };
    if (this.o.token) headers.Authorization = `Bearer ${this.o.token}`;
    const res = await this.fetch(`https://api.github.com/repos/${this.o.repo}${path}`, { headers });
    if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
    return (accept.includes("raw") ? await res.text() : await res.json()) as T;
  }

  async refresh(): Promise<Ballot> {
    const pulls = await this.api<PullJson[]>("/pulls?state=open&per_page=100");
    const entries: BallotEntry[] = [];
    const rejected: Ballot["rejected"] = [];
    const live = new Set<string>();
    for (const pr of pulls) {
      if (pr.draft) continue;
      live.add(pr.head.sha);
      const candidate = await this.candidate(pr);
      if (candidate === null) continue; // not a strategy PR at all
      if (!candidate.ok) {
        rejected.push({ number: pr.number, reason: candidate.reason });
        continue;
      }
      if (this.o.requireApproval && !(await this.approved(pr))) {
        rejected.push({ number: pr.number, reason: "awaiting maintainer approval of the latest commit" });
        continue;
      }
      entries.push({
        number: pr.number,
        title: pr.title,
        author: pr.user.login,
        url: pr.html_url,
        votes: await this.votes(pr.number),
        strategy: candidate.strategy,
      });
    }
    for (const sha of this.byHead.keys()) if (!live.has(sha)) this.byHead.delete(sha);
    return { entries: rank(entries), rejected, fetchedAt: Date.now() };
  }

  // null: not a strategy PR (no strategies/*.json besides the template).
  private async candidate(pr: PullJson): Promise<Candidate | null> {
    if (this.byHead.has(pr.head.sha)) return this.byHead.get(pr.head.sha)!;
    const files = await this.api<{ filename: string; status: string }[]>(`/pulls/${pr.number}/files?per_page=100`);
    let result: Candidate | null;
    if (!files.some((f) => isStrategyFile(f.filename))) {
      this.byHead.set(pr.head.sha, null);
      return null;
    }
    const [file] = files;
    if (files.length !== 1 || file === undefined) {
      result = { ok: false, reason: "a strategy PR changes exactly one file, strategies/<name>.json" };
    } else if (!STRATEGY_FILE.test(file.filename)) {
      result = { ok: false, reason: `${file.filename} is not strategies/<lowercase-name>.json` };
    } else if (file.status !== "added" && file.status !== "modified") {
      result = { ok: false, reason: `${file.filename} was ${file.status}` };
    } else {
      const raw = await this.api<string>(`/contents/${file.filename}?ref=${pr.head.sha}`, "application/vnd.github.raw+json");
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
      const parsed = json === undefined ? { ok: false as const, error: "not valid JSON" } : parseStrategy(json);
      result = parsed.ok ? { ok: true, strategy: parsed.strategy } : { ok: false, reason: `${file.filename}: ${parsed.error}` };
    }
    this.byHead.set(pr.head.sha, result);
    return result;
  }

  private async approved(pr: PullJson): Promise<boolean> {
    if (this.approvedHeads.has(pr.head.sha)) return true;
    const reviews = await this.api<{ state: string; commit_id: string; author_association: string }[]>(
      `/pulls/${pr.number}/reviews?per_page=100`,
    );
    const ok = reviews.some((r) => r.state === "APPROVED" && r.commit_id === pr.head.sha && TRUSTED.has(r.author_association));
    if (ok) this.approvedHeads.add(pr.head.sha);
    return ok;
  }

  // One vote per account: 👍 reactions on the PR, bots excluded.
  private async votes(number: number): Promise<number> {
    const voters = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const batch = await this.api<{ user: { login: string; type: string } | null }[]>(
        `/issues/${number}/reactions?content=%2B1&per_page=100&page=${page}`,
      );
      for (const r of batch) if (r.user && r.user.type !== "Bot") voters.add(r.user.login);
      if (batch.length < 100) break;
    }
    return voters.size;
  }
}

// Bribe pots by PR number, in the coin's raw units (stream/bribes.ts).
export type Pots = ReadonlyMap<number, bigint>;
const NO_POTS: Pots = new Map();

// A PR's pot if it's big enough to count, else 0.
export function potOf(entry: Pick<BallotEntry, "number">, pots: Pots, minPot: bigint): bigint {
  const pot = pots.get(entry.number) ?? 0n;
  return pot > 0n && pot >= minPot ? pot : 0n;
}

// Pots that count outrank any vote count, biggest first; then most votes;
// ties go to the older PR.
export function rank(entries: BallotEntry[], pots: Pots = NO_POTS, minPot = 0n): BallotEntry[] {
  const cmp = (x: bigint, y: bigint) => (x > y ? -1 : x < y ? 1 : 0);
  return [...entries].sort((a, b) => cmp(potOf(a, pots, minPot), potOf(b, pots, minPot)) || b.votes - a.votes || a.number - b.number);
}

// The entry for the next game, or null for Jev's own judgment.
export function pick(ballot: Ballot | null, minVotes: number, pots: Pots = NO_POTS, minPot = 0n): BallotEntry | null {
  const top = rank(ballot?.entries ?? [], pots, minPot)[0];
  return top !== undefined && (potOf(top, pots, minPot) > 0n || top.votes >= minVotes) ? top : null;
}
