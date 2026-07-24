// Vitest global setup: extends `expect` with jest-dom matchers.
import "@testing-library/jest-dom";

// jsdom's default (opaque) origin doesn't expose Web Storage, so provide a
// minimal in-memory `localStorage` for code/tests that persist UI state.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

// jsdom has no ResizeObserver; @xyflow/react (the SystemGraph renderer)
// registers one on mount, so tests that render a graph need this stub.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
