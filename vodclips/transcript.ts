// whisper.cpp (whisper-cli) over a stream's audio. A long stream is split
// into half-hour chunks so a crash costs one chunk and several can run at
// once; each chunk's JSON is read back with its offset added.

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface Line {
  from: number; // seconds into the VOD
  to: number;
  text: string;
}

export const CHUNK_SEC = 1800;

type WhisperJson = { transcription: { offsets: { from: number; to: number }; text: string }[] };

function read(file: string, offsetSec: number): Line[] {
  const d = JSON.parse(readFileSync(file, "utf8")) as WhisperJson;
  return d.transcription
    .map((s) => ({ from: offsetSec + s.offsets.from / 1000, to: offsetSec + s.offsets.to / 1000, text: s.text.trim() }))
    .filter((l) => l.text && !/^\[.*\]$|^\(.*\)$/.test(l.text));
}

// Chunks are c00.json, c01.json, ... in dir.
export function loadTranscript(dir: string): Line[] {
  return readdirSync(dir)
    .filter((f) => /^c\d+\.json$/.test(f))
    .sort()
    .flatMap((f) => read(path.join(dir, f), Number(f.slice(1, -5)) * CHUNK_SEC));
}

export function between(lines: Line[], from: number, to: number): Line[] {
  return lines.filter((l) => l.to > from && l.from < to);
}

const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} failed: ${err.slice(-400)}`);
};

export interface WhisperModels {
  dir: string; // holds ggml-*.bin
  fast: string; // the whole-stream pass
  accurate: string; // captions
  vad: string;
}

export const MODELS: WhisperModels = {
  dir: path.join(process.env.HOME ?? "", ".cache/whisper-cpp"),
  fast: "ggml-base.en.bin",
  accurate: "ggml-large-v3-turbo-q5_0.bin",
  vad: "ggml-silero-v5.1.2.bin",
};

// The whole stream: wav -> chunks -> one JSON per chunk, `parallel` at a time.
export async function transcribe(wav: string, dir: string, parallel = 3, log: (l: string) => void = () => {}): Promise<void> {
  const chunks = path.join(dir, "chunks");
  mkdirSync(chunks, { recursive: true });
  if (!readdirSync(chunks).some((f) => f.endsWith(".wav")))
    await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", wav, "-f", "segment", "-segment_time", String(CHUNK_SEC), "-c", "copy", path.join(chunks, "c%02d.wav")]);
  const todo = readdirSync(chunks)
    .filter((f) => f.endsWith(".wav"))
    .sort()
    .filter((f) => !existsSync(path.join(dir, f.replace(".wav", ".json"))));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++]!;
      await run([
        "whisper-cli", "-m", path.join(MODELS.dir, MODELS.fast), "-f", path.join(chunks, f), "-t", "4",
        "--vad", "-vm", path.join(MODELS.dir, MODELS.vad), "-oj", "-of", path.join(dir, f.replace(".wav", "")), "-np",
      ]);
      log(`[whisper] ${f}`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
}

export interface Word {
  from: number; // seconds into the clip
  to: number;
  text: string;
}

// Word timings for one clip's audio, with the accurate model (for captions).
export async function words(wav: string, outBase: string): Promise<Word[]> {
  if (!existsSync(`${outBase}.json`))
    await run([
      "whisper-cli", "-m", path.join(MODELS.dir, MODELS.accurate), "-f", wav, "-t", "8",
      "-ml", "1", "-sow", "-oj", "-of", outBase, "-np",
    ]);
  const d = JSON.parse(readFileSync(`${outBase}.json`, "utf8")) as WhisperJson;
  return d.transcription
    .map((s) => ({ from: s.offsets.from / 1000, to: s.offsets.to / 1000, text: s.text.trim() }))
    .filter((w) => w.text && !/^\[.*\]$/.test(w.text));
}

// One window of the stream again, with the accurate model and short lines
// (so there are more places to cut). Times are VOD seconds.
export async function retranscribe(wav: string, fromSec: number, toSec: number, outBase: string): Promise<Line[]> {
  if (!existsSync(`${outBase}.json`)) {
    const part = `${outBase}.wav`;
    await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", fromSec.toFixed(2), "-t", (toSec - fromSec).toFixed(2), "-i", wav, "-c:a", "pcm_s16le", part]);
    await run([
      "whisper-cli", "-m", path.join(MODELS.dir, MODELS.accurate), "-f", part, "-t", "8",
      "--vad", "-vm", path.join(MODELS.dir, MODELS.vad), "-ml", "70", "-sow", "-oj", "-of", outBase, "-np",
    ]);
  }
  return read(`${outBase}.json`, fromSec);
}
