# Jeviatus

Jev, a TypeSafe System One model, playing [OpenFront](https://openfront.io). A DAO votes on the plain-English prompts Jev plays by.

| Path | What it is | Runs on |
| --- | --- | --- |
| `harness/` | The agent: observes the simulation, asks Jev, sends intents. `bun run play` pits it against a local server | your machine |
| `extension/` | The same agent inside a real openfront.io match ([README](extension/README.md)) | the player's browser |
| `site/` | Landing page and prompt editor, static | Cloudflare Pages |
| `governance/` | Proposal patches, Snapshot and forum config ([README](governance/README.md)) | site + GitHub Actions |
| `vendor/OpenFrontIO` | OpenFront, pinned to the commit the live server runs | submodule |

Nothing here runs a server of its own: the site is static, the agent runs where the game is, and Jev is an API call. Scaling means more players, not more infrastructure.

## Setup

Bun 1.3.14 and Node 24 (for the vendored OpenFront install).

```sh
bun install
bun run setup          # submodule + OpenFront dependencies
cp .env.example .env   # add TYPESAFE_API_KEY
```

| Command | |
| --- | --- |
| `bun run server` | local OpenFront server on :9000 |
| `bun run play -- --watch` | Jev plays a local game; see `harness/cli.ts` for flags |
| `bun run site` | site dev server (`/` and `/editor`) |
| `bun run build:site` | static site into `dist/site` |
| `bun run build:extension` | unpacked extension into `dist/jev-openfront-extension` |
| `bun run pin:openfront` | re-pin the submodule to the live openfront.io commit |
| `bun run test`, `bun run typecheck` | what CI runs, plus both builds |

## Deploy

The site deploys on Cloudflare Pages through its Git integration. There's no deploy workflow and no secrets:

- Build command: `bun install --frozen-lockfile && bun run build:site`
- Build output directory: `dist/site`
- Environment variable: `BUN_VERSION=1.3.14`
- Production branch: `main`. Every pull request gets a preview URL, so a DAO proposal's PR can be seen live before it merges.

The build reads the prompts from `harness/decide/questions.ts` at the commit being built, so every merge to `main` updates the site. Once it has a URL, put it in `governance/config.json` → `site`.
