/**
 * Versioned JSON configuration contracts and validation.
 *
 * The validator is the runtime authority for `mmstar.config.json`. It applies
 * documented defaults, rejects unknown fields, and reports every issue with an
 * actionable path instead of inferring or repairing input. The generated editor
 * schema in `./schema` mirrors these rules for editors; credentials never
 * belong in configuration and are read from the environment by the runner.
 */
import type { ValidationIssue } from "./errors";
import { isReasoningMode, REASONING_MODES, type ReasoningMode } from "./reasoning";

export const CONFIG_VERSION = 1;

export interface DatasetConfig {
  /** Dataset path relative to the working directory; never absolute or traversing. */
  path: string;
}

export interface ExecutionConfig {
  /** Maximum number of rate-limit groups with work in flight. */
  maxConcurrentGroups: number;
  /** Retries after the initial attempt; 3 means at most four attempts. */
  maxRetries: number;
  /** Per-request timeout in milliseconds, including response body time. */
  requestTimeoutMs: number;
  /** Account-wide request cap across all groups, or null for no configured cap. */
  maxRequestsPerMinute: number | null;
  /** Root directory for run artifacts, relative to the working directory. */
  resultsRoot: string;
}

export const PROVIDER_SORTS = ["price", "throughput", "latency"] as const;

export type ProviderSort = (typeof PROVIDER_SORTS)[number];

/**
 * Explicit OpenRouter provider routing preferences. `require_parameters` is
 * always set by the adapter and is not configurable.
 */
export interface ProviderRoutingConfig {
  /** Providers allowed to serve the model. Mutually exclusive with `ignore`. */
  only?: string[];
  /** Provider order preference. */
  order?: string[];
  /** Providers excluded from serving the model. Mutually exclusive with `only`. */
  ignore?: string[];
  /** Whether fallback providers may serve when preferred providers are unavailable. */
  allowFallbacks?: boolean;
  /** Routing preference when several providers are eligible. */
  sort?: ProviderSort;
}

export interface ModelAliasConfig {
  /** Fixed OpenRouter model ID; dynamic router aliases and variant suffixes are rejected. */
  openRouterId: string;
  /** Ordered, unique reasoning modes; each mode becomes one evaluation. */
  reasoningModes: ReasoningMode[];
  /** Group whose shared provider limit serializes all of its evaluations. */
  rateLimitGroup: string;
  provider?: ProviderRoutingConfig;
}

export interface ModelSetConfig {
  /** Ordered aliases; order determines deterministic evaluation ordering. */
  models: string[];
}

export interface MmstarConfig {
  version: typeof CONFIG_VERSION;
  $schema?: string;
  dataset: DatasetConfig;
  execution: ExecutionConfig;
  models: Record<string, ModelAliasConfig>;
  sets: Record<string, ModelSetConfig>;
}

export const DATASET_PATH_DEFAULT = "MMStar.tsv";
export const RESULTS_ROOT_DEFAULT = "results";

export const EXECUTION_LIMITS = {
  maxConcurrentGroups: { min: 1, max: 64, default: 4 },
  maxRetries: { min: 0, max: 10, default: 3 },
  requestTimeoutMs: { min: 1_000, max: 600_000, default: 120_000 },
  maxRequestsPerMinute: { min: 1, max: 60_000, default: null },
} as const;

export const EXECUTION_DEFAULTS: ExecutionConfig = {
  maxConcurrentGroups: EXECUTION_LIMITS.maxConcurrentGroups.default,
  maxRetries: EXECUTION_LIMITS.maxRetries.default,
  requestTimeoutMs: EXECUTION_LIMITS.requestTimeoutMs.default,
  maxRequestsPerMinute: EXECUTION_LIMITS.maxRequestsPerMinute.default,
  resultsRoot: RESULTS_ROOT_DEFAULT,
};

