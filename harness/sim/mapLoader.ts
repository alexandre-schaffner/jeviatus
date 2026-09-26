// Loads OpenFront maps from disk. Port of the vendor's
// tests/perf/fullgame/NodeGameMapLoader.ts, plus a directory override so tests
// can point at the small maps in tests/testdata/maps.

import fs from "node:fs";
import path from "node:path";
import { GameMapType } from "src/core/game/Game";
import type { GameMapLoader, MapData } from "src/core/game/GameMapLoader";
import type { MapManifest } from "src/core/game/TerrainMapLoader";

export const VENDOR_DIR = path.resolve(import.meta.dir, "../../vendor/OpenFrontIO");
export const MAPS_DIR = path.join(VENDOR_DIR, "resources/maps");
export const TEST_MAPS_DIR = path.join(VENDOR_DIR, "tests/testdata/maps");

export function mapKey(map: GameMapType): string {
  const key = Object.keys(GameMapType).find(
    (k) => GameMapType[k as keyof typeof GameMapType] === map,
  );
  if (key === undefined) throw new Error(`unknown map: ${map}`);
  return key.toLowerCase();
}

export class FsMapLoader implements GameMapLoader {
  // `fixedDir` serves one directory for every map type (test maps).
  constructor(
    private readonly mapsDir: string = MAPS_DIR,
    private readonly fixedDir?: string,
  ) {}

  getMapData(map: GameMapType): MapData {
    const dir = this.fixedDir ?? path.join(this.mapsDir, mapKey(map));
    const read = (name: string) => async () => new Uint8Array(fs.readFileSync(path.join(dir, name)));
    return {
      mapBin: read("map.bin"),
      map4xBin: read("map4x.bin"),
      map16xBin: read("map16x.bin"),
      manifest: async () =>
        JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as MapManifest,
      webpPath: path.join(dir, "thumbnail.webp"),
      layerPng: async () => {
        throw new Error("layer PNGs are not needed headless");
      },
    };
  }
}

// Case-insensitive lookup of a GameMapType by its key or display value.
export function parseMap(name: string): GameMapType {
  const n = name.toLowerCase().replace(/[\s_-]/g, "");
  for (const [k, v] of Object.entries(GameMapType)) {
    if (k.toLowerCase() === n || String(v).toLowerCase().replace(/[\s_-]/g, "") === n) {
      return v as GameMapType;
    }
  }
  throw new Error(`unknown map "${name}"`);
}
