/**
 * Response normalization.
 *
 * Provider responses become the bounded, versioned records the persistence layer
 * stores: requested and actual model/provider stay separate, usage and cost are
 * nullable rather than zero, and failures are classified without echoing
 * credentials. The parsed response body is returned for local audit; the public
 * projection is defined in chunk 8.
 */
import type { CostRecord, FailureRecord, UsageRecord } from "@mmstar/results";
import {
  classifyHttpFailure,
  failureCategoryForStatus,
  isJsonObject,
  type ProviderFailure,
  type ProviderResult,
  tryParseJson,
} from "./provider-failure";

export interface NormalizedCompletion {
  responseId: string | null;
  /** Model ID reported by the response; may differ from the requested ID in form only. */
  modelUsed: string | null;
  /** Serving provider reported by the response when known, else null. */
  upstreamProvider: string | null;
  finishReason: string | null;
  /** Visible response text; null when the response carried no text content. */
  responseText: string | null;
  usage: UsageRecord | null;
  /** Reported cost when the gateway supplied one, otherwise unknown (never zero). */
  cost: CostRecord;
  rawResponse: unknown;
}

export interface NormalizeCompletionInput {
  status: number;
  bodyText: string;
  headers?: Readonly<Record<string, string>>;
  /** Epoch milliseconds used to resolve HTTP-date `Retry-After` values. */
  now: number;
}

export function normalizeChatCompletion(
  input: NormalizeCompletionInput,
): ProviderResult<NormalizedCompletion> {
  const parsed = tryParseJson(input.bodyText);
  const httpFailure = input.status < 200 || input.status >= 300;

  if (parsed === null) {
    if (httpFailure) return failureFromStatus(input, null);
    return unknownFailure("response body was not valid JSON", input.status, null);
  }
  if (!isJsonObject(parsed)) {
    if (httpFailure) return failureFromStatus(input, parsed);
    return unknownFailure("response body was not a JSON object", input.status, parsed);
  }

  if (httpFailure) return failureFromStatus(input, parsed);

  const choices = Array.isArray(parsed.choices) ? parsed.choices : null;
  if (parsed.error !== undefined && (choices === null || choices.length === 0)) {
    return {
      ok: false,
      failure: classifyEmbeddedError(parsed.error, input.status),
      rawResponse: parsed,
    };
  }
  if (choices === null || choices.length === 0) {
    return unknownFailure("response contained no choices", input.status, parsed);
  }

  const choice = choices[0];
  if (!isJsonObject(choice)) {
    return unknownFailure("first response choice was not an object", input.status, parsed);
  }
  const message = isJsonObject(choice.message) ? choice.message : null;
  const { usage, cost } = parseUsageAndCost(parsed.usage);

  return {
    ok: true,
    value: {
      responseId: typeof parsed.id === "string" ? parsed.id : null,
      modelUsed: typeof parsed.model === "string" ? parsed.model : null,
      upstreamProvider: parseUpstreamProvider(parsed),
      finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
      responseText: parseResponseText(message),
      usage,
      cost,
      rawResponse: parsed,
    },
  };
}

function failureFromStatus(input: NormalizeCompletionInput, rawResponse: unknown): ProviderFailure {
  return {
    ok: false,
    failure: classifyHttpFailure({
      status: input.status,
      bodyText: input.bodyText,
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      now: input.now,
    }),
    rawResponse,
  };
}

function unknownFailure(
  message: string,
  httpStatus: number,
  rawResponse: unknown,
): ProviderFailure {
  const failure: FailureRecord = {
    category: "unknown",
    message,
    httpStatus,
    retryAfterMs: null,
  };
  return { ok: false, failure, rawResponse };
}

/** Classify an `error` object delivered with a 2xx body. */
function classifyEmbeddedError(error: unknown, httpStatus: number): FailureRecord {
  if (typeof error === "string" && error.trim() !== "") {
    return { category: "unknown", message: error.trim(), httpStatus, retryAfterMs: null };
  }
  if (isJsonObject(error)) {
    const code = error.code;
    const numericCode = typeof code === "number" && code >= 400 && code <= 599 ? code : httpStatus;
    const message = typeof error.message === "string" && error.message.trim() !== "";
    return {
      category: failureCategoryForStatus(numericCode),
      message: message
        ? (error.message as string)
        : `embedded provider error (code ${numericCode})`,
      httpStatus: numericCode,
      retryAfterMs: null,
    };
  }
  return {
    category: "unknown",
    message: "response contained an unrecognized embedded error",
    httpStatus,
    retryAfterMs: null,
  };
}

function parseUsageAndCost(value: unknown): { usage: UsageRecord | null; cost: CostRecord } {
  const unknownCost: CostRecord = { kind: "unknown", usd: null };
  if (!isJsonObject(value)) return { usage: null, cost: unknownCost };

  const details = isJsonObject(value.completion_tokens_details)
    ? value.completion_tokens_details
    : null;
  const usage: UsageRecord = {
    promptTokens: readToken(value.prompt_tokens),
    completionTokens: readToken(value.completion_tokens),
    totalTokens: readToken(value.total_tokens),
    reasoningTokens: details === null ? null : readToken(details.reasoning_tokens),
  };

  const reported = value.cost;
  const cost: CostRecord =
    typeof reported === "number" && Number.isFinite(reported) && reported >= 0
      ? { kind: "reported", usd: reported }
      : unknownCost;

  return { usage, cost };
}

function readToken(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function parseResponseText(message: Record<string, unknown> | null): string | null {
  if (message === null) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (isJsonObject(part) && part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    if (parts.length === 0) return null;
    return parts.join("");
  }
  return null;
}

function parseUpstreamProvider(body: Record<string, unknown>): string | null {
  const metadata = isJsonObject(body.openrouter_metadata) ? body.openrouter_metadata : null;
  if (metadata !== null) {
    const endpoints = isJsonObject(metadata.endpoints) ? metadata.endpoints : null;
    const selected = endpoints?.selected;
    if (Array.isArray(selected)) {
      for (const entry of selected) {
        if (isJsonObject(entry) && typeof entry.provider === "string" && entry.provider !== "") {
          return entry.provider;
        }
      }
    } else if (
      isJsonObject(selected) &&
      typeof selected.provider === "string" &&
      selected.provider !== ""
    ) {
      return selected.provider;
    }
    if (typeof metadata.provider === "string" && metadata.provider !== "") {
      return metadata.provider;
    }
  }
  const legacy = body.provider;
  if (typeof legacy === "string" && legacy !== "") return legacy;
  return null;
}