/** Alias, set, and rate-limit-group names. */
export const IDENTIFIER_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Fixed OpenRouter model IDs: `vendor/model`, optionally with a `~` latest marker. */
export const MODEL_ID_REGEX = /^[A-Za-z0-9~][A-Za-z0-9~._-]*\/[A-Za-z0-9~][A-Za-z0-9~._-]*$/;
/** OpenRouter provider slugs. */
export const PROVIDER_SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Router aliases that substitute models at request time. */
export const DYNAMIC_MODEL_IDS = ["openrouter/auto", "openrouter/free"] as const;

/** Model variant suffixes (`:nitro`, `:floor`, ...) that change routing or behavior. */
export const MODEL_VARIANT_SEPARATOR = ":";

const ROOT_KEYS = ["$schema", "version", "dataset", "execution", "models", "sets"] as const;
const DATASET_KEYS = ["path"] as const;
const EXECUTION_KEYS = [
  "maxConcurrentGroups",
  "maxRetries",
  "requestTimeoutMs",
  "maxRequestsPerMinute",
  "resultsRoot",
] as const;
const MODEL_KEYS = ["openRouterId", "reasoningModes", "rateLimitGroup", "provider"] as const;
const PROVIDER_KEYS = ["only", "order", "ignore", "allowFallbacks", "sort"] as const;
const SET_KEYS = ["models"] as const;

export type ConfigParseResult =
  | { ok: true; config: MmstarConfig; issues: readonly [] }
  | { ok: false; issues: readonly ValidationIssue[] };

/**
 * Validate a parsed JSON value. Returns a normalized config with defaults
 * applied, preserving declared ordering of models, sets, and reasoning modes.
 */
export function parseMmstarConfig(input: unknown): ConfigParseResult {
  const issues: ValidationIssue[] = [];
  const config = validateConfigDocument(input, issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, config, issues: [] };
}

/** Parse JSON text; syntax errors become validation issues instead of exceptions. */
export function parseMmstarConfigJson(text: string): ConfigParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issues: [{ path: "", code: "invalid_json", message: `not valid JSON: ${detail}` }],
    };
  }
  return parseMmstarConfig(parsed);
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

function indexAt(parent: string, index: number): string {
  return `${parent}[${index}]`;
}

function pushIssue(issues: ValidationIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

function checkUnknownKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      pushIssue(
        issues,
        at(path, key),
        "unknown_field",
        `unknown field; allowed fields: ${allowed.join(", ")}`,
      );
    }
  }
}

function readBoundedInteger(
  value: JsonObject,
  key: string,
  path: string,
  limits: { min: number; max: number },
  issues: ValidationIssue[],
): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  const fieldPath = at(path, key);
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    pushIssue(issues, fieldPath, "invalid_type", "must be an integer");
    return undefined;
  }
  if (raw < limits.min || raw > limits.max) {
    pushIssue(
      issues,
      fieldPath,
      "out_of_range",
      `must be between ${limits.min} and ${limits.max} (received ${raw})`,
    );
    return undefined;
  }
  return raw;
}

/**
 * Dataset and results paths are resolved relative to the working directory.
 * Absolute paths and `..` segments are rejected so a config cannot silently
 * read or write outside the workspace.
 */
function readRelativePath(
  value: JsonObject,
  key: string,
  path: string,
  fallback: string,
  issues: ValidationIssue[],
): string {
  const raw = value[key];
  if (raw === undefined) return fallback;
  const fieldPath = at(path, key);
  if (typeof raw !== "string" || raw.trim() === "") {
    pushIssue(issues, fieldPath, "invalid_path", "must be a non-empty relative path");
    return fallback;
  }
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    pushIssue(issues, fieldPath, "invalid_path", "must be relative to the working directory");
    return fallback;
  }
  if (raw.split(/[\\/]/).some((segment) => segment === "..")) {
    pushIssue(issues, fieldPath, "invalid_path", "must not contain '..' segments");
    return fallback;
  }
  return raw;
}

function validateDataset(value: unknown, issues: ValidationIssue[]): DatasetConfig {
  if (value === undefined) return { path: DATASET_PATH_DEFAULT };
  if (!isObject(value)) {
    pushIssue(issues, "dataset", "invalid_type", "must be an object");
    return { path: DATASET_PATH_DEFAULT };
  }
  checkUnknownKeys(value, DATASET_KEYS, "dataset", issues);
  return { path: readRelativePath(value, "path", "dataset", DATASET_PATH_DEFAULT, issues) };
}

