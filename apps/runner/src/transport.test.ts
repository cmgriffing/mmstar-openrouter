import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTransport } from "./transport";

describe("fetchTransport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards method, headers, body, and signal and reads the response", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("hello", { status: 200, headers: { "x-test": "yes" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const response = await fetchTransport({
      url: "https://example.test/x",
      method: "POST",
      headers: { a: "b" },
      body: "{}",
      signal: controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("hello");
    expect(response.headers["x-test"]).toBe("yes");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/x",
      expect.objectContaining({
        method: "POST",
        headers: { a: "b" },
        body: "{}",
        signal: controller.signal,
      }),
    );
  });

  it("propagates caller cancellation to fetch", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const pending = fetchTransport({
      url: "https://example.test/x",
      method: "GET",
      headers: {},
      body: null,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
  });
});
