import type { GameConfig } from "src/core/Schemas";
import { simpleHash } from "src/core/Util";

export interface CreatedGame {
  gameID: string;
  workerPath: string;
}

// POST /api/create_game. In dev (GAME_ENV=dev) a bare UUID is a valid token.
export async function createGame(
  baseUrl: string,
  token: string,
  config: GameConfig,
): Promise<CreatedGame> {
  const res = await fetch(`${baseUrl}/api/create_game`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(config),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`create_game failed (${res.status}): ${JSON.stringify(body)}`);
  }
  if (typeof body.gameID !== "string" || typeof body.workerPath !== "string") {
    throw new Error(`create_game returned an unexpected body: ${JSON.stringify(body)}`);
  }
  return { gameID: body.gameID, workerPath: body.workerPath };
}

// Mirrors ServerEnv.workerPath: games route to workers by hash of the id.
// Dev runs 2 workers (NUM_WORKERS default).
export function workerPathFor(gameID: string): string {
  return `w${simpleHash(gameID) % 2}`;
}

export function wsUrl(baseUrl: string, workerPath: string): string {
  return `${baseUrl.replace(/^http/, "ws")}/${workerPath}`;
}
