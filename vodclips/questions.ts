// What Jev asks about each candidate moment, reverse-engineered from what
// performs on Clavicular's Instagram: 360 reels with play counts, ~95
// transcribed (research notes in vodclips/README.md). The beats carry over to
// other IRL streamers; the wording about who they are comes from their
// profile (streamer.ts). The winners are short
// (every top-5 stream clip is <= 29 s). They open mid-confrontation and land
// one of a few beats:
//   A  a blunt verdict to someone's face ("you're plastic maxing", a 1-10 rating)
//   B  a status flip: he IDs, rejects or kicks someone out, or steals the girl
//   C  he gets mogged, rejected or humiliated (biggest spread off-platform)
//   D  he breaks: a meltdown, panic, a stunt
//   E  lingo: a new or absurd "-maxxing"
//   F  an absurd non-sequitur from a chaotic stranger
// The flops are monologues: advice, politics, prayer, long sit-down setups.

import { choice, noul, type Questions, score } from "@typesafe-ai/sdk";
import type { Peak } from "./signals";
import type { Streamer } from "./streamer";

// Every question is framed by the streamer's profile (streamer.ts).
const role = (st: Streamer) =>
  `You pick moments from ${st.name}'s livestream (${st.stream}) to cut into Instagram Reels for ${st.name}'s clip pages. ` +
  `Viewers scroll fast. ${st.pitch} ` +
  "The transcript is automatic and noisy; judge what is actually being said, not exact words.";

const SEEN = [
  "`moment.transcript` is what is said, timed in seconds from the peak of viewer activity",
  "`moment.chat_right_after` and `moment.viewer_clip_titles` show how viewers reacted; viewers clipping it is strong evidence something happened",
];

export type Answers = Record<string, { choice?: string; score?: number; noul?: number; probabilities?: Record<string, number> }>;

export function momentQuestions(st: Streamer, starts: Record<string, string>, ends: Record<string, string>): Questions {
  const ROLE = role(st);
  const lingo = st.lingoExamples.length ? ` (like ${st.lingoExamples.map((l) => `'${l}'`).join(", ")})` : "";
  return {
    // A
    verdict: score(
      {
        role: ROLE,
        question: `Does ${st.name} deliver a blunt, quotable judgment about a specific person who is there with them (or a named celebrity)?`,
        consider: [...SEEN, ...st.verdictHints, "it must be aimed at someone, not a general opinion"],
      },
      [
        "none: nobody is judged",
        "vague: a general opinion with no one targeted",
        "mild: a judgment of someone present, but softened or long-winded",
        "clear: a direct judgment of someone present that viewers would quote",
        "brutal: a short standalone verdict to someone's face, like \"you're plastic maxing\" or \"6.5, not even a 7\"",
      ],
    ),
    // B and C
    status: choice(
      {
        role: ROLE,
        question: "By the end of this moment, has someone visibly lost status, and who?",
        consider: [
          ...SEEN,
          `${st.short} wins: they reject, dismiss, ID, roast or kick someone out, or take someone's girl`,
          `${st.short} loses: they get mogged, rejected, out-classed, roasted back or humiliated`,
          "none: nobody is put down",
        ],
      },
      { none: "nobody loses status", streamer_wins: `${st.short} puts someone down or wins the exchange`, streamer_loses: `${st.short} gets put down, rejected or mogged` },
    ),
    // The foil
    foil: score(
      {
        role: ROLE,
        question: "Is there a second person on camera whose reaction shows the moment landed?",
        consider: [...SEEN, "a stranger, a woman, or a physically contrasting man answering fast is ideal", "denial, a stunned short answer, silence, laughter or \"what?\" all count"],
      },
      [
        "monologue: only one person talks",
        "background: others are around but don't react to him",
        "conversation: a back-and-forth with no clear reaction beat",
        "reaction: someone visibly reacts to what was said",
        "rapid back-and-forth with an unmistakable reaction beat",
      ],
    ),
    // Works cold
    cold_open: score(
      {
        role: ROLE,
        question: "Could this work as a short clip for someone who never saw the stream: can it open on a line that already sets up the premise, with the payoff soon after?",
        consider: [...SEEN, "the best clips open on a question or accusation aimed at someone and pay off within about 15 seconds", "inside jokes from earlier in the stream don't work cold"],
      },
      [
        "only makes sense with earlier context from the stream",
        "needs a long setup before anything happens",
        "needs a few seconds of setup",
        "the premise is clear within the first line or two",
        "instantly clear: the first line is the premise and the payoff follows fast",
      ],
    ),
    // E
    lingo: noul({
      role: ROLE,
      question: `Does someone coin or apply the community's slang in a new or absurd way that could be the clip's title${lingo}?`,
      consider: SEEN,
    } as never),
    // Shareability
    outrage: score(
      {
        role: ROLE,
        question: "How strongly would an ordinary viewer feel compelled to comment, argue or share it?",
        consider: [...SEEN, "shocking, cruel, absurd or morally loaded lines drive comments", "an absurd non-sequitur from a chaotic stranger also does"],
      },
      ["nothing to react to", "mildly interesting", "funny or surprising", "people would argue about it in the comments", "outrageous: people would send it to friends"],
    ),
    // D
    spectacle: score(
      {
        role: ROLE,
        question: `Does ${st.name} visibly break or do something physical: crying, panic, a meltdown, being out-classed physically, a stunt that succeeds or fails?`,
        consider: SEEN,
      },
      ["nothing like it", "a small flinch", "flustered or embarrassed", "a clear break or a stunt", "a full meltdown or a spectacular stunt"],
    ),
    // The flops
    flop: noul({
      role: ROLE,
      question: "Is this moment mainly one of the formats that flop: an advice or informational monologue, politics talk, prayer or gratitude, logistics or a sponsor read, or a long sit-down setup with no punchline?",
      consider: SEEN,
    } as never),
    // The one thing never posted, however viral: slurs, sex talk and shock
    // are fair game, sexualising a possible minor is not.
    minor: noul({
      role: ROLE,
      question: "Does this moment involve someone who may be under 18 in a sexual or romantic context?",
      consider: [...SEEN, "an age check or someone saying their age or school year is a signal", "adults only, however crude, is a no"],
    } as never),
    start: choice(
      {
        role: ROLE,
        question: "Which line should the clip open on? Pick the line where the setup begins: the first thing said to the other person that the punchline depends on.",
        consider: [
          ...SEEN,
          "the opening line is the hook: a question, an outrageous claim or an introduction aimed at someone (\"I'm gonna cut to the chase...\", \"Like the show iCarly?\", \"How old are you?\")",
          "never cut the setup the payoff needs, but skip small talk and greetings before it",
          "aim for the whole clip to be 10 to 25 seconds",
        ],
      },
      starts,
    ),
    end: choice(
      {
        role: ROLE,
        question: "Which line is the last one the clip should include? End right after the punchline or the reaction to it.",
        consider: [...SEEN, "end 1 to 3 seconds after the payoff lands; don't trail into the next topic"],
      },
      ends,
    ),
  };
}

