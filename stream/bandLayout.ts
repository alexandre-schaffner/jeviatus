// Where everything on the band goes: sizes, fonts, colors and positions, in
// output pixels. The encoder (stream/encoder.ts) draws this with ffmpeg; the
// band's writer (stream/band.ts) cuts each text to the width its slot has,
// since drawtext never wraps or clips.
//
//  ┌────────┬───────────────────────────────────────────┬──────────────────────┐
//  │  JEV   │ What's happening now (big)                │ GAME #13 · LIVE 14:32│
//  │ ▌LIVE▐ │ STRATEGY  "Turtle up"  PR #14 · 9 votes   │ #4 of 23 · 6.2% land │
//  │  24/7  │ VOTE      github.com/…/pulls · thumbs-up  │ RECORD 1 win in 12   │
//  │        │                                           │ LAB    change 3, 2/4 │
//  ├────────┼───────────────────────────────────────────┴──────────────────────┤
//  │        │ BRIBE     send $JEV to …   (only with bribes on)                 │
//  └────────┴──────────────────────────────────────────────────────────────────┘

import type { StreamConfig } from "./config";

// Three rows of text, four with the bribe strip.
export const bandLines = (bribes: boolean) => (bribes ? 4 : 3);

// The band's height for an output height.
export function bandHeight(outputHeight: number, lines = 3): number {
  return Math.round(((outputHeight / 720) * (36 + 24 * lines)) / 2) * 2;
}

// The browser gets the output minus the band.
export function screenSize(c: Pick<StreamConfig, "width" | "height">, lines = 3): { width: number; height: number } {
  return { width: c.width, height: c.height - bandHeight(c.height, lines) };
}

export const BAND_FILES = ["now.txt", "strategy.txt", "vote.txt", "bribe.txt", "game.txt", "clock.txt", "standing.txt", "record.txt", "lab.txt"] as const;
export type BandFile = (typeof BAND_FILES)[number];

