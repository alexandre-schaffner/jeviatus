// ffmpeg command for the broadcast: grab the X display (with the pointer, so
// viewers see the clicks), take the browser's audio from PulseAudio (or
// silence) plus the stream's own mix (the lofi, raw PCM on pipe:3), draw the vote band under the game, encode H.264/AAC with a fixed
// 2 s keyframe interval (Kick's ingest rejects longer GOPs), and push FLV over
// RTMPS to every platform (Kick, pump.fun) from that one encode. Optionally
// the same encode also goes to rolling recording segments
// (stream/recordings.ts), for TikTok clips.

import path from "node:path";
import { BAND_COLORS, BAND_FONTS, type BandBox, bandDesign, type BandSlot } from "./bandLayout";
import type { StreamConfig, StreamOutput } from "./config";
import { SEGMENT_PATTERN } from "./recordings";
import { OUT_RATE } from "./audio";

export { bandHeight, bandLines, screenSize } from "./bandLayout";

export interface RecordTarget {
  dir: string;
  segmentSeconds: number;
}

// The band: the folder its text files are written to (stream/band.ts), and
// whether it has the bribe strip and the lab row (stream/bandLayout.ts).
export interface BandLayout {
  dir: string;
  bribes: boolean;
  lab: boolean;
}

// Filtergraph escaping for a quoted option value.
const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

// A file slot is re-read every frame (reload=1); expansion=none keeps '%' in
// PR titles literal.
function drawtext(slot: BandSlot, dir: string): string {
  const source = slot.file ? `textfile='${escape(path.join(dir, slot.file))}':reload=1` : `text='${escape(slot.text ?? "")}'`;
  const x = slot.align === "right" ? `${slot.x}-text_w` : slot.align === "center" ? `${slot.x}+(${slot.maxWidth}-text_w)/2` : String(slot.x);
  return `drawtext=${source}:expansion=none:fontfile='${escape(BAND_FONTS[slot.font])}':fontsize=${slot.size}:fontcolor=${slot.color}:x=${x}:y=${Math.round(slot.y)}`;
}

