// Read side of governance: the Jeviatus Snapshot space and its proposals,
// and the Discourse forum. Configured in governance/config.json; an empty
// space or forum URL means that part isn't live yet.

import config from "../governance/config.json";

export const GOV = config;

// Preview another space's ballots read-only (e.g. ?space=ens.eth) before
// Jeviatus has its own. Publishing always targets the configured space.
const preview = new URLSearchParams(location.search).get("space");
export const readSpace = preview && /^[\w.-]+$/.test(preview) ? preview : GOV.snapshot.space;
export const votingLive = GOV.snapshot.space !== "";
export const forumLive = GOV.forum.url !== "";

export interface SpaceInfo {
  id: string;
  name: string;
  network: string;
  symbol: string;
  voting: { delay: number | null; period: number | null; quorum: number | null; type: string | null };
}

export interface ProposalInfo {
  id: string;
  title: string;
  state: "pending" | "active" | "closed";
  choices: string[];
  scores: number[];
  scores_total: number;
  end: number;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${GOV.snapshot.hub}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(json.errors?.[0]?.message ?? `Snapshot hub answered ${res.status}`);
  return json.data as T;
}

export async function spaceInfo(id: string): Promise<SpaceInfo | null> {
  const d = await graphql<{ space: SpaceInfo | null }>(
    "query($id: String!) { space(id: $id) { id name network symbol voting { delay period quorum type } } }",
    { id },
  );
  return d.space;
}

export async function proposals(space: string, first = 6): Promise<ProposalInfo[]> {
  const d = await graphql<{ proposals: ProposalInfo[] }>(
    `query($space: String!, $first: Int!) { proposals(first: $first, where: { space: $space }, orderBy: "created", orderDirection: desc) {
      id title state choices scores scores_total end } }`,
    { space, first },
  );
  return d.proposals;
}

export const proposalUrl = (space: string, id: string) => `${GOV.snapshot.ui}/#/${space}/proposal/${id}`;
export const spaceUrl = (space: string) => `${GOV.snapshot.ui}/#/${space}`;

// Latest block on the space's network: token balances are counted there.
export async function latestBlock(network: string): Promise<number> {
  const res = await fetch(`${GOV.snapshot.rpc}/${network}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const json = await res.json();
  if (!json.result) throw new Error("Couldn't read the latest block");
  return Number.parseInt(json.result, 16);
}

// ---------- Discourse ----------

export interface Topic {
  id: number;
  slug: string;
  title: string;
  posts_count: number;
  last_posted_at: string | null;
}

// Discourse opens its composer prefilled from these parameters.
export function newTopicUrl(title: string, body: string): string {
  const q = new URLSearchParams({ title, body, category: GOV.forum.category });
  return `${GOV.forum.url}/new-topic?${q}`;
}

export const topicUrl = (t: Topic) => `${GOV.forum.url}/t/${t.slug}/${t.id}`;
export const categoryUrl = () => (GOV.forum.categoryId ? `${GOV.forum.url}/c/${GOV.forum.category}/${GOV.forum.categoryId}` : GOV.forum.url);

// Needs the forum to allow this site's origin (Discourse `cors_origins`).
export async function latestTopics(n = 6): Promise<Topic[]> {
  const url = GOV.forum.categoryId ? `${categoryUrl()}/l/latest.json` : `${GOV.forum.url}/latest.json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Forum answered ${res.status}`);
  const json = await res.json();
  return (json.topic_list?.topics ?? []).filter((t: Topic & { pinned?: boolean }) => !t.pinned).slice(0, n);
}

export function relativeTime(unixSeconds: number): string {
  const d = unixSeconds * 1000 - Date.now();
  const abs = Math.abs(d);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 3_600_000) return rtf.format(Math.round(d / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(d / 3_600_000), "hour");
  return rtf.format(Math.round(d / 86_400_000), "day");
}