export function hookQuestion(st: Streamer, opts: Record<string, string>): Questions {
  const ROLE = role(st);
  return {
    hook: choice(
      {
        role: ROLE,
        question: "Which text should sit on top of this clip to stop a scroll?",
        consider: [
          "it must be true to what happens in `moment.transcript`",
          `a short verbatim punchline in quotes, or a third-person '${st.name} <does something> <twist>' headline, work best`,
          "curiosity: it should make people want to see the reaction",
        ],
      },
      opts,
    ),
  };
}

const level = (a: Answers, k: string) => a[k]?.score ?? 0; // 0..4
const yes = (a: Answers, k: string) => a[k]?.noul ?? 0;

// The research's weights: 2 verdict + 2 status flip + foil + cold open +
// lingo + outrage + chat + 2 audio payoff + spectacle, gated by the flops.
// Chat and audio come from the signals, not from Jev. Out of ~1.
export function scoreOf(a: Answers, p: Peak): number {
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const statusFlip = 1 - (a.status?.probabilities?.none ?? (a.status?.choice === "none" ? 1 : 0));
  const chat = clamp01((Math.max(p.chatZ, 0) + Math.max(p.laughZ, 0)) / 6) * 4;
  const audio = clamp01(p.loudZ / 3);
  const clipped = clamp01(Math.log1p(p.clipW) / 3); // viewers voted with the clip button
  let s =
    2 * level(a, "verdict") +
    2 * 4 * statusFlip +
    level(a, "foil") +
    level(a, "cold_open") +
    4 * yes(a, "lingo") +
    level(a, "outrage") +
    chat +
    2 * 4 * audio * 0.5 +
    level(a, "spectacle") +
    4 * clipped;
  s /= 4 * (2 + 2 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1);
  // Gates: it must work cold, and land a verdict, a flip or a break.
  if (level(a, "cold_open") < 1.5) s *= 0.6;
  if (Math.max(level(a, "verdict"), 4 * statusFlip, level(a, "spectacle"), level(a, "outrage")) < 2.5) s *= 0.7;
  s *= 1 - 0.6 * yes(a, "flop");
  if (yes(a, "minor") > 0.3) s = 0;
  return s;
}
