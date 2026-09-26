// Live game on the local dev server with FakeJev agents — no TypeSafe key
// needed. The agents play for real (spawn, expand, build), which drives
// genuine multi-client intent traffic. A human (or the extension) joins via
// the printed URL; the lobby waits for one human before starting.
//
//   bun scripts/fake-live.ts
import { Difficulty, GameMapType } from "src/core/game/Game";
import { loadConfig } from "../harness/config";
import { runLive } from "../harness/session";
import { FakeJev } from "../tests/helpers";

const config = loadConfig();
config.typesafeApiKey = undefined;

const result = await runLive({
  config,
  jevFor: () => new FakeJev(),
  agents: Number(process.env.AGENTS ?? 6),
  maxMinutes: Number(process.env.MINUTES ?? 10),
  log: (l) => console.log(l),
  game: { map: GameMapType.World, nations: 8, difficulty: Difficulty.Easy, tribes: 0 },
  watch: {
    spectators: 0,
    humans: 1,
    timeoutMs: 10 * 60 * 1000,
    onLobby: (spectateUrl) => {
      console.log(`\n=== JOIN URL: ${spectateUrl.replace("?spectate", "")} ===\n`);
    },
  },
});
console.log("done", JSON.stringify(result.summaries));
process.exit(0);
