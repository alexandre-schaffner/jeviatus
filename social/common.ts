// What the uploaders share: the Poster shape, env handling, JSON over HTTP
// with readable errors, a token store for tokens that rotate (TikTok,
// Instagram), and OAuth 1.0a request signing (X).

import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { PlannedPost, Platform } from "./queue";

export type Env = Record<string, string | undefined>;

export interface PostResult {
  url: string | null;
  remoteId: string | null;
}

export interface PostContext {
  env: Env;
  log: (line: string) => void;
  tokens: TokenStore;
  // Where scratch files (a poster frame) may go.
  workDir: string;
}

export interface Poster {
  platform: Platform;
  // Env vars it can't run without.
  required: string[];
  // Everything it would send, for --dry-run: no network, no files read.
  preview: (p: PlannedPost, env: Env) => Record<string, unknown>;
  post: (p: PlannedPost, ctx: PostContext) => Promise<PostResult>;
}

export const missingEnv = (poster: Poster, env: Env) => poster.required.filter((k) => !env[k]?.trim());

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what}: HTTP ${status} ${body.slice(0, 400)}`);
  }
}

export async function http(what: string, url: string, init: RequestInit & { expect?: number[] } = {}): Promise<Response> {
  const res = await fetch(url, init);
  const ok = init.expect ? init.expect.includes(res.status) : res.ok;
  if (!ok) throw new HttpError(res.status, await res.text().catch(() => ""), what);
  return res;
}

export async function json<T = Record<string, unknown>>(what: string, url: string, init: RequestInit & { expect?: number[] } = {}): Promise<T> {
  const res = await http(what, url, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

// Tokens some platforms hand back on every refresh (the old one dies): kept
// in a 0600 file beside the posted log, taking precedence over the env.
export class TokenStore {
  private data: Record<string, string>;
  constructor(private readonly file: string) {
    this.data = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
  }
  get(key: string, env: Env): string | undefined {
    return this.data[key] ?? env[key];
  }
  set(key: string, value: string): void {
    this.data[key] = value;
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    chmodSync(this.file, 0o600);
  }
}

// --- OAuth 1.0a (RFC 5849), HMAC-SHA1 ------------------------------------------------

export interface OAuth1Keys {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

export const pct = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// The Authorization header. Only query and form-encoded params are signed;
// JSON and multipart bodies aren't part of the signature.
export function oauth1Header(method: string, url: string, keys: OAuth1Keys, formParams: Record<string, string> = {}, fixed?: { nonce: string; timestamp: string }): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: keys.consumerKey,
    oauth_nonce: fixed?.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: fixed?.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: keys.token,
    oauth_version: "1.0",
  };
  const params: [string, string][] = [...u.searchParams.entries(), ...Object.entries(formParams), ...Object.entries(oauth)];
  const normalized = params
    .map(([k, v]) => [pct(k), pct(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${pct(`${u.origin}${u.pathname}`)}&${pct(normalized)}`;
  const signature = createHmac("sha1", `${pct(keys.consumerSecret)}&${pct(keys.tokenSecret)}`).update(base).digest("base64");
  const header = { ...oauth, oauth_signature: signature };
  return `OAuth ${Object.entries(header)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`)
    .join(", ")}`;
}

// The text as a platform takes it: caption plus hashtags.
export const withTags = (caption: string, tags: string[]) => (tags.length ? `${caption}\n\n${tags.join(" ")}` : caption);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
