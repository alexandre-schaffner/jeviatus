// Background music: a shuffled playlist, looped forever, fed to the audio mix
// (voice.ts VoicePump) under the commentator. Your own tracks in MUSIC_DIR
// play if there are any (make sure you may stream them); otherwise the
// original lofi composed by lofi.ts. Tracks are decoded by ffmpeg one ahead,
// off the audio clock, so a slow decode never stalls the stream.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { MusicSource } from "./voice";

const RATE = 48_000;
const FADE_FRAMES = RATE * 2;
const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i;

interface Track {
  name: string;
  pcm: Int16Array; // interleaved stereo
  at: number; // frame
}

export function audioFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => AUDIO.test(f) && !f.startsWith("."))
    .map((f) => path.join(dir, f));
}

export function shuffle<T>(xs: T[], rand = Math.random): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export class Playlist implements MusicSource {
  private current: Track | null = null;
  private ready: Track | null = null;
  private loading = false;
  private queue: string[] = [];
  private last: string | null = null;

  constructor(
    private readonly files: () => string[],
    private readonly ffmpeg: string,
    private readonly log: (line: string) => void,
  ) {}

  get nowPlaying(): string | null {
    return this.current?.name ?? null;
  }

  start(): void {
    void this.prefetch();
  }

  private async prefetch(): Promise<void> {
    if (this.loading || this.ready) return;
    this.loading = true;
    try {
      for (let tries = 0; tries < 3 && !this.ready; tries++) {
        if (this.queue.length === 0) {
          // A fresh shuffle each round; never the same track twice in a row.
          this.queue = shuffle(this.files());
          if (this.queue.length > 1 && this.queue[0] === this.last) this.queue.push(this.queue.shift()!);
        }
        const file = this.queue.shift();
        if (!file) return;
        try {
          this.ready = { name: path.basename(file).replace(AUDIO, ""), pcm: await this.decode(file), at: 0 };
        } catch (err) {
          this.log(`[music] skipping ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.loading = false;
    }
  }

  private async decode(file: string): Promise<Int16Array> {
    const p = Bun.spawn([this.ffmpeg, "-v", "error", "-i", file, "-vn", "-f", "s16le", "-ar", String(RATE), "-ac", "2", "-"], { stdout: "pipe", stderr: "pipe" });
    const [buf, err, code] = [await new Response(p.stdout).arrayBuffer(), await new Response(p.stderr).text(), await p.exited];
    if (code !== 0 || buf.byteLength < RATE * 4) throw new Error(err.trim().split("\n").at(-1) || `ffmpeg exited ${code}`);
    return new Int16Array(buf);
  }

  read(out: Float32Array, frames: number): boolean {
    let written = 0;
    while (written < frames) {
      if (this.current === null || this.current.at * 2 >= this.current.pcm.length) {
        this.current = this.ready;
        this.ready = null;
        void this.prefetch();
        if (this.current === null) break;
        this.last = this.current.name;
        this.log(`[music] now playing ${this.current.name}`);
      }
      const t = this.current;
      const total = t.pcm.length / 2;
      const n = Math.min(frames - written, total - t.at);
      for (let i = 0; i < n; i++) {
        const f = t.at + i;
        // Fade every track in and out, so any file joins the next smoothly.
        const fade = Math.min(1, f / FADE_FRAMES, (total - f) / FADE_FRAMES);
        out[(written + i) * 2] = (t.pcm[f * 2]! / 32768) * fade;
        out[(written + i) * 2 + 1] = (t.pcm[f * 2 + 1]! / 32768) * fade;
      }
      t.at += n;
      written += n;
    }
    out.fill(0, written * 2, frames * 2);
    return written > 0;
  }
}
