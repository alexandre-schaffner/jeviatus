// The stream's own audio: the background music (music.ts) as a continuous
// 48 kHz stereo stream, played into the broadcast through its own ffmpeg
// input (pipe:3, see encoder.ts). On the Mac path the screencast's frame clock
// pulls audio in lockstep with the video frames; in the container it runs its
// own clock.

export const OUT_RATE = 48_000;

// Background music for the mix: stereo frames at OUT_RATE, or silence.
export interface MusicSource {
  // Fills `out` (interleaved stereo, -1..1) with the next frames; false: nothing to play.
  read(out: Float32Array, frames: number): boolean;
}

export class AudioPump {
  // Fractional frames owed, so video frames of 1/fps s add up exactly.
  private carry = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scratch = new Float32Array(0);

  constructor(
    private readonly write: (pcm: Uint8Array) => void,
    private readonly music: MusicSource | null = null,
    private readonly musicGain = 0.22,
  ) {}

  // The next `seconds` of audio, written to the encoder.
  pull(seconds: number): void {
    const exact = seconds * OUT_RATE + this.carry;
    const frames = Math.floor(exact);
    this.carry = exact - frames;
    if (frames <= 0) return;
    if (this.scratch.length < frames * 2) this.scratch = new Float32Array(frames * 2);
    const music = this.scratch;
    const hasMusic = this.music?.read(music, frames) ?? false;
    const out = new Int16Array(frames * 2);
    if (hasMusic) {
      for (let i = 0; i < frames * 2; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(music[i]! * this.musicGain * 32767)));
    }
    this.write(new Uint8Array(out.buffer));
  }

  // Self-clocked, for when nothing else paces the encoder's inputs (the
  // container, where ffmpeg grabs the screen itself).
  startClock(): void {
    let t0 = performance.now();
    let sent = 0;
    this.timer = setInterval(() => {
      const due = (performance.now() - t0) / 1000;
      // After a stall, skip ahead rather than burst.
      if (due - sent > 1) {
        t0 = performance.now();
        sent = 0;
        return;
      }
      this.pull(due - sent);
      sent = due;
    }, 20);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
