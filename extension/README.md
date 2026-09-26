# Jev for OpenFront — browser extension

A Chromium Manifest V3 extension that runs the repository's Jev agent inside OpenFront matches on **openfront.io** and on a local OpenFront dev server (`localhost` / `127.0.0.1`).

## Use

```sh
bun run build:extension
```

1. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked** → `dist/jev-openfront-extension`.
2. In the popup, save your TypeSafe API key and enable Jev.
3. Open `https://openfront.io` (or `http://localhost:9000` from `bun run server`), join a multiplayer match and start it. Enable Jev before the match begins.
4. The in-page panel reports each decision and has an On/Off switch. Off is re-checked immediately before every intent is sent, including one whose Jev request began before the switch.

Singleplayer games run entirely in the page without a WebSocket, so the extension can't attach to them.

## Logging games

To keep a trace of every game you play with the extension (for `bun run analyze`), run a local sink:

```sh
bun run trace-sink
```

and paste the printed Trace URL and token into the popup. Each game lands in `runs/<ts>-extension-<gameID>/trace.jsonl`, in the same format as `bun run play`. The background worker posts to loopback only; with the Trace URL empty, nothing is logged.

## Staying in sync with openfront.io

The extension bundles the OpenFront wire codec and simulation from `vendor/OpenFrontIO`, and the binary wire has no version negotiation: the bundle must match the server's commit exactly. openfront.io ships every few days. After each release:

```sh
bun run pin:openfront && bun run build:extension
```

Then reload the extension in `chrome://extensions` and reload any open OpenFront tab. `bun scripts/pin-openfront.ts --check` exits non-zero when the pin is stale.

At runtime the extension compares the page's `BOOTSTRAP_CONFIG.gitCommit` with the bundled commit (also in `BUILD.txt`). It stops, showing the fix command in the panel, on a mismatch, a server `version_mismatch` error, or repeated decode failures. It warns when a hosted page reports no commit.

## How it works

```text
OpenFront page (MAIN world)
  hook.ts         copy server WebSocket frames; send pre-encoded intent frames;
                  relay BOOTSTRAP_CONFIG (gitCommit, cdnBase, maps asset manifest)
       │ postMessage(ArrayBuffer)
       ▼
content.ts (ISOLATED world)
  decode wire → Mirror → Agent/Pipeline → encode intent
  map URLs resolved like the client: buildAssetUrl(manifest, cdnBase)
       │ chrome.runtime message (state + typed questions only)
       ▼
background.ts
  chrome.storage API key → TypeSafeClient.systemOne → typed answer
```

- The extension piggybacks on the page's own game WebSocket, so authentication (Turnstile, tokens) is the page's concern.
- The API key never enters the page's JavaScript world: only the popup and the background worker read it.
- Only the pages in `manifest.json`'s `matches` (loopback and openfront.io) get the scripts.
- Actions are revalidated by the harness immediately before encoding.
- Stop conditions are sticky until the game's socket closes.

The bundled OpenFront-derived code remains subject to the license copied into the build as `OPENFRONT-LICENSE`.

## Fair play

Automating public matches affects other players and may violate the hosted service's terms. Prefer private lobbies.
