// Ambient declarations the vendored client code expects. OpenFront declares
// these in src/client/Main.ts, which the harness never loads.
export {};
declare global {
  interface Window {
    showPage?: (pageId: string) => void;
  }
}
