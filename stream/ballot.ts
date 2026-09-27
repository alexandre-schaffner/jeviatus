// Strategies come from pull requests. Anyone can propose one: an open PR
// that adds or edits exactly one strategies/<slug>.json file that validates.
// Viewers promote proposals with 👍 and with bribes in the stream's coin
// (stream/bribes.ts), which ranks them as the maintainer's review queue; the
// band shows the leaders. A proposal labeled with the block label (only
// maintainers can label PRs) is off the queue. Only the maintainer merges, and
// what plays is the newest merged strategy, as it reads on the default branch
// now, until another one is merged.

import { isStrategyFile, parseStrategy, STRATEGY_FILE, type Strategy, type StrategyParse } from "../harness/strategy/doctrine";

export interface BallotEntry {
  number: number;
  title: string;
  author: string;
  url: string;
  votes: number;
  strategy: Strategy;
}

// The strategy that plays: the newest one the maintainer merged.
export interface LiveStrategy {
  number: number;
  title: string;
  author: string;
  url: string;
  mergedAt: string;
  file: string;
  strategy: Strategy;
}

export interface Ballot {
  // Open proposals, ranked by 👍 (the band re-ranks them with bribes).
  entries: BallotEntry[];
  // PRs touching strategies/ that aren't proposals, and why (for logs).
  rejected: { number: number; reason: string }[];
  // null: nothing merged yet; Jev plays on its own judgment.
  live: LiveStrategy | null;
  fetchedAt: number;
}

export interface BallotOptions {
  repo: string;
  token?: string;
  // Proposals with this label are off the queue.
  blockLabel?: string;
  fetch?: typeof fetch;
}

// How many of the newest merged PRs to look through for a strategy.
const MERGED_LOOKBACK = 50;

interface PullJson {
  number: number;
  title: string;
  draft: boolean;
  html_url: string;
  user: { login: string };
  head: { sha: string };
  labels?: { name: string }[];
  merged_at?: string | null;
}

type Candidate = { ok: true; strategy: Strategy } | { ok: false; reason: string };

export class GitHubBallot {
  private readonly fetch: typeof fetch;
  // Content is a property of a commit: fetch it once per head (null: that
  // head isn't a strategy proposal).
  private readonly byHead = new Map<string, Candidate | null>();
  // A merged PR's files never change: the strategy files it added or edited.
  private readonly mergedFiles = new Map<number, string[]>();
  private defaultBranch: string | null = null;

  constructor(private readonly o: BallotOptions) {
    this.fetch = o.fetch ?? fetch;
  }

  private async api<T>(path: string, accept = "application/vnd.github+json"): Promise<T> {
    const result = await this.apiOrNull<T>(path, accept);
    if (result === null) throw new Error(`GitHub ${path}: HTTP 404`);
    return result;
  }

  // null on 404.
  private async apiOrNull<T>(path: string, accept = "application/vnd.github+json"): Promise<T | null> {
    const headers: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "jeviatus-stream" };
    if (this.o.token) headers.Authorization = `Bearer ${this.o.token}`;
    const res = await this.fetch(`https://api.github.com/repos/${this.o.repo}${path}`, { headers });
    if (res.status === 404) return null;
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
      const block = this.o.blockLabel?.toLowerCase();
      if (block && pr.labels?.some((l) => l.name.toLowerCase() === block)) {
        rejected.push({ number: pr.number, reason: `a maintainer labeled it "${this.o.blockLabel}"` });
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
    return { entries: rank(entries), rejected, live: await this.live(), fetchedAt: Date.now() };
  }

  // The newest merged PR that added or edited a strategy that's still on the
  // default branch and still validates, with the file as it reads there now
  // (the maintainer may have edited it after merging).
  private async live(): Promise<LiveStrategy | null> {
    this.defaultBranch ??= (await this.api<{ default_branch: string }>("")).default_branch;
    const branch = encodeURIComponent(this.defaultBranch);
    const merged: PullJson[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.api<PullJson[]>(`/pulls?state=closed&base=${branch}&sort=updated&direction=desc&per_page=100&page=${page}`);
      merged.push(...batch.filter((p) => p.merged_at));
      if (batch.length < 100) break;
    }
    merged.sort((a, b) => Date.parse(b.merged_at!) - Date.parse(a.merged_at!));
    for (const pr of merged.slice(0, MERGED_LOOKBACK)) {
      for (const file of await this.strategyFilesOf(pr.number)) {
        const raw = await this.apiOrNull<string>(`/contents/${file}?ref=${branch}`, "application/vnd.github.raw+json");
        if (raw === null) continue; // removed since
        const parsed = parseRaw(raw);
        if (parsed.ok) {
          return { number: pr.number, title: pr.title, author: pr.user.login, url: pr.html_url, mergedAt: pr.merged_at!, file, strategy: parsed.strategy };
        }
      }
    }
    return null;
  }

  private async strategyFilesOf(number: number): Promise<string[]> {
    let files = this.mergedFiles.get(number);
    if (files === undefined) {
      const all = await this.api<{ filename: string; status: string }[]>(`/pulls/${number}/files?per_page=100`);
      files = all.filter((f) => STRATEGY_FILE.test(f.filename) && f.status !== "removed").map((f) => f.filename);
      this.mergedFiles.set(number, files);
    }
    return files;
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
      const parsed = parseRaw(raw);
      result = parsed.ok ? { ok: true, strategy: parsed.strategy } : { ok: false, reason: `${file.filename}: ${parsed.error}` };
    }
    this.byHead.set(pr.head.sha, result);
    return result;
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

function parseRaw(raw: string): StrategyParse {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  return parseStrategy(json);
}

// Bribe pots by PR number, in the coin's raw units (stream/bribes.ts).
export type Pots = ReadonlyMap<number, bigint>;
const NO_POTS: Pots = new Map();

// A PR's pot if it's big enough to count, else 0.
export function potOf(entry: Pick<BallotEntry, "number">, pots: Pots, minPot: bigint): bigint {
  const pot = pots.get(entry.number) ?? 0n;
  return pot > 0n && pot >= minPot ? pot : 0n;
}

// The review queue: pots that count outrank any vote count, biggest first;
// then most votes; ties go to the older PR.
export function rank(entries: BallotEntry[], pots: Pots = NO_POTS, minPot = 0n): BallotEntry[] {
  const cmp = (x: bigint, y: bigint) => (x > y ? -1 : x < y ? 1 : 0);
  return [...entries].sort((a, b) => cmp(potOf(a, pots, minPot), potOf(b, pots, minPot)) || b.votes - a.votes || a.number - b.number);
}

