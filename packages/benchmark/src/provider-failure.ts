/**
 * OpenRouter transport contract and failure classification.
 *
 * The adapter is runtime-neutral: it sends a plain request descriptor to an
 * injected transport and receives a plain response descriptor. `apps/runner`
 * implements the transport with `fetch`; tests implement it with fixtures.
 * Failure classification is separate from retry policy — chunk 4 decides which
 * classified failures are retried using `isRetryableFailure`.
 */
import type { FailureCategory, FailureRecord } from "@mmstar/results";

export interface ProviderTransportRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** JSON-encoded request body, or null for GET requests. */
  body: string | null;
  signal: AbortSignal;
}

export interface ProviderTransportResponse {
  status: number;
  /** Lower-cased header names are preferred but not required. */
  headers: Record<string, string>;
  body: string;
}

export type ProviderTransport = (
  request: ProviderTransportRequest,
) => Promise<ProviderTransportResponse>;

export interface ProviderSuccess<T> {
  ok: true;
  value: T;
}

export interface ProviderFailure {
  ok: false;
  failure: FailureRecord;
  /**
   * Parsed provider response retained for local audit, or null when unavailable.
   * Never contains credentials; persistence is owned by chunk 5.
   */
  rawResponse: unknown;
}

export type ProviderResult<T> = ProviderSuccess<T> | ProviderFailure;

/** Longest provider message retained in a failure record. */
export const MAX_FAILURE_MESSAGE_CHARS = 500;

/**
 * 5xx statuses treated as transient. Others (for example 501 and 505) are still
 * classified as `server_error` but are not retried by `isRetryableFailure`.
 */
export const RETRYABLE_SERVER_STATUSES: readonly number[] = [
  500, 502, 503, 504, 507, 508, 520, 521, 522, 523, 524, 525, 527, 530,
];

/** Classify an HTTP failure status into a stable failure category. */
export function failureCategoryForStatus(status: number): FailureCategory {
  if (status === 401 || status === 403) return "auth";
  // 402 (credits) and 404 (no endpoints/model) are account/routing configuration.
  if (status === 402 || status === 404) return "configuration";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 499) return "cancelled";
  if (status >= 500 && status <= 599) return "server_error";
  if (status >= 400 && status <= 499) return "invalid_request";
  return "unknown";
}

/**
 * `error.metadata.limit_source` value OpenRouter uses for a transient in-flight
 * spending-budget 402. Every other 402 (credit exhaustion, key limit,
 * `weight_exceeds_budget`) stays a terminal `configuration` failure.
 */
export const IN_FLIGHT_BUDGET_LIMIT_SOURCE = "openrouter_in_flight_budget";

/** Read `error.metadata.limit_source` from a parsed error object, or null. */
export function limitSourceOf(error: unknown): string | null {
  if (!isJsonObject(error)) return null;
  const metadata = error.metadata;
  if (!isJsonObject(metadata)) return null;
  const source = metadata.limit_source;
  return typeof source === "string" ? source : null;
}

/**
 * Classify a status with its parsed error body. A 402 in-flight budget is a
 * retryable `rate_limit`; every other status delegates to
 * `failureCategoryForStatus`.
 */
export function failureCategoryForStatusWithError(status: number, error: unknown): FailureCategory {
  if (status === 402 && limitSourceOf(error) === IN_FLIGHT_BUDGET_LIMIT_SOURCE) {
    return "rate_limit";
  }
  return failureCategoryForStatus(status);
}

/**
 * True when a classified failure is transient under the documented policy:
 * timeouts, network failures, 429, and selected 5xx. Authentication,
 * configuration, invalid-request, content-filter, cancelled, and unknown
 * failures are terminal for the attempt.
 */
export function isRetryableFailure(failure: FailureRecord): boolean {
  switch (failure.category) {
    case "timeout":
    case "network":
    case "rate_limit":
      return true;
    case "server_error":
      return failure.httpStatus === null || RETRYABLE_SERVER_STATUSES.includes(failure.httpStatus);
    default:
      return false;
  }
}

/** Bound and normalize a provider message for durable storage. */
export function boundMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_FAILURE_MESSAGE_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_FAILURE_MESSAGE_CHARS - 1)}…`;
}

/** Best-effort extraction of an actionable provider error message. */
export function extractProviderErrorMessage(bodyText: string, status: number): string {
  const parsed = tryParseJson(bodyText);
  if (isJsonObject(parsed) && isJsonObject(parsed.error)) {
    const message = parsed.error.message;
    if (typeof message === "string" && message.trim() !== "") return boundMessage(message);
  }
  const trimmed = bodyText.trim();
  if (trimmed !== "") return boundMessage(trimmed);
  return `HTTP ${status} response contained no error detail`;
}

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 * `now` is the epoch-millisecond time the response was received.
 */
export function parseRetryAfterMs(value: string | undefined, now: number): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * Parse an `X-RateLimit-Reset` header into a delay in milliseconds. OpenRouter
 * sends epoch milliseconds; a non-numeric value or a time that is not in the
 * future (including epoch seconds mistaken for milliseconds) contributes no
 * delay, so the ladder falls through to exponential backoff rather than
 * sleeping for an absurd interval.
 */
export function parseRateLimitResetMs(value: string | undefined, now: number): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) return null;
  const reset = Number(trimmed);
  if (!Number.isSafeInteger(reset) || reset <= now) return null;
  return reset - now;
}

/** Retry signals carried by a response's rate-limit headers. */
export function parseRetrySignals(
  headers: Readonly<Record<string, string>> | undefined,
  now: number,
): Pick<FailureRecord, "retryAfterMs" | "rateLimitResetMs"> {
  return {
    retryAfterMs: parseRetryAfterMs(readHeader(headers, "retry-after"), now),
    rateLimitResetMs: parseRateLimitResetMs(readHeader(headers, "x-ratelimit-reset"), now),
  };
}

export interface ClassifyHttpFailureInput {
  status: number;
  bodyText: string;
  headers?: Readonly<Record<string, string>>;
  /** Epoch milliseconds used to resolve HTTP-date `Retry-After` values. */
  now: number;
}

export function classifyHttpFailure(input: ClassifyHttpFailureInput): FailureRecord {
  const parsed = tryParseJson(input.bodyText);
  const error = isJsonObject(parsed) ? parsed.error : undefined;
  return {
    category: failureCategoryForStatusWithError(input.status, error),
    message: extractProviderErrorMessage(input.bodyText, input.status),
    httpStatus: input.status,
    ...parseRetrySignals(input.headers, input.now),
  };
}

/** Read a header case-insensitively from a plain header record. */
export function readHeader(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/**
 * Classify an exception thrown by the transport. Caller cancellation and
 * timeout are distinguished by the composed abort signal, never by parsing the
 * exception text.
 */
export function classifyTransportError(
  error: unknown,
  state: { cancelled: boolean; timedOut: boolean },
): FailureRecord {
  if (state.cancelled) {
    return {
      category: "cancelled",
      message: "request was cancelled before a response was received",
      httpStatus: null,
      retryAfterMs: null,
    };
  }
  if (state.timedOut) {
    return {
      category: "timeout",
      message: "request timed out before a response was received",
      httpStatus: null,
      retryAfterMs: null,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    category: "network",
    message: `request failed before a response: ${boundMessage(message)}`,
    httpStatus: null,
    retryAfterMs: null,
  };
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
