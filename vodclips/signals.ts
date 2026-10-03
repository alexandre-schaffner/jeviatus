// Where in a long stream something happened, second by second, from three
// signals nobody has to watch the stream for:
//   clips:   viewers clipped it (Kick clips end where the viewer pressed the button)
//   chat:    chat sped up, or filled with laugh/shock emotes
//   loud:    the room got loud (shouting, laughing, music)
// Each becomes a robust z-score against the surrounding half hour, so a
// quiet 4 am stretch and a packed club don't drown each other out.

import type { ChatSample, ViewerClip } from "./kick";

// What a viewer sees trails the broadcast by a few seconds, so a clip made
// at wallclock T ends around T - lag in the VOD.
export const VIEWER_LAG_SEC = 8;

const LAUGH = /laugh|kekw|lul|omegalul|icant|lmao|lmfao|haha|😂|💀|🤣|dead|crying/i;
const SHOCK = /wth|wtf|pog|omg|holy|bro|nah|💀|😭|😳|ayo|w+\b|\bl+\b|ratio|mog/i;

export interface Signals {
  durationSec: number;
  clip: Float32Array; // clip weight per second
  chatRate: Float32Array; // messages per second, held between samples
  chatLaugh: Float32Array; // share of messages that laugh, held
  loud: Float32Array; // dB per second
}

export function clipCurve(clips: ViewerClip[], startIso: string, durationSec: number): Float32Array {
  const out = new Float32Array(Math.ceil(durationSec));
  const start = Date.parse(startIso);
  for (const c of clips) {
    const end = (Date.parse(c.createdAt) - start) / 1000 - VIEWER_LAG_SEC;
    if (end < 0 || end > durationSec) continue;
    // The payoff sits near the end of a clip: weight the last 25 s, and more
    // for clips other people watched.
    const w = 1 + Math.log1p(Math.max(0, c.views)) / 2;
    const from = Math.max(0, Math.floor(end - Math.min(25, c.durationSec)));
    for (let t = from; t < Math.min(out.length, Math.ceil(end)); t++) out[t]! += w;
  }
  return out;
}

export function chatCurves(samples: ChatSample[], startIso: string, durationSec: number): { rate: Float32Array; laugh: Float32Array } {
  const n = Math.ceil(durationSec);
  const rate = new Float32Array(n);
  const laugh = new Float32Array(n);
  const start = Date.parse(startIso);
  const sorted = [...samples].sort((a, b) => a.offsetSec - b.offsetSec);
  sorted.forEach((s, i) => {
    const times = s.messages.map((m) => (Date.parse(m.at) - start) / 1000);
    const span = times.length > 1 ? Math.max(1, Math.max(...times) - Math.min(...times)) : 5;
    const r = s.messages.length / span;
    const l = s.messages.length ? s.messages.filter((m) => LAUGH.test(m.text)).length / s.messages.length : 0;
    const to = Math.min(n, i + 1 < sorted.length ? sorted[i + 1]!.offsetSec : n);
    for (let t = s.offsetSec; t < to; t++) {
      rate[t] = r;
      laugh[t] = l;
    }
  });
  return { rate, laugh };
}

// Per-second loudness (dB RMS) of 16 kHz mono s16le PCM with a 44-byte header.
export async function loudness(wav: string): Promise<Float32Array> {
  const file = Bun.file(wav);
  const rate = 16000;
  const out = new Float32Array(Math.floor((file.size - 44) / 2 / rate));
  let sec = 0;
  let acc = 0;
  let k = 0;
  let skip = 44;
  let carry: number | null = null;
  for await (const chunk of file.stream()) {
    let i = 0;
    if (skip) {
      const s = Math.min(skip, chunk.length);
      skip -= s;
      i = s;
    }
    if (carry !== null && i < chunk.length) {
      const v = ((chunk[i]! << 8) | carry) << 16 >> 16;
      acc += (v / 32768) ** 2;
      k++;
      i++;
      carry = null;
    }
    for (; i + 1 < chunk.length; i += 2) {
      const v = ((chunk[i + 1]! << 8) | chunk[i]!) << 16 >> 16;
      acc += (v / 32768) ** 2;
      if (++k === rate) {
        if (sec < out.length) out[sec] = 10 * Math.log10(acc / rate + 1e-12);
        sec++;
        acc = 0;
        k = 0;
      }
    }
    if (i < chunk.length) carry = chunk[i]!;
  }
  return out;
}

