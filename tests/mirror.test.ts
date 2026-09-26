// A content script outlives any one game: a reconnect, a rejoin that resends
// the start message, or the next match all build a new Mirror in the same
// module instance, on a map the previous one already played on. See
// harness/vendorPatches.ts.

import { expect, test } from "bun:test";
import path from "node:path";
import { patchVendorSource } from "../harness/vendorPatches";
import { offlineGame } from "./helpers";

const LOADER = path.resolve(import.meta.dir, "../vendor/OpenFrontIO/src/core/game/TerrainMapLoader.ts");

test("the map-cache patch still applies to the vendored loader", async () => {
  const source = await Bun.file(LOADER).text();
  const patched = patchVendorSource(LOADER, source);
  expect(patched).not.toBe(source);
  expect(patched).not.toContain("return cached;");
});

test("a second game on the same map starts from an unowned map", async () => {
  const first = await offlineGame({ nations: 6 });
  first.step(300); // nations spawn and expand: tiles get owners
  expect(first.mirror.game.players().some((p) => p.numTilesOwned() > 0)).toBe(true);

  const second = await offlineGame({ nations: 1 });
  expect(second.mirror.game.map()).not.toBe(first.mirror.game.map());
  let owned = 0;
  second.mirror.game.map().forEachTile((t) => {
    if (second.mirror.game.map().ownerID(t) !== 0) owned++;
  });
  expect(owned).toBe(0);
  expect(() => second.step(300)).not.toThrow();
}, 120_000);