function validateExecution(value: unknown, issues: ValidationIssue[]): ExecutionConfig {
  const execution: ExecutionConfig = { ...EXECUTION_DEFAULTS };
  if (value === undefined) return execution;
  if (!isObject(value)) {
    pushIssue(issues, "execution", "invalid_type", "must be an object");
    return execution;
  }
  checkUnknownKeys(value, EXECUTION_KEYS, "execution", issues);

  execution.maxConcurrentGroups =
    readBoundedInteger(
      value,
      "maxConcurrentGroups",
      "execution",
      EXECUTION_LIMITS.maxConcurrentGroups,
      issues,
    ) ?? EXECUTION_DEFAULTS.maxConcurrentGroups;
  execution.maxRetries =
    readBoundedInteger(value, "maxRetries", "execution", EXECUTION_LIMITS.maxRetries, issues) ??
    EXECUTION_DEFAULTS.maxRetries;
  execution.requestTimeoutMs =
    readBoundedInteger(
      value,
      "requestTimeoutMs",
      "execution",
      EXECUTION_LIMITS.requestTimeoutMs,
      issues,
    ) ?? EXECUTION_DEFAULTS.requestTimeoutMs;

  if (value.maxRequestsPerMinute !== undefined) {
    if (value.maxRequestsPerMinute === null) {
      execution.maxRequestsPerMinute = null;
    } else {
      execution.maxRequestsPerMinute =
        readBoundedInteger(
          value,
          "maxRequestsPerMinute",
          "execution",
          EXECUTION_LIMITS.maxRequestsPerMinute,
          issues,
        ) ?? null;
    }
  }

  execution.resultsRoot = readRelativePath(
    value,
    "resultsRoot",
    "execution",
    RESULTS_ROOT_DEFAULT,
    issues,
  );
  return execution;
}

function validateReasoningModes(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): ReasoningMode[] {
  if (!Array.isArray(value)) {
    pushIssue(
      issues,
      path,
      "invalid_type",
      `must be a non-empty array of reasoning modes: ${REASONING_MODES.join(", ")}`,
    );
    return [];
  }
  if (value.length === 0) {
    pushIssue(
      issues,
      path,
      "empty_list",
      `must list at least one reasoning mode: ${REASONING_MODES.join(", ")}`,
    );
    return [];
  }
  const modes: ReasoningMode[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryPath = indexAt(path, index);
    if (!isReasoningMode(entry)) {
      pushIssue(
        issues,
        entryPath,
        "unknown_reasoning_mode",
        `unknown reasoning mode ${JSON.stringify(entry)}; expected one of: ${REASONING_MODES.join(", ")}`,
      );
      return;
    }
    if (seen.has(entry)) {
      pushIssue(
        issues,
        entryPath,
        "duplicate_reasoning_mode",
        `duplicate reasoning mode "${entry}"`,
      );
      return;
    }
    seen.add(entry);
    modes.push(entry);
  });
  return modes;
}

