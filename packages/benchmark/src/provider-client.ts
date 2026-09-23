/**
 * OpenRouter adapter client.
 *
 * The client owns request construction, credential handling, timeout/cancel
 * composition, and response normalization. It never reads configuration and
 * never touches the filesystem: the runner injects the transport
 * (`apps/runner` uses `fetch`) and passes the API key read from the
 * environment. Credentials are attached only to outgoing headers and are never
 * part of failures, events, or persisted records.
 */
import type { FailureRecord } from "@mmstar/results";
import {
  classifyHttpFailure,
  classifyTransportError,
  type ProviderFailure,
  type ProviderResult,
  type ProviderTransport,
  type ProviderTransportResponse,
  tryParseJson,
} from "./provider-failure";
import {
  type ModelCatalog,
  ProviderProtocolError,
  parseModelCatalogResponse,
} from "./provider-metadata";
import type { ChatCompletionRequestPayload } from "./provider-request";
import { type NormalizedCompletion, normalizeChatCompletion } from "./provider-response";

export const OPENROUTER_API_BASE_DEFAULT = "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
/**
 * Opt-in header for routing metadata (`openrouter_metadata`). The endpoint also
 * accepts the legacy `X-OpenRouter-Experimental-Metadata` header.
 */
export const OPENROUTER_METADATA_HEADER = "X-OpenRouter-Metadata";
export const OPENROUTER_METADATA_VALUE = "enabled";
/** Metadata fetches are not experiment requests; they get a short fixed bound. */
export const DEFAULT_CATALOG_TIMEOUT_MS = 30_000;

/** Read the API key from an environment snapshot; empty values count as unset. */
export function readOpenRouterApiKey(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const raw = env[OPENROUTER_API_KEY_ENV];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export interface OpenRouterClientOptions {
  transport: ProviderTransport;
  /** API key read from the environment by the caller; null when unset. */
  apiKey: string | null;
  /** API base URL; defaults to the public OpenRouter API. */
  baseUrl?: string;
  /** Injected epoch-milliseconds clock for deterministic tests. */
  now?: () => number;
}

export interface RequestControl {
  signal?: AbortSignal;
}

export class OpenRouterClient {
  private readonly transport: ProviderTransport;
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(options: OpenRouterClientOptions) {
    this.transport = options.transport;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? OPENROUTER_API_BASE_DEFAULT).replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
  }

  /** Fetch and parse the model catalog; no API key is required for reading it. */
  async fetchModelCatalog(
    options: RequestControl & { timeoutMs?: number } = {},
  ): Promise<ProviderResult<ModelCatalog>> {
    const response = await this.send({
      method: "GET",
      path: "/models",
      body: null,
      timeoutMs: options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
      signal: options.signal,
      requireApiKey: false,
    });
    if (!response.ok) return response;

    const { status, headers, body } = response.value;
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        failure: classifyHttpFailure({
          status,
          bodyText: body,
          headers,
          now: this.now(),
        }),
        rawResponse: tryParseJson(body),
      };
    }

    const parsed = tryParseJson(body);
    if (parsed === null) {
      return {
        ok: false,
        failure: unknownFailure("models response was not valid JSON", status),
        rawResponse: null,
      };
    }
    try {
      return {
        ok: true,
        value: parseModelCatalogResponse(parsed, new Date(this.now()).toISOString()),
      };
    } catch (error) {
      const message =
        error instanceof ProviderProtocolError
          ? `models response did not match the documented contract: ${error.message}`
          : String(error);
      return { ok: false, failure: unknownFailure(message, status), rawResponse: parsed };
    }
  }

  /** Submit one chat completion and normalize the result. */
  async chatCompletion(
    payload: ChatCompletionRequestPayload,
    options: RequestControl & { timeoutMs: number },
  ): Promise<ProviderResult<NormalizedCompletion>> {
    const response = await this.send({
      method: "POST",
      path: "/chat/completions",
      body: payload,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      requireApiKey: true,
    });
    if (!response.ok) return response;

    return normalizeChatCompletion({
      status: response.value.status,
      bodyText: response.value.body,
      headers: response.value.headers,
      now: this.now(),
    });
  }

  private async send(options: {
    method: "GET" | "POST";
    path: string;
    body: unknown;
    timeoutMs: number;
    signal: AbortSignal | undefined;
    requireApiKey: boolean;
  }): Promise<ProviderResult<ProviderTransportResponse>> {
    if (options.requireApiKey && this.apiKey === null) {
      return configurationFailure(
        `${OPENROUTER_API_KEY_ENV} is not set; export it in the runner environment before making requests`,
      );
    }

    const timed = createTimedSignal(options.timeoutMs, options.signal);
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
        [OPENROUTER_METADATA_HEADER]: OPENROUTER_METADATA_VALUE,
      };
      if (this.apiKey !== null) headers.Authorization = `Bearer ${this.apiKey}`;
      const response = await this.transport({
        url: `${this.baseUrl}${options.path}`,
        method: options.method,
        headers,
        body: options.body === null ? null : JSON.stringify(options.body),
        signal: timed.signal,
      });
      return { ok: true, value: response };
    } catch (error) {
      const timedOut = timed.timedOut();
      return {
        ok: false,
        failure: classifyTransportError(error, {
          cancelled: !timedOut && (options.signal?.aborted ?? false),
          timedOut,
        }),
        rawResponse: null,
      };
    } finally {
      timed.dispose();
    }
  }
}

interface TimedSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

/**
 * Compose the caller's cancellation signal with a request timeout. The timeout
 * outcome is recorded explicitly so an aborted fetch is classified as a timeout
 * rather than a network error.
 */
function createTimedSignal(timeoutMs: number, caller: AbortSignal | undefined): TimedSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let abortListener: (() => void) | null = null;
  if (caller !== undefined) {
    if (caller.aborted) {
      controller.abort();
    } else {
      abortListener = () => controller.abort();
      caller.addEventListener("abort", abortListener, { once: true });
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      if (caller !== undefined && abortListener !== null) {
        caller.removeEventListener("abort", abortListener);
      }
    },
  };
}

function configurationFailure(message: string): ProviderFailure {
  const failure: FailureRecord = {
    category: "configuration",
    message,
    httpStatus: null,
    retryAfterMs: null,
  };
  return { ok: false, failure, rawResponse: null };
}

function unknownFailure(message: string, httpStatus: number): FailureRecord {
  return { category: "unknown", message, httpStatus, retryAfterMs: null };
}
