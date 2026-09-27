// Bribes: anyone can propose a strategy PR (stream/ballot.ts); viewers pay in
// the stream's pump.fun coin to promote one up the maintainer's review queue.
// A bribe is a transfer of the coin to the stream's wallet that names a PR,
// either with a memo ("#12") or, for wallets that can't attach one, with the
// PR number as the amount's last decimals (….000012). Each PR has a pot that
// grows while it's open; pots of at least BRIBE_MIN rank ahead of any 👍 count
// on the band. A bribe buys attention, not a match: only the maintainer
// merges, and only merged strategies play. The stream only reads the chain:
// it holds no key that can move funds, so there are no refunds.
//
// The chain is read over Solana JSON-RPC: the wallet's token accounts for the
// coin, their new signatures, and each transaction's token balance changes
// and memo. What's been counted persists in a small ledger on the volume, so
// a restart neither drops nor double-counts a bribe.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Bribe {
  signature: string;
  // The wallet whose balance of the coin went down the most (else the fee payer).
  from: string;
  amount: bigint; // raw units
  memo: string | null;
  // The PR it backs; null for a tip that names none.
  pr: number | null;
  blockTime: number | null;
}

export interface BribeOptions {
  rpcUrl: string;
  mint: string;
  wallet: string;
  ticker: string;
  minTokens: number;
  ledgerFile: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Ledger {
  // Unix seconds the ledger was started: older transfers aren't bribes.
  since: number;
  decimals: number | null;
  // Newest counted signature, per token account of the wallet.
  cursors: Record<string, string>;
  // PR number → backer → raw amount (decimal string).
  pots: Record<string, Record<string, string>>;
  // Recently counted signatures: one transaction can touch two of our accounts.
  recent: string[];
}

// Solana's jsonParsed transaction, the parts read here.
interface TokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}
interface ParsedInstruction {
  program?: string;
  parsed?: unknown;
}
export interface ParsedTransaction {
  blockTime?: number | null;
  meta: {
    err: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    innerInstructions?: { instructions: ParsedInstruction[] }[];
  } | null;
  transaction: { message: { accountKeys: { pubkey: string }[]; instructions: ParsedInstruction[] } };
}
interface SignatureInfo {
  signature: string;
  err: unknown;
  blockTime: number | null;
}

// Finalized: a bribe that could still be rolled back never buys a match.
const COMMITMENT = "finalized";
const PAGE = 1000;
const RECENT = 2000;
// Without a memo, the amount's last decimals name the PR (up to 6 digits).
export const tailDigits = (decimals: number) => Math.min(decimals, 6);

// "#12", "12", "PR 12", "pr#12" → 12.
export function parseMemo(memo: string): number | null {
  const m = /^\s*(?:pr\s*)?#?\s*(\d{1,6})\s*$/i.exec(memo);
  const n = m ? Number(m[1]) : 0;
  return n > 0 ? n : null;
}

// The PR a memo-less amount names: its last decimals (5000.000012 → #12).
export function prFromAmount(raw: bigint, decimals: number): number | null {
  const digits = tailDigits(decimals);
  if (digits === 0) return null;
  const n = Number(raw % 10n ** BigInt(digits));
  return n > 0 ? n : null;
}

function memoOf(tx: ParsedTransaction): string | null {
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions);
  for (const ix of [...tx.transaction.message.instructions, ...inner]) {
    if (ix.program === "spl-memo" && typeof ix.parsed === "string") return ix.parsed;
  }
  return null;
}

