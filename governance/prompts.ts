// Parse harness/decide/questions.ts into its prompts, keeping the source
// position of every plain string a proposal may rewrite: the question and
// each `consider` hint. The site quotes these, the editor previews edits on
// them, and scripts/snapshot-to-pr.ts applies voted edits through them.
// Parsing (not importing) keeps this independent of the OpenFront submodule.

import ts from "typescript";
import { QUESTIONS_FILE } from "./patch";

export { QUESTIONS_FILE };

export interface Span {
  start: number;
  end: number;
}

export interface Hint {
  text: string;
  span?: Span; // set when the hint is a plain string literal, so it can be rewritten
}

export interface PromptNode {
  id: string; // question ID; per-player IDs carry a placeholder, e.g. "retreat.<attack>"
  kind: "choice" | "score" | "noul";
  line: number;
  question: string;
  questionSpan?: Span;
  premise?: string;
  context?: string;
  rules?: string;
  hints: Hint[];
  // Set when `consider` is an array literal: new hints go after `open`.
  hintList?: { open: number; indent: string };
  levels?: string[]; // score answer levels
  options?: Record<string, string>; // fixed choice options
}

export interface PromptFile {
  role: string;
  prompts: Record<string, PromptNode>;
}

export function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

export function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

export function sourceFile(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

// Template substitutions become readable placeholders: `${o.ref}` -> <player>.
function placeholder(expr: ts.Expression): string {
  const t = expr.getText();
  if (/ref/i.test(t)) return "<player>";
  if (/name/i.test(t)) return "<name>";
  if (/\bid\(\)/.test(t)) return "<attack>";
  if (/bomb/.test(t)) return "<bomb>";
  if (/key/.test(t)) return "<structure>";
  if (/PURPOSE/.test(t)) return "<what it does>";
  return "<…>";
}

// A string-valued expression: literals, templates, `+` chains, a known const.
export function textOf(expr: ts.Expression | undefined, consts: Record<string, string> = {}): string | undefined {
  if (expr === undefined) return undefined;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  if (ts.isTemplateExpression(expr)) {
    return expr.head.text + expr.templateSpans.map((s) => placeholder(s.expression) + s.literal.text).join("");
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = textOf(expr.left, consts);
    const r = textOf(expr.right, consts);
    return l !== undefined && r !== undefined ? l + r : undefined;
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return textOf(expr.expression, consts);
  // `recheck ? "late question" : "first question"`: the first-time wording.
  if (ts.isConditionalExpression(expr)) return textOf(expr.whenFalse, consts);
  if (ts.isIdentifier(expr)) return consts[expr.text];
  return undefined;
}

// Only a plain literal can be swapped for another literal without touching code.
function literalSpan(expr: ts.Expression): Span | undefined {
  return ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) ? { start: expr.getStart(), end: expr.getEnd() } : undefined;
}

function hintsOf(src: ts.SourceFile, value: ts.Expression | undefined): Pick<PromptNode, "hints" | "hintList"> {
  if (value === undefined) return { hints: [] };
  const expr = unwrap(value);
  const one = textOf(expr);
  if (one !== undefined && !ts.isArrayLiteralExpression(expr)) return { hints: [{ text: one, span: literalSpan(expr) }] };
  if (!ts.isArrayLiteralExpression(expr)) return { hints: [] };
  const hints: Hint[] = [];
  for (const e of expr.elements) {
    if (ts.isSpreadElement(e)) {
      // `...(recheck ? [..] : [])`: the first-time branch, matching the question text.
      const inner = unwrap(e.expression);
      const branch = ts.isConditionalExpression(inner) ? unwrap(inner.whenFalse) : inner;
      if (ts.isArrayLiteralExpression(branch)) for (const b of branch.elements) {
        const s = textOf(b as ts.Expression);
        if (s !== undefined) hints.push({ text: s });
      }
      continue;
    }
    const s = textOf(e);
    if (s !== undefined) hints.push({ text: s, span: literalSpan(e) });
  }
  const first = expr.elements[0];
  const lineStart = (pos: number) => src.text.lastIndexOf("\n", pos - 1) + 1;
  const indent = first
    ? src.text.slice(lineStart(first.getStart()), first.getStart())
    : src.text.slice(lineStart(expr.getStart()), expr.getStart()).match(/^\s*/)![0] + "  ";
  return { hints, hintList: { open: expr.getStart() + 1, indent: /^\s*$/.test(indent) ? indent : "  " } };
}

function props(obj: ts.ObjectLiteralExpression): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) out.set(p.name.text, p.initializer);
  }
  return out;
}

export function stringRecord(obj: ts.ObjectLiteralExpression): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of props(obj)) {
    const s = textOf(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

// Where a question builder's result is stored: `route: choice(..)`,
// `q.expand_commit = score(..)`, `q[\`retreat.${..}\`] = noul(..)`, `site: choice(..)`.
function idOf(call: ts.CallExpression): string | undefined {
  const parent = call.parent;
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = parent.left;
    if (ts.isPropertyAccessExpression(left)) return left.name.text;
    if (ts.isElementAccessExpression(left)) {
      const arg = left.argumentExpression;
      if (ts.isTemplateExpression(arg)) return arg.head.text + placeholder(arg.templateSpans[0].expression);
      return textOf(arg);
    }
  }
  return undefined;
}

// Enclosing function, so the four `site` questions stay apart.
function scopeOf(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node; n; n = n.parent) if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
  return undefined;
}

const SITE_IDS: Record<string, string> = {
  spawnQuestion: "spawn_site",
  buildSiteQuestion: "build_site",
  nukeSiteQuestion: "nuke_site",
  boatSiteQuestion: "boat_site",
};

export function parsePromptFile(text: string, name = QUESTIONS_FILE): PromptFile {
  const src = sourceFile(name, text);
  const consts: Record<string, string> = {};
  walk(src, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const s = textOf(n.initializer);
      if (s !== undefined) consts[n.name.text] = s;
    }
  });
  const prompts: Record<string, PromptNode> = {};
  walk(src, (n) => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
    const kind = n.expression.text;
    if (kind !== "choice" && kind !== "score" && kind !== "noul") return;
    let id = idOf(n);
    const scope = scopeOf(n);
    if (id === "site" && scope && SITE_IDS[scope]) id = SITE_IDS[scope];
    // attackCommit(): `return score(..)` inside a helper, named after the question it feeds.
    if (id === undefined && scope === "attackCommit") id = "attack_commit";
    if (id === undefined) return;
    const [first, second] = n.arguments.map(unwrap);
    const p: PromptNode = { id, kind, line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1, question: "", hints: [] };
    const direct = textOf(first, consts);
    if (direct !== undefined) {
      p.question = direct;
      p.questionSpan = literalSpan(first);
    } else if (first && ts.isObjectLiteralExpression(first)) {
      const f = props(first);
      const q = f.get("question");
      p.question = textOf(q, consts) ?? "";
      p.questionSpan = q ? literalSpan(unwrap(q)) : undefined;
      p.premise = textOf(f.get("premise"), consts);
      p.context = textOf(f.get("context"), consts);
      p.rules = textOf(f.get("rules"), consts);
      Object.assign(p, hintsOf(src, f.get("consider")));
    }
    if (second && ts.isArrayLiteralExpression(second)) p.levels = second.elements.map((e) => textOf(e)).filter((s): s is string => s !== undefined);
    if (second && ts.isObjectLiteralExpression(second)) {
      const opts = stringRecord(second);
      if (Object.keys(opts).length > 0) p.options = opts;
    }
    prompts[id] = p;
  });
  return { role: consts.WHO ?? "", prompts };
}
