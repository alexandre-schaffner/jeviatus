import { BRIDGE, type ExtensionToPage, type PageToExtension } from "./protocol";

// This bundle runs in the page's main world before OpenFront creates a socket.
// It forwards copies of incoming binary frames to the isolated extension world
// and accepts already-encoded intent frames back. It never sees the API key.
const NativeWebSocket = window.WebSocket;
const sockets = new Map<number, WebSocket>();
const backlog: PageToExtension[] = [];
let nextSocketId = 1;
let extensionReady = false;

interface BootstrapConfig {
  gitCommit?: string;
  cdnBase?: string;
  assetManifest?: Record<string, string>;
}

// Read at socket-open time: this script runs at document_start, before the
// inline script that sets window.BOOTSTRAP_CONFIG has executed.
function bootstrapConfig(): BootstrapConfig | undefined {
  return (window as unknown as { BOOTSTRAP_CONFIG?: BootstrapConfig }).BOOTSTRAP_CONFIG;
}

function bootstrapMessage(socketId: number): PageToExtension {
  const config = bootstrapConfig();
  const mapManifest: Record<string, string> = {};
  for (const [key, url] of Object.entries(config?.assetManifest ?? {})) {
    if (key.startsWith("maps/")) mapManifest[key] = url;
  }
  return {
    bridge: BRIDGE,
    direction: "page-to-extension",
    type: "bootstrap",
    socketId,
    gitCommit: config?.gitCommit,
    cdnBase: config?.cdnBase,
    mapManifest,
  };
}

function publish(message: PageToExtension, transfer: Transferable[] = []): void {
  if (!extensionReady) {
    if (message.type === "frame" && backlog.length >= 2_000) backlog.shift();
    backlog.push(message);
    return;
  }
  window.postMessage(message, location.origin, transfer);
}

function track(socket: WebSocket): WebSocket {
  const socketId = nextSocketId++;
  sockets.set(socketId, socket);
  socket.addEventListener("open", () => {
    publish({ bridge: BRIDGE, direction: "page-to-extension", type: "socket-open", socketId, url: socket.url });
    publish(bootstrapMessage(socketId));
  });
  socket.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const frame = event.data.slice(0);
    publish({ bridge: BRIDGE, direction: "page-to-extension", type: "frame", socketId, frame }, [frame]);
  });
  socket.addEventListener("close", () => {
    sockets.delete(socketId);
    publish({ bridge: BRIDGE, direction: "page-to-extension", type: "socket-close", socketId, url: socket.url });
  });
  return socket;
}

const WrappedWebSocket = new Proxy(NativeWebSocket, {
  construct(Target, args: ConstructorParameters<typeof WebSocket>) {
    return track(Reflect.construct(Target, args) as WebSocket);
  },
});

Object.defineProperty(WrappedWebSocket, "name", { value: "WebSocket" });
window.WebSocket = WrappedWebSocket;

window.addEventListener("message", (event: MessageEvent<ExtensionToPage>) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (message?.bridge !== BRIDGE || message.direction !== "extension-to-page") return;
  if (message.type === "hello") {
    extensionReady = true;
    for (const pending of backlog.splice(0)) {
      const transfer = pending.type === "frame" ? [pending.frame] : [];
      window.postMessage(pending, location.origin, transfer);
    }
    return;
  }
  if (message.type !== "send" || !(message.frame instanceof ArrayBuffer)) return;
  const socket = sockets.get(message.socketId);
  if (socket?.readyState === NativeWebSocket.OPEN) socket.send(message.frame);
});
