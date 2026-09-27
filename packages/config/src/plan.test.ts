import { describe, expect, it } from "vitest";
import type { EvaluationPlan, MmstarConfig } from "./index";
import { expandPlan, parseMmstarConfig } from "./index";

function parseOrThrow(input: unknown): MmstarConfig {
  const result = parseMmstarConfig(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.config;
}

function configWithModels(
  models: Record<string, unknown>,
  setModels: string[] = Object.keys(models),
): MmstarConfig {
  return parseOrThrow({ version: 1, models, sets: { demo: { models: setModels } } });
}

const baseSource = {
  setName: "demo",
  fixtureIds: ["0", "1", "2"],
  datasetSha256: "dataset-sha",
  configSha256: "config-sha",
  promptVersion: 3,
  scorerVersion: 4,
} as const;

function expandOrThrow(source: Parameters<typeof expandPlan>[0]): EvaluationPlan {
  const result = expandPlan(source);
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.plan;
}

describe("expandPlan", () => {
  it("expands deterministically in set then mode order", () => {
    const config = configWithModels({
      "vision-a": {
        openRouterId: "vendor/vision-a",
        reasoningModes: ["default", "high"],
        rateLimitGroup: "family-a",
      },
      "vision-b": {
        openRouterId: "vendor/vision-b",
        reasoningModes: ["none"],
        rateLimitGroup: "family-b",
      },
    });

    const plan = expandOrThrow({ config, ...baseSource });
    expect(plan.planVersion).toBe(1);
    expect(plan.evaluations.map((evaluation) => evaluation.evaluationId)).toEqual([
      "vision-a::default",
      "vision-a::high",
      "vision-b::none",
    ]);
    expect(plan.evaluations.map((evaluation) => evaluation.rateLimitGroup)).toEqual([
      "family-a",
      "family-a",
      "family-b",
    ]);
    expect(plan.dataset).toEqual({
      path: "MMStar.tsv",
      sha256: "dataset-sha",
      fixtureCount: 3,
      fixtureIds: ["0", "1", "2"],
    });
    expect(plan.configSha256).toBe("config-sha");
    expect(plan.promptVersion).toBe(3);
    expect(plan.scorerVersion).toBe(4);

    const repeated = expandOrThrow({ config, ...baseSource });
    expect(repeated).toEqual(plan);
  });

  it("rejects duplicate evaluations across aliases", () => {
    const config = configWithModels({
      a: { openRouterId: "vendor/same", reasoningModes: ["high"], rateLimitGroup: "g" },
      b: { openRouterId: "vendor/same", reasoningModes: ["high"], rateLimitGroup: "g" },
    });
    const result = expandPlan({ config, ...baseSource });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(["duplicate_evaluation"]);
      expect(result.issues[0]?.message).toContain("vendor/same");
    }
  });

  it("allows the same model and mode with different provider routing", () => {
    const config = configWithModels({
      a: { openRouterId: "vendor/same", reasoningModes: ["high"], rateLimitGroup: "g" },
      b: {
        openRouterId: "vendor/same",
        reasoningModes: ["high"],
        rateLimitGroup: "g",
        provider: { only: ["provider-a"], allowFallbacks: false },
      },
    });
    const plan = expandOrThrow({ config, ...baseSource });
    expect(plan.evaluations.map((evaluation) => evaluation.evaluationId)).toEqual([
      "a::high",
      "b::high",
    ]);
  });

  it("reports unknown sets and duplicate fixture selection", () => {
    const config = configWithModels({
      a: { openRouterId: "vendor/a", reasoningModes: ["default"], rateLimitGroup: "g" },
    });
    const unknown = expandPlan({ config, ...baseSource, setName: "missing" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues[0]?.code).toBe("unknown_set");

    const duplicated = expandPlan({ config, ...baseSource, fixtureIds: ["0", "0"] });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.issues.map((issue) => issue.code)).toContain("duplicate_fixture");
    }
  });

  it("expands all from a resolved effort list in ascending order", () => {
    const config = configWithModels({
      a: { openRouterId: "vendor/a", reasoningModes: "all", rateLimitGroup: "g" },
    });
    const resolvedEfforts = new Map([["a", ["none", "low", "medium", "high", "xhigh", "max"]]]);
    const plan = expandOrThrow({ config, ...baseSource, resolvedEfforts });
    expect(plan.evaluations.map((evaluation) => evaluation.evaluationId)).toEqual([
      "a::none",
      "a::low",
      "a::medium",
      "a::high",
      "a::xhigh",
      "a::max",
    ]);
    expect(plan.evaluations.map((evaluation) => evaluation.reasoningMode)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("passes unknown resolved effort strings through as concrete modes", () => {
    const config = configWithModels({
      a: { openRouterId: "vendor/a", reasoningModes: "all", rateLimitGroup: "g" },
    });
    const plan = expandOrThrow({
      config,
      ...baseSource,
      resolvedEfforts: new Map([["a", ["low", "ultra"]]]),
    });
    expect(plan.evaluations.map((evaluation) => evaluation.evaluationId)).toEqual([
      "a::low",
      "a::ultra",
    ]);
  });

  it("fails closed when all has no resolved effort list", () => {
    const config = configWithModels({
      a: { openRouterId: "vendor/a", reasoningModes: "all", rateLimitGroup: "g" },
    });
    const result = expandPlan({ config, ...baseSource });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(["all_requires_metadata"]);
      expect(result.issues[0]?.path).toBe("sets.demo.models[0]");
      expect(result.issues[0]?.message).toContain('"a"');
    }
  });

  it("detects duplicates across aliases resolved from all", () => {
    const config = configWithModels({
      a: { openRouterId: "vendor/same", reasoningModes: "all", rateLimitGroup: "g" },
      b: { openRouterId: "vendor/same", reasoningModes: "all", rateLimitGroup: "g" },
    });
    const resolvedEfforts = new Map([
      ["a", ["low"]],
      ["b", ["low"]],
    ]);
    const result = expandPlan({ config, ...baseSource, resolvedEfforts });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(["duplicate_evaluation"]);
      expect(result.issues[0]?.message).toContain("vendor/same");
    }
  });
});
