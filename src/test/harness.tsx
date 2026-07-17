// Shared page-test scaffolding: a mocked `@tauri-apps/api/core#invoke` plus a
// QueryClient-wrapped render helper. Every `*Page.test.tsx` file previously
// re-declared this near-verbatim (see e.g. the old OrdersPage/PvpPage tests);
// pulled out once here so new page tests (and future ones) just import it.
import type { ReactNode } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

/** The mock backing `invoke()`; tests read call args off it directly with
 *  `expect(invokeMock).toHaveBeenCalledWith(...)`, same as before. */
export const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

/**
 * Wire `invokeMock` from a `{ command: handler }` map. Commands without a
 * handler resolve `undefined` (most queries treat that as "no data yet" via
 * `?? []` / `?? {}`, matching the old per-file default branches) — so a test
 * only needs to describe the commands it actually cares about.
 *
 * A handler can return a value (resolves), throw (rejects with the thrown
 * value), or itself return a rejected promise — whichever reads best at the
 * call site:
 *
 *   mockInvoke({
 *     market_orders: () => ORDERS,
 *     production_profit: () => { throw appError; },
 *   });
 */
export function mockInvoke(
  handlers: Record<string, (args?: unknown) => unknown>,
) {
  invokeMock.mockImplementation((cmd: string, args?: unknown) => {
    const handler = handlers[cmd];
    if (!handler) return Promise.resolve(undefined);
    try {
      return Promise.resolve(handler(args));
    } catch (err) {
      return Promise.reject(err);
    }
  });
}

/**
 * Render `ui` inside a fresh `QueryClientProvider`. `retry: false` is load-
 * bearing: without it, a mutation/query rejection retries (with backoff)
 * before settling into its error state, so error-path tests hang/time out
 * waiting for `isError` to flip.
 */
export function renderWithQuery(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}