// The coin `wallet` received in this transaction, or null if none.
export function parseBribe(signature: string, tx: ParsedTransaction, o: { mint: string; wallet: string }): Bribe | null {
  const meta = tx.meta;
  if (meta === null || meta.err !== null) return null;
  const change = new Map<string, bigint>();
  let decimals = 0;
  const add = (b: TokenBalance, sign: bigint) => {
    if (b.mint !== o.mint || !b.owner) return;
    decimals = b.uiTokenAmount.decimals;
    change.set(b.owner, (change.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  };
  for (const b of meta.preTokenBalances ?? []) add(b, -1n);
  for (const b of meta.postTokenBalances ?? []) add(b, 1n);
  const amount = change.get(o.wallet) ?? 0n;
  if (amount <= 0n) return null;
  let from = tx.transaction.message.accountKeys[0]?.pubkey ?? "unknown";
  let most = 0n;
  for (const [owner, d] of change) {
    if (owner !== o.wallet && -d > most) {
      most = -d;
      from = owner;
    }
  }
  const memo = memoOf(tx);
  // A memo that names no PR ("gm") falls back to the amount.
  const pr = (memo !== null ? parseMemo(memo) : null) ?? prFromAmount(amount, decimals);
  return { signature, from, amount, memo, pr, blockTime: tx.blockTime ?? null };
}

// 50234.5 → "50.2K"; whole tokens below 1000 keep up to 2 decimals.
export function formatTokens(raw: bigint, decimals: number): string {
  const whole = Number(raw) / 10 ** decimals;
  for (const [unit, size] of [["B", 1e9], ["M", 1e6], ["K", 1e3]] as const) {
    if (whole >= size) return `${Number((whole / size).toFixed(1))}${unit}`;
  }
  return String(Number(whole.toFixed(2)));
}

// "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" → "7xKX…gAsU"
export const shortAddress = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

export class SolanaBribes {
  private readonly fetch: typeof fetch;
  private readonly ledger: Ledger;
  private readonly recent: Set<string>;
  private busy = false;

  constructor(private readonly o: BribeOptions) {
    this.fetch = o.fetch ?? fetch;
    this.ledger = this.load();
    this.recent = new Set(this.ledger.recent);
  }

  get decimals(): number | null {
    return this.ledger.decimals;
  }

  get minPot(): bigint {
    const d = this.ledger.decimals;
    return d === null ? 0n : BigInt(Math.round(this.o.minTokens * 10 ** d));
  }

  format(raw: bigint): string {
    return `${formatTokens(raw, this.ledger.decimals ?? 0)} $${this.o.ticker}`;
  }

  pots(): Map<number, bigint> {
    const pots = new Map<number, bigint>();
    for (const [pr, backers] of Object.entries(this.ledger.pots)) {
      const total = Object.values(backers).reduce((sum, v) => sum + BigInt(v), 0n);
      if (total > 0n) pots.set(Number(pr), total);
    }
    return pots;
  }

  // Counts every bribe that arrived since the last refresh and returns them.
  // Overlapping calls return nothing.
  async refresh(): Promise<Bribe[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      if (this.ledger.decimals === null) {
        const supply = await this.rpc<{ value: { decimals: number } }>("getTokenSupply", [this.o.mint, { commitment: COMMITMENT }]);
        this.ledger.decimals = supply.value.decimals;
        this.save();
      }
      const accounts = await this.rpc<{ value: { pubkey: string }[] }>("getTokenAccountsByOwner", [
        this.o.wallet,
        { mint: this.o.mint },
        { encoding: "jsonParsed", commitment: COMMITMENT },
      ]);
      const found: Bribe[] = [];
      for (const { pubkey } of accounts.value) found.push(...(await this.scan(pubkey)));
      return found;
    } finally {
      this.busy = false;
    }
  }

  // New signatures of one token account, oldest first; the cursor advances
  // one transaction at a time, so a failure resumes where it stopped.
  private async scan(account: string): Promise<Bribe[]> {
    const cursor = this.ledger.cursors[account];
    const sigs: SignatureInfo[] = []; // newest first
    let before: string | undefined;
    for (let done = false; !done; ) {
      const page = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
        account,
        { limit: PAGE, commitment: COMMITMENT, ...(cursor ? { until: cursor } : {}), ...(before ? { before } : {}) },
      ]);
      done = page.length < PAGE;
      for (const s of page) {
        if (s.blockTime !== null && s.blockTime < this.ledger.since) {
          done = true;
          break;
        }
        sigs.push(s);
      }
      before = page.at(-1)?.signature;
    }
    const found: Bribe[] = [];
    for (const s of sigs.reverse()) {
      if (s.err === null && !this.recent.has(s.signature)) {
        const tx = await this.rpc<ParsedTransaction | null>("getTransaction", [
          s.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: COMMITMENT },
        ]);
        if (tx === null) break; // not served yet; next refresh
        const bribe = parseBribe(s.signature, tx, this.o);
        if (bribe !== null) {
          if (bribe.pr !== null) this.credit(bribe.pr, bribe.from, bribe.amount);
          found.push(bribe);
        }
        this.remember(s.signature);
      }
      this.ledger.cursors[account] = s.signature;
      this.save();
    }
    return found;
  }

  private credit(pr: number, from: string, amount: bigint): void {
    const backers = (this.ledger.pots[String(pr)] ??= {});
    backers[from] = String(BigInt(backers[from] ?? "0") + amount);
  }

  private remember(signature: string): void {
    this.recent.add(signature);
    this.ledger.recent.push(signature);
    if (this.ledger.recent.length > RECENT) this.recent.delete(this.ledger.recent.shift()!);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetch(this.o.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`Solana RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`Solana RPC ${method}: ${body.error.message}`);
    return body.result as T;
  }

  // A ledger for another coin or wallet is someone else's: start over.
  private load(): Ledger {
    const fresh: Ledger = { since: Math.floor((this.o.now ?? Date.now)() / 1000), decimals: null, cursors: {}, pots: {}, recent: [] };
    if (!existsSync(this.o.ledgerFile)) return fresh;
    const saved = JSON.parse(readFileSync(this.o.ledgerFile, "utf8")) as Ledger & { mint?: string; wallet?: string };
    return saved.mint === this.o.mint && saved.wallet === this.o.wallet ? saved : fresh;
  }

  private save(): void {
    mkdirSync(path.dirname(this.o.ledgerFile), { recursive: true });
    const tmp = `${this.o.ledgerFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ mint: this.o.mint, wallet: this.o.wallet, ...this.ledger }));
    renameSync(tmp, this.o.ledgerFile);
  }
}
