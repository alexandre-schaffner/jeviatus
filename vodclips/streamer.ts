// Who the clips are cut from. Everything the questions and the hook prompt
// say about the streamer comes from a profile: vodclips/streamers/<channel>.json,
// or the file passed with --streamer. A channel without one gets a generic
// profile built from its slug, which works but judges less sharply; write a
// profile from what performs on the streamer's clip pages (see
// research-clavicular-instagram.md for how the Clavicular one was made).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Streamer {
  channel: string; // Kick slug
  name: string; // full name in hooks and questions
  short: string; // nickname hooks may use
  who: string; // one line: what they're known for
  stream: string; // what a typical stream is
  pitch: string; // what goes viral for them, one or two sentences
  speakers: string; // who talks on stream, so hooks don't misattribute lines
  verdictHints: string[]; // what counts as a blunt verdict from them
  lingoExamples: string[]; // community slang that makes a title
  hookRules: string[]; // hook formats that perform, with real examples
}

export function generic(channel: string): Streamer {
  return {
    channel,
    name: channel,
    short: channel,
    who: "a Kick livestreamer",
    stream: "a long livestream",
    pitch: "What goes viral is a short exchange with someone on camera that lands a blunt, quotable or absurd beat.",
    speakers: `The transcript has no speaker names, so don't say ${channel} did or said something unless the transcript makes it clear; describing the person is safer.`,
    verdictHints: ["a rating, an accusation or a roast all count"],
    lingoExamples: [],
    hookRules: [
      "Hook formats that perform for stream clips (pick the one that fits; mix them across the 5):",
      "1. The verbatim punchline in quotes, at most 10 words.",
      `2. A third-person headline: ${channel} + strong verb + who + twist.`,
      `3. Reaction framing: ${channel} was shocked when she revealed this / the moment ${channel} finds out ...`,
      `4. When they lose: <who> just humiliated ${channel}.`,
      "ALL CAPS on one or two words is fine. Never invent a fact the transcript doesn't support. Never mention minors.",
    ],
  };
}

export function loadStreamer(channel: string, file?: string): Streamer {
  const f = file ?? path.join(import.meta.dir, "streamers", `${channel}.json`);
  if (!existsSync(f)) {
    if (file) throw new Error(`no streamer profile at ${file}`);
    return generic(channel);
  }
  return { ...generic(channel), ...(JSON.parse(readFileSync(f, "utf8")) as Partial<Streamer>), channel };
}