function validateProvider(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): ProviderRoutingConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    pushIssue(issues, path, "invalid_type", "must be an object");
    return undefined;
  }
  checkUnknownKeys(value, PROVIDER_KEYS, path, issues);

  const provider: ProviderRoutingConfig = {};
  const lists = ["only", "order", "ignore"] as const;
  for (const listKey of lists) {
    const raw = value[listKey];
    if (raw === undefined) continue;
    const listPath = at(path, listKey);
    if (!Array.isArray(raw)) {
      pushIssue(issues, listPath, "invalid_type", "must be an array of provider slugs");
      continue;
    }
    const slugs: string[] = [];
    const seen = new Set<string>();
    raw.forEach((entry, index) => {
      const entryPath = indexAt(listPath, index);
      if (typeof entry !== "string" || !PROVIDER_SLUG_REGEX.test(entry)) {
        pushIssue(
          issues,
          entryPath,
          "invalid_provider_slug",
          'must be a provider slug such as "openai" or "amazon-bedrock"',
        );
        return;
      }
      if (seen.has(entry)) {
        pushIssue(issues, entryPath, "duplicate_provider", `duplicate provider "${entry}"`);
        return;
      }
      seen.add(entry);
      slugs.push(entry);
    });
    provider[listKey] = slugs;
  }

  if (provider.only !== undefined && provider.ignore !== undefined) {
    pushIssue(
      issues,
      path,
      "conflicting_provider_filter",
      "provider.only and provider.ignore are mutually exclusive",
    );
  }

  if (value.allowFallbacks !== undefined) {
    if (typeof value.allowFallbacks !== "boolean") {
      pushIssue(issues, at(path, "allowFallbacks"), "invalid_type", "must be a boolean");
    } else {
      provider.allowFallbacks = value.allowFallbacks;
    }
  }

  if (value.sort !== undefined) {
    if (
      typeof value.sort !== "string" ||
      !(PROVIDER_SORTS as readonly string[]).includes(value.sort)
    ) {
      pushIssue(
        issues,
        at(path, "sort"),
        "unknown_provider_sort",
        `must be one of: ${PROVIDER_SORTS.join(", ")}`,
      );
    } else {
      provider.sort = value.sort as ProviderSort;
    }
  }

  return provider;
}

function validateModelId(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    pushIssue(
      issues,
      path,
      "invalid_model_id",
      'must be a fixed OpenRouter model ID such as "vendor/model"',
    );
    return undefined;
  }
  if ((DYNAMIC_MODEL_IDS as readonly string[]).includes(value)) {
    pushIssue(
      issues,
      path,
      "dynamic_model_id",
      `"${value}" is a dynamic router alias; fixed-model comparisons require a concrete model ID`,
    );
    return undefined;
  }
  if (value.includes(MODEL_VARIANT_SEPARATOR)) {
    pushIssue(
      issues,
      path,
      "model_variant_id",
      `model variants ("${MODEL_VARIANT_SEPARATOR}...") change routing or behavior; declare a concrete model ID`,
    );
    return undefined;
  }
  if (!MODEL_ID_REGEX.test(value)) {
    pushIssue(
      issues,
      path,
      "invalid_model_id",
      'must look like "vendor/model" and contain no whitespace or query characters',
    );
    return undefined;
  }
  return value;
}

function validateAlias(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): ModelAliasConfig | undefined {
  if (!isObject(value)) {
    pushIssue(issues, path, "invalid_type", "must be an object");
    return undefined;
  }
  checkUnknownKeys(value, MODEL_KEYS, path, issues);

  const openRouterId = validateModelId(value.openRouterId, at(path, "openRouterId"), issues);
  const reasoningModes = validateReasoningModes(
    value.reasoningModes,
    at(path, "reasoningModes"),
    issues,
  );

  let rateLimitGroup: string | undefined;
  const rawGroup = value.rateLimitGroup;
  if (typeof rawGroup !== "string" || !IDENTIFIER_REGEX.test(rawGroup)) {
    pushIssue(
      issues,
      at(path, "rateLimitGroup"),
      "invalid_rate_limit_group",
      "must be a non-empty identifier naming the shared rate-limit group",
    );
  } else {
    rateLimitGroup = rawGroup;
  }

  const provider = validateProvider(value.provider, at(path, "provider"), issues);

  if (openRouterId === undefined || rateLimitGroup === undefined || reasoningModes.length === 0) {
    return undefined;
  }
  return provider === undefined
    ? { openRouterId, reasoningModes, rateLimitGroup }
    : { openRouterId, reasoningModes, rateLimitGroup, provider };
}

function validateModels(
  value: unknown,
  issues: ValidationIssue[],
): Record<string, ModelAliasConfig> {
  const models: Record<string, ModelAliasConfig> = {};
  if (!isObject(value)) {
    pushIssue(issues, "models", "invalid_type", "must be an object of model aliases");
    return models;
  }
  const names = Object.keys(value);
  if (names.length === 0) {
    pushIssue(issues, "models", "empty_list", "must define at least one model alias");
    return models;
  }
  for (const name of names) {
    const path = at("models", name);
    if (!IDENTIFIER_REGEX.test(name)) {
      pushIssue(
        issues,
        path,
        "invalid_alias",
        "alias names must start with a letter or digit and contain only letters, digits, '.', '_', or '-'",
      );
      continue;
    }
    const alias = validateAlias(value[name], path, issues);
    if (alias !== undefined) models[name] = alias;
  }
  return models;
}

