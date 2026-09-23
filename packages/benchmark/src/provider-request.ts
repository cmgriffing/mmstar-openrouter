/**
 * Multimodal chat-completion request construction.
 *
 * The request is built only from the frozen preflight decision and the
 * answer-free prompt projection. `model` is always the fixed OpenRouter ID from
 * the plan — dynamic router aliases and variant suffixes are rejected here as a
 * second line of defense after config validation. Provider routing preferences
 * are mapped to the upstream snake_case payload with `require_parameters: true`
 * always set.
 */
import {
  DYNAMIC_MODEL_IDS,
  MODEL_ID_REGEX,
  MODEL_VARIANT_SEPARATOR,
  type ProviderRoutingConfig,
} from "@mmstar/config";
import type { PromptPayload } from "./prompt";
import type { PreflightEvaluation } from "./provider-preflight";

export class ProviderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

/** Upstream `provider` object; `require_parameters` is not configurable. */
export interface ProviderRoutingPayload {
  only?: string[];
  order?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  sort?: string;
  require_parameters: true;
}

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ChatMessage {
  role: "user";
  content: ChatContentPart[];
}

export interface ChatCompletionRequestPayload {
  model: string;
  messages: ChatMessage[];
  /** Omitted entirely when the preflight decision is to omit the parameter. */
  reasoning?: { effort: string };
  provider: ProviderRoutingPayload;
}

/** True for concrete model IDs only: no dynamic routers, no variant suffixes. */
export function isFixedModelId(modelId: string): boolean {
  return (
    !(DYNAMIC_MODEL_IDS as readonly string[]).includes(modelId) &&
    !modelId.includes(MODEL_VARIANT_SEPARATOR) &&
    MODEL_ID_REGEX.test(modelId)
  );
}

export function assertFixedModelId(modelId: string): void {
  if (!isFixedModelId(modelId)) {
    throw new ProviderRequestError(
      `"${modelId}" is not a fixed model ID; dynamic routers and variant suffixes cannot be used for fixed-model comparisons`,
    );
  }
}

/**
 * Build the request for one evaluation and fixture. The text part carries the
 * versioned instruction and the question verbatim; the expected answer never
 * enters this payload.
 */
export function buildChatCompletionRequest(input: {
  evaluation: PreflightEvaluation;
  prompt: PromptPayload;
}): ChatCompletionRequestPayload {
  const { evaluation, prompt } = input;
  assertFixedModelId(evaluation.openRouterId);

  return {
    model: evaluation.openRouterId,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${prompt.instruction}\n\n${prompt.question}`,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${prompt.image.mediaType};base64,${prompt.image.base64}`,
            },
          },
        ],
      },
    ],
    ...(evaluation.reasoning === null ? {} : { reasoning: evaluation.reasoning }),
    provider: toProviderPayload(evaluation.provider),
  };
}

export function toProviderPayload(provider: ProviderRoutingConfig | null): ProviderRoutingPayload {
  const payload: ProviderRoutingPayload = { require_parameters: true };
  if (provider === null) return payload;
  if (provider.only !== undefined) payload.only = [...provider.only];
  if (provider.order !== undefined) payload.order = [...provider.order];
  if (provider.ignore !== undefined) payload.ignore = [...provider.ignore];
  if (provider.allowFallbacks !== undefined) payload.allow_fallbacks = provider.allowFallbacks;
  if (provider.sort !== undefined) payload.sort = provider.sort;
  return payload;
}
