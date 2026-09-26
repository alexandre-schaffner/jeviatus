// What Jev does well and badly, from every logged game.
//
//   bun run analyze [dir...] [--out <dir>]
//
// Reads every trace.jsonl under the given directories (default: runs/, CLI
// and extension games alike) and writes <out>/report.md, <out>/report.json
// and <out>/moments/*.md (default out: the first directory).

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadTraces } from "../harness/analyze/load";
import { buildReport, renderMoment, renderReport } from "../harness/analyze/report";
import { loadConfig } from "../harness/config";

const { values, positionals } = parseArgs({
  options: { out: { type: "string" } },
  allowPositionals: true,
  strict: true,
});
const dirs = positionals.length > 0 ? positionals : [loadConfig().runsDir];
const out = values.out ?? dirs[0];

const games = loadTraces(dirs);
if (games.length === 0) {
  console.error(`no trace.jsonl under ${dirs.join(", ")}`);
  process.exit(1);
}
const { report, moments } = buildReport(games);

const momentsDir = path.join(out, "moments");
fs.rmSync(momentsDir, { recursive: true, force: true });
fs.mkdirSync(momentsDir, { recursive: true });
for (const m of moments) fs.writeFileSync(path.join(momentsDir, m.file), renderMoment(m));
fs.writeFileSync(path.join(out, "report.md"), renderReport(report));
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));

const o = report.overall;
console.log(`${o.games} game(s): ${o.wins} won (${Math.round(o.winRate * 100)}%), mean placement ${o.meanPlacement ?? "–"}, median ${o.medianMinutes} min survived`);
for (const f of report.findings.filter((f) => f.kind === "bad" && f.count > 0).sort((a, b) => b.count - a.count)) {
  console.log(`  ${f.count}× ${f.title} (${f.games} game(s))`);
}
console.log(`wrote ${path.join(out, "report.md")}, report.json and ${moments.length} moment(s) in ${momentsDir}/`);