function validateSets(
  value: unknown,
  models: Record<string, ModelAliasConfig>,
  issues: ValidationIssue[],
): Record<string, ModelSetConfig> {
  const sets: Record<string, ModelSetConfig> = {};
  if (!isObject(value)) {
    pushIssue(issues, "sets", "invalid_type", "must be an object of named sets");
    return sets;
  }
  const names = Object.keys(value);
  if (names.length === 0) {
    pushIssue(issues, "sets", "empty_list", "must define at least one named set");
    return sets;
  }
  for (const name of names) {
    const path = at("sets", name);
    if (!IDENTIFIER_REGEX.test(name)) {
      pushIssue(issues, path, "invalid_set_name", "set names must be valid identifiers");
      continue;
    }
    const raw = value[name];
    if (!isObject(raw)) {
      pushIssue(issues, path, "invalid_type", "must be an object with a models array");
      continue;
    }
    checkUnknownKeys(raw, SET_KEYS, path, issues);
    const rawModels = raw.models;
    if (!Array.isArray(rawModels) || rawModels.length === 0) {
      pushIssue(
        issues,
        at(path, "models"),
        "empty_list",
        "must reference at least one model alias",
      );
      continue;
    }
    const selected: string[] = [];
    const seen = new Set<string>();
    rawModels.forEach((entry, index) => {
      const entryPath = indexAt(at(path, "models"), index);
      if (typeof entry !== "string") {
        pushIssue(issues, entryPath, "invalid_alias_reference", "must be a model alias name");
        return;
      }
      if (seen.has(entry)) {
        pushIssue(issues, entryPath, "duplicate_alias_reference", `duplicate alias "${entry}"`);
        return;
      }
      seen.add(entry);
      if (models[entry] === undefined) {
        pushIssue(
          issues,
          entryPath,
          "unknown_alias",
          `alias "${entry}" is not defined in models; available aliases: ${Object.keys(models).join(", ") || "none"}`,
        );
        return;
      }
      selected.push(entry);
    });
    sets[name] = { models: selected };
  }
  return sets;
}

function validateConfigDocument(input: unknown, issues: ValidationIssue[]): MmstarConfig {
  const config: MmstarConfig = {
    version: CONFIG_VERSION,
    dataset: { path: DATASET_PATH_DEFAULT },
    execution: { ...EXECUTION_DEFAULTS },
    models: {},
    sets: {},
  };

  if (!isObject(input)) {
    pushIssue(issues, "", "invalid_type", "configuration root must be a JSON object");
    return config;
  }

  checkUnknownKeys(input, ROOT_KEYS, "", issues);

  if (input.version === undefined) {
    pushIssue(
      issues,
      "version",
      "missing_version",
      `missing required "version"; expected ${CONFIG_VERSION}`,
    );
  } else if (input.version !== CONFIG_VERSION) {
    pushIssue(
      issues,
      "version",
      "unsupported_version",
      `unsupported configuration version ${JSON.stringify(input.version)}; expected ${CONFIG_VERSION}`,
    );
  }

  if (input.$schema !== undefined) {
    if (typeof input.$schema !== "string" || input.$schema.trim() === "") {
      pushIssue(issues, "$schema", "invalid_type", "must be a non-empty string when present");
    } else {
      config.$schema = input.$schema;
    }
  }

  config.dataset = validateDataset(input.dataset, issues);
  config.execution = validateExecution(input.execution, issues);
  config.models = validateModels(input.models, issues);
  config.sets = validateSets(input.sets, config.models, issues);

  return config;
}

/** Default `$schema` value for configs kept in the repository root. */
export const CONFIG_SCHEMA_REFERENCE = "./mmstar.config.schema.json";
