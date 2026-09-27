/**
 * Bounded retry policy.
 *
 * Only classified transient failures are retried (`isRetryableFailure`):
 * timeouts, network failures, 429, and selected 5xx. `maxRetries` counts
 * retries after the initial attempt, so `maxRetries: 3` allows at most four
 * attempts. Delays are jittered exponential backoff unless the server supplied
 * a `Retry-After`, which is honored exactly.
 */
import type { FailureRecord } from "@mmstar/results";
import { isRetryableFailure } from "./provider-failure";

export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 30_000;
/** Floor so a jitter draw near zero cannot hammer a failing endpoint. */
export const RETRY_MIN_DELAY_MS = 250;
/**
 * Effective cooldowns longer than this halt scheduling instead of sleeping for
 * hours. Five minutes sits above OpenRouter's documented `Retry-After: 60`
 * example (ordinary throttles keep waiting) and below free-tier daily resets
 * (which halt, preserving pending work for `resume`).
 */
export const RATE_LIMIT_HALT_THRESHOLD_MS = 300_000;

/**
 * True when the failed attempt may be retried: the failure is transient and the
 * attempt budget is not exhausted. `attemptNumber` is 1-based.
 */
export function shouldRetryAttempt(
  failure: FailureRecord,
  attemptNumber: number,
  maxRetries: number,
): boolean {
  if (attemptNumber > maxRetries) return false;
  return isRetryableFailure(failure);
}

export interface RetryDelayInput {
  /** 1-based number of the attempt that failed. */
  attemptNumber: number;
  failure: FailureRecord;
  /** Deterministic jitter source in [0, 1); injected for tests. */
  random: () => number;
}

/**
 * Delay before the next attempt. Priority is `Retry-After` (including zero),
 * then a future `X-RateLimit-Reset`, then the jittered exponential window
 * `[RETRY_MIN_DELAY_MS, min(cap, base * 2^(n-1))]`.
 */
export function computeRetryDelayMs(input: RetryDelayInput): number {
  if (input.failure.retryAfterMs !== null) return input.failure.retryAfterMs;
  const resetMs = input.failure.rateLimitResetMs;
  if (resetMs !== null && resetMs !== undefined) return resetMs;
  const exponential = RETRY_BASE_DELAY_MS * 2 ** (input.attemptNumber - 1);
  const window = Math.min(RETRY_MAX_DELAY_MS, Math.max(RETRY_MIN_DELAY_MS, exponential));
  const jittered = RETRY_MIN_DELAY_MS + input.random() * (window - RETRY_MIN_DELAY_MS);
  return Math.round(jittered);
}
