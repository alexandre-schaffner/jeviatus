// Serve the production build in dist/site. Opening its HTML straight from
// disk doesn't work: browsers block module scripts on file:// URLs.
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { serveOnFreePort } from "./port.ts";

const root = join(import.meta.dir, "..", "dist", "site");
if (!existsSync(join(root, "index.html"))) {
  console.error("No build yet: run `bun run build:site` first.");
  process.exit(1);
}

const server = serveOnFreePort({
  fetch(req) {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = Bun.file(join(root, path === "/" ? "index.html" : path));
    return file.exists().then((ok) => (ok ? new Response(file) : new Response("Not found", { status: 404 })));
  },
});
console.log(`Jeviatus build: ${server.url}`);
