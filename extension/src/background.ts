import { TypeSafeClient } from "@typesafe-ai/sdk";
import { DEFAULT_SETTINGS, normalizeSettings } from "./settings";

interface JevRequest {
  type: "jev:ask";
  state: unknown;
  questions: unknown;
}

function isJevRequest(value: unknown): value is JevRequest {
  return typeof value === "object" && value !== null && (value as Partial<JevRequest>).type === "jev:ask";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
