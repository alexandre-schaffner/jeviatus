import { TypeSafeClient } from "@typesafe-ai/sdk";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings";
import { isTraceBatch, type TraceBatch } from "./traceSink";

interface JevRequest {
  type: "jev:ask";
  label: string;
  state: unknown;
  questions: unknown;
}

function isJevRequest(value: unknown): value is JevRequest {
  return typeof value === "object" && value !== null && (value as Partial<JevRequest>).type === "jev:ask";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isTraceBatch(message)) {
    // One post at a time, so batches reach the sink in order.
    traceQueue = traceQueue.then(() => postTrace(message));
    void traceQueue.then(() => sendResponse({ ok: true }));
    return true;
  }
  if (!isJevRequest(message)) return;
  void ask(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error: unknown) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  return true;
});

async function ask(request: JevRequest): Promise<unknown> {
  const settings = normalizeSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
  if (settings.apiKey === "") throw new Error("Add a TypeSafe API key in the Jev extension popup");
  if (!settings.enabled) throw new Error("Jev was switched off");
  const client = new TypeSafeClient({
    apiKey: settings.apiKey,
    defaultModel: settings.model,
    timeout: 4_000,
    retry: { maxRetries: 1, backoffInitialMs: 200, backoffMaxMs: 500 },
  });
  return client.systemOne({
    state: request.state as never,
    questions: request.questions as never,
    model: settings.model,
  });
}

let traceQueue: Promise<void> = Promise.resolve();
let traceWarned = false;

// The custom header makes a browser preflight any cross-origin post, which
// the sink never answers: web pages can't write to it, this worker (with host
// permission for loopback) can.
async function postTrace(batch: TraceBatch): Promise<void> {
  const settings = normalizeSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
  if (settings.traceUrl === "") return;
  try {
    const response = await fetch(settings.traceUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jev-trace-token": settings.traceToken },
      body: JSON.stringify({ gameID: batch.gameID, events: batch.events }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    traceWarned = false;
  } catch (error) {
    if (!traceWarned) console.warn(`[Jev extension] trace sink at ${settings.traceUrl} unreachable`, error);
    traceWarned = true;
  }
}
