// General Static, put together: the brain (commentator.ts) picks the line,
// the voice (voice.ts) says it into the broadcast, and the avatar (avatar.ts)
// mouths it on screen with a subtitle bubble. Kick chat feeds the brain.

import { installExpression, moodExpression, sayExpression } from "./avatar";
import type { Cdp } from "./cdp";
import { ClaudeWriter, CannedWriter, Commentator, type Line } from "./commentator";
import type { StreamConfig } from "./config";
import { KickChat } from "./kickchat";
import { createTts, durationMs, envelope, type VoicePump } from "./voice";

// The picture reaches the encoder about this long after the page draws it
// (screencast capture + frame pacing), so the voice starts this much later.
const LEAD_MS = 120;

export interface CharacterDeps {
  cfg: NonNullable<StreamConfig["character"]>;
  // The pages he appears on (the game, the lab).
  filmable: (url: string) => boolean;
  cdp: () => Cdp | null;
  // The stream's audio mix: his voice goes over the music there.
  pump: VoicePump;
  log: (line: string) => void;
}

export class Character {
  readonly brain: Commentator;
  readonly pump: VoicePump;
  private readonly chat: KickChat | null;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private idleMood: string | null = null;

  constructor(private readonly d: CharacterDeps) {
    const { cfg, log } = d;
    const tts = createTts(cfg.tts);
    this.pump = d.pump;
    const writer = cfg.claude ? new ClaudeWriter({ ...cfg.claude, name: cfg.name, log }) : new CannedWriter(cfg.name);
    this.brain = new Commentator({
      writer,
      speak: (line) => this.speak(line, tts),
      log,
      idleMs: cfg.idleSeconds * 1000,
      chatGapMs: cfg.chatGapSeconds * 1000,
    });
    this.chat = cfg.kickChannel ? new KickChat(cfg.kickChannel, (m) => this.brain.chat(m), log) : null;
    log(`[commentator] ${cfg.name}: lines by ${writer.name}, voice ${tts?.name ?? "off (subtitles only)"}, chat ${cfg.kickChannel ? `kick.com/${cfg.kickChannel}` : "off"}`);
  }

  start(): void {
    this.brain.start();
    this.chat?.start();
    this.timers.push(setInterval(() => void this.ensure(), 2000));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.brain.stop();
    this.chat?.stop();
  }

  private async page(): Promise<{ cdp: Cdp; id: string } | null> {
    const cdp = this.d.cdp();
    if (!cdp || cdp.closed) return null;
    const page = (await cdp.targets()).find((t) => t.type === "page" && this.d.filmable(t.url));
    return page ? { cdp, id: page.targetId } : null;
  }

  // Draws the character on each fresh page load, and keeps its resting face
  // in line with the match (sad while Jev is out).
  private async ensure(): Promise<void> {
    try {
      const p = await this.page();
      if (!p) return;
      await p.cdp.evaluate(p.id, installExpression(this.d.cfg.name), 5_000);
      const phase = this.brain.situation.phase;
      const mood = phase === "dead" ? "sad" : phase === "between" && /won/i.test(this.brain.situation.lastResult ?? "") ? "happy" : "neutral";
      if (mood !== this.idleMood) {
        await p.cdp.evaluate(p.id, moodExpression(mood), 5_000);
        this.idleMood = mood;
      }
    } catch {
      // the page is navigating; next time
    }
  }

  private async speak(line: Line, tts: ReturnType<typeof createTts>): Promise<void> {
    let pcm: Uint8Array | null = null;
    if (tts) {
      try {
        pcm = await tts.speak(line.text, line.mood);
      } catch (err) {
        this.d.log(`[commentator] voice failed, subtitles only: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Without a voice, the bubble stays up about as long as reading it takes.
    const durMs = pcm ? durationMs(pcm) : Math.max(2500, line.text.length * 55);
    this.d.log(`[commentator] (${line.mood}${line.replyTo ? `, to ${line.replyTo}` : ""}) ${line.text}`);
    try {
      const p = await this.page();
      if (p) {
        await p.cdp.evaluate(p.id, installExpression(this.d.cfg.name), 5_000);
        await p.cdp.evaluate(p.id, sayExpression({ text: line.text, mood: line.mood, env: pcm ? envelope(pcm) : [], durMs, ...(line.replyTo ? { replyTo: line.replyTo } : {}) }), 5_000);
      }
    } catch {
      // the voice still goes out
    }
    // Bounded: if the encoder stops pulling audio, the brain mustn't hang on it.
    if (pcm) await Promise.race([this.pump.play(pcm, LEAD_MS), Bun.sleep(durMs + 5_000)]);
    else await Bun.sleep(durMs);
  }
}
