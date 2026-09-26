// Build-time facts from the harness source, imported by the pages as Bun
// macros: the bundle carries the text of harness/decide/questions.ts as it
// stands on the commit being built, so a merged prompt PR changes the site
// with no copy-paste step.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import config from "../governance/config.json";
import { DEFAULTS } from "../harness/config";
import { GOALS } from "../harness/strategy/memory";
import { QUESTIONS_FILE } from "../governance/patch";
import { parsePromptFile, type PromptFile, sourceFile, stringRecord, unwrap, walk } from "../governance/prompts";

const ROOT = join(import.meta.dir, "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const parse = (file: string) => sourceFile(file, read(file));

export interface Prompt {
  id: string;
  kind: "choice" | "score" | "noul";
  question: string;
  premise?: string;
  context?: string;
  rules?: string;
  consider: string[];
  levels?: string[];
  options?: Record<string, string>;
  line: number;
}

export interface Source {
  repo: string;
  file: string;
  role: string;
  prompts: Record<string, Prompt>;
  routes: Record<string, string>;
  goals: Record<string, string>;
  constants: Record<string, number>;
  model: string;
  commit: Record<string, number[]>; // Score level -> troop fraction
  sha: string;
}

// `export const NAME = { ... } as const` in a file.
function constObject(file: string, name: string): Record<string, string> {
  let out: Record<string, string> = {};
  walk(parse(file), (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      const init = unwrap(n.initializer);
      if (ts.isObjectLiteralExpression(init)) out = stringRecord(init);
    }
  });
  return out;
}

function constNumbers(file: string, names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  walk(parse(file), (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && names.includes(n.name.text) && n.initializer && ts.isNumericLiteral(n.initializer)) {
      out[n.name.text] = Number(n.initializer.text);
    }
  });
  return out;
}

// `export const NAME = [0.1, 0.25] as const`.
function constArrays(file: string, names: string[]): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  walk(parse(file), (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || !names.includes(n.name.text) || !n.initializer) return;
    const init = unwrap(n.initializer);
    if (ts.isArrayLiteralExpression(init)) out[n.name.text] = init.elements.filter(ts.isNumericLiteral).map((e) => Number(e.text));
  });
  return out;
}

const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: ROOT }).stdout.toString().trim();

export function source(): Source {
  const file = parsePromptFile(read(QUESTIONS_FILE));
  const prompts: Record<string, Prompt> = {};
  for (const [id, p] of Object.entries(file.prompts)) {
    prompts[id] = {
      id,
      kind: p.kind,
      question: p.question,
      premise: p.premise,
      context: p.context,
      rules: p.rules,
      consider: p.hints.map((h) => h.text),
      levels: p.levels,
      options: p.options,
      line: p.line,
    };
  }
  const { model, ...defaults } = DEFAULTS;
  return {
    repo: `https://github.com/${config.repo}`,
    file: QUESTIONS_FILE,
    role: file.role,
    prompts,
    routes: constObject("harness/decide/candidates.ts", "ROUTES"),
    goals: GOALS,
    constants: {
      ...constNumbers("harness/decide/pipeline.ts", ["FALLBACK_MIN_P", "FINISH_CAP", "FINISH_CAP_UNDER_ATTACK"]),
      ...defaults,
    },
    model,
    commit: constArrays(QUESTIONS_FILE, ["ATTACK_COMMIT"]),
    sha: git("rev-parse", "--short", "HEAD"),
  };
}

// The editor's copy: the raw file and where each editable string sits in it,
// so edits preview as the exact diff the pull request will carry.
export function promptFile(): { text: string; file: PromptFile; sha: string } {
  const text = read(QUESTIONS_FILE);
  return { text, file: parsePromptFile(text), sha: git("rev-parse", "HEAD") };
}
