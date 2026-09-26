// Publish a proposal to Snapshot from the visitor's wallet. Loaded on demand.
//
// This mirrors the official client (@snapshot-labs/snapshot.js 0.17.5,
// src/sign/index.ts and types.ts): the same EIP-712 domain and Proposal
// types, signed off-chain (no gas), then posted to the Snapshot sequencer as
// { address, sig, data }. The package itself pulls ~1.8 MB into a browser
// bundle; viem does the signing in a fraction of that.

import { createWalletClient, custom, type EIP1193Provider, getAddress } from "viem";

export const DOMAIN = { name: "snapshot", version: "0.1.4" } as const;

export const PROPOSAL_TYPES = {
  Proposal: [
    { name: "from", type: "string" },
    { name: "space", type: "string" },
    { name: "timestamp", type: "uint64" },
    { name: "type", type: "string" },
    { name: "title", type: "string" },
    { name: "body", type: "string" },
    { name: "discussion", type: "string" },
    { name: "choices", type: "string[]" },
    { name: "labels", type: "string[]" },
    { name: "start", type: "uint64" },
    { name: "end", type: "uint64" },
    { name: "snapshot", type: "uint64" },
    { name: "plugins", type: "string" },
    { name: "privacy", type: "string" },
    { name: "app", type: "string" },
  ],
} as const;

export interface ProposalMessage {
  from: string;
  space: string;
  timestamp: number;
  type: string;
  title: string;
  body: string;
  discussion: string;
  choices: string[];
  labels: string[];
  start: number;
  end: number;
  snapshot: number;
  plugins: string;
  privacy: string;
  app: string;
}

function wallet(): EIP1193Provider {
  const eth = (window as { ethereum?: EIP1193Provider }).ethereum;
  if (!eth) throw new Error("No wallet found. Install a browser wallet such as MetaMask or Rabby, then try again.");
  return eth;
}

export async function connect(): Promise<string> {
  const accounts = (await wallet().request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The wallet didn't share an address.");
  return getAddress(accounts[0]);
}

// Sign and send; resolves to the new proposal's ID.
export async function publish(sequencer: string, message: ProposalMessage): Promise<string> {
  const account = getAddress(message.from);
  const client = createWalletClient({ account, transport: custom(wallet()) });
  const msg = { ...message, from: account };
  const sig = await client.signTypedData({
    domain: DOMAIN,
    types: PROPOSAL_TYPES,
    primaryType: "Proposal",
    message: { ...msg, timestamp: BigInt(msg.timestamp), start: BigInt(msg.start), end: BigInt(msg.end), snapshot: BigInt(msg.snapshot) },
  });
  const res = await fetch(sequencer, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ address: account, sig, data: { domain: DOMAIN, types: PROPOSAL_TYPES, message: msg } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || `Snapshot answered ${res.status}`);
  return json.id as string;
}
