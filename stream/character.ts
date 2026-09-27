// General Static, put together: the brain (commentator.ts) picks the line
// and the avatar (avatar.ts) mouths it on screen with a subtitle bubble. Kick
// chat feeds the brain.

import { installExpression, moodExpression, sayExpression } from "./avatar";
import type { Cdp } from "./cdp";
import { ClaudeCodeWriter, ClaudeWriter, CannedWriter, Commentator, type Line } from "./commentator";
import { claudeEnv } from "./lab";
import type { StreamConfig } from "./config";
import { KickChat } from "./kickchat";

export interface CharacterDeps {
  cfg: NonNullable<StreamConfig["character"]>;
  // The pages he appears on (the game, the lab).
  filmable: (url: string) => boolean;
  cdp: () => Cdp | null;
  log: (line: string) => void;
}

export class Character {
  readonly brain: Commentator;
  private readonly chat: KickChat | null;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private idleMood: string | null = null;

  constructor(private readonly d: CharacterDeps) {
    const { cfg, log } = d;
    const writer = cfg.claudeCode
      ? new ClaudeCodeWriter({ ...cfg.claudeCode, name: cfg.name, log, env: claudeEnv() })
      : cfg.claude
        ? new ClaudeWriter({ ...cfg.claude, name: cfg.name, log })
        : new CannedWriter(cfg.name);
    this.brain = new Commentator({
      writer,
      speak: (line) => this.speak(line),
      log,
      idleMs: cfg.idleSeconds * 1000,
      chatGapMs: cfg.chatGapSeconds * 1000,
    });
    this.chat = cfg.kickChannel ? new KickChat(cfg.kickChannel, (m) => this.brain.chat(m), log) : null;
    log(`[commentator] ${cfg.name}: lines by ${writer.name}, chat ${cfg.kickChannel ? `kick.com/${cfg.kickChannel}` : "off"}`);
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

  private async speak(line: Line): Promise<void> {
    // The bubble stays up about as long as reading it takes.
    const durMs = Math.max(2500, line.text.length * 55);
    this.d.log(`[commentator] (${line.mood}${line.replyTo ? `, to ${line.replyTo}` : ""}) ${line.text}`);
    try {
      const p = await this.page();
      if (p) {
        await p.cdp.evaluate(p.id, installExpression(this.d.cfg.name), 5_000);
        await p.cdp.evaluate(p.id, sayExpression({ text: line.text, mood: line.mood, durMs, ...(line.replyTo ? { replyTo: line.replyTo } : {}) }), 5_000);
      }
    } catch {
      // the page is navigating; the line is lost
    }
    await Bun.sleep(durMs);
  }
}
