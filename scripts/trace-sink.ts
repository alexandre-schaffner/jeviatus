// Logs games played with the browser extension from your own browser.
//
//   bun run trace-sink [--dir runs] [--port 9231] [--token <t>]
//
// Paste the printed URL and token into the extension popup (Trace URL, Trace
// token); every game then lands in <dir>/<ts>-extension-<gameID>/trace.jsonl,
// ready for `bun run analyze`.

import { parseArgs } from "node:util";
import { loadConfig } from "../harness/config";
import { startTraceSink } from "../harness/log/sink";

const { values } = parseArgs({
  options: {
    dir: { type: "string", default: loadConfig().runsDir },
    port: { type: "string", default: process.env.TRACE_PORT ?? "9231" },
    token: { type: "string", default: process.env.TRACE_TOKEN ?? crypto.randomUUID() },
  },
  strict: true,
});

const sink = startTraceSink({ dir: values.dir!, port: Number(values.port), token: values.token! });
console.log(`trace sink writing to ${values.dir}/`);
console.log(`  Trace URL:   ${sink.url}`);
console.log(`  Trace token: ${sink.token}`);
console.log(`or, from the extension's service worker console:`);
console.log(`  chrome.storage.local.set(${JSON.stringify({ traceUrl: sink.url, traceToken: sink.token })})`);

process.on("SIGINT", async () => {
  await sink.stop();
  process.exit(0);
});
