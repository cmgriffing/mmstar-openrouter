/**
 * OpenRouter model metadata parsing and capability snapshots.
 *
 * `GET /api/v1/models` carries the fresh capability evidence a run freezes:
 * input modalities, `reasoning.supported_efforts`, `default_effort`,
 * `default_enabled`, `supports_max_tokens`, and `mandatory`. The parser fails
 * loudly on shapes it does not understand instead of guessing support; unknown
 * capabilities fail closed during preflight.
 */
import {
  CAPABILITY_SNAPSHOT_VERSION,
  type ModelCapabilitySnapshot,
  type ReasoningCapabilitySnapshot,
} from "@mmstar/results";
import { isJsonObject } from "./provider-failure";

/**
 * Declared effort support:
 * - `string[]`: the values the gateway lists (descending effort order),
 * - `null`: metadata explicitly says all gateway effort values are accepted,
 * - `"no-effort-selection"`: a reasoning model whose metadata omits
 *   `supported_efforts`,
 * - `"non-reasoning"`: the model declares no reasoning object at all.
 */
export type SupportedEfforts = string[] | null | "no-effort-selection" | "non-reasoning";

export interface ModelReasoningMetadata {
  supportedEfforts: SupportedEfforts;
  /** Upstream `default_effort`; `"none"` means off by default. */
  defaultEffort: string | null;
  defaultEnabled: boolean | null;
  supportsMaxTokens: boolean;
  mandatory: boolean | null;
}

export interface ModelMetadata {
  id: string;
  name: string | null;
  contextLength: number | null;
  inputModalities: string[];
  reasoning: ModelReasoningMetadata;
}

export interface ModelCatalog {
  /** ISO-8601 UTC timestamp of the metadata fetch. */
  fetchedAt: string;
  models: ModelMetadata[];
}

/** Metadata could not be interpreted under the documented contract. */
export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

const OMITTED_REASONING: ModelReasoningMetadata = {
  supportedEfforts: "non-reasoning",
  defaultEffort: null,
  defaultEnabled: null,
  supportsMaxTokens: false,
  mandatory: null,
};

/** Parse the models response body into a validated catalog. */
export function parseModelCatalogResponse(raw: unknown, fetchedAt: string): ModelCatalog {
  if (!isJsonObject(raw)) {
    throw new ProviderProtocolError("models response must be a JSON object");
  }
  if (raw.error !== undefined) {
    throw new ProviderProtocolError(`models request failed: ${describeErrorValue(raw.error)}`);
  }
  const data = raw.data;
  if (!Array.isArray(data)) {
    throw new ProviderProtocolError('models response is missing a "data" array');
  }

  const models: ModelMetadata[] = [];
  const seen = new Set<string>();
  data.forEach((entry, index) => {
    const path = `data[${index}]`;
    if (!isJsonObject(entry)) {
      throw new ProviderProtocolError(`${path} must be an object`);
    }
    const id = entry.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw new ProviderProtocolError(`${path}.id must be a non-empty string`);
    }
    if (seen.has(id)) {
      throw new ProviderProtocolError(`models response contains duplicate id "${id}"`);
    }
    seen.add(id);
    models.push({
      id,
      name: readNullableString(entry.name, `${path}.name`),
      contextLength: readNullableInteger(entry.context_length, `${path}.context_length`),
      inputModalities: parseInputModalities(entry.architecture, `${path}.architecture`),
      reasoning: parseReasoning(entry.reasoning, `${path}.reasoning`),
    });
  });

  return { fetchedAt, models };
}

export function findModelMetadata(catalog: ModelCatalog, modelId: string): ModelMetadata | null {
  return catalog.models.find((model) => model.id === modelId) ?? null;
}

export function toCapabilitySnapshot(
  metadata: ModelMetadata,
  fetchedAt: string,
): ModelCapabilitySnapshot {
  return {
    snapshotVersion: CAPABILITY_SNAPSHOT_VERSION,
    modelId: metadata.id,
    fetchedAt,
    imageInput: metadata.inputModalities.includes("image"),
    inputModalities: [...metadata.inputModalities],
    reasoning: { ...metadata.reasoning, supportedEfforts: copyEfforts(metadata.reasoning) },
  };
}

function copyEfforts(reasoning: ReasoningCapabilitySnapshot): SupportedEfforts {
  const efforts = reasoning.supportedEfforts;
  return Array.isArray(efforts) ? [...efforts] : efforts;
}

function parseInputModalities(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!isJsonObject(value)) {
    throw new ProviderProtocolError(`${path} must be an object when present`);
  }
  const modalities = value.input_modalities;
  if (modalities === undefined) return [];
  if (!Array.isArray(modalities) || modalities.some((entry) => typeof entry !== "string")) {
    throw new ProviderProtocolError(`${path}.input_modalities must be an array of strings`);
  }
  return modalities as string[];
}

function parseReasoning(value: unknown, path: string): ModelReasoningMetadata {
  if (value === undefined || value === null) return { ...OMITTED_REASONING };
  if (!isJsonObject(value)) {
    throw new ProviderProtocolError(`${path} must be an object when present`);
  }
  return {
    supportedEfforts: parseSupportedEfforts(value.supported_efforts, `${path}.supported_efforts`),
    defaultEffort: readNullableString(value.default_effort, `${path}.default_effort`),
    defaultEnabled: readNullableBoolean(value.default_enabled, `${path}.default_enabled`),
    supportsMaxTokens: readBoolean(value.supports_max_tokens, `${path}.supports_max_tokens`),
    mandatory: readNullableBoolean(value.mandatory, `${path}.mandatory`),
  };
}

function parseSupportedEfforts(value: unknown, path: string): SupportedEfforts {
  if (value === undefined) return "no-effort-selection";
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ProviderProtocolError(`${path} must be null or an array of strings`);
  }
  return value as string[];
}

function readNullableString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new ProviderProtocolError(`${path} must be a string or null`);
  return value;
}

function readNullableInteger(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ProviderProtocolError(`${path} must be a non-negative integer or null`);
  }
  return value;
}

function readNullableBoolean(value: unknown, path: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new ProviderProtocolError(`${path} must be a boolean or null`);
  }
  return value;
}

function readBoolean(value: unknown, path: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new ProviderProtocolError(`${path} must be a boolean`);
  return value;
}

function describeErrorValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (isJsonObject(value)) {
    const message = value.message;
    if (typeof message === "string") return message;
    const code = value.code;
    if (typeof code === "number" || typeof code === "string") return `code ${code}`;
  }
  return "unknown error";
}
