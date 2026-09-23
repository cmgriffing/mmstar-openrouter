import { describe, expect, it } from "vitest";
import { buildPrompt, PROMPT_INSTRUCTION } from "./prompt";
import type { PreflightEvaluation } from "./provider-preflight";
import {
  buildChatCompletionRequest,
  isFixedModelId,
  ProviderRequestError,
} from "./provider-request";

const prompt = buildPrompt({
  fixtureId: "0",
  question: "Which option is correct?",
  image: { mediaType: "image/jpeg", base64: "AAAA" },
});

function evaluation(overrides: Partial<PreflightEvaluation> = {}): PreflightEvaluation {
  return {
    evaluationId: "a::high",
    modelAlias: "a",
    openRouterId: "vendor/model",
    reasoningMode: "high",
    rateLimitGroup: "group",
    provider: null,
    reasoning: { effort: "high" },
    ...overrides,
  };
}

describe("buildChatCompletionRequest", () => {
  it("builds a multimodal user message from the answer-free prompt", () => {
    const request = buildChatCompletionRequest({ evaluation: evaluation(), prompt });

    expect(request).toEqual({
      model: "vendor/model",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${PROMPT_INSTRUCTION}\n\nWhich option is correct?`,
            },
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,AAAA" },
            },
          ],
        },
      ],
      reasoning: { effort: "high" },
      provider: { require_parameters: true },
    });
  });

  it("omits the reasoning parameter entirely for default and non-reasoning models", () => {
    const request = buildChatCompletionRequest({
      evaluation: evaluation({ reasoning: null }),
      prompt,
    });
    expect("reasoning" in request).toBe(false);
    expect(Object.keys(request)).toEqual(["model", "messages", "provider"]);
  });

  it("maps explicit none to an effort request", () => {
    const request = buildChatCompletionRequest({
      evaluation: evaluation({ reasoningMode: "none", reasoning: { effort: "none" } }),
      prompt,
    });
    expect(request.reasoning).toEqual({ effort: "none" });
  });

  it("maps provider routing to snake_case with require_parameters always set", () => {
    const request = buildChatCompletionRequest({
      evaluation: evaluation({
        provider: {
          only: ["openai", "azure"],
          order: ["openai"],
          allowFallbacks: false,
          sort: "latency",
        },
      }),
      prompt,
    });
    expect(request.provider).toEqual({
      only: ["openai", "azure"],
      order: ["openai"],
      allow_fallbacks: false,
      sort: "latency",
      require_parameters: true,
    });
  });

  it("rejects dynamic routers and variant suffixes from a fixed-model plan", () => {
    expect(isFixedModelId("openrouter/auto")).toBe(false);
    expect(isFixedModelId("openrouter/free")).toBe(false);
    expect(isFixedModelId("vendor/model:nitro")).toBe(false);
    expect(isFixedModelId("vendor/model")).toBe(true);

    expect(() =>
      buildChatCompletionRequest({
        evaluation: evaluation({ openRouterId: "openrouter/auto" }),
        prompt,
      }),
    ).toThrow(ProviderRequestError);
    expect(() =>
      buildChatCompletionRequest({
        evaluation: evaluation({ openRouterId: "vendor/model:floor" }),
        prompt,
      }),
    ).toThrow(ProviderRequestError);
  });
});
