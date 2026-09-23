import { describe, expect, it } from "vitest";
import { isRetryableFailure } from "./provider-failure";
import { normalizeChatCompletion } from "./provider-response";

const NOW = Date.parse("2026-09-23T00:00:00.000Z");

function normalize(body: unknown, status = 200, headers?: Record<string, string>) {
  return normalizeChatCompletion({
    status,
    bodyText: typeof body === "string" ? body : JSON.stringify(body),
    ...(headers === undefined ? {} : { headers }),
    now: NOW,
  });
}

describe("normalizeChatCompletion", () => {
  it("normalizes a successful response with usage, cost, and serving provider", () => {
    const result = normalize({
      id: "gen-1",
      model: "vendor/model",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "A" } }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 20,
        total_tokens: 1220,
        completion_tokens_details: { reasoning_tokens: 12 },
        cost: 0.00123,
      },
      openrouter_metadata: {
        requested: "vendor/model",
        endpoints: { selected: [{ provider: "OpenAI", model: "vendor/model" }] },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      responseId: "gen-1",
      modelUsed: "vendor/model",
      upstreamProvider: "OpenAI",
      finishReason: "stop",
      responseText: "A",
      usage: {
        promptTokens: 1200,
        completionTokens: 20,
        totalTokens: 1220,
        reasoningTokens: 12,
      },
      cost: { kind: "reported", usd: 0.00123 },
    });
  });

  it("keeps unknown usage and cost distinct from zero", () => {
    const result = normalize({
      choices: [{ finish_reason: "stop", message: { content: "B" } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usage).toBeNull();
    expect(result.value.cost).toEqual({ kind: "unknown", usd: null });

    const partial = normalize({
      choices: [{ finish_reason: "stop", message: { content: "B" } }],
      usage: { prompt_tokens: 5 },
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.value.usage).toEqual({
      promptTokens: 5,
      completionTokens: null,
      totalTokens: null,
      reasoningTokens: null,
    });
    expect(partial.value.cost).toEqual({ kind: "unknown", usd: null });
  });

  it("reads the legacy provider field and joins array content parts", () => {
    const result = normalize({
      provider: "DeepInfra",
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: [
              { type: "text", text: "The answer " },
              { type: "text", text: "is C." },
            ],
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.upstreamProvider).toBe("DeepInfra");
    expect(result.value.responseText).toBe("The answer is C.");
  });

  it("retains an empty response text with a length finish reason", () => {
    const result = normalize({
      choices: [{ finish_reason: "length", message: { content: "" } }],
      usage: { completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 300 } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.responseText).toBe("");
    expect(result.value.finishReason).toBe("length");
    expect(result.value.usage?.reasoningTokens).toBe(300);
  });

  it("classifies HTTP failures and parses Retry-After", () => {
    const rateLimited = normalize({ error: { code: 429, message: "Rate limit exceeded" } }, 429, {
      "retry-after": "5",
    });
    expect(rateLimited).toEqual({
      ok: false,
      failure: {
        category: "rate_limit",
        message: "Rate limit exceeded",
        httpStatus: 429,
        retryAfterMs: 5000,
      },
      rawResponse: { error: { code: 429, message: "Rate limit exceeded" } },
    });
    if (!rateLimited.ok) expect(isRetryableFailure(rateLimited.failure)).toBe(true);

    const auth = normalize({ error: { message: "Invalid key" } }, 401);
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.failure.category).toBe("auth");

    const payment = normalize({ error: { message: "Insufficient credits" } }, 402);
    if (!payment.ok) expect(payment.failure.category).toBe("configuration");

    const missing = normalize({ error: { message: "No endpoints found" } }, 404);
    if (!missing.ok) expect(missing.failure.category).toBe("configuration");

    const invalid = normalize({ error: { message: "bad image" } }, 400);
    if (!invalid.ok) expect(invalid.failure.category).toBe("invalid_request");

    const retryableServer = normalize("upstream exploded", 503);
    if (!retryableServer.ok) {
      expect(retryableServer.failure.category).toBe("server_error");
      expect(isRetryableFailure(retryableServer.failure)).toBe(true);
    }

    const permanentServer = normalize("not implemented", 501);
    if (!permanentServer.ok) {
      expect(permanentServer.failure.category).toBe("server_error");
      expect(isRetryableFailure(permanentServer.failure)).toBe(false);
    }
  });

  it("rejects malformed and empty success bodies as terminal failures", () => {
    const malformed = normalize("{not json", 200);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.failure.category).toBe("unknown");
      expect(isRetryableFailure(malformed.failure)).toBe(false);
    }

    const noChoices = normalize({ id: "gen-2" });
    expect(noChoices.ok).toBe(false);
    if (!noChoices.ok) expect(noChoices.failure.message).toContain("no choices");

    const notAnObject = normalize(JSON.stringify([1, 2, 3]), 200);
    expect(notAnObject.ok).toBe(false);
    if (!notAnObject.ok) expect(notAnObject.failure.category).toBe("unknown");
  });

  it("classifies an error object embedded in a 2xx body", () => {
    const result = normalize({ error: { code: 429, message: "slow down" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.category).toBe("rate_limit");
      expect(result.failure.httpStatus).toBe(429);
      expect(isRetryableFailure(result.failure)).toBe(true);
    }

    const stringError = normalize({ error: "upstream unavailable" });
    expect(stringError.ok).toBe(false);
    if (!stringError.ok) expect(stringError.failure.message).toBe("upstream unavailable");
  });
});