// Debian's fonts-dejavu-core (installed in stream/Dockerfile); macOS's Arial.
const mac = process.platform === "darwin";
export const BAND_FONTS = {
  regular: process.env.BAND_FONT ?? (mac ? "/System/Library/Fonts/Supplemental/Arial.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
  bold: process.env.BAND_FONT_BOLD ?? (mac ? "/System/Library/Fonts/Supplemental/Arial Bold.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
  black: process.env.BAND_FONT_BLACK ?? (mac ? "/System/Library/Fonts/Supplemental/Arial Black.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
};
export type BandFont = keyof typeof BAND_FONTS;

export const BAND_COLORS = {
  bg: "0x0d1117",
  panel: "0x161b22",
  brand: "0x0f1f19",
  bribeBg: "0x2a2311",
  accent: "0x53e3a6",
  gold: "0xffd166",
  live: "0xe5484d",
  white: "0xf0f6fc",
  text: "0xc9d1d9",
  muted: "0x8b949e",
};

export interface BandBox {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface BandSlot {
  // A file re-read every frame, or fixed text.
  file?: BandFile;
  text?: string;
  font: BandFont;
  size: number;
  color: string;
  // left: x is the left edge; right: x is the right edge; center: centered in [x, x + maxWidth].
  align: "left" | "right" | "center";
  x: number;
  y: number;
  maxWidth: number;
}

export interface BandDesign {
  top: number;
  height: number;
  boxes: BandBox[];
  slots: BandSlot[];
}

// Cap height of Arial and DejaVu, as a share of the font size: drawtext puts
// the top of the tallest glyph at y, so a label and its bigger value share a
// baseline when the label sits lower by the difference of their cap heights.
const CAP = 0.72;
const beside = (valueY: number, valueSize: number, labelSize: number) => valueY + CAP * (valueSize - labelSize);

export function bandDesign(o: { width: number; height: number; bribes: boolean; lab: boolean }): BandDesign {
  const k = o.height / 720;
  const px = (n: number) => Math.round(n * k);
  const lines = bandLines(o.bribes);
  const height = bandHeight(o.height, lines);
  const top = o.height - height;
  const main = bandHeight(o.height, 3);
  const C = BAND_COLORS;
  const y = (n: number) => top + px(n);
  const brandW = px(132);
  const panelW = px(340);
  const panelX = o.width - panelW;
  const pad = px(18);
  const mid = brandW + px(20);
  const midEnd = panelX - px(18);
  const valueX = mid + px(88);
  const boxes: BandBox[] = [
    { x: 0, y: top, w: o.width, h: Math.max(2, px(2)), color: C.accent },
    { x: 0, y: top + Math.max(2, px(2)), w: brandW, h: height - Math.max(2, px(2)), color: C.brand },
    { x: panelX, y: top + Math.max(2, px(2)), w: panelW, h: main - Math.max(2, px(2)), color: C.panel },
    { x: px(24), y: y(64), w: px(50), h: px(20), color: C.live },
  ];
  const slot = (s: Omit<BandSlot, "align" | "maxWidth"> & Partial<Pick<BandSlot, "align" | "maxWidth">>): BandSlot => ({ align: "left", maxWidth: o.width, ...s });
  const slots: BandSlot[] = [
    // The brand.
    slot({ text: "JEV", font: "black", size: px(34), color: C.accent, x: px(22), y: y(16) }),
    slot({ text: "LIVE", font: "bold", size: px(13), color: C.white, align: "center", x: px(24), y: y(68), maxWidth: px(50) }),
    slot({ text: "24/7", font: "bold", size: px(13), color: C.muted, x: px(82), y: y(68) }),
    // What's happening, the strategy in play, how to vote.
    slot({ file: "now.txt", font: "bold", size: px(22), color: C.white, x: mid, y: y(16), maxWidth: midEnd - mid }),
    slot({ text: "STRATEGY", font: "bold", size: px(12), color: C.accent, x: mid, y: beside(y(51), px(17), px(12)) }),
    slot({ file: "strategy.txt", font: "regular", size: px(17), color: C.white, x: valueX, y: y(51), maxWidth: midEnd - valueX }),
    slot({ text: "VOTE", font: "bold", size: px(12), color: C.gold, x: mid, y: beside(y(80), px(16), px(12)) }),
    slot({ file: "vote.txt", font: "regular", size: px(16), color: C.text, x: valueX, y: y(80), maxWidth: midEnd - valueX }),
    // The match: which game, its clock, Jev's standing, the record and the lab.
    slot({ file: "game.txt", font: "bold", size: px(12), color: C.accent, x: panelX + pad, y: y(18), maxWidth: px(170) }),
    slot({ file: "clock.txt", font: "bold", size: px(32), color: C.white, align: "right", x: o.width - pad, y: y(14), maxWidth: px(110) }),
    slot({ file: "standing.txt", font: "regular", size: px(15), color: C.white, x: panelX + pad, y: y(38), maxWidth: panelW - 2 * pad - px(104) }),
    slot({ text: "RECORD", font: "bold", size: px(11), color: C.muted, x: panelX + pad, y: beside(y(64), px(14), px(11)) }),
    slot({ file: "record.txt", font: "regular", size: px(14), color: C.text, x: panelX + pad + px(58), y: y(64), maxWidth: panelW - 2 * pad - px(58) }),
  ];
  if (o.lab) {
    slots.push(
      slot({ text: "LAB", font: "bold", size: px(11), color: C.muted, x: panelX + pad, y: beside(y(85), px(14), px(11)) }),
      slot({ file: "lab.txt", font: "regular", size: px(14), color: C.text, x: panelX + pad + px(58), y: y(85), maxWidth: panelW - 2 * pad - px(58) }),
    );
  }
  if (o.bribes) {
    boxes.push({ x: brandW, y: top + main, w: o.width - brandW, h: height - main, color: C.bribeBg });
    const by = top + main + px(6);
    slots.push(
      slot({ text: "BRIBE", font: "bold", size: px(12), color: C.gold, x: mid, y: beside(by, px(15), px(12)) }),
      slot({ file: "bribe.txt", font: "regular", size: px(15), color: C.gold, x: valueX, y: by, maxWidth: o.width - pad - valueX }),
    );
  }
  return { top, height, boxes, slots };
}

// --- text widths -------------------------------------------------------------------

// Advance widths (1/1000 em) of printable ASCII in Arial (Helvetica's metrics).
// DejaVu Sans runs about 12% wider; unknown fonts are measured the same way.
const ASCII = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
};
const OTHER: Record<string, number> = { "·": 278, "…": 1000, "—": 1000, "–": 556, "“": 333, "”": 333, "‘": 222, "’": 222, "×": 584 };

function fontScale(font: BandFont): number {
  const file = BAND_FONTS[font];
  const base = /Arial|Helvetica|Liberation ?Sans/i.test(file) ? 1 : 1.12;
  return font === "black" ? base * 1.2 : base;
}

export function textWidth(text: string, font: BandFont, size: number): number {
  const table = font === "regular" ? ASCII.regular : ASCII.bold;
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    units += c >= 32 && c <= 126 ? table[c - 32]! : (OTHER[ch] ?? (c >= 0x2e80 ? 1000 : 600));
  }
  return (units / 1000) * size * fontScale(font);
}

// The text, cut with an ellipsis to fit the width (with a little slack for
// the estimate).
export function fit(text: string, font: BandFont, size: number, maxWidth: number): string {
  const room = maxWidth * 0.97;
  if (textWidth(text, font, size) <= room) return text;
  const chars = [...text];
  while (chars.length > 0 && textWidth(`${chars.join("").trimEnd()}…`, font, size) > room) chars.pop();
  return chars.length > 0 ? `${chars.join("").trimEnd()}…` : "";
}
