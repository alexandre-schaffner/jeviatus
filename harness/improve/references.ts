// What the improvement loop may ground a change in, besides OpenFront's own
// source (vendor/OpenFrontIO): the community wikis and r/OpenFrontIO, saved
// as plain-text files, one per page or post, each headed with its URL:
//
//   <dir>/wiki/<site>/<page>.md     every article of each wiki (MediaWiki API)
//   <dir>/reddit/<post id>.md       a post and its comments (Reddit's API with
//                                   REDDIT_CLIENT_ID/SECRET, else its public RSS)
//   <dir>/INDEX.md                  one line per file
//
// Refreshed at most once a day. Without an app, Reddit throttles hard (one
// request every half minute or worse), so the RSS fetcher paces itself and
// waits out 429s; posts accumulate across days.
// Everything here is third-party text: it's evidence to quote, never
// instructions (the prompt says so, and grounding.ts checks the quotes).

import fs from "node:fs";
import path from "node:path";

export const REFERENCES_DIR = ".loop/references";

const UA = "jeviatus-lab/1.0 (research for an OpenFront AI player; one fetch a day)";

// The wikis: MediaWiki sites with their API endpoint and article URL prefix.
export const WIKIS = [
  { site: "miraheze", api: "https://openfront.miraheze.org/w/api.php", page: "https://openfront.miraheze.org/wiki/" },
  { site: "fandom", api: "https://openfront.fandom.com/api.php", page: "https://openfront.fandom.com/wiki/" },
] as const;

const SUBREDDIT = "OpenFrontIO";
// Listings to collect posts from, most useful first.
const REDDIT_FEEDS = [
  ...["strategy", "tips", "guide", "how to", "attack", "alliance", "boat", "nuke", "city", "economy", "early game", "defense", "troops"].map(
    (q) => `https://www.reddit.com/r/${SUBREDDIT}/search.rss?q=${encodeURIComponent(q)}&restrict_sr=on&sort=top&t=all&limit=25`,
  ),
  `https://www.reddit.com/r/${SUBREDDIT}/top/.rss?t=all&limit=100`,
  `https://www.reddit.com/r/${SUBREDDIT}/top/.rss?t=year&limit=100`,
];

export interface RefreshOptions {
  maxAgeHours?: number;
  // A Reddit "script" app (reddit.com/prefs/apps): the official API, about
  // 100 requests a minute. Without one, the public RSS feeds, which Reddit
  // throttles hard for unauthenticated clients.
  reddit?: { clientId: string; clientSecret: string } | null;
  redditPosts?: number;
  // Pause between Reddit requests.
  paceMs?: number;
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "page";
}

// MediaWiki markup to readable text: templates, tables and refs out, links to their labels.
export function wikitextToText(w: string): string {
  let s = w.replace(/<!--[\s\S]*?-->/g, "").replace(/<ref[^>]*\/>/g, "").replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "");
  // Nested templates: strip innermost first.
  for (let i = 0; i < 6 && /\{\{[^{}]*\}\}/.test(s); i++) s = s.replace(/\{\{[^{}]*\}\}/g, "");
  s = s
    .replace(/\{\|[\s\S]*?\|\}/g, (t) => t.replace(/^\s*[|!]-?\s*/gm, "").replace(/\s*(\|\||!!)\s*/g, " | "))
    .replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, "")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+ ([^\]]*)\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

// HTML (Reddit's RSS content) to text.
export function htmlToText(h: string): string {
  const decode = (s: string) =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
      .replace(/&amp;/g, "&");
  return decode(decode(h).replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n").replace(/<[^>]+>/g, ""))
    // Reddit's RSS footer on every post.
    .replace(/\s*submitted by\s+\/u\/\S+\s*\[link\]\s*\[comments\]\s*$/i, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

interface FeedEntry {
  title: string;
  link: string;
  author: string;
  content: string;
}

export function parseFeed(xml: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]!;
    out.push({
      title: htmlToText(/<title>([\s\S]*?)<\/title>/.exec(e)?.[1] ?? ""),
      link: /<link href="([^"]+)"/.exec(e)?.[1] ?? "",
      author: /<name>([\s\S]*?)<\/name>/.exec(e)?.[1] ?? "",
      content: htmlToText(/<content[^>]*>([\s\S]*?)<\/content>/.exec(e)?.[1] ?? ""),
    });
  }
  return out;
}

function header(url: string, title: string): string {
  return `URL: ${url}\nTitle: ${title}\n\n`;
}

