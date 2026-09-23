import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CATALOG_TIMEOUT_MS,
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_METADATA_HEADER,
  OpenRouterClient,
  readOpenRouterApiKey,
} from "./provider-client";
import type {
  ProviderTransport,
  ProviderTransportRequest,
  ProviderTransportResponse,
} from "./provider-failure";
import type { ChatCompletionRequestPayload } from "./provider-request";

const NOW = Date.parse("2026-09-23T00:00:00.000Z");

function staticTransport(response: Partial<ProviderTransportResponse> = {}): {
  transport: ProviderTransport;
  requests: ProviderTransportRequest[];
} {
  const requests: ProviderTransportRequest[] = [];
  return {
    requests,
    transport: async (request) => {
      requests.push(request);
      return { status: 200, headers: {}, body: "", ...response };
    },
  };
}

function clientWith(
  transport: ProviderTransport,
  apiKey: string | null = "sk-secret",
): OpenRouterClient {
  return new OpenRouterClient({ transport, apiKey, now: () => NOW });
}

const chatPayload: ChatCompletionRequestPayload = {
  model: "vendor/model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  provider: { require_parameters: true },
};

describe("readOpenRouterApiKey", () => {
  it("reads only the environment variable and treats empty values as unset", () => {
    expect(readOpenRouterApiKey({ [OPENROUTER_API_KEY_ENV]: " sk-1 " })).toBe("sk-1");
    expect(readOpenRouterApiKey({ [OPENROUTER_API_KEY_ENV]: "" })).toBeNull();
    expect(readOpenRouterApiKey({})).toBeNull();
  });
});

describe("OpenRouterClient", () => {
  it("fetches and parses the model catalog without requiring a key", async () => {
    const { transport, requests } = staticTransport({
      body: JSON.stringify({
        data: [
          {
            id: "vendor/vision",
            architecture: { input_modalities: ["text", "image"] },
            reasoning: { supported_efforts: null },
          },
        ],
      }),
    });
    const client = clientWith(transport, null);

    const result = await client.fetchModelCatalog();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fetchedAt).toBe("2026-09-23T00:00:00.000Z");
    expect(result.value.models[0]?.id).toBe("vendor/vision");
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers.Authorization).toBeUndefined();
    expect(requests[0]?.headers[OPENROUTER_METADATA_HEADER]).toBe("enabled");
  });

  it("classifies catalog HTTP and protocol failures", async () => {
    const httpFailure = clientWith(
      staticTransport({ status: 500, body: JSON.stringify({ error: { message: "down" } }) })
        .transport,
    );
    const http = await httpFailure.fetchModelCatalog();
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.failure.category).toBe("server_error");

    const protocolFailure = clientWith(
      staticTransport({ body: JSON.stringify({ data: {} }) }).transport,
    );
    const protocol = await protocolFailure.fetchModelCatalog();
    expect(protocol.ok).toBe(false);
    if (!protocol.ok) {
      expect(protocol.failure.message).toContain("documented contract");
      expect(protocol.failure.category).toBe("unknown");
    }
  });

  it("submits a chat completion with the injected credential", async () => {
    const { transport, requests } = staticTransport({
      body: JSON.stringify({
        id: "gen-1",
        model: "vendor/model",
        choices: [{ finish_reason: "stop", message: { content: "A" } }],
      }),
    });
    const client = clientWith(transport);

    const result = await client.chatCompletion(chatPayload, { timeoutMs: 5000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.responseText).toBe("A");
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.Authorization).toBe("Bearer sk-secret");
    expect(JSON.parse(requests[0]?.body ?? "null")).toEqual(chatPayload);
  });

  it("fails closed without a credential and never calls the transport", async () => {
    const { transport, requests } = staticTransport();
    const client = clientWith(transport, null);

    const result = await client.chatCompletion(chatPayload, { timeoutMs: 5000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.category).toBe("configuration");
    expect(result.failure.message).toContain(OPENROUTER_API_KEY_ENV);
    expect(requests).toHaveLength(0);
  });

  it("classifies a request timeout", async () => {
    const transport: ProviderTransport = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    const client = clientWith(transport);

    const result = await client.chatCompletion(chatPayload, { timeoutMs: 5 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.category).toBe("timeout");
    expect(result.failure.httpStatus).toBeNull();
  });

  it("distinguishes caller cancellation from a timeout", async () => {
    const transport: ProviderTransport = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    const client = clientWith(transport);
    const controller = new AbortController();

    const pending = client.chatCompletion(chatPayload, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.category).toBe("cancelled");
  });

  it("does not leak credentials into failures or raw response data", async () => {
    const { transport } = staticTransport({
      status: 401,
      body: JSON.stringify({ error: { message: "Invalid API key" } }),
    });
    const client = clientWith(transport);

    const result = await client.chatCompletion(chatPayload, { timeoutMs: 5000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe("Invalid API key");
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("bounds the default catalog timeout", () => {
    expect(DEFAULT_CATALOG_TIMEOUT_MS).toBe(30_000);
  });
});

describe("request timeout composition", () => {
  it("clears the timeout timer after a completed request", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = staticTransport({
        body: JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: "A" } }],
        }),
      });
      const client = clientWith(transport);
      const result = await client.chatCompletion(chatPayload, { timeoutMs: 10_000 });
      expect(result.ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
