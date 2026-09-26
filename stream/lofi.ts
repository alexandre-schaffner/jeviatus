// Original lofi hip-hop, synthesized from scratch: jazzy seventh chords on a
// Rhodes-like FM piano, a round bass, swung boom-bap drums, a sparse
// pentatonic melody, vinyl crackle, all through a dark low-pass and a little
// tape saturation. Every note is generated here, so the stream's background
// music can't draw a copyright claim. Rendered once to WAV files; music.ts
// plays them.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export const MUSIC_RATE = 48_000;

// Chords as a bass note and a rootless voicing, in semitones from the key.
interface Chord {
  bass: number;
  notes: number[];
}

const PROGRESSIONS: Chord[][] = [
  // ii9 V13 Imaj9 vi9
  [{ bass: 2, notes: [5, 9, 12, 16] }, { bass: 7, notes: [5, 11, 16, 21] }, { bass: 0, notes: [4, 7, 11, 14] }, { bass: 9, notes: [7, 12, 16, 23] }],
  // Imaj7 iii7 vi7 IVmaj9
  [{ bass: 0, notes: [4, 7, 11, 14] }, { bass: 4, notes: [7, 11, 14, 19] }, { bass: 9, notes: [7, 12, 16, 19] }, { bass: 5, notes: [9, 12, 16, 19] }],
  // i9 iv9 bVII9 bIIImaj7 (minor)
  [{ bass: 0, notes: [3, 7, 10, 14] }, { bass: 5, notes: [8, 12, 15, 19] }, { bass: 10, notes: [2, 5, 9, 14] }, { bass: 3, notes: [7, 10, 14, 19] }],
  // IVmaj7 iii7 ii7 Imaj9
  [{ bass: 5, notes: [9, 12, 16, 19] }, { bass: 4, notes: [7, 11, 14, 17] }, { bass: 2, notes: [5, 9, 12, 16] }, { bass: 0, notes: [4, 7, 11, 14] }],
];

export interface TrackSpec {
  seed: number;
  key: number; // semitones above C
  bpm: number;
  progression: number;
  bars: number;
}

export const TRACKS: TrackSpec[] = [
  { seed: 11, key: 2, bpm: 74, progression: 0, bars: 48 },
  { seed: 23, key: 5, bpm: 78, progression: 1, bars: 48 },
  { seed: 37, key: 9, bpm: 72, progression: 2, bars: 44 },
  { seed: 41, key: 0, bpm: 80, progression: 3, bars: 52 },
  { seed: 59, key: 7, bpm: 76, progression: 2, bars: 48 },
  { seed: 67, key: 3, bpm: 70, progression: 0, bars: 44 },
];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const TAU = Math.PI * 2;

