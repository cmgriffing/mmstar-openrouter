import type { EvaluationPlan } from "@mmstar/config";
import { describe, expect, it } from "vitest";
import { type ModelCatalog, parseModelCatalogResponse } from "./provider-metadata";
import { decideReasoningRequest, preflightPlan, resolveAllEfforts } from "./provider-preflight";

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

function planFor(entries: readonly { alias: string; id: string; mode: string }[]): EvaluationPlan {
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

  it("rejects a plan that still contains the unresolved all sentinel", () => {
    const catalog = catalogOf([imageModel("vendor/all", { supported_efforts: null })]);
    const result = preflightPlan(planFor([{ alias: "a", id: "vendor/all", mode: "all" }]), catalog);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("unsupported_reasoning_effort");
    expect(result.issues[0]?.path).toBe("plan.evaluations[0].reasoningMode");
    expect(result.issues[0]?.message).toContain("sentinel");
  });
});

function reasoningOf(catalog: ModelCatalog, id: string) {
  const metadata = catalog.models.find((model) => model.id === id);
  if (metadata === undefined) throw new Error(`missing model ${id}`);
  return metadata.reasoning;
}

describe("resolveAllEfforts", () => {
  it("reorders listed efforts ascending, including none", () => {
    const catalog = catalogOf([
      imageModel("vendor/reasoner", {
        supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"],
      }),
    ]);
    expect(resolveAllEfforts(reasoningOf(catalog, "vendor/reasoner"))).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("appends unknown values in catalog order and deduplicates", () => {
    const catalog = catalogOf([
      imageModel("vendor/future", {
        supported_efforts: ["ultra", "high", "ultra", "low"],
      }),
    ]);
    expect(resolveAllEfforts(reasoningOf(catalog, "vendor/future"))).toEqual([
      "low",
      "high",
      "ultra",
    ]);
  });

  it("expands null to the full gateway vocabulary ascending", () => {
    const catalog = catalogOf([imageModel("vendor/all", { supported_efforts: null })]);
    expect(resolveAllEfforts(reasoningOf(catalog, "vendor/all"))).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("falls back to a single default when no effort can be selected", () => {
    const empty = catalogOf([imageModel("vendor/empty", { supported_efforts: [] })]);
    expect(resolveAllEfforts(reasoningOf(empty, "vendor/empty"))).toEqual(["default"]);

    // Gemma-shaped metadata: a reasoning object without supported_efforts.
    const noSelection = catalogOf([imageModel("vendor/gemma", { default_enabled: true })]);
    expect(resolveAllEfforts(reasoningOf(noSelection, "vendor/gemma"))).toEqual(["default"]);

    const nonReasoning = catalogOf([imageModel("vendor/plain")]);
    expect(resolveAllEfforts(reasoningOf(nonReasoning, "vendor/plain"))).toEqual(["default"]);
  });

  it("trims listed values, drops blank entries, and falls back when nothing remains", () => {
    const messy = catalogOf([
      imageModel("vendor/messy", { supported_efforts: [" high ", "", "   ", "high"] }),
    ]);
    expect(resolveAllEfforts(reasoningOf(messy, "vendor/messy"))).toEqual(["high"]);

    const blank = catalogOf([imageModel("vendor/blank", { supported_efforts: ["", "   "] })]);
    expect(resolveAllEfforts(reasoningOf(blank, "vendor/blank"))).toEqual(["default"]);
  });

  it("maps a literal default entry to the baseline evaluation", () => {
    const catalog = catalogOf([
      imageModel("vendor/defensive", { supported_efforts: ["default", "high"] }),
    ]);
    const efforts = resolveAllEfforts(reasoningOf(catalog, "vendor/defensive"));
    expect(efforts).toEqual(["default", "high"]);

    const result = preflightPlan(
      planFor(efforts.map((mode) => ({ alias: "a", id: "vendor/defensive", mode }))),
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preflight.evaluations[0]?.reasoning).toBeNull();
    expect(result.preflight.evaluations[1]?.reasoning).toEqual({ effort: "high" });
  });

  it("resolves none from metadata and preflight rejects it when reasoning is mandatory", () => {
    const catalog = catalogOf([
      imageModel("vendor/mandatory", { supported_efforts: ["none", "low"], mandatory: true }),
    ]);
    const efforts = resolveAllEfforts(reasoningOf(catalog, "vendor/mandatory"));
    expect(efforts).toEqual(["none", "low"]);

    const result = preflightPlan(
      planFor(efforts.map((mode) => ({ alias: "a", id: "vendor/mandatory", mode }))),
      catalog,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe("mandatory_reasoning");
    expect(result.issues[0]?.path).toBe("plan.evaluations[0].reasoningMode");
  });

  it("carries an unknown resolved effort through preflight as a concrete string", () => {
    const catalog = catalogOf([
      imageModel("vendor/future", { supported_efforts: ["low", "ultra"] }),
    ]);
    const efforts = resolveAllEfforts(reasoningOf(catalog, "vendor/future"));
    const result = preflightPlan(
      planFor(efforts.map((mode) => ({ alias: "a", id: "vendor/future", mode }))),
      catalog,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preflight.evaluations[1]?.reasoningMode).toBe("ultra");
    expect(result.preflight.evaluations[1]?.reasoning).toEqual({ effort: "ultra" });
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

  it("rejects the all sentinel instead of sending it as an effort", () => {
    const decision = decideReasoningRequest("all", reasoning);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("unsupported_reasoning_effort");
    expect(decision.message).toContain("sentinel");
  });
});
