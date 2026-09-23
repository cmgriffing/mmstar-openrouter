import type { FailureRecord } from "@mmstar/results";
import { describe, expect, it } from "vitest";
import {
  computeRetryDelayMs,
  RETRY_MAX_DELAY_MS,
  RETRY_MIN_DELAY_MS,
  shouldRetryAttempt,
} from "./retry-policy";

function failure(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    category: "network",
    message: "boom",
    httpStatus: null,
    retryAfterMs: null,
    ...overrides,
  };
}

const half = () => 0.5;

describe("shouldRetryAttempt", () => {
  it("retries only transient failures within the retry budget", () => {
    expect(shouldRetryAttempt(failure(), 1, 3)).toBe(true);
    expect(shouldRetryAttempt(failure({ category: "rate_limit" }), 1, 3)).toBe(true);
    expect(shouldRetryAttempt(failure({ category: "server_error", httpStatus: 503 }), 3, 3)).toBe(
      true,
    );
    expect(shouldRetryAttempt(failure({ category: "auth" }), 1, 3)).toBe(false);
    expect(shouldRetryAttempt(failure({ category: "invalid_request" }), 1, 3)).toBe(false);
  });

  it("never exceeds maxRetries after the initial attempt", () => {
    // maxRetries=3 means attempts 1..4; attempt 4 is the final one.
    expect(shouldRetryAttempt(failure(), 3, 3)).toBe(true);
    expect(shouldRetryAttempt(failure(), 4, 3)).toBe(false);
    expect(shouldRetryAttempt(failure(), 1, 0)).toBe(false);
  });
});

describe("computeRetryDelayMs", () => {
  it("grows the jittered backoff window exponentially", () => {
    // Windows: attempt 1 [250, 1000], attempt 2 [250, 2000], attempt 3 [250, 4000].
    expect(computeRetryDelayMs({ attemptNumber: 1, failure: failure(), random: half })).toBe(625);
    expect(computeRetryDelayMs({ attemptNumber: 2, failure: failure(), random: half })).toBe(1125);
    expect(computeRetryDelayMs({ attemptNumber: 3, failure: failure(), random: half })).toBe(2125);
  });

  it("caps the backoff window", () => {
    expect(computeRetryDelayMs({ attemptNumber: 10, failure: failure(), random: half })).toBe(
      RETRY_MIN_DELAY_MS + (RETRY_MAX_DELAY_MS - RETRY_MIN_DELAY_MS) / 2,
    );
    expect(computeRetryDelayMs({ attemptNumber: 10, failure: failure(), random: () => 0 })).toBe(
      RETRY_MIN_DELAY_MS,
    );
  });

  it("never exceeds the capped window for any jitter value", () => {
    expect(
      computeRetryDelayMs({ attemptNumber: 10, failure: failure(), random: () => 0.999 }),
    ).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
  });

  it("honors Retry-After exactly, including zero", () => {
    expect(
      computeRetryDelayMs({
        attemptNumber: 1,
        failure: failure({ category: "rate_limit", retryAfterMs: 5000 }),
        random: half,
      }),
    ).toBe(5000);
    expect(
      computeRetryDelayMs({
        attemptNumber: 1,
        failure: failure({ category: "rate_limit", retryAfterMs: 0 }),
        random: half,
      }),
    ).toBe(0);
  });
});
