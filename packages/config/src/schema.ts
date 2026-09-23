/**
 * Generated JSON Schema for `mmstar.config.json` (editor/autocomplete support).
 *
 * The runtime validator in `./config` is authoritative; this schema mirrors its
 * field names, defaults, and bounds so editors warn before a config is loaded.
 * Regenerate the committed file with `pnpm schema` after changing config rules.
 */
import {
  CONFIG_VERSION,
  DATASET_PATH_DEFAULT,
  EXECUTION_LIMITS,
  IDENTIFIER_REGEX,
  MODEL_ID_REGEX,
  PROVIDER_SLUG_REGEX,
  PROVIDER_SORTS,
  RESULTS_ROOT_DEFAULT,
} from "./config";
import { REASONING_MODES } from "./reasoning";

/** Committed schema file, resolved from the repository root. */
export const CONFIG_SCHEMA_FILE = "mmstar.config.schema.json";

export function buildConfigJsonSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "MMStar OpenRouter runner configuration",
    description:
      "Versioned configuration for MMStar benchmark runs. Credentials never belong here; the runner reads OPENROUTER_API_KEY from the environment.",
    type: "object",
    additionalProperties: false,
    required: ["version", "models", "sets"],
    properties: {
      $schema: {
        type: "string",
        description: `Reference to this schema, typically "${CONFIG_SCHEMA_FILE}".`,
      },
      version: {
        const: CONFIG_VERSION,
        description: "Configuration schema version.",
      },
      dataset: { $ref: "#/$defs/dataset" },
      execution: { $ref: "#/$defs/execution" },
      models: {
        type: "object",
        description: "Named model aliases, expanded into evaluations by sets.",
        minProperties: 1,
        propertyNames: { pattern: IDENTIFIER_REGEX.source },
        additionalProperties: { $ref: "#/$defs/modelAlias" },
      },
      sets: {
        type: "object",
        description: "Named sets of model aliases that runs can select.",
        minProperties: 1,
        propertyNames: { pattern: IDENTIFIER_REGEX.source },
        additionalProperties: { $ref: "#/$defs/set" },
      },
    },
    $defs: {
      dataset: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description: "Dataset path relative to the working directory.",
            default: DATASET_PATH_DEFAULT,
          },
        },
      },
      execution: {
        type: "object",
        additionalProperties: false,
        properties: {
          maxConcurrentGroups: {
            type: "integer",
            minimum: EXECUTION_LIMITS.maxConcurrentGroups.min,
            maximum: EXECUTION_LIMITS.maxConcurrentGroups.max,
            default: EXECUTION_LIMITS.maxConcurrentGroups.default,
            description: "Rate-limit groups allowed to have work in flight at once.",
          },
          maxRetries: {
            type: "integer",
            minimum: EXECUTION_LIMITS.maxRetries.min,
            maximum: EXECUTION_LIMITS.maxRetries.max,
            default: EXECUTION_LIMITS.maxRetries.default,
            description: "Retries after the initial attempt; 3 allows at most four attempts.",
          },
          requestTimeoutMs: {
            type: "integer",
            minimum: EXECUTION_LIMITS.requestTimeoutMs.min,
            maximum: EXECUTION_LIMITS.requestTimeoutMs.max,
            default: EXECUTION_LIMITS.requestTimeoutMs.default,
            description: "Per-request timeout in milliseconds.",
          },
          maxRequestsPerMinute: {
            type: ["integer", "null"],
            minimum: EXECUTION_LIMITS.maxRequestsPerMinute.min,
            maximum: EXECUTION_LIMITS.maxRequestsPerMinute.max,
            description: "Account-wide request cap, or null for no configured cap.",
          },
          resultsRoot: {
            type: "string",
            minLength: 1,
            default: RESULTS_ROOT_DEFAULT,
            description: "Root directory for run artifacts, relative to the working directory.",
          },
        },
      },
      modelAlias: {
        type: "object",
        additionalProperties: false,
        required: ["openRouterId", "reasoningModes", "rateLimitGroup"],
        properties: {
          openRouterId: {
            type: "string",
            pattern: MODEL_ID_REGEX.source,
            description: 'Fixed OpenRouter model ID such as "vendor/model".',
          },
          reasoningModes: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { enum: [...REASONING_MODES] },
            description: "Ordered reasoning modes; each mode becomes one evaluation.",
          },
          rateLimitGroup: {
            type: "string",
            pattern: IDENTIFIER_REGEX.source,
            description: "Shared rate-limit group serializing all of its evaluations.",
          },
          provider: { $ref: "#/$defs/providerRouting" },
        },
      },
      providerRouting: {
        type: "object",
        additionalProperties: false,
        not: { required: ["only", "ignore"] },
        properties: {
          only: {
            type: "array",
            items: { type: "string", pattern: PROVIDER_SLUG_REGEX.source },
            uniqueItems: true,
            description: "Providers allowed to serve the model.",
          },
          order: {
            type: "array",
            items: { type: "string", pattern: PROVIDER_SLUG_REGEX.source },
            uniqueItems: true,
            description: "Preferred provider order.",
          },
          ignore: {
            type: "array",
            items: { type: "string", pattern: PROVIDER_SLUG_REGEX.source },
            uniqueItems: true,
            description: "Providers excluded from serving the model.",
          },
          allowFallbacks: {
            type: "boolean",
            description:
              "Whether fallback providers may serve when preferred ones are unavailable.",
          },
          sort: {
            enum: [...PROVIDER_SORTS],
            description: "Routing preference when several providers are eligible.",
          },
        },
      },
      set: {
        type: "object",
        additionalProperties: false,
        required: ["models"],
        properties: {
          models: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", pattern: IDENTIFIER_REGEX.source },
            description: "Ordered model alias references.",
          },
        },
      },
    },
  };
}

/** Serialized schema exactly as committed to `mmstar.config.schema.json`. */
export function generateConfigSchemaJson(): string {
  return `${JSON.stringify(buildConfigJsonSchema(), null, 2)}\n`;
}
