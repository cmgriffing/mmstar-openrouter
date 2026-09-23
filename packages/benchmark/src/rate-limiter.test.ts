import { describe, expect, it } from "vitest";
import { RATE_LIMIT_WINDOW_MS, RequestRateLimiter } from "./rate-limiter";

const T0 = Date.parse("2026-09-23T00:00:00.000Z");

function limiter(limit: number, start = T0) {
  let now = start;
  const instance = new RequestRateLimiter(limit, () => now);
  return {
    instance,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("RequestRateLimiter", () => {
  it("allows requests up to the limit and reports when the next slot opens", () => {
    const { instance } = limiter(2);
    expect(instance.nextAvailableAt()).toBeNull();
    instance.recordRequest();
    expect(instance.nextAvailableAt()).toBeNull();
    instance.recordRequest();
    expect(instance.nextAvailableAt()).toBe(T0 + RATE_LIMIT_WINDOW_MS);
  });

  it("slides the window so capacity frees exactly one window after the first request", () => {
    const { instance, advance } = limiter(1);
    instance.recordRequest();

    advance(RATE_LIMIT_WINDOW_MS - 1);
    expect(instance.nextAvailableAt()).toBe(T0 + RATE_LIMIT_WINDOW_MS);

    advance(1);
    expect(instance.nextAvailableAt()).toBeNull();
  });

  it("accounts for interleaved requests across the run", () => {
    const { instance, advance } = limiter(2);
    instance.recordRequest();
    advance(30_000);
    instance.recordRequest();
    // Both requests occupy the window; the next slot opens when the first expires.
    expect(instance.nextAvailableAt()).toBe(T0 + RATE_LIMIT_WINDOW_MS);
    advance(30_000);
    expect(instance.nextAvailableAt()).toBeNull();
    instance.recordRequest();
    // A third request at t0+60s now holds the window until t0+90s.
    expect(instance.nextAvailableAt()).toBe(T0 + RATE_LIMIT_WINDOW_MS + 30_000);
  });

  it("drops expired timestamps", () => {
    const { instance, advance } = limiter(2);
    instance.recordRequest();
    instance.recordRequest();
    advance(RATE_LIMIT_WINDOW_MS + 1);
    expect(instance.countInWindow()).toBe(0);
    expect(instance.nextAvailableAt()).toBeNull();
  });
});
