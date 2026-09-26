import { DEFAULT_SETTINGS, normalizeSettings } from "./settings";

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`popup markup is missing ${selector}`);
  return element;
}

const form = required<HTMLFormElement>("form");
const enabled = required<HTMLInputElement>("#enabled");
const apiKey = required<HTMLInputElement>("#apiKey");
const model = required<HTMLInputElement>("#model");
const interval = required<HTMLInputElement>("#interval");
const confidence = required<HTMLInputElement>("#confidence");
const traceUrl = required<HTMLInputElement>("#traceUrl");
const traceToken = required<HTMLInputElement>("#traceToken");
const status = required<HTMLElement>("#status");

async function main(): Promise<void> {
  const initial = normalizeSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
  enabled.checked = initial.enabled;
  apiKey.value = initial.apiKey;
  model.value = initial.model;
  interval.value = String(initial.decisionInterval);
  confidence.value = String(initial.minConfidence);
  traceUrl.value = initial.traceUrl;
  traceToken.value = initial.traceToken;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = normalizeSettings({
      enabled: enabled.checked,
      apiKey: apiKey.value,
      model: model.value,
      decisionInterval: interval.value,
      minConfidence: confidence.value,
      traceUrl: traceUrl.value,
      traceToken: traceToken.value,
    });
    traceUrl.value = next.traceUrl;
    void chrome.storage.local.set(next).then(() => {
      status.textContent = next.enabled ? "Saved · Jev enabled" : "Saved · Jev off";
      if (next.traceUrl !== "") status.textContent += " · logging games";
    });
  });

  enabled.addEventListener("change", () => {
    void chrome.storage.local.set({ enabled: enabled.checked });
    status.textContent = enabled.checked ? "Jev enabled" : "Jev off";
  });
}

void main().catch((error: unknown) => {
  status.textContent = error instanceof Error ? error.message : String(error);
});
