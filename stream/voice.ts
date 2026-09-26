// The commentator's voice: text to speech (ElevenLabs, OpenAI, or macOS `say`
// for a keyless try-out), as 24 kHz mono 16-bit PCM, played into the
// broadcast's audio through its own ffmpeg input (pipe:3, see encoder.ts).
//
// VoicePump turns "speak this" into a continuous 48 kHz stereo stream: the
// background music (music.ts), ducked under the voice while it talks. On the
// Mac path the screencast's frame clock pulls audio in lockstep with the video frames, so voice and picture stay in
// sync by construction; in the container it runs its own clock.

import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const VOICE_RATE = 24_000;
const BYTES_PER_SAMPLE = 2;

export type Mood = "neutral" | "happy" | "angry" | "shocked" | "smug" | "sad";
export const MOODS: readonly Mood[] = ["neutral", "happy", "angry", "shocked", "smug", "sad"];

export interface Tts {
  readonly name: string;
  // 24 kHz mono s16le PCM.
  speak(text: string, mood: Mood): Promise<Uint8Array>;
}

export type TtsConfig =
  | { provider: "elevenlabs"; apiKey: string; voiceId: string; model: string }
  | { provider: "openai"; apiKey: string; voice: string; model: string }
  | { provider: "say"; voice: string }
  | { provider: "none" };

const TTS_TIMEOUT_MS = 12_000;

// How the character sounds per mood, for the providers that take direction.
const DIRECTION: Record<Mood, string> = {
  neutral: "a bratty, self-important cartoon general: loud, nasal, sure he's the smartest person alive",
  happy: "obnoxiously gloating and triumphant, rubbing it in",
  angry: "a whiny, outraged tantrum, voice cracking with indignation",
  shocked: "high-pitched panic, screeching disbelief",
  smug: "insufferably smug, slow and condescending",
  sad: "melodramatic fake sobbing, milking it",
};

export function createTts(c: TtsConfig): Tts | null {
  switch (c.provider) {
    case "elevenlabs":
      return {
        name: `ElevenLabs (${c.model})`,
        async speak(text, mood) {
          const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(c.voiceId)}?output_format=pcm_24000`, {
            method: "POST",
            headers: { "xi-api-key": c.apiKey, "content-type": "application/json" },
            body: JSON.stringify({
              text,
              model_id: c.model,
              // Livelier (less stable) for the big moments.
              voice_settings: { stability: mood === "neutral" ? 0.5 : 0.3, similarity_boost: 0.8, style: mood === "neutral" ? 0.3 : 0.6 },
            }),
            signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
          return new Uint8Array(await res.arrayBuffer());
        },
      };
    case "openai":
      return {
        name: `OpenAI (${c.model})`,
        async speak(text, mood) {
          const res = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: { authorization: `Bearer ${c.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: c.model, voice: c.voice, input: text, instructions: `Voice: ${DIRECTION[mood]}. A live game-stream commentator.`, response_format: "pcm" }),
            signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
          return new Uint8Array(await res.arrayBuffer());
        },
      };
    case "say":
      return {
        name: `macOS say (${c.voice})`,
        async speak(text, mood) {
          const file = path.join(os.tmpdir(), `jev-say-${crypto.randomUUID()}.wav`);
          try {
            const rate = mood === "shocked" || mood === "angry" ? "205" : mood === "sad" ? "160" : "185";
            const p = Bun.spawn(["say", "-v", c.voice, "-r", rate, "--file-format=WAVE", `--data-format=LEI16@${VOICE_RATE}`, "-o", file, text], { stdout: "ignore", stderr: "pipe" });
            if ((await p.exited) !== 0) throw new Error(`say: ${(await new Response(p.stderr).text()).trim()}`);
            return wavData(new Uint8Array(await Bun.file(file).arrayBuffer()));
          } finally {
            rmSync(file, { force: true });
          }
        },
      };
    case "none":
      return null;
  }
}

