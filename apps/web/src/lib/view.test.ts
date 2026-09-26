import type { EvaluationComparison, RunSummary } from "@mmstar/results";
import { OUTCOME_KINDS, OUTCOME_STATES } from "@mmstar/results";
import { describe, expect, it } from "vitest";
import {
  categoryCell,
  categoryMatrix,
  comparisonCost,
  fixtureQueryString,
  isIncomplete,
  OUTCOME_KIND_OPTIONS,
  OUTCOME_STATE_OPTIONS,
  outcomePresentation,
  parseBackTarget,
  publicationSettingIssues,
  readFixtureFilters,
  sortComparisons,
  unresolvedCount,
} from "./view";

function comparison(overrides: Partial<EvaluationComparison> = {}): EvaluationComparison {
  return {
    rootRunId: "root",
    evaluationId: "alpha::high",
    modelAlias: "alpha",
    openRouterId: "vendor/alpha",
    reasoningMode: "high",
    rateLimitGroup: "g-alpha",
    selected: 10,
    settled: 10,
    correct: 6,
    incorrect: 4,
    ambiguous: 0,
    invalid: 0,
    refused: 0,
    truncated: 0,
    pending: 0,
    failed: 0,
    indeterminate: 0,
    cancelled: 0,
    attempts: 10,
    coverage: 1,
    scoredAccuracy: 0.6,
    selectedAccuracy: 0.6,
    meanRequestLatencyMs: 1200,
    meanTotalFixtureTimeMs: 1300,
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    reasoningTokens: null,
    usageUnknownCount: 0,
    reportedUsd: 0.5,
    estimatedUsd: null,
    knownUsd: 0.5,
    costUnknownCount: 0,
    ...overrides,
  };
}

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "root",
    rootRunId: "root",
    runKind: "primary",
    parentRunId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
    lifecycleState: "completed",
    setName: "demo",
    fixtureCount: 10,
    recoveredFixtureCount: 0,
    promptVersion: 1,
    scorerVersion: 1,
    datasetSha256: "abc",
    codeDirty: false,
    isRoot: true,
    ...overrides,
  };
}

describe("view vocabularies", () => {
  it("mirrors the repository outcome unions without importing them client-side", () => {
    expect(OUTCOME_STATE_OPTIONS.map((option) => option.value)).toEqual([...OUTCOME_STATES]);
    expect(OUTCOME_KIND_OPTIONS.map((option) => option.value)).toEqual([...OUTCOME_KINDS]);
  });
});

describe("outcomePresentation", () => {
  it("labels scored and unresolved outcomes with distinct symbols", () => {
    expect(outcomePresentation("settled", "correct")).toEqual({
      label: "Correct",
      symbol: "✓",
      tone: "good",
    });
    expect(outcomePresentation("settled", "incorrect")).toEqual({
      label: "Incorrect",
      symbol: "×",
      tone: "bad",
    });
    expect(outcomePresentation("settled", "truncated").tone).toBe("warn");
    expect(outcomePresentation("failed", null)).toEqual({
      label: "Failed",
      symbol: "✗",
      tone: "bad",
    });
    expect(outcomePresentation("indeterminate", null)).toEqual({
      label: "Indeterminate",
      symbol: "?",
      tone: "warn",
    });
    expect(outcomePresentation("pending", null).tone).toBe("neutral");
  });
});

