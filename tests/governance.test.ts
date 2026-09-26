import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { applyPatch, extractPatch, type Patch, proposalBody, validatePatch } from "../governance/patch";
import { parsePromptFile, QUESTIONS_FILE } from "../governance/prompts";

const TEXT = readFileSync(QUESTIONS_FILE, "utf8");
const FILE = parsePromptFile(TEXT);
const patch = (edits: Patch["edits"]): Patch => ({ v: 1, file: QUESTIONS_FILE, base: "test", edits });

function applied(edits: Patch["edits"]) {
  const r = applyPatch(TEXT, FILE, patch(edits));
  expect(r.problems).toEqual([]);
  return { text: r.text, file: parsePromptFile(r.text) };
}

describe("parsePromptFile", () => {
  test("finds every question with its hints", () => {
    expect(Object.keys(FILE.prompts)).toContain("route");
    expect(Object.keys(FILE.prompts)).toContain("retreat.<attack>");
    expect(FILE.prompts.route.hints.length).toBeGreaterThan(5);
    expect(FILE.prompts.route.hints.every((h) => h.span)).toBe(true);
    expect(FILE.role).toContain("OpenFront");
  });

  test("spans point at the literal source text", () => {
    const h = FILE.prompts.attack_target.hints[0];
    expect(JSON.parse(TEXT.slice(h.span!.start, h.span!.end))).toBe(h.text);
  });

  test("questions with live values are not rewritable", () => {
    expect(FILE.prompts["retreat.<attack>"].questionSpan).toBeUndefined();
    expect(FILE.prompts.route.questionSpan).toBeDefined();
  });
});

describe("applyPatch", () => {
  const route = FILE.prompts.route;

  test("rewrites a hint and the question", () => {
    const { file } = applied([
      { op: "hint", prompt: "route", index: 2, from: route.hints[2].text, to: "a new hint" },
      { op: "question", prompt: "route", from: route.question, to: "What now?" },
    ]);
    expect(file.prompts.route.hints[2].text).toBe("a new hint");
    expect(file.prompts.route.question).toBe("What now?");
    expect(file.prompts.route.hints.length).toBe(route.hints.length);
  });

  test("adds hints at the top, in the middle and after the last", () => {
    const last = route.hints.length - 1;
    const { file } = applied([
      { op: "add-hint", prompt: "route", after: -1, anchor: null, to: "first" },
      { op: "add-hint", prompt: "route", after: 3, anchor: route.hints[3].text, to: "middle one" },
      { op: "add-hint", prompt: "route", after: 3, anchor: route.hints[3].text, to: "middle two" },
      { op: "add-hint", prompt: "route", after: last, anchor: route.hints[last].text, to: "last" },
    ]);
    const texts = file.prompts.route.hints.map((h) => h.text);
    expect(texts[0]).toBe("first");
    expect(texts.slice(5, 7)).toEqual(["middle one", "middle two"]);
    expect(texts.at(-1)).toBe("last");
    expect(texts.length).toBe(route.hints.length + 4);
  });

  test("removes a hint with its line", () => {
    const { text, file } = applied([{ op: "remove-hint", prompt: "route", index: 1, from: route.hints[1].text }]);
    expect(file.prompts.route.hints.map((h) => h.text)).toEqual(route.hints.filter((_, i) => i !== 1).map((h) => h.text));
    expect(text.split("\n").length).toBe(TEXT.split("\n").length - 1);
  });

  test("hostile text stays a string literal", () => {
    const evil = `"); process.exit(1); ("\` \${x} \\ end`;
    const { file } = applied([{ op: "hint", prompt: "route", index: 0, from: route.hints[0].text, to: evil }]);
    expect(file.prompts.route.hints[0].text).toBe(evil);
    expect(Object.keys(file.prompts)).toEqual(Object.keys(FILE.prompts));
  });

  test("refuses stale, doubled or impossible edits", () => {
    const stale = applyPatch(TEXT, FILE, patch([{ op: "hint", prompt: "route", index: 0, from: "not the text", to: "x y z" }]));
    expect(stale.problems[0]).toContain("changed since");
    expect(stale.text).toBe(TEXT);
    const twice = applyPatch(TEXT, FILE, patch([
      { op: "hint", prompt: "route", index: 0, from: route.hints[0].text, to: "one two" },
      { op: "remove-hint", prompt: "route", index: 0, from: route.hints[0].text },
    ]));
    expect(twice.problems[0]).toContain("twice");
    const code = FILE.prompts["retreat.<attack>"];
    const templ = applyPatch(TEXT, FILE, patch([{ op: "question", prompt: "retreat.<attack>", from: code.question, to: "Pull back?" }]));
    expect(templ.problems[0]).toContain("built in code");
    const unknown = applyPatch(TEXT, FILE, patch([{ op: "hint", prompt: "nope", index: 0, from: "a", to: "b c d" }]));
    expect(unknown.problems[0]).toContain("no such question");
  });
});

describe("proposal body", () => {
  test("round-trips the patch block", () => {
    const p = patch([{ op: "hint", prompt: "route", index: 0, from: FILE.prompts.route.hints[0].text, to: "better hint" }]);
    const body = proposalBody({ why: "Because.", file: FILE, patch: p, discussion: "https://forum.example/t/1" });
    expect(body).toContain("Changed hint 1");
    expect(extractPatch(body).patch).toEqual(p);
  });

  test("validation rejects multi-line and oversized text", () => {
    expect(validatePatch(patch([{ op: "hint", prompt: "route", index: 0, from: "a", to: "two\nlines" }])).problems.length).toBe(1);
    expect(validatePatch(patch([{ op: "hint", prompt: "route", index: 0, from: "a", to: "x".repeat(600) }])).problems.length).toBe(1);
    expect(validatePatch({ v: 2 }).problems.length).toBeGreaterThan(0);
    const elsewhere = { ...patch([{ op: "hint", prompt: "route", index: 0, from: "a", to: "b c d" }]), file: ".github/workflows/x.yml" };
    expect(validatePatch(elsewhere).problems[0]).toContain("may only change");
  });
});
