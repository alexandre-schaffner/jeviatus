# Jev for OpenFront — browser extension

This Chromium Manifest V3 extension runs the repository's Jev agent inside OpenFront matches on **openfront.io** and on a **locally hosted** OpenFront dev server (`localhost` / `127.0.0.1`).

## Build and load

```sh
bun run build:extension
```

Then open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, choose **Load unpacked**, and select `dist/jev-openfront-extension`.

Open `https://openfront.io` (or `http://localhost:9000` from `bun run server`), join a multiplayer match, and start it. Use the extension popup to save your TypeSafe API key and enable Jev. The page also gets a small top-right On/Off control.

Enable the extension before the match begins. It can be toggled during play; Off is checked again immediately before each game intent is sent.

The extension piggybacks on the page's own game WebSocket, so all authentication (Turnstile, tokens) is handled by the normal page flow. Singleplayer games run entirely inside the page without a WebSocket, so the extension cannot attach to them.

## Compatibility

The extension bundles the OpenFront wire codec and simulation from `vendor/OpenFrontIO`, pinned to the exact commit the server runs: the binary wire format has no version negotiation. The hosted service's commit is published in the page's `window.BOOTSTRAP_CONFIG.gitCommit`; the extension compares it against the bundled commit (stamped into `dist/jev-openfront-extension/BUILD.txt`) and stops, with the fix command in the page panel, when they differ. It also stops if game frames fail to decode, and warns when a hosted page reports no commit at all.

openfront.io ships a new release every few days. After each one, re-pin the submodule to the live commit (read from the upstream repo's `prod-blue`/`prod-green` GitHub Deployments) and rebuild:

```sh
bun run pin:openfront && bun run build:extension
```

`bun scripts/pin-openfront.ts --check` exits non-zero when the pin is stale. Reload the unpacked extension in `chrome://extensions` afterwards, then reload any open OpenFront tab: a tab loaded before a release keeps the old build.

Map data is loaded the same way the page loads it: the main-world hook relays `BOOTSTRAP_CONFIG` (CDN base + hashed asset manifest) to the content script, which resolves `maps/...` paths exactly like the OpenFront client.

The bundled OpenFront-derived code remains subject to the license copied into the built extension as `OPENFRONT-LICENSE`.

## Fair play

Automating public matches affects other players and may violate the hosted service's terms. Prefer private lobbies.
