// The soundtrack: a track you drop in music/ (tempo from its name, e.g.
// "drop_128bpm.mp3", or --bpm), or a built-in synthesized beat so a video
// never needs licensed audio. Cuts land on bar lines either way.

import { readdirSync } from "node:fs";
import path from "node:path";

export interface Music {
  // An audio file, or null for the built-in beat.
  file: string | null;
  bpm: number;
  // Seconds into the track where the video starts (e.g. at the drop).
  startSec: number;
}

export const DEFAULT_BPM = 120;
const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i;

export function bpmFromName(file: string): number | null {
  const m = /(\d{2,3})\s*bpm/i.exec(path.basename(file));
  const bpm = m ? Number(m[1]) : NaN;
  return bpm >= 60 && bpm <= 200 ? bpm : null;
}

// A random track from a directory, or the file itself. Seeded so a video
// re-renders with the same song.
export function chooseTrack(pathOrDir: string, seed: number): string | null {
  if (AUDIO.test(pathOrDir)) return pathOrDir;
  let names: string[];
  try {
    names = readdirSync(pathOrDir).filter((n) => AUDIO.test(n)).sort();
  } catch {
    return null;
  }
  return names.length > 0 ? path.join(pathOrDir, names[Math.abs(seed) % names.length]!) : null;
}

export const barSeconds = (bpm: number) => (4 * 60) / bpm;

// An aevalsrc expression for a driving minor-key beat: kick on every beat,
// clap on 2 and 4, off-beat hats, and bass and pad following Am-F-C-G, both
// ducking under the kick. Commas are fine inside the quotes it goes in.
export function beatExpression(bpm: number): string {
  const beat = 60 / bpm;
  const bar = 4 * beat;
  // Chord roots (Hz) and triads, one chord per bar.
  const roots = [55, 43.65, 65.41, 49];
  const triads = [
    [220, 261.63, 329.63],
    [174.61, 220, 261.63],
    [261.63, 329.63, 392],
    [196, 246.94, 293.66],
  ];
  const pickBy = (vals: number[]) => `if(eq(ld(1),0),${vals[0]},if(eq(ld(1),1),${vals[1]},if(eq(ld(1),2),${vals[2]},${vals[3]})))`;
  const sine = (freq: string) => `sin(2*PI*${freq}*t)`;
  // ffmpeg expressions have ten variables (0-9); random() keeps its seed in one.
  return [
    `st(0,mod(t,${beat}))`, // time since the beat
    `st(1,mod(floor(t/${bar}),4))`, // chord index
    `st(2,1-exp(-9*ld(0)))`, // sidechain pump
    `st(3,0.9*sin(2*PI*(45*ld(0)+4*(1-exp(-30*ld(0)))))*exp(-7*ld(0)))`, // kick: pitch drop 165 -> 45 Hz
    `st(4,0.3*(2*random(5)-1)*exp(-16*mod(t+${beat},${2 * beat})))`, // clap on 2 and 4
    `st(6,0.07*(2*random(7)-1)*exp(-70*mod(t+${beat / 2},${beat})))`, // off-beat hats
    `st(8,0.32*${sine(pickBy(roots))}*ld(2))`, // bass
    `st(9,0.05*ld(2)*(${[0, 1, 2].map((k) => sine(pickBy(triads.map((c) => c[k]!)))).join("+")}))`, // pad
    "0.8*(ld(3)+ld(4)+ld(6)+ld(8)+ld(9))",
  ].join(";");
}
