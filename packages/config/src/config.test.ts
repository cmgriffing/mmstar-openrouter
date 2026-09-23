import { describe, expect, it } from "vitest";
import exampleConfig from "../../../mmstar.config.example.json";
import type { MmstarConfig } from "./index";
import {
  CONFIG_VERSION,
  DATASET_PATH_DEFAULT,
  EXECUTION_DEFAULTS,
  parseMmstarConfig,
  parseMmstarConfigJson,
  RESULTS_ROOT_DEFAULT,
} from "./index";

function fullConfig(): Record<string, unknown> {
  return {
    version: 1,
    $schema: "./mmstar.config.schema.json",
    dataset: { path: "datasets/MMStar.tsv" },
    execution: {
      maxConcurrentGroups: 2,
      maxRetries: 5,
      requestTimeoutMs: 30_000,
      maxRequestsPerMinute: 120,
      resultsRoot: "runs",
    },
    models: {
      "vision-a": {
        openRouterId: "vendor/vision-a",
        reasoningModes: ["default", "high"],
        rateLimitGroup: "vendor-family",
        provider: { only: ["provider-a"], allowFallbacks: false, sort: "price" },
      },
      "vision-b": {
        openRouterId: "vendor/vision-b",
        reasoningModes: ["none"],
        rateLimitGroup: "vendor-family",
      },
    },
    sets: { demo: { models: ["vision-a", "vision-b"] } },
  };
}

