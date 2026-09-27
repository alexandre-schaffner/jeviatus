import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { harnessCommit } from "../harness/log/trace";
import { patchVendorSource } from "../harness/vendorPatches";

const root = path.resolve(import.meta.dir, "..");
const source = path.join(root, "extension");
// --out <dir>: build somewhere else (the improvement loop builds each
// candidate commit into the folder loaded in the browser).
const outArg = process.argv.indexOf("--out");
const output = outArg > 0 ? path.resolve(process.argv[outArg + 1]!) : path.join(root, "dist", "jev-openfront-extension");

// Build next to the output and swap it in at the end: the stream's browser
// loads the output folder, and a failed build mustn't leave it empty.
const staging = `${output}.building`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const openfrontCommit = await gitHead(path.join(root, "vendor", "OpenFrontIO"));
const harness = await harnessCommit();

// The same vendored-source fix-ups the Bun preload applies to the harness.
const vendorPatches: Plugin = {
  name: "openfront-vendor-patches",
  setup(b) {
    b.onLoad({ filter: /[\\/]vendor[\\/]OpenFrontIO[\\/].*TerrainMapLoader\.ts$/ }, async (args) => ({
      contents: patchVendorSource(args.path, await readFile(args.path, "utf8")),
      loader: "ts",
    }));
  },
};

// esbuild, not Bun.build: vendored OpenFront needs `useDefineForClassFields:
// false` (see harness/preload.ts), which only esbuild honors. The root
// tsconfig also supplies the `src/*` alias into the submodule.
await build({
  entryPoints: ["hook", "content", "background", "popup"].map((name) => path.join(source, "src", `${name}.ts`)),
  outdir: staging,
  bundle: true,
  format: "iife",
  target: ["chrome120"],
  tsconfig: path.join(root, "tsconfig.json"),
  sourcemap: true,
  logLevel: "info",
  plugins: [vendorPatches],
  define: { __JEV_OPENFRONT_COMMIT__: JSON.stringify(openfrontCommit), __JEV_HARNESS_COMMIT__: JSON.stringify(harness) },
});

for (const file of ["manifest.json", "popup.html", "popup.css", "README.md"]) {
  cpSync(path.join(source, file), path.join(staging, file));
}
// The decision overlay is shared with the harness (harness/overlay): same
// page, fed over postMessage instead of SSE.
cpSync(path.join(root, "harness", "overlay", "index.html"), path.join(staging, "overlay.html"));
cpSync(path.join(root, "harness", "overlay", "overlay.js"), path.join(staging, "overlay.js"));
cpSync(path.join(root, "vendor", "OpenFrontIO", "LICENSE"), path.join(staging, "OPENFRONT-LICENSE"));

writeFileSync(path.join(staging, "BUILD.txt"), `OpenFront submodule: ${openfrontCommit}\nHarness: ${harness}\n`);
rmSync(output, { recursive: true, force: true });
renameSync(staging, output);
console.log(`Built unpacked extension at ${output}`);

async function gitHead(cwd: string): Promise<string> {
  const process = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await process.exited) !== 0) return "unknown";
  return (await new Response(process.stdout).text()).trim();
}
