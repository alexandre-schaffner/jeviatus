// Stream environment. Everything the 24/7 container needs comes from env
// (docker compose passes .env through); secrets never leave this process
// except the stream keys (to ffmpeg) and the TypeSafe key (to the extension).

// One destination of the broadcast.
export interface StreamOutput {
  name: "kick" | "pumpfun" | "file";
  url: string;
}

import type { TtsConfig } from "./voice";

// Viewers bribe Jev with the stream's pump.fun coin (stream/bribes.ts). Only
// public addresses: the stream never holds a key that can move funds.
export interface BribeConfig {
  rpcUrl: string;
  mint: string;
  wallet: string;
  ticker: string;
  // Smallest pot (in whole tokens) that outranks the vote count.
  minTokens: number;
  refreshSeconds: number;
  ledgerFile: string;
}

export interface StreamConfig {
  // container: Xvfb + PulseAudio + xdotool in Docker (stream/Dockerfile).
  // mac: a Chrome for Testing window on this Mac, filmed over DevTools
  // (stream/screencast.ts), with its real GPU; no audio capture.
  platform: "container" | "mac";
  // Where ffmpeg sends the stream: Kick and/or pump.fun (RTMPS ingest + key),
  // or STREAM_OUTPUT alone (any ffmpeg output: a file for a dry run, a local
  // RTMP server). The first one is primary: if it drops, the encoder restarts.
  outputs: StreamOutput[];
  width: number;
  height: number;
  fps: number;
  videoKbps: number;
  audio: boolean;
  display: string;
  typesafeApiKey: string;
  model: string;
  openfrontUrl: string;
  username: string;
  // Chrome DevTools port, loopback only: the driver's only handle on the browser.
  cdpPort: number;
  profileDir: string;
  extensionDir: string;
  // How the driver clicks: xdotool moves the real X pointer (visible on
  // stream); cdp injects events (for running outside the container).
  pointer: "xdotool" | "cdp";
  ballot: {
    repo: string;
    token: string | undefined;
    requireApproval: boolean;
    minVotes: number;
    refreshSeconds: number;
  };
  // Give up on a lobby that hasn't started after this long.
  lobbyTimeoutSeconds: number;
  // Leave a match after this long regardless (public games can stall).
  maxGameMinutes: number;
  // After Jev is eliminated, keep spectating this long before the next lobby.
  spectateAfterDeathSeconds: number;
  // Move the in-game camera to where things happen (stream/camera.ts).
  camera: boolean;
  // Every game's trace (harness/log/sink.ts), beside the Chrome profile. The
  // token is fresh per process: only this driver hands it to the extension.
  trace: {
    dir: string;
    port: number;
    token: string;
  };
  // Rolling recording of the broadcast for TikTok clips (stream/recordings.ts),
  // or null when STREAM_RECORD_HOURS is 0.
  record: { dir: string; segmentSeconds: number; keepHours: number } | null;
  // null when BRIBE_MINT / BRIBE_WALLET aren't set.
  bribe: BribeConfig | null;
  // The on-screen commentator (stream/character.ts), or null when COMMENTATOR=false.
  character: {
    name: string;
    // Claude writes the lines (and answers chat); without a key, canned lines.
    claude: { apiKey: string; model: string } | null;
    tts: TtsConfig;
    // Whose Kick chat to read and answer; null: no chat.
    kickChannel: string | null;
    idleSeconds: number;
    chatGapSeconds: number;
  } | null;
  // Background music under the commentator (stream/music.ts), or null when MUSIC=false.
  music: {
    // Your own tracks; when empty, the original lofi composed by stream/lofi.ts.
    dir: string;
    generatedDir: string;
    volume: number;
  } | null;
  // Live coding between matches (stream/lab.ts), or null when STREAM_LAB=false.
  lab: {
    everyGames: number;
    gamesPerBuild: number;
    maxMinutes: number;
    model: string | null;
    prs: boolean;
    dir: string;
  } | null;
}

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`${name} is required (see stream/README.md)`);
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${raw}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