// The samples of a PCM WAV file (skipping whatever chunks precede "data").
export function wavData(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  for (let at = 12; at + 8 <= wav.length; ) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "data") return wav.subarray(at + 8, Math.min(wav.length, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

// Loudness per `stepMs` window, 0..1 (normalized to the line's loudest
// window): drives the avatar's mouth.
export function envelope(pcm: Uint8Array, stepMs = 40): number[] {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / BYTES_PER_SAMPLE));
  const step = Math.max(1, Math.round((VOICE_RATE * stepMs) / 1000));
  const out: number[] = [];
  for (let i = 0; i < samples.length; i += step) {
    let sum = 0;
    const end = Math.min(samples.length, i + step);
    for (let j = i; j < end; j++) sum += samples[j]! * samples[j]!;
    out.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  const peak = Math.max(1, ...out);
  return out.map((v) => Math.round((v / peak) * 100) / 100);
}

export const durationMs = (pcm: Uint8Array) => (pcm.byteLength / BYTES_PER_SAMPLE / VOICE_RATE) * 1000;

// What goes to the encoder: 48 kHz stereo s16le, the voice over the music.
export const OUT_RATE = 48_000;

// Background music for the mix: stereo frames at OUT_RATE, or silence.
export interface MusicSource {
  // Fills `out` (interleaved stereo, -1..1) with the next frames; false: nothing to play.
  read(out: Float32Array, frames: number): boolean;
}

interface Playing {
  // Speech resampled to OUT_RATE, mono, -1..1.
  samples: Float32Array;
  at: number;
  done: () => void;
}

// 24 kHz mono s16le → 48 kHz mono float, linear interpolation.
export function upsample(pcm: Uint8Array): Float32Array {
  const src = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / BYTES_PER_SAMPLE));
  const ratio = OUT_RATE / VOICE_RATE;
  const out = new Float32Array(src.length * ratio);
  for (let i = 0; i < out.length; i++) {
    const x = i / ratio;
    const a = Math.floor(x);
    const b = Math.min(src.length - 1, a + 1);
    out[i] = ((src[a]! + (src[b]! - src[a]!) * (x - a)) / 32768);
  }
  return out;
}

export interface MixOptions {
  music?: MusicSource | null;
  // Music level on its own, and under the voice.
  musicGain?: number;
  duckGain?: number;
}

export class VoicePump {
  private playing: Playing | null = null;
  // Fractional frames owed, so video frames of 1/fps s add up exactly.
  private carry = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private gain: number;
  private scratch = new Float32Array(0);
  // Music level; the lab raises it while nobody's playing.
  musicGain: number;
  private readonly duckGain: number;

  constructor(
    private readonly write: (pcm: Uint8Array) => void,
    private readonly mix: MixOptions = {},
  ) {
    this.musicGain = mix.musicGain ?? 0.22;
    this.duckGain = mix.duckGain ?? 0.07;
    this.gain = this.musicGain;
  }

  get speaking(): boolean {
    return this.playing !== null;
  }

  // Resolves once the line has been handed to the encoder in full.
  play(pcm: Uint8Array, leadMs = 0): Promise<void> {
    this.playing?.done();
    // A lead of silence: the picture reaches the encoder a little after the
    // page draws it, so the voice waits for the mouth.
    const speech = upsample(pcm);
    const lead = Math.round((OUT_RATE * leadMs) / 1000);
    const samples = new Float32Array(lead + speech.length);
    samples.set(speech, lead);
    return new Promise((resolve) => {
      this.playing = { samples, at: 0, done: resolve };
    });
  }

  // The next `seconds` of audio, written to the encoder.
  pull(seconds: number): void {
    const exact = seconds * OUT_RATE + this.carry;
    const frames = Math.floor(exact);
    this.carry = exact - frames;
    if (frames <= 0) return;
    if (this.scratch.length < frames * 2) this.scratch = new Float32Array(frames * 2);
    const music = this.scratch;
    const hasMusic = this.mix.music?.read(music, frames) ?? false;
    const out = new Int16Array(frames * 2);
    const p = this.playing;
    // The music eases down under the voice (time constant 40 ms) and back up (250 ms).
    const target = p ? this.duckGain : this.musicGain;
    const k = 1 / ((p ? 0.04 : 0.25) * OUT_RATE);
    for (let i = 0; i < frames; i++) {
      this.gain += (target - this.gain) * k;
      const v = p && p.at < p.samples.length ? p.samples[p.at++]! : 0;
      const l = (hasMusic ? music[i * 2]! * this.gain : 0) + v;
      const r = (hasMusic ? music[i * 2 + 1]! * this.gain : 0) + v;
      out[i * 2] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
      out[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
    }
    if (p && p.at >= p.samples.length) {
      this.playing = null;
      p.done();
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
    this.playing?.done();
    this.playing = null;
  }
}
