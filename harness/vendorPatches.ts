// Source fix-ups applied to vendored OpenFront files, by both loaders of that
// code: the Bun preload (harness, tests) and the esbuild extension build.
//
// TerrainMapLoader caches loaded maps per module instance (`loadedMaps`), and
// the game mutates its map (tile ownership lives in it). One browser worker
// runs one game so upstream never notices, but the harness runs several games
// per process (--agents N, tests), and the extension's content script outlives
// every game in its tab (reconnects, rejoins, the next match). A cache hit
// hands the new game the previous game's owned tiles, whose owners don't exist
// yet: the first capture crashes with "reading '_borderTiles'" on tick 1.
// Dropping the cache hit loads a fresh map per game.

const SHARED_MAP_CACHE_HIT = "if (cached !== undefined) return cached;";

export function patchVendorSource(path: string, source: string): string {
  if (!/[\\/]TerrainMapLoader\.ts$/.test(path)) return source;
  if (source.includes(SHARED_MAP_CACHE_HIT)) return source.replace(SHARED_MAP_CACHE_HIT, "");
  // The cache is still there but its hit line changed shape: fail loudly
  // rather than ship a bundle that crashes on the second game.
  if (source.includes("loadedMaps.get(")) {
    throw new Error(`${path}: TerrainMapLoader's map cache changed shape; update harness/vendorPatches.ts`);
  }
  return source;
}