// Renders one track: stereo float samples at MUSIC_RATE.
export function render(spec: TrackSpec): { left: Float32Array; right: Float32Array } {
  const rand = rng(spec.seed);
  const beat = 60 / spec.bpm;
  const bar = beat * 4;
  const total = Math.ceil((spec.bars * bar + 2) * MUSIC_RATE);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const at = (t: number) => Math.round(t * MUSIC_RATE);
  // Swung eighths: the off-beat lands late.
  const eighth = (barStart: number, i: number) => barStart + Math.floor(i / 2) * beat + (i % 2 ? beat * 0.58 : 0);

  const rhodes = (t0: number, midi: number, dur: number, vel: number) => {
    const f = hz(midi);
    const start = at(t0);
    const len = at(dur + 0.25);
    const pan = 0.5 + (rand() - 0.5) * 0.5;
    for (let i = 0; i < len && start + i < total; i++) {
      const t = i / MUSIC_RATE;
      const env = Math.min(1, t / 0.006) * Math.exp(-t / 1.4) * (t > dur ? Math.exp(-(t - dur) / 0.06) : 1);
      const ph = TAU * f * t;
      const tine = Math.sin(ph + 1.3 * Math.exp(-t * 7) * Math.sin(2 * ph)) + 0.18 * Math.sin(2 * ph) * Math.exp(-t * 3);
      const trem = 1 + 0.12 * Math.sin(TAU * 4.2 * t);
      const y = tine * env * vel;
      L[start + i]! += y * (1 - pan) * trem;
      R[start + i]! += y * pan * (2 - trem);
    }
  };

  const bass = (t0: number, midi: number, dur: number) => {
    const f = hz(midi);
    const start = at(t0);
    const len = at(dur + 0.1);
    for (let i = 0; i < len && start + i < total; i++) {
      const t = i / MUSIC_RATE;
      const env = Math.min(1, t / 0.012) * Math.exp(-t / 0.9) * (t > dur ? Math.exp(-(t - dur) / 0.04) : 1);
      const y = (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t)) * env * 0.32;
      L[start + i]! += y;
      R[start + i]! += y;
    }
  };

  const kick = (t0: number, vel: number) => {
    const start = at(t0);
    let ph = 0;
    for (let i = 0; i < at(0.45) && start + i < total; i++) {
      const t = i / MUSIC_RATE;
      ph += (TAU * (45 + 85 * Math.exp(-t * 28))) / MUSIC_RATE;
      const y = Math.tanh(Math.sin(ph) * Math.exp(-t * 7) * 1.6) * 0.55 * vel;
      L[start + i]! += y;
      R[start + i]! += y;
    }
  };

  const snare = (t0: number, vel: number) => {
    const start = at(t0);
    let lp = 0;
    let prev = 0;
    for (let i = 0; i < at(0.3) && start + i < total; i++) {
      const t = i / MUSIC_RATE;
      const n = rand() * 2 - 1;
      lp += 0.35 * (n - lp);
      const band = lp - prev;
      prev = lp;
      const y = (band * 1.4 * Math.exp(-t * 16) + 0.35 * Math.sin(TAU * 185 * t) * Math.exp(-t * 22)) * 0.4 * vel;
      L[start + i]! += y * 0.9;
      R[start + i]! += y;
    }
  };

  const hat = (t0: number, vel: number) => {
    const start = at(t0);
    let prev = 0;
    for (let i = 0; i < at(0.06) && start + i < total; i++) {
      const t = i / MUSIC_RATE;
      const n = rand() * 2 - 1;
      const y = (n - prev) * Math.exp(-t * 70) * 0.05 * vel;
      prev = n;
      L[start + i]! += y;
      R[start + i]! += y * 0.8;
    }
  };

  const prog = PROGRESSIONS[spec.progression % PROGRESSIONS.length]!;
  const root = 60 + spec.key - (spec.key > 6 ? 12 : 0);
  const pentatonic = [0, 2, 4, 7, 9].map((s) => root + 12 + s + (prog === PROGRESSIONS[2] ? (s === 4 ? -1 : s === 9 ? -1 : 0) : 0));
  const drumsOff = (b: number) => b < 4 || b >= spec.bars - 4;
  const breakdown = (b: number) => b >= Math.floor(spec.bars / 2) && b < Math.floor(spec.bars / 2) + 4;

  for (let b = 0; b < spec.bars; b++) {
    const t = 1 + b * bar;
    const chord = prog[b % prog.length]!;
    const notes = chord.notes.map((n) => root + n).map((n) => (n > 79 ? n - 12 : n));
    // Chord on the one, strummed a little; a lighter restrike on the and-of-three.
    notes.forEach((n, i) => rhodes(t + i * 0.014 + rand() * 0.01, n, bar * 0.62, 0.09 + rand() * 0.02));
    if (rand() < 0.6) notes.slice(1).forEach((n, i) => rhodes(eighth(t, 5) + i * 0.01, n, beat * 1.2, 0.055));
    const bassNote = 36 + ((spec.key + chord.bass) % 12);
    bass(t, bassNote, beat * 1.6);
    bass(eighth(t, 5), rand() < 0.5 ? bassNote : bassNote + 7, beat * 1.1);
    // A few melody notes every other bar.
    if (b % 2 === 1 && !drumsOff(b)) {
      for (let k = 0; k < 2 + Math.floor(rand() * 3); k++) rhodes(eighth(t, Math.floor(rand() * 8)), pentatonic[Math.floor(rand() * pentatonic.length)]!, beat * 0.9, 0.05);
    }
    if (drumsOff(b)) continue;
    const full = !breakdown(b);
    for (let i = 0; i < 8; i++) {
      const s = eighth(t, i) + (rand() - 0.5) * 0.008;
      hat(s, i % 2 ? 0.6 + rand() * 0.2 : 1);
      if (!full) continue;
      if (i === 0 || i === 5 || (i === 3 && rand() < 0.35)) kick(s, i === 0 ? 1 : 0.8);
      if (i === 2 || i === 6) snare(s + 0.012, 0.9 + rand() * 0.1);
    }
  }

  // Vinyl: hiss and crackle.
  let hiss = 0;
  for (let i = 0; i < total; i++) {
    hiss += 0.08 * (rand() * 2 - 1 - hiss);
    let c = hiss * 0.012;
    if (rand() < 7 / MUSIC_RATE) c += (rand() - 0.5) * 0.25;
    L[i]! += c;
    R[i]! += c;
  }

  // Dark low-pass, tape saturation, fades, normalize.
  const k = 1 - Math.exp((-TAU * 3800) / MUSIC_RATE);
  const fadeIn = at(2);
  const fadeOut = at(5);
  let peak = 0;
  for (const ch of [L, R]) {
    let a = 0;
    let b2 = 0;
    for (let i = 0; i < total; i++) {
      a += k * (ch[i]! - a);
      b2 += k * (a - b2);
      let y = Math.tanh(b2 * 1.3);
      if (i < fadeIn) y *= i / fadeIn;
      if (i > total - fadeOut) y *= Math.max(0, (total - i) / fadeOut);
      ch[i] = y;
      peak = Math.max(peak, Math.abs(y));
    }
  }
  const gain = 0.85 / Math.max(peak, 1e-6);
  for (let i = 0; i < total; i++) {
    L[i]! *= gain;
    R[i]! *= gain;
  }
  return { left: L, right: R };
}

export function wav(left: Float32Array, right: Float32Array): Uint8Array {
  const n = left.length;
  const out = new Uint8Array(44 + n * 4);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 4, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, MUSIC_RATE, true);
  v.setUint32(28, MUSIC_RATE * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, left[i]!)) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, right[i]!)) * 32767, true);
  }
  return out;
}

// Renders any missing tracks into `dir` (a few seconds each, once) and
// returns their paths.
export async function ensureLofi(dir: string, log: (line: string) => void): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const spec of TRACKS) {
    const file = path.join(dir, `jev-lofi-${spec.seed}.wav`);
    if (!existsSync(file)) {
      const t0 = performance.now();
      const { left, right } = render(spec);
      await Bun.write(file, wav(left, right));
      log(`[music] composed ${path.basename(file)} (${Math.round(left.length / MUSIC_RATE)}s) in ${Math.round(performance.now() - t0)} ms`);
    }
    files.push(file);
  }
  return files;
}