// Kick and pump.fun both show the ingest as a "Stream URL"
// (rtmps://….live-video.net:443/app/) and the key separately; ffmpeg wants
// them joined.
export function ingestUrl(url: string, key: string): string {
  let base = url.trim().replace(/\/+$/, "");
  // Kick's ingest is Amazon IVS, which only accepts rtmps://<host>:443/app/<key>;
  // a bare host (as sometimes copied from the dashboard) gets the rest.
  const ivs = /^rtmps:\/\/([^/:]+\.live-video\.net)(:\d+)?$/i.exec(base);
  if (ivs) base = `rtmps://${ivs[1]}${ivs[2] ?? ":443"}/app`;
  return `${base}/${key}`;
}

export function loadOutputs(): StreamOutput[] {
  const file = process.env.STREAM_OUTPUT?.trim();
  if (file) return [{ name: "file", url: file }];
  const outputs: StreamOutput[] = [];
  const set = (name: string) => Boolean(process.env[name]?.trim());
  if (set("KICK_STREAM_URL") || set("KICK_STREAM_KEY")) outputs.push({ name: "kick", url: ingestUrl(str("KICK_STREAM_URL"), str("KICK_STREAM_KEY")) });
  if (set("PUMPFUN_STREAM_URL") || set("PUMPFUN_STREAM_KEY")) outputs.push({ name: "pumpfun", url: ingestUrl(str("PUMPFUN_STREAM_URL"), str("PUMPFUN_STREAM_KEY")) });
  if (outputs.length === 0) throw new Error("set KICK_STREAM_URL/KEY and/or PUMPFUN_STREAM_URL/KEY, or STREAM_OUTPUT (see stream/README.md)");
  return outputs;
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function loadBribeConfig(data = "/data"): BribeConfig | null {
  const mint = process.env.BRIBE_MINT?.trim();
  const wallet = process.env.BRIBE_WALLET?.trim();
  if (!mint && !wallet) return null;
  for (const [name, v] of [["BRIBE_MINT", mint], ["BRIBE_WALLET", wallet]] as const) {
    if (!v || !BASE58_ADDRESS.test(v)) throw new Error(`${name} must be a Solana address (bribes need both BRIBE_MINT and BRIBE_WALLET)`);
  }
  return {
    rpcUrl: str("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
    mint: mint!,
    wallet: wallet!,
    ticker: str("BRIBE_TICKER", "JEV").replace(/^\$/, ""),
    minTokens: num("BRIBE_MIN", 1),
    refreshSeconds: num("BRIBE_REFRESH_SECONDS", 20),
    ledgerFile: str("BRIBE_LEDGER", `${data}/bribes.json`),
  };
}

// The voice: COMMENTATOR_VOICE picks the provider; by default the first one
// with a key, else macOS's own `say` on a Mac, else subtitles only.
export function loadTts(mac: boolean): TtsConfig {
  const eleven = process.env.ELEVENLABS_API_KEY?.trim();
  const openai = process.env.OPENAI_API_KEY?.trim();
  const choice = str("COMMENTATOR_VOICE", eleven ? "elevenlabs" : openai ? "openai" : mac ? "say" : "none");
  switch (choice) {
    case "elevenlabs":
      // "Clyde": a gravelly war-veteran voice from ElevenLabs' default library.
      return { provider: "elevenlabs", apiKey: str("ELEVENLABS_API_KEY"), voiceId: str("ELEVENLABS_VOICE_ID", "2EiwWnXFnvU5JabPnv8n"), model: str("ELEVENLABS_MODEL", "eleven_flash_v2_5") };
    case "openai":
      return { provider: "openai", apiKey: str("OPENAI_API_KEY"), voice: str("OPENAI_VOICE", "onyx"), model: str("OPENAI_TTS_MODEL", "gpt-4o-mini-tts") };
    case "say":
      return { provider: "say", voice: str("SAY_VOICE", "Rocko (English (US))") };
    case "none":
      return { provider: "none" };
    default:
      throw new Error(`COMMENTATOR_VOICE must be elevenlabs, openai, say or none, got ${choice}`);
  }
}

// Where the profile, traces, recordings and bribe ledger live: the volume in
// the container, Application Support on a Mac.
function dataDir(platform: StreamConfig["platform"]): string {
  if (platform === "container") return str("STREAM_DATA_DIR", "/data");
  return str("STREAM_DATA_DIR", `${process.env.HOME}/Library/Application Support/jeviatus`);
}

export function loadStreamConfig(): StreamConfig {
  const platform = str("STREAM_PLATFORM", process.platform === "darwin" ? "mac" : "container") === "mac" ? "mac" : "container";
  const data = dataDir(platform);
  const mac = platform === "mac";
  return {
    platform,
    outputs: loadOutputs(),
    width: num("STREAM_WIDTH", 1280),
    height: num("STREAM_HEIGHT", 720),
    fps: num("STREAM_FPS", 30),
    videoKbps: num("STREAM_VIDEO_KBPS", 4500),
    // The Mac path films frames only; capturing Chrome's audio needs a loopback device.
    audio: mac ? false : bool("STREAM_AUDIO", true),
    display: str("DISPLAY", ":99"),
    typesafeApiKey: str("TYPESAFE_API_KEY"),
    model: str("JEV_MODEL", "jev-1.13.0"),
    openfrontUrl: str("STREAM_OPENFRONT_URL", "https://openfront.io").replace(/\/+$/, ""),
    username: str("JEV_USERNAME", "jeviatus"),
    cdpPort: num("CDP_PORT", 9222),
    profileDir: str("CHROME_PROFILE_DIR", `${data}/chrome-profile`),
    extensionDir: str("EXTENSION_DIR", "dist/jev-openfront-extension"),
    pointer: str("POINTER", mac ? "cdp" : "xdotool") === "cdp" ? "cdp" : "xdotool",
    ballot: {
      repo: str("BALLOT_REPO", "alexandre-schaffner/jeviatus"),
      token: process.env.GITHUB_TOKEN?.trim() || undefined,
      requireApproval: bool("BALLOT_REQUIRE_APPROVAL", true),
      minVotes: num("BALLOT_MIN_VOTES", 1),
      refreshSeconds: num("BALLOT_REFRESH_SECONDS", process.env.GITHUB_TOKEN ? 60 : 300),
    },
    lobbyTimeoutSeconds: num("LOBBY_TIMEOUT_SECONDS", 240),
    maxGameMinutes: num("MAX_GAME_MINUTES", 60),
    spectateAfterDeathSeconds: num("SPECTATE_AFTER_DEATH_SECONDS", 20),
    camera: bool("STREAM_CAMERA", true),
    trace: {
      dir: str("TRACE_DIR", `${data}/runs`),
      port: num("TRACE_PORT", 9231),
      token: crypto.randomUUID(),
    },
    record:
      num("STREAM_RECORD_HOURS", 6) > 0
        ? { dir: str("STREAM_RECORD_DIR", `${data}/recordings`), segmentSeconds: num("STREAM_RECORD_SEGMENT_SECONDS", 300), keepHours: num("STREAM_RECORD_HOURS", 6) }
        : null,
    bribe: loadBribeConfig(data),
    character: bool("COMMENTATOR", true)
      ? {
          name: str("COMMENTATOR_NAME", "General Static"),
          claude: process.env.ANTHROPIC_API_KEY?.trim() ? { apiKey: str("ANTHROPIC_API_KEY"), model: str("COMMENTATOR_MODEL", "claude-haiku-4-5-20251001") } : null,
          tts: loadTts(mac),
          kickChannel: process.env.KICK_CHANNEL?.trim().replace(/^https?:\/\/(www\.)?kick\.com\//i, "").replace(/\/.*$/, "") || null,
          idleSeconds: num("COMMENTATOR_IDLE_SECONDS", 35),
          chatGapSeconds: num("COMMENTATOR_CHAT_GAP_SECONDS", 12),
        }
      : null,
    music: bool("MUSIC", true) ? { dir: str("MUSIC_DIR", `${data}/music`), generatedDir: `${data}/lofi`, volume: num("MUSIC_VOLUME", 0.22) } : null,
    lab: bool("STREAM_LAB", true)
      ? {
          everyGames: num("STREAM_LAB_EVERY_GAMES", 2),
          gamesPerBuild: num("STREAM_LAB_GAMES_PER_BUILD", 4),
          maxMinutes: num("STREAM_LAB_MAX_MINUTES", 12),
          model: process.env.STREAM_LAB_MODEL?.trim() || null,
          prs: bool("STREAM_LAB_PRS", false),
          dir: `${data}/lab`,
        }
      : null,
  };
}
