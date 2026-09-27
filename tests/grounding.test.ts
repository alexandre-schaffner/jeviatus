import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCitations, normalizeUrl, parseCitations, referenceTexts } from "../harness/improve/grounding";
import { htmlToText, parseFeed, wikitextToText } from "../harness/improve/references";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "grounding-"));
const src = path.join(root, "vendor/OpenFrontIO/src/core");
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(src, "Attack.ts"), ["// line 1", "export function losses() {", "  // defenders on a defense post lose half as many troops", "  return 0.5;", "}"].join("\n"));
const refs = path.join(root, ".loop/references");
fs.mkdirSync(path.join(refs, "wiki/miraheze"), { recursive: true });
fs.writeFileSync(path.join(refs, "wiki/miraheze/Attacking_Guide.md"), "URL: https://openfront.miraheze.org/wiki/Attacking_Guide\nTitle: Attacking Guide\n\nTroops regenerate fastest when your population is around 40% of the maximum.\n");
fs.mkdirSync(path.join(refs, "reddit"), { recursive: true });
fs.writeFileSync(path.join(refs, "reddit/abc123.md"), "URL: https://www.reddit.com/r/OpenFrontIO/comments/abc123/boats/\nTitle: Boats\n\nNever send boats at someone who borders you, just walk in.\n");

const check = (text: string) => checkCitations(parseCitations(text), { root, references: referenceTexts(refs) });

describe("grounding", () => {
  test("verbatim quotes from the code, a wiki page and a post check out", () => {
    const r = check(`## Grounding
- source: vendor/OpenFrontIO/src/core/Attack.ts:L3-L3 "defenders on a defense post lose half as many troops"
- wiki: https://openfront.miraheze.org/wiki/Attacking_Guide "Troops regenerate fastest when your population is around 40%"
- reddit: https://old.reddit.com/r/OpenFrontIO/comments/abc123/boats "never send boats at someone who borders you"`);
    expect(r.bad).toEqual([]);
    expect(r.ok.map((c) => c.kind)).toEqual(["source", "wiki", "reddit"]);
    expect(r.grounded).toBe(true);
  });

  test("a made-up quote, a wrong line range, an unsaved URL or harness code don't", () => {
    const r = check(`- source: vendor/OpenFrontIO/src/core/Attack.ts:L1-L1 "defenders on a defense post lose half as many troops"
- wiki: https://openfront.miraheze.org/wiki/Attacking_Guide "cities double your troop regeneration rate instantly"
- reddit: https://www.reddit.com/r/OpenFrontIO/comments/zzz999/other "never send boats at someone who borders you"
- source: harness/decide/pipeline.ts:L1-L2 "export function applyBudget(action: Action"`);
    // The first is within the slack of lines 1-1 (the quote is on line 3): it passes.
    expect(r.ok.length).toBe(1);
    expect(r.bad.map((b) => b.why)).toEqual([
      "quote not found in https://openfront.miraheze.org/wiki/Attacking_Guide",
      expect.stringContaining("isn't one of the saved references"),
      "source citations must point into OpenFront's code (vendor/OpenFrontIO/)",
    ]);
    expect(r.grounded).toBe(false);
  });

  test("no citations: not grounded", () => {
    expect(check("## Change\nsomething").grounded).toBe(false);
  });

  test("URLs match across www/old, trailing slashes and case", () => {
    expect(normalizeUrl("https://old.reddit.com/r/OpenFrontIO/comments/abc/x/")).toBe(normalizeUrl("https://www.reddit.com/r/openfrontio/comments/abc/x"));
  });
});

describe("references", () => {
  test("wiki markup to text", () => {
    expect(wikitextToText("'''Cities''' raise {{Stat|x}} max troops, see [[Troops|troop growth]] and [[Gold]].<ref>v23</ref>")).toBe("Cities raise  max troops, see troop growth and Gold.");
  });

  test("Reddit RSS entries", () => {
    const xml = `<feed><entry><author><name>/u/pro</name></author><title>Boat tips</title><link href="https://www.reddit.com/r/OpenFrontIO/comments/abc123/boat_tips/" /><content type="html">&lt;p&gt;Use boats &amp;amp; win&lt;/p&gt;</content></entry></feed>`;
    expect(parseFeed(xml)).toEqual([{ title: "Boat tips", link: "https://www.reddit.com/r/OpenFrontIO/comments/abc123/boat_tips/", author: "/u/pro", content: "Use boats & win" }]);
    expect(htmlToText("a&lt;br&gt;b")).toBe("a\nb");
  });
});