async function wikis(dir: string, log: (l: string) => void, f: typeof fetch): Promise<number> {
  let n = 0;
  for (const w of WIKIS) {
    const out = path.join(dir, "wiki", w.site);
    try {
      const titles: string[] = [];
      let cont: string | undefined;
      do {
        const url = `${w.api}?action=query&list=allpages&apnamespace=0&apfilterredir=nonredirects&aplimit=500&format=json${cont ? `&apcontinue=${encodeURIComponent(cont)}` : ""}`;
        const j = (await (await f(url, { headers: { "user-agent": UA } })).json()) as { query?: { allpages?: { title: string }[] }; continue?: { apcontinue?: string } };
        titles.push(...(j.query?.allpages ?? []).map((p) => p.title));
        cont = j.continue?.apcontinue;
      } while (cont);
      // Patch notes for long-gone versions ("0.12.0") would mostly mislead.
      const wanted = titles.filter((t) => !/^v?\d+(\.\d+)+/.test(t));
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      for (let i = 0; i < wanted.length; i += 50) {
        const batch = wanted.slice(i, i + 50);
        const url = `${w.api}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(batch.join("|"))}`;
        const j = (await (await f(url, { headers: { "user-agent": UA } })).json()) as { query?: { pages?: { title: string; revisions?: { slots?: { main?: { content?: string } } }[] }[] } };
        for (const p of j.query?.pages ?? []) {
          const text = wikitextToText(p.revisions?.[0]?.slots?.main?.content ?? "");
          if (text.length < 80) continue;
          fs.writeFileSync(path.join(out, `${slug(p.title)}.md`), header(`${w.page}${encodeURI(p.title.replace(/ /g, "_"))}`, p.title) + text + "\n");
          n++;
        }
        await sleep(300);
      }
    } catch (err) {
      log(`[references] ${w.site} wiki: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return n;
}

// One Reddit request, paced, waiting out rate limits.
async function reddit(url: string, f: typeof fetch, paceMs: number): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(paceMs);
    const res = await f(url, { headers: { "user-agent": UA } });
    if (res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 30);
      await sleep(Math.min(120, reset + 2) * 1000);
      continue;
    }
    if (!res.ok) return null;
    return res.text();
  }
  return null;
}

async function redditPosts(dir: string, log: (l: string) => void, f: typeof fetch, max: number, paceMs: number): Promise<number> {
  const out = path.join(dir, "reddit");
  fs.mkdirSync(out, { recursive: true });
  const posts = new Map<string, string>();
  for (const feed of REDDIT_FEEDS) {
    const xml = await reddit(feed, f, paceMs);
    if (xml === null) continue;
    for (const e of parseFeed(xml)) {
      const id = /\/comments\/([a-z0-9]+)\//.exec(e.link)?.[1];
      if (id && !posts.has(id)) posts.set(id, e.link);
    }
    if (posts.size >= max * 2) break;
  }
  let n = 0;
  for (const [id, link] of [...posts].slice(0, max)) {
    const file = path.join(out, `${id}.md`);
    // Posts rarely change after a week; keep what we have.
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 7 * 86_400_000) {
      n++;
      continue;
    }
    const xml = await reddit(`${link.replace(/\/$/, "")}/.rss?limit=40`, f, paceMs);
    if (xml === null) continue;
    const [post, ...comments] = parseFeed(xml);
    if (!post) continue;
    const body = [post.content, ...comments.filter((c) => c.content.length > 20).map((c) => `--- comment by ${c.author.replace(/^\/u\//, "")}:\n${c.content}`)].join("\n\n");
    fs.writeFileSync(file, header(link, post.title) + body + "\n");
    n++;
  }
  if (posts.size === 0) log("[references] reddit: no posts (rate-limited or unreachable); keeping what's saved");
  return n;
}

interface ApiThing {
  kind: string;
  data: { id?: string; title?: string; selftext?: string; body?: string; author?: string; permalink?: string; score?: number; replies?: { data?: { children?: ApiThing[] } } | "" };
}

// A comment tree, flattened: the better-scored comments, a few levels deep.
export function flattenComments(things: ApiThing[], depth = 0, out: { author: string; body: string; score: number }[] = []): typeof out {
  for (const t of things) {
    if (t.kind !== "t1" || !t.data.body) continue;
    if ((t.data.score ?? 0) >= 1) out.push({ author: t.data.author ?? "?", body: t.data.body.trim(), score: t.data.score ?? 0 });
    const replies = typeof t.data.replies === "object" ? (t.data.replies.data?.children ?? []) : [];
    if (depth < 3) flattenComments(replies, depth + 1, out);
  }
  return out;
}

// The official API with an app-only token (no user account involved).
async function redditApi(dir: string, log: (l: string) => void, f: typeof fetch, app: { clientId: string; clientSecret: string }, max: number): Promise<number> {
  const auth = await f("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { "user-agent": UA, authorization: `Basic ${btoa(`${app.clientId}:${app.clientSecret}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const token = ((await auth.json()) as { access_token?: string }).access_token;
  if (!token) throw new Error(`no token (HTTP ${auth.status})`);
  const get = async (url: string) => {
    await sleep(700);
    const res = await f(`https://oauth.reddit.com${url}`, { headers: { "user-agent": UA, authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  };
  const listings = [
    ...["strategy", "tips", "guide", "how to", "attack", "alliance", "boat", "nuke", "city", "economy", "early game", "defense", "troops"].map(
      (q) => `/r/${SUBREDDIT}/search?q=${encodeURIComponent(q)}&restrict_sr=1&sort=top&t=all&limit=50&raw_json=1`,
    ),
    `/r/${SUBREDDIT}/top?t=all&limit=100&raw_json=1`,
  ];
  const posts = new Map<string, number>();
  for (const l of listings) {
    const j = (await get(l).catch(() => null)) as { data?: { children?: ApiThing[] } } | null;
    for (const c of j?.data?.children ?? []) if (c.data.id && c.kind === "t3") posts.set(c.data.id, (posts.get(c.data.id) ?? 0) + 1 + (c.data.score ?? 0) / 1000);
  }
  // Posts that show up in several strategy searches first.
  const ranked = [...posts].sort((a, b) => b[1] - a[1]).slice(0, max);
  const out = path.join(dir, "reddit");
  fs.mkdirSync(out, { recursive: true });
  let n = 0;
  for (const [id] of ranked) {
    const file = path.join(out, `${id}.md`);
    if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 7 * 86_400_000) {
      n++;
      continue;
    }
    const j = (await get(`/comments/${id}?limit=100&depth=4&sort=top&raw_json=1`).catch(() => null)) as [{ data: { children: ApiThing[] } }, { data: { children: ApiThing[] } }] | null;
    const post = j?.[0]?.data.children[0]?.data;
    if (!post?.permalink) continue;
    const comments = flattenComments(j![1].data.children).slice(0, 40);
    const body = [post.selftext?.trim() ?? "", ...comments.map((c) => `--- comment by ${c.author} (${c.score} points):\n${c.body}`)].filter(Boolean).join("\n\n");
    fs.writeFileSync(file, header(`https://www.reddit.com${post.permalink}`, post.title ?? id) + body + "\n");
    n++;
  }
  log(`[references] reddit API: ${posts.size} posts found, ${n} saved`);
  return n;
}

export function indexReferences(dir: string): string[] {
  const lines: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md") && e.name !== "INDEX.md") {
        const head = fs.readFileSync(p, "utf8").slice(0, 600);
        const title = /^Title: (.*)$/m.exec(head)?.[1] ?? e.name;
        lines.push(`- ${path.relative(dir, p)}: ${title}`);
      }
    }
  };
  walk(dir);
  return lines.sort();
}

// Brings `dir` up to date (at most once per maxAgeHours). Never throws: the
// loop works with whatever was saved before.
export async function refreshReferences(dir: string, log: (line: string) => void, o: RefreshOptions = {}): Promise<void> {
  const stamp = path.join(dir, ".fetched");
  const maxAge = (o.maxAgeHours ?? 24) * 3_600_000;
  if (fs.existsSync(stamp) && Date.now() - fs.statSync(stamp).mtimeMs < maxAge) return;
  fs.mkdirSync(dir, { recursive: true });
  const f = o.fetch ?? fetch;
  const t0 = Date.now();
  const wiki = await wikis(dir, log, f).catch(() => 0);
  const posts = o.reddit
    ? await redditApi(dir, log, f, o.reddit, o.redditPosts ?? 80).catch((e) => (log(`[references] reddit API: ${e instanceof Error ? e.message : String(e)}`), 0))
    : await redditPosts(dir, log, f, o.redditPosts ?? 60, o.paceMs ?? 6_000).catch(() => 0);
  const index = indexReferences(dir);
  fs.writeFileSync(path.join(dir, "INDEX.md"), `# References (${index.length} files)\n\nEach file starts with its URL. Quote them verbatim when you cite them.\n\n${index.join("\n")}\n`);
  fs.writeFileSync(stamp, new Date().toISOString());
  log(`[references] ${wiki} wiki pages, ${posts} reddit posts in ${Math.round((Date.now() - t0) / 1000)}s`);
}
