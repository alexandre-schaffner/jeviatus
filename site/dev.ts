// Dev server for the site: both pages at the paths the static build uses.
import editor from "./editor.html";
import index from "./index.html";
import { serveOnFreePort } from "./port.ts";

const server = serveOnFreePort({ development: true, routes: { "/": index, "/index.html": index, "/editor.html": editor } });
console.log(`Jeviatus site: ${server.url}`);
