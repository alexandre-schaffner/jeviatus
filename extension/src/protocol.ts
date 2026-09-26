export const BRIDGE = "jev-openfront-local-v1";

export interface BridgeHello {
  bridge: typeof BRIDGE;
  direction: "extension-to-page";
  type: "hello";
}

export interface BridgeSend {
  bridge: typeof BRIDGE;
  direction: "extension-to-page";
  type: "send";
  socketId: number;
  frame: ArrayBuffer;
}

export type ExtensionToPage = BridgeHello | BridgeSend;

export interface BridgeFrame {
  bridge: typeof BRIDGE;
  direction: "page-to-extension";
  type: "frame";
  socketId: number;
  frame: ArrayBuffer;
}

// The page's own asset resolution data, read from window.BOOTSTRAP_CONFIG in
// the main world. On openfront.io, map binaries live on a CDN behind hashed
// URLs listed in the asset manifest; on the local dev server both are absent
// and plain same-origin /maps/... paths work.
export interface BridgeBootstrap {
  bridge: typeof BRIDGE;
  direction: "page-to-extension";
  type: "bootstrap";
  socketId: number;
  gitCommit?: string;
  cdnBase?: string;
  mapManifest?: Record<string, string>;
}

export interface BridgeSocketState {
  bridge: typeof BRIDGE;
  direction: "page-to-extension";
  type: "socket-open" | "socket-close";
  socketId: number;
  url: string;
}

export type PageToExtension = BridgeFrame | BridgeSocketState | BridgeBootstrap;

export function isPageMessage(value: unknown): value is PageToExtension {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<PageToExtension>;
  return message.bridge === BRIDGE && message.direction === "page-to-extension";
}
