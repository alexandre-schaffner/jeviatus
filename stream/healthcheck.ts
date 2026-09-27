// The container's HEALTHCHECK (stream/Dockerfile): healthy while the browser
// answers on its DevTools port and the broadcast encoder is running. The
// stream restarts its own crashed processes; this is what `docker ps` and
// `deploy/deploy.sh <host> status` show when that isn't enough.

import { readdirSync, readFileSync } from "node:fs";

const port = Number(process.env.CDP_PORT ?? 9222);
const browser = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(
  (r) => r.ok,
  () => false,
);

// The music decoder is an ffmpeg too; only the encoder runs libx264.
const encoder = readdirSync("/proc")
  .filter((pid) => /^\d+$/.test(pid))
  .some((pid) => {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      return argv[0]?.endsWith("ffmpeg") === true && argv.includes("libx264");
    } catch {
      return false;
    }
  });

if (!browser) console.log(`no browser on 127.0.0.1:${port}`);
if (!encoder) console.log("no encoder running");
process.exit(browser && encoder ? 0 : 1);
