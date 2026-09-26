// Bun preload (see bunfig.toml): transpile vendored OpenFront sources with
// esbuild instead of Bun's built-in transpiler.
//
// OpenFront compiles with `useDefineForClassFields: false`, and its sim relies
// on it: field initializers read constructor parameter properties
// (e.g. NationNukeBehavior's `atomBombPerceivedCost = this.cost(...)`). Bun
// ignores that tsconfig flag and always uses define semantics, which throws
// mid-game and, worse, could silently change sim behavior and desync us from
// the server. esbuild honors the flag, so vendor files go through it.
//
// It also applies the shared source fix-ups in harness/vendorPatches.ts.

import { plugin } from "bun";
import { transformSync } from "esbuild";
import { patchVendorSource } from "./vendorPatches";

const VENDOR_TS = /[\\/]vendor[\\/]OpenFrontIO[\\/](src|zbin|tests)[\\/].*\.ts$/;

plugin({
  name: "openfront-legacy-class-fields",
  setup(build) {
    build.onLoad({ filter: VENDOR_TS }, async (args) => {
      const source = patchVendorSource(args.path, await Bun.file(args.path).text());
      const out = transformSync(source, {
        loader: "ts",
        format: "esm",
        target: "es2022",
        sourcefile: args.path,
        sourcemap: "inline",
        tsconfigRaw: {
          compilerOptions: {
            useDefineForClassFields: false,
            experimentalDecorators: true,
          },
        },
      });
      return { contents: out.code, loader: "js" };
    });
  },
});
