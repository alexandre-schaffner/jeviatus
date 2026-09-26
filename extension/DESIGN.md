# Jev extension design

## Usage first

1. Load `dist/jev-openfront-extension` as an unpacked Chromium extension.
2. Put the TypeSafe API key in the popup and enable Jev.
3. Open a multiplayer game at `https://openfront.io` (or a private game at `http://localhost:9000` from the vendored dev server), join it, and start it.
4. The in-page control reports each decision. Switching it off prevents every subsequent intent, including an intent whose Jev request began before the switch.

The extension attaches to the page's own game WebSocket, so hosted-service authentication is entirely the page's concern. Singleplayer matches have no socket and cannot be attached.

## Module map

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

`settings.ts` is the shared, validated boundary for popup, content script, and background worker. `scripts/build-extension.ts` is the deterministic build lever; it stamps the bundled OpenFront commit into the build (`__JEV_OPENFRONT_COMMIT__`, `BUILD.txt`).

## Key invariants

- The API key never enters the page's JavaScript world.
- Only loopback and openfront.io pages are eligible (`isAllowedHost`).
- The extension observes the same binary turns as the game and runs the same deterministic simulation code from the pinned OpenFront submodule.
- Actions are revalidated by the existing harness immediately before encoding.
- `AgentOptions.canAct` is checked immediately before each send, making Off a hard gate across async decisions.
- The extension must be built from the same OpenFront commit as the server it attaches to because the binary wire has no version negotiation. A commit mismatch, a server `version_mismatch` error, or repeated decode failures block Jev for that game (sticky until the socket closes); a hosted page with no commit is flagged rather than silently passed (`compat.ts`). `bun run pin:openfront` re-pins to live prod.
- The in-page overlay iframe is sized to its content and sits below OpenFront's top-right HUD, so it never swallows clicks meant for the game.

## Phase checklist

- [x] Ground: trace OpenFront transport, wire codec, mirror, and Jev pipeline
- [x] Sketch: define page/isolated/background boundaries and hard-stop invariant
- [x] Agree: proceed without a checkpoint, as requested
- [x] Implement: extension source, build, settings, and local-only guard
- [x] Verify: build, typecheck, unit tests, and built-manifest inspection
- [x] Hosted service: pin submodule to the deployed commit, allow openfront.io, resolve map assets via BOOTSTRAP_CONFIG