const drawbox = (b: BandBox) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${b.color}:t=fill`;

export function ffmpegArgs(
  c: Pick<StreamConfig, "outputs" | "width" | "height" | "fps" | "videoKbps" | "audio" | "display"> & {
    // x11: grab the Xvfb screen (the container). pipe: JPEG frames on stdin
    // (stream/screencast.ts, on macOS).
    source?: "x11" | "pipe";
    // The stream's own mix (the music): 48 kHz stereo s16le on pipe:3
    // (stream/audio.ts).
    mix?: boolean;
  },
  band: BandLayout,
  record?: RecordTarget,
): string[] {
  const gop = String(c.fps * 2);
  const kbps = `${c.videoKbps}k`;
  const design = bandDesign({ width: c.width, height: c.height, bribes: band.bribes, lab: band.lab });
  const screen = { width: c.width, height: design.top };
  const pipe = c.source === "pipe";
  // Inputs: 0 video; then the game audio (PulseAudio, or silence), unless the
  // Mac path's only sound is the mix; then the mix.
  const game = !(pipe && c.mix);
  const mixIn = game ? 2 : 1;
  const filter = [
    // Screencast frames can come a pixel off the requested size.
    `[0:v]${pipe ? `scale=${screen.width}:${screen.height},` : ""}pad=${c.width}:${c.height}:0:0:color=${BAND_COLORS.bg}`,
    ...design.boxes.map(drawbox),
    ...design.slots.map((slot) => drawtext(slot, band.dir)),
  ].join(",");
  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-nostats",
    ...(pipe
      ? // Video: the page's own frames, paced to the fps by the screencast.
        ["-thread_queue_size", "1024", "-f", "image2pipe", "-framerate", String(c.fps), "-c:v", "mjpeg", "-i", "pipe:0"]
      : // Video: the whole virtual screen (the browser, in kiosk mode).
        [
          "-thread_queue_size", "1024",
          "-f", "x11grab",
          "-draw_mouse", "1",
          "-framerate", String(c.fps),
          "-video_size", `${screen.width}x${screen.height}`,
          "-i", `${c.display}.0+0,0`,
        ]),
    // Audio: the browser's sink monitor, or a silent track (players expect one).
    ...(!game
      ? []
      : c.audio && !pipe
        ? ["-thread_queue_size", "1024", "-f", "pulse", "-i", "stream.monitor"]
        : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]),
    // Raw PCM needs no probing: without these, ffmpeg waits for 5 s of it.
    ...(c.mix ? ["-thread_queue_size", "1024", "-analyzeduration", "0", "-probesize", "32", "-f", "s16le", "-ar", String(OUT_RATE), "-ch_layout", "stereo", "-i", "pipe:3"] : []),
    "-filter_complex", `${filter}[v]${audioFilter(c.mix === true, game, mixIn)}`,
    "-map", "[v]", "-map", c.mix ? "[a]" : "1:a",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-pix_fmt", "yuv420p",
    "-r", String(c.fps),
    "-g", gop,
    "-keyint_min", gop,
    "-sc_threshold", "0",
    "-b:v", kbps,
    "-maxrate", kbps,
    "-bufsize", `${c.videoKbps * 2}k`,
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", "48000",
    "-ac", "2",
    ...output(c.outputs, record),
  ];
}

// The stream's mix alone, or with the game's sound under it.
function audioFilter(mix: boolean, game: boolean, mixIn: number): string {
  if (!mix) return "";
  const fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
  if (!game) return `;[${mixIn}:a]${fmt}[a]`;
  return `;[1:a]${fmt},volume=0.7[g];[${mixIn}:a]${fmt}[m];[g][m]amix=inputs=2:normalize=0[a]`;
}

const isFile = (target: string) => !/^[a-z]+:\/\//i.test(target);

// A file (dry run) is Matroska unless named .flv: it stays playable if killed.
const format = (target: string) => (isFile(target) && !target.endsWith(".flv") ? "matroska" : "flv");

function output(outputs: StreamOutput[], record: RecordTarget | undefined): string[] {
  const [primary] = outputs;
  if (primary === undefined) throw new Error("no stream output");
  if (outputs.length === 1 && !record) return ["-f", format(primary.url), ...(isFile(primary.url) ? ["-y"] : []), primary.url];
  // tee: one encode, several muxers. The first platform is primary: if it
  // drops, ffmpeg exits and the supervisor reconnects. A secondary platform or
  // the recording (a full disk) must never take it down, so their slaves
  // ignore failures (stream/main.ts reconnects a dropped platform later; see
  // slaveFailure). tee has no global-header flag of its own, and FLV needs the
  // H.264 headers up front.
  const slaves = outputs.map((o, i) => `[f=${format(o.url)}:onfail=${i === 0 ? "abort" : "ignore"}]${teeEscape(o.url)}`);
  if (record) {
    const pattern = `${record.dir.replace(/\/+$/, "")}/${SEGMENT_PATTERN}`;
    slaves.push(`[f=segment:segment_time=${record.segmentSeconds}:segment_format=matroska:strftime=1:reset_timestamps=1:onfail=ignore]${teeEscape(pattern)}`);
  }
  return ["-flags", "+global_header", "-f", "tee", slaves.join("|")];
}

// tee's output list reserves | [ ] and backslash.
const teeEscape = (s: string) => s.replace(/[\\|[\]]/g, (ch) => `\\${ch}`);

// Which platform a tee failure line is about ("Slave muxer #1 failed: …,
// continuing with 2/3 slaves."): slaves are numbered in `outputs` order, the
// recording last. null for any other line, and for the recording.
export function slaveFailure(line: string, outputs: StreamOutput[]): StreamOutput | null {
  const m = /Slave muxer #(\d+) failed/.exec(line);
  return m ? (outputs[Number(m[1])] ?? null) : null;
}

// For logs: the stream key is the last path segment of the ingest URL.
export function redact(output: string): string {
  return /^rtmps?:\/\//i.test(output) ? output.replace(/\/[^/]+$/, "/<stream key>") : output;
}

export function describeOutputs(outputs: StreamOutput[]): string {
  return outputs.map((o) => (o.name === "file" ? o.url : `${o.name} (${redact(o.url)})`)).join(", ");
}
