// Validates a strategy pull request the way the stream's ballot will
// (stream/ballot.ts): exactly one changed file, strategies/<name>.json, that
// parses as a strategy. CI runs it on every PR touching strategies/.
//
//   bun scripts/check-strategy.ts <base-ref>     # e.g. origin/main

import { isStrategyFile, parseStrategy, STRATEGY_FILE } from "../harness/strategy/doctrine";

const base = process.argv[2] ?? "origin/main";
const diff = Bun.spawnSync(["git", "diff", "--name-status", `${base}...HEAD`]);
if (diff.exitCode !== 0) {
  console.error(diff.stderr.toString());
  process.exit(2);
}
const changes = diff.stdout
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [status, ...paths] = line.split("\t");
    return { status: status!, file: paths.at(-1)! };
  });

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`);
  console.error("See strategies/README.md for how to propose a strategy.");
  process.exit(1);
};

// Docs and the example template are repo changes, not strategies.
if (!changes.some((c) => isStrategyFile(c.file))) {
  console.log("Not a strategy PR; nothing to check.");
  process.exit(0);
}
if (changes.length !== 1) fail(`a strategy PR changes exactly one file; this one changes ${changes.length}: ${changes.map((c) => c.file).join(", ")}`);
const [{ status, file }] = changes as [{ status: string; file: string }];
if (!STRATEGY_FILE.test(file)) fail(`${file} should be strategies/<lowercase-name>.json`);
if (status !== "A" && status !== "M") fail(`${file} must be added or edited (status ${status})`);

let json: unknown;
try {
  json = await Bun.file(file).json();
} catch {
  fail(`${file} is not valid JSON`);
}
const parsed = parseStrategy(json);
if (!parsed.ok) fail(`${file}: ${parsed.error}`);
else console.log(`✓ ${file}: "${parsed.strategy.name}" is a valid strategy. It's in the stream's review queue: 👍 votes and bribes promote it, and once it's merged Jev plays it.`);
