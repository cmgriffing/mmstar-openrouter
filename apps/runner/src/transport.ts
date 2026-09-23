/**
 * `fetch`-based transport for the runner.
 *
 * This is the only place the adapter touches a real network API. Bun and Node
 * both provide `fetch`, `Headers`, and `AbortSignal`; tests for the adapter use
 * an injected mock transport instead of this one.
 */
import type { ProviderTransport } from "@mmstar/benchmark";

export const fetchTransport: ProviderTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === null ? {} : { body: request.body }),
    signal: request.signal,
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    status: response.status,
    headers,
    body: await response.text(),
  };
};
