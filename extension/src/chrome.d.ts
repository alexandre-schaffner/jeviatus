interface ChromeStorageArea {
  get(defaults?: object): Promise<Record<string, unknown>>;
  set(values: object): Promise<void>;
}

// OpenFront submodule commit the extension bundle was built from, injected by
// scripts/build-extension.ts (esbuild define). Compared against the page's
// BOOTSTRAP_CONFIG.gitCommit to catch a stale wire codec.
declare const __JEV_OPENFRONT_COMMIT__: string;

declare const chrome: {
  storage: {
    local: ChromeStorageArea;
    onChanged: {
      addListener(listener: (changes: unknown, areaName: string) => void): void;
    };
  };
  runtime: {
    getURL(path: string): string;
    sendMessage<T = unknown>(message: unknown): Promise<T>;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  };
};