function parseOrThrow(input: unknown): MmstarConfig {
  const result = parseMmstarConfig(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.config;
}

function issueKeys(input: unknown): string[] {
  const result = parseMmstarConfig(input);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}:${issue.code}`);
}

describe("parseMmstarConfig", () => {
  it("parses a full document and preserves declared ordering", () => {
    const config = parseOrThrow(fullConfig());
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.$schema).toBe("./mmstar.config.schema.json");
    expect(config.dataset.path).toBe("datasets/MMStar.tsv");
    expect(config.execution).toEqual({
      maxConcurrentGroups: 2,
      maxRetries: 5,
      requestTimeoutMs: 30_000,
      maxRequestsPerMinute: 120,
      resultsRoot: "runs",
    });
    expect(Object.keys(config.models)).toEqual(["vision-a", "vision-b"]);
    expect(config.models["vision-a"]?.reasoningModes).toEqual(["default", "high"]);
    expect(config.sets.demo?.models).toEqual(["vision-a", "vision-b"]);
  });

  it("applies documented defaults for minimal input", () => {
    const config = parseOrThrow({
      version: 1,
      models: {
        a: { openRouterId: "vendor/a", reasoningModes: ["default"], rateLimitGroup: "g" },
      },
      sets: { s: { models: ["a"] } },
    });
    expect(config.dataset.path).toBe(DATASET_PATH_DEFAULT);
    expect(config.execution).toEqual(EXECUTION_DEFAULTS);
    expect(config.execution.resultsRoot).toBe(RESULTS_ROOT_DEFAULT);
    expect(config.models.a?.provider).toBeUndefined();
  });

  it("rejects a non-object root and an unsupported version with actionable paths", () => {
    expect(issueKeys(["not", "a", "config"])).toEqual([":invalid_type"]);
    expect(issueKeys({ models: {}, sets: {} })).toContain("version:missing_version");
    expect(issueKeys({ ...fullConfig(), version: 2 })).toContain("version:unsupported_version");
  });

  it("rejects unknown fields at every level", () => {
    const input = fullConfig();
    input.extra = true;
    const models = input.models as Record<string, Record<string, unknown>>;
    models["vision-a"] = { ...models["vision-a"], temperature: 0.5 };
    const sets = input.sets as Record<string, Record<string, unknown>>;
    sets.demo = { ...sets.demo, fixtures: ["0"] };
    const keys = issueKeys(input);
    expect(keys).toContain("extra:unknown_field");
    expect(keys).toContain("models.vision-a.temperature:unknown_field");
    expect(keys).toContain("sets.demo.fixtures:unknown_field");
  });

  it("validates reasoning modes, aliases, and model IDs", () => {
    const keys = issueKeys({
      version: 1,
      models: {
        a: {
          openRouterId: "openai/gpt-5: nitro",
          reasoningModes: ["high", "sideways", "high"],
          rateLimitGroup: "",
        },
      },
      sets: { s: { models: ["a"] } },
    });
    expect(keys).toEqual(
      expect.arrayContaining([
        "models.a.openRouterId:model_variant_id",
        "models.a.reasoningModes[1]:unknown_reasoning_mode",
        "models.a.reasoningModes[2]:duplicate_reasoning_mode",
        "models.a.rateLimitGroup:invalid_rate_limit_group",
      ]),
    );
  });

  it("rejects dynamic routers and malformed model IDs", () => {
    const base = (openRouterId: string): Record<string, unknown> => ({
      version: 1,
      models: { a: { openRouterId, reasoningModes: ["default"], rateLimitGroup: "g" } },
      sets: { s: { models: ["a"] } },
    });
    expect(issueKeys(base("openrouter/auto"))).toContain("models.a.openRouterId:dynamic_model_id");
    expect(issueKeys(base("openrouter/free"))).toContain("models.a.openRouterId:dynamic_model_id");
    expect(issueKeys(base("novendor"))).toContain("models.a.openRouterId:invalid_model_id");
  });

  it("validates provider routing preferences", () => {
    const input = fullConfig();
    const models = input.models as Record<string, Record<string, unknown>>;
    models["vision-a"] = {
      ...models["vision-a"],
      provider: { only: ["provider-a"], ignore: ["provider-b"], sort: "cheapest", nope: 1 },
    };
    const keys = issueKeys(input);
    expect(keys).toContain("models.vision-a.provider:conflicting_provider_filter");
    expect(keys).toContain("models.vision-a.provider.sort:unknown_provider_sort");
    expect(keys).toContain("models.vision-a.provider.nope:unknown_field");
  });

  it("rejects out-of-range execution limits", () => {
    const keys = issueKeys({
      ...fullConfig(),
      execution: {
        maxConcurrentGroups: 0,
        maxRetries: 99,
        requestTimeoutMs: 5_000_000,
        maxRequestsPerMinute: 0,
      },
    });
    expect(keys).toContain("execution.maxConcurrentGroups:out_of_range");
    expect(keys).toContain("execution.maxRetries:out_of_range");
    expect(keys).toContain("execution.requestTimeoutMs:out_of_range");
    expect(keys).toContain("execution.maxRequestsPerMinute:out_of_range");
  });

  it("keeps dataset and results paths relative and traversal-free", () => {
    const keys = issueKeys({
      ...fullConfig(),
      dataset: { path: "/etc/passwd" },
      execution: { resultsRoot: "../outside" },
    });
    expect(keys).toContain("dataset.path:invalid_path");
    expect(keys).toContain("execution.resultsRoot:invalid_path");
  });

  it("validates sets against declared aliases", () => {
    const input = fullConfig();
    const sets = input.sets as Record<string, Record<string, unknown>>;
    sets.demo = { models: ["missing", "vision-a", "vision-a"] };
    const keys = issueKeys(input);
    expect(keys).toContain("sets.demo.models[0]:unknown_alias");
    expect(keys).toContain("sets.demo.models[2]:duplicate_alias_reference");
  });

  it("keeps the committed example valid and pointed at the generated schema", () => {
    const config = parseOrThrow(exampleConfig);
    expect(config.$schema).toBe("./mmstar.config.schema.json");
    expect(Object.keys(config.models)).toEqual(["example-image-model"]);
    expect(Object.keys(config.sets)).toEqual(["example"]);
  });

  it("reports invalid JSON without throwing", () => {
    const result = parseMmstarConfigJson("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("invalid_json");
    }
  });
});
