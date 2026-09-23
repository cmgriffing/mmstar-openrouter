import type { EvaluationPlan, ReasoningMode } from "@mmstar/config";
import { describe, expect, it } from "vitest";
import { type ModelCatalog, parseModelCatalogResponse } from "./provider-metadata";
import { decideReasoningRequest, preflightPlan } from "./provider-preflight";

const FETCHED_AT = "2026-09-23T00:00:00.000Z";

function catalogOf(models: readonly Record<string, unknown>[]): ModelCatalog {
  return parseModelCatalogResponse({ data: models }, FETCHED_AT);
}

function imageModel(id: string, reasoning?: unknown): Record<string, unknown> {
  return {
    id,
    name: id,
    architecture: { input_modalities: ["text", "image"] },
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function planFor(
  entries: readonly { alias: string; id: string; mode: ReasoningMode }[],
): EvaluationPlan {
  return {
    planVersion: 1,
    setName: "demo",
    promptVersion: 1,
    scorerVersion: 1,
    dataset: { path: "MMStar.tsv", sha256: "dataset-sha", fixtureCount: 1, fixtureIds: ["0"] },
    configSha256: null,
    evaluations: entries.map((entry) => ({
      evaluationId: `${entry.alias}::${entry.mode}`,
      modelAlias: entry.alias,
      openRouterId: entry.id,
      reasoningMode: entry.mode,
      rateLimitGroup: "group",
      provider: null,
    })),
  };
}

describe("preflightPlan", () => {
  it("accepts a listed effort and records the capability snapshot", () => {
    const catalog = catalogOf([
      imageModel("vendor/reasoner", {
        supported_efforts: ["high", "medium", "low"],
        default_effort: "medium",
        default_enabled: true,
        mandatory: false,
      }),
    ]);

    const result = preflightPlan(
      planFor([{ alias: "a", id: "vendor/reasoner", mode: "high" }]),
      catalog,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preflight.evaluations[0]?.reasoning).toEqual({ effort: "high" });
    expect(result.preflight.capabilities).toEqual([
      {
        snapshotVersion: 1,
        modelId: "vendor/reasoner",
        fetchedAt: FETCHED_AT,
        imageInput: true,
        inputModalities: ["text", "image"],
        reasoning: {
          supportedEfforts: ["high", "medium", "low"],
          defaultEffort: "medium",
          defaultEnabled: true,
          supportsMaxTokens: false,
          mandatory: false,
        },
      },
    ]);
  });

  it("rejects an effort the metadata does not list while accepting a listed one", () => {
    const catalog = catalogOf([
      imageModel("vendor/reasoner", { supported_efforts: ["high", "low"] }),
    ]);

    const result = preflightPlan(
      planFor([
        { alias: "a", id: "vendor/reasoner", mode: "high" },
        { alias: "a", id: "vendor/reasoner", mode: "medium" },
      ]),
      catalog,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe("unsupported_reasoning_effort");
    expect(result.issues[0]?.path).toBe("plan.evaluations[1].reasoningMode");
    expect(result.issues[0]?.message).toContain("high, low");
  });

  it("accepts any explicit effort when supported_efforts is null", () => {
    const catalog = catalogOf([imageModel("vendor/all", { supported_efforts: null })]);
    const result = preflightPlan(
      planFor([{ alias: "a", id: "vendor/all", mode: "xhigh" }]),
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preflight.evaluations[0]?.reasoning).toEqual({ effort: "xhigh" });
  });

  it("rejects explicit efforts when no effort selection is exposed", () => {
    const noReasoningObject = catalogOf([imageModel("vendor/plain")]);
    const result = preflightPlan(
      planFor([{ alias: "a", id: "vendor/plain", mode: "low" }]),
      noReasoningObject,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("unsupported_reasoning_effort");
    expect(result.issues[0]?.message).toContain("no effort selection");
  });

  it("accepts default and none for a non-reasoning model and omits the parameter", () => {
    const catalog = catalogOf([imageModel("vendor/plain")]);
    const result = preflightPlan(
      planFor([
        { alias: "a", id: "vendor/plain", mode: "default" },
        { alias: "a", id: "vendor/plain", mode: "none" },
      ]),
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preflight.evaluations[0]?.reasoning).toBeNull();
    expect(result.preflight.evaluations[1]?.reasoning).toBeNull();
    expect(result.preflight.capabilities[0]?.reasoning.supportedEfforts).toBe("non-reasoning");
  });

  it("rejects none when reasoning is mandatory", () => {
    const catalog = catalogOf([
      imageModel("vendor/mandatory", { supported_efforts: ["high", "low"], mandatory: true }),
    ]);
    const result = preflightPlan(
      planFor([{ alias: "a", id: "vendor/mandatory", mode: "none" }]),
      catalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("mandatory_reasoning");
  });

  it("accepts default and explicit efforts for a mandatory-reasoning model", () => {
    const catalog = catalogOf([
      imageModel("vendor/mandatory", { supported_efforts: ["high", "low"], mandatory: true }),
    ]);
    const result = preflightPlan(
      planFor([
        { alias: "a", id: "vendor/mandatory", mode: "default" },
        { alias: "a", id: "vendor/mandatory", mode: "low" },
      ]),
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preflight.evaluations[0]?.reasoning).toBeNull();
    expect(result.preflight.evaluations[1]?.reasoning).toEqual({ effort: "low" });
  });

  it("fails closed when the reasoning object omits supported_efforts", () => {
    const catalog = catalogOf([imageModel("vendor/vague", { default_enabled: true })]);
    const explicit = preflightPlan(
      planFor([{ alias: "a", id: "vendor/vague", mode: "medium" }]),
      catalog,
    );
    expect(explicit.ok).toBe(false);
    if (explicit.ok) return;
    expect(explicit.issues[0]?.code).toBe("unsupported_reasoning_effort");

    const none = preflightPlan(
      planFor([{ alias: "a", id: "vendor/vague", mode: "none" }]),
      catalog,
    );
    expect(none.ok).toBe(true);
    if (!none.ok) return;
    expect(none.preflight.evaluations[0]?.reasoning).toEqual({ effort: "none" });
  });

  it("rejects models without image input", () => {
    const catalog = catalogOf([
      {
        id: "vendor/text-only",
        architecture: { input_modalities: ["text"] },
      },
    ]);
    const result = preflightPlan(
      planFor([{ alias: "a", id: "vendor/text-only", mode: "default" }]),
      catalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("missing_image_input");
    expect(result.issues[0]?.message).toContain("text");
  });

  it("rejects unknown models", () => {
    const catalog = catalogOf([imageModel("vendor/known")]);
    const result = preflightPlan(
      planFor([{ alias: "a", id: "vendor/missing", mode: "default" }]),
      catalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("unknown_model");
  });

  it("collects every issue instead of stopping at the first", () => {
    const catalog = catalogOf([imageModel("vendor/reasoner", { supported_efforts: ["low"] })]);
    const result = preflightPlan(
      planFor([
        { alias: "a", id: "vendor/unknown", mode: "default" },
        { alias: "a", id: "vendor/reasoner", mode: "max" },
      ]),
      catalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "unknown_model",
      "unsupported_reasoning_effort",
    ]);
  });

  it("deduplicates capability snapshots for repeated model IDs", () => {
    const catalog = catalogOf([imageModel("vendor/reasoner", { supported_efforts: null })]);
    const result = preflightPlan(
      planFor([
        { alias: "a", id: "vendor/reasoner", mode: "default" },
        { alias: "b", id: "vendor/reasoner", mode: "high" },
      ]),
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preflight.capabilities).toHaveLength(1);
    expect(result.preflight.evaluations).toHaveLength(2);
  });
});

describe("decideReasoningRequest", () => {
  const reasoning = {
    supportedEfforts: ["high", "low"] as string[] | null | "no-effort-selection" | "non-reasoning",
    defaultEffort: "low" as string | null,
    defaultEnabled: null,
    supportsMaxTokens: false,
    mandatory: null as boolean | null,
  };

  it("always omits the parameter for default, even when reasoning is mandatory", () => {
    expect(decideReasoningRequest("default", { ...reasoning, mandatory: true })).toEqual({
      ok: true,
      reasoning: null,
    });
  });
});