describe("comparison presentation", () => {
  it("flags incomplete and unresolved work", () => {
    expect(isIncomplete(comparison())).toBe(false);
    expect(isIncomplete(comparison({ settled: 9, pending: 1 }))).toBe(true);
    expect(unresolvedCount(comparison({ failed: 2, indeterminate: 1 }))).toBe(3);
  });

  it("sorts by selected accuracy then alias", () => {
    const rows = [
      comparison({ modelAlias: "beta", selectedAccuracy: 0.5, scoredAccuracy: 0.5 }),
      comparison({ modelAlias: "alpha", selectedAccuracy: 0.7, scoredAccuracy: 0.6 }),
      comparison({ modelAlias: "alpha", reasoningMode: "low", selectedAccuracy: 0.7 }),
    ];
    expect(sortComparisons(rows).map((row) => `${row.modelAlias}:${row.reasoningMode}`)).toEqual([
      "alpha:high",
      "alpha:low",
      "beta:high",
    ]);
  });

  it("keeps unknown cost distinct from a zero cost", () => {
    const known = comparisonCost(comparison({ knownUsd: 0, reportedUsd: 0 }));
    expect(known.text).toBe("$0.00");
    expect(known.missing).toBe(false);

    const missing = comparisonCost(comparison({ knownUsd: null, reportedUsd: null }));
    expect(missing.text).toBe("not reported");
    expect(missing.missing).toBe(true);

    const unknown = comparisonCost(
      comparison({ knownUsd: null, reportedUsd: null, costUnknownCount: 3 }),
    );
    expect(unknown.text).toBe("—");
    expect(unknown.detail).toContain("3 attempts with unknown cost");
  });

  it("reports mixed frozen settings across winning families", () => {
    expect(publicationSettingIssues([run(), run({ runId: "child", rootRunId: "root" })])).toEqual(
      [],
    );
    const issues = publicationSettingIssues([run(), run({ runId: "child", promptVersion: 2 })]);
    expect(issues).toEqual([{ field: "prompt version", values: ["v1", "v2"] }]);
  });
});

describe("filter sanitization", () => {
  const context = {
    evaluationIds: new Set(["alpha::high"]),
    categories: new Set(["biology"]),
  };

  it("accepts known values and reports unknown ones", () => {
    const valid = readFixtureFilters(
      new URLSearchParams({ evaluationId: "alpha::high", category: "biology", state: "failed" }),
      context,
    );
    expect(valid.values).toEqual({
      evaluationId: "alpha::high",
      category: "biology",
      state: "failed",
      offset: 0,
    });
    expect(valid.invalid).toEqual([]);

    const invalid = readFixtureFilters(
      new URLSearchParams({
        evaluationId: "nope",
        category: "nope",
        state: "nope",
        kind: "nope",
        offset: "-3",
      }),
      context,
    );
    expect(invalid.values).toEqual({ offset: 0 });
    expect(invalid.invalid).toEqual(["evaluationId", "category", "state", "kind", "offset"]);
  });

  it("only allows same-site back targets", () => {
    expect(parseBackTarget("/fixtures?rootRunId=x")).toBe("/fixtures?rootRunId=x");
    expect(parseBackTarget("https://evil.example/")).toBeNull();
    expect(parseBackTarget("//evil.example/fixtures")).toBeNull();
    expect(parseBackTarget(null)).toBeNull();
  });

  it("builds canonical drilldown query strings with an explicit page size", () => {
    expect(fixtureQueryString({ evaluationId: "alpha::high", limit: 25 })).toBe(
      "evaluationId=alpha%3A%3Ahigh&limit=25",
    );
    expect(fixtureQueryString({ offset: 0 })).toBe("");
    expect(fixtureQueryString({ state: "failed", offset: 50 })).toBe("state=failed&offset=50");
  });
});

describe("category matrix", () => {
  it("groups category rows by evaluation", () => {
    const rows = [
      {
        rootRunId: "root",
        evaluationId: "alpha::high",
        category: "biology",
        selected: 10,
        settled: 8,
        correct: 4,
        accuracy: 0.5,
      },
      {
        rootRunId: "root",
        evaluationId: "alpha::high",
        category: "math",
        selected: 5,
        settled: 5,
        correct: 5,
        accuracy: 1,
      },
    ];
    const matrix = categoryMatrix(rows);
    expect(matrix.names).toEqual(["biology", "math"]);
    expect(categoryCell(matrix.byEvaluation.get("alpha::high")?.get("biology"))).toBe(
      "50.0% · 4 / 8",
    );
    expect(categoryCell(undefined)).toBe("—");
  });
});
