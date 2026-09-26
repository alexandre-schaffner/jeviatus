import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { build, type BuildOptions, type Plugin } from "esbuild";
import { harnessCommit } from "../harness/log/trace";
import { patchVendorSource } from "../harness/vendorPatches";

const root = path.resolve(import.meta.dir, "..");
const source = path.join(root, "extension");
// --out <dir>: build somewhere else (the improvement loop builds each
// candidate commit into the folder loaded in the browser).
const outArg = process.argv.indexOf("--out");
const output = outArg > 0 ? path.resolve(process.argv[outArg + 1]!) : path.join(root, "dist", "jev-openfront-extension");

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

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

const shared: BuildOptions = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  tsconfig: path.join(root, "tsconfig.json"),
  sourcemap: true,
  legalComments: "eof",
  logLevel: "info",
  plugins: [vendorPatches],
  define: { __JEV_OPENFRONT_COMMIT__: JSON.stringify(openfrontCommit), __JEV_HARNESS_COMMIT__: JSON.stringify(harness) },
};

for (const name of ["hook", "content", "background", "popup"] as const) {
  await build({
    ...shared,
    entryPoints: [path.join(source, "src", `${name}.ts`)],
    outfile: path.join(output, `${name}.js`),
  });
}

for (const file of ["manifest.json", "popup.html", "popup.css", "README.md"]) {
  cpSync(path.join(source, file), path.join(output, file));
}
// The decision overlay is shared with the harness (harness/overlay): same
// page, fed over postMessage instead of SSE.
cpSync(path.join(root, "harness", "overlay", "index.html"), path.join(output, "overlay.html"));
cpSync(path.join(root, "harness", "overlay", "overlay.js"), path.join(output, "overlay.js"));
cpSync(path.join(root, "vendor", "OpenFrontIO", "LICENSE"), path.join(output, "OPENFRONT-LICENSE"));

// The wire codec and simulation are commit-specific, so the manifest's host
// set is part of the build contract: loopback for the vendored dev server,
// openfront.io for the hosted service. Guard against either going missing.
// The worker's own hosts: the Jev API, and loopback for the trace sink.
const manifest = JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8")) as {
  content_scripts?: { matches?: string[] }[];
  host_permissions?: string[];
};
for (const required of ["https://api.typesafe.ai/*", "http://127.0.0.1/*", "http://localhost/*"]) {
  if (!manifest.host_permissions?.includes(required)) throw new Error(`extension manifest is missing host permission ${required}`);
}
const matches = manifest.content_scripts?.flatMap((script) => script.matches ?? []) ?? [];
for (const required of ["http://localhost/*", "http://127.0.0.1/*", "https://openfront.io/*", "https://*.openfront.io/*"]) {
  if (!matches.includes(required)) throw new Error(`extension manifest is missing expected match ${required}`);
}

writeFileSync(path.join(output, "BUILD.txt"), `OpenFront submodule: ${openfrontCommit}\nHarness: ${harness}\n`);
console.log(`Built unpacked extension at ${output}`);

async function gitHead(cwd: string): Promise<string> {
  const process = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await process.exited) !== 0) return "unknown";
  return (await new Response(process.stdout).text()).trim();
}
