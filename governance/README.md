# Jeviatus DAO governance

How a change to Jev's prompts goes from anyone's idea to Jev's next game, and what has to be set up for it to run.

```text
editor (site/editor.html)          anyone, no code: reword a question or hint, preview the exact diff
   │  Start a forum thread         Discourse composer opens prefilled with the proposal
   ▼
forum (Discourse)                  debate; the thread link goes into the proposal
   │  Sign and publish             a free EIP-712 signature, posted to Snapshot's sequencer
   ▼
Snapshot space                     token-weighted vote: For / Against / Abstain
   │  hourly workflow              .github/workflows/dao-proposals.yml
   ▼
pull request (label dao-proposal)  opened by scripts/snapshot-to-pr.ts, reviewed and approved by a maintainer
```

Everything is configured in [`config.json`](config.json). An empty `snapshot.space` or `forum.url` means that part is not live yet: the site says so, the editor still works (drafts can be copied or downloaded), and the workflow exits without doing anything.

## What a proposal can change

Only the plain-text strings in `harness/decide/questions.ts`: a question's wording and its `consider` hints (reword, add, remove). Questions built from live game values (template strings) and everything else in the repo stay code changes for developers.

A proposal carries a machine-readable patch in a fenced `jeviatus-patch` block, visible to voters. Each edit names the exact text it expects to replace. The bot writes new text with `JSON.stringify`, so a proposal can never inject code. It re-parses the result and checks that every voted string landed. If the file changed underneath the proposal, the bot opens an issue instead of guessing. The logic is in [`patch.ts`](patch.ts), and [`tests/governance.test.ts`](../tests/governance.test.ts) covers it.

## Setup

### 1. Snapshot space (voting)

1. Register an ENS name for the DAO (for example `jeviatus.eth`) on Ethereum mainnet.
2. On [snapshot.org](https://snapshot.org), create a space on that name.
3. **Voting strategy (token-weighted):** add the `erc20-balance-of` strategy with the Jeviatus token's contract address, network and decimals. Each wallet then votes with its token balance at the proposal's snapshot block.
4. **Proposal validation:** use `basic` with a minimum token balance, so proposing needs some stake and spam stays out.
5. **Voting settings:** set a voting period (the editor uses the space's period; `snapshot.votingDays` is only the fallback) and, if you want, a quorum. The bot only acts when the quorum is met and For beats Against.
6. Put the ENS name in `config.json` → `snapshot.space`, then rebuild the site.

To see the site's ballot list working before your space exists, add `?space=ens.eth` (or any other space) to the landing page URL. It's read-only: publishing always targets the configured space.

To rehearse the whole flow first, create a space on Snapshot's testnet (testnet.snapshot.box, Sepolia ENS). Then point `hub`, `sequencer` and `ui` at `https://testnet.hub.snapshot.org`, `https://testnet.seq.snapshot.org` and `https://testnet.snapshot.box`.

### 2. Discourse (debate)

1. Host a Discourse forum (self-hosted, or discourse.org hosting) and create a category for strategy proposals (default slug `strategy`).
2. Put the forum URL in `forum.url`, the category slug in `forum.category`, and its numeric ID in `forum.categoryId`.
3. So the landing page can list the latest threads, allow the site's origin in the admin setting `cors_origins`. Self-hosted forums also need `DISCOURSE_ENABLE_CORS: true` in `app.yml`. Without CORS the page falls back to a link to the forum.
4. Optional: install the Discourse Snapshot plugin (or add a pinned "how to propose" topic linking to the editor), so threads and votes point at each other.

### 3. The pull request bot

- `.github/workflows/dao-proposals.yml` runs hourly and on demand (Actions → DAO proposals → Run workflow, with an optional proposal ID and a dry-run switch).
- It needs no secret to work. Pull requests opened with the default `GITHUB_TOKEN` don't trigger other workflows, though, so add a `DAO_BOT_TOKEN` secret (a fine-grained token or GitHub App token with contents, pull requests and issues write) if CI should run on bot PRs.
- **Maintainer review:** protect `main` with a rule that requires at least one approving review. The bot never merges.
- Locally: `bun scripts/snapshot-to-pr.ts --dry-run` shows what it would do. `--space other.eth` or `--proposal 0x…` narrows it down.

### 4. Site

The site is static and is hosted on Cloudflare Pages (see the root [README](../README.md#deploy)). Every merge to `main` rebuilds it, so a merged proposal shows up on the site without a manual step. Set `site` in `config.json` to its public URL, so proposals link back to the editor.
