import type { OverlayStatus } from "./overlayPanel";

// Jev failures the player can fix, turned into what to do about them.
export function jevFailureStatus(message: string): OverlayStatus | null {
  if (/Extension context invalidated/i.test(message)) {
    return { tone: "error", title: "Extension reloaded", detail: "This tab still runs the previous build and can't reach Jev. Reload the tab." };
  }
  if (/API key/i.test(message) || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) {
    const hint = /popup/i.test(message) ? "" : ". Check the TypeSafe API key in the extension popup";
    return { tone: "error", title: "Jev can't sign in", detail: `${message.replace(/\.$/, "")}${hint}.` };
  }
  if (/timed? ?out|timeout|abort/i.test(message)) {
    return { tone: "warn", title: "Jev is slow", detail: `${message}. Decisions are being skipped until requests get through.` };
  }
  return null;
}