// z-score of each second against the median and MAD of the window around it
// (computed on a coarse grid, which is plenty for half-hour baselines).
export function localZ(x: Float32Array, windowSec = 1800, gridSec = 60): Float32Array {
  const out = new Float32Array(x.length);
  const cells = Math.ceil(x.length / gridSec);
  const med = new Float32Array(cells);
  const mad = new Float32Array(cells);
  for (let c = 0; c < cells; c++) {
    const mid = c * gridSec + gridSec / 2;
    const lo = Math.max(0, Math.floor(mid - windowSec / 2));
    const hi = Math.min(x.length, Math.ceil(mid + windowSec / 2));
    const vals = Array.from(x.subarray(lo, hi)).sort((a, b) => a - b);
    const m = vals[vals.length >> 1] ?? 0;
    const dev = vals.map((v) => Math.abs(v - m)).sort((a, b) => a - b);
    med[c] = m;
    mad[c] = Math.max(1e-3, 1.4826 * (dev[dev.length >> 1] ?? 0));
  }
  for (let t = 0; t < x.length; t++) {
    const c = Math.min(cells - 1, Math.floor(t / gridSec));
    out[t] = (x[t]! - med[c]!) / mad[c]!;
  }
  return out;
}

export function smooth(x: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(x.length);
  let sum = 0;
  for (let t = 0; t < Math.min(x.length, radius); t++) sum += x[t]!;
  for (let t = 0; t < x.length; t++) {
    if (t + radius < x.length) sum += x[t + radius]!;
    if (t - radius - 1 >= 0) sum -= x[t - radius - 1]!;
    out[t] = sum / (Math.min(x.length - 1, t + radius) - Math.max(0, t - radius) + 1);
  }
  return out;
}

export interface Peak {
  sec: number;
  heat: number;
  clipW: number; // summed clip weight around the peak
  clips: number; // viewer clips ending near it
  chatZ: number;
  laughZ: number;
  loudZ: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// The hottest seconds, at least `gapSec` apart.
export function peaks(s: Signals, clips: ViewerClip[], startIso: string, max = 120, gapSec = 120): Peak[] {
  // Clips are sparse (most seconds have none), so a z-score blows up; count
  // them on a log scale instead: one unwatched clip ~1, a pile-up ~4.
  const clipW = smooth(s.clip, 5);
  const chatZ = localZ(smooth(s.chatRate, 30));
  const laughZ = localZ(smooth(s.chatLaugh, 30));
  const loudZ = localZ(smooth(s.loud, 5), 900);
  const heat = new Float32Array(s.durationSec);
  for (let t = 0; t < heat.length; t++) {
    // Chat reacts after the moment, so look 20 s ahead for it.
    const ahead = Math.min(heat.length - 1, t + 20);
    heat[t] =
      0.45 * clamp(1.5 * Math.log1p(clipW[t]! * 11), 0, 6) +
      0.25 * clamp(chatZ[ahead]!, -2, 6) +
      0.15 * clamp(laughZ[ahead]!, -2, 6) +
      0.15 * clamp(loudZ[t]!, -2, 6);
  }
  const order = Array.from(heat.keys()).sort((a, b) => heat[b]! - heat[a]!);
  const taken: number[] = [];
  const start = Date.parse(startIso);
  const ends = clips.map((c) => (Date.parse(c.createdAt) - start) / 1000 - VIEWER_LAG_SEC);
  for (const t of order) {
    if (taken.length >= max) break;
    if (taken.some((u) => Math.abs(u - t) < gapSec)) continue;
    taken.push(t);
  }
  return taken.map((t) => {
    const near = clips.filter((_, i) => ends[i]! >= t - 15 && ends[i]! <= t + 40);
    return {
      sec: t,
      heat: heat[t]!,
      clipW: near.reduce((a, c) => a + 1 + Math.log1p(c.views) / 2, 0),
      clips: near.length,
      chatZ: chatZ[Math.min(heat.length - 1, t + 20)]!,
      laughZ: laughZ[Math.min(heat.length - 1, t + 20)]!,
      loudZ: loudZ[t]!,
    };
  });
}
