import type { EvaluationComparison, RunSummary } from "@mmstar/results";
import { OUTCOME_KINDS, OUTCOME_STATES } from "@mmstar/results";
import { describe, expect, it } from "vitest";
import {
  buildChartAxisScale,
  categoryCell,
  categoryMatrix,
  chartEmptyMessage,
  chartExclusionText,
  compareReasoningModes,
  comparisonChartSeries,
  comparisonCost,
  comparisonCountLabel,
  comparisonHref,
  comparisonIgnoredNotices,
  comparisonQueryString,
  costExclusion,
  filterComparisonGroups,
  fixtureQueryString,
  groupEvaluations,
  isIncomplete,
  matrixEmptySelection,
  matrixRowHidden,
  median,
  nextComparisonAxes,
  nextComparisonSort,
  OUTCOME_KIND_OPTIONS,
  OUTCOME_STATE_OPTIONS,
  outcomePresentation,
  parseBackTarget,
  publicationSettingIssues,
  readComparisonFilters,
  readFixtureFilters,
  selectMatchingAction,
  sortComparisonRows,
  toggleComparisonSelection,
  toggleComparisonVisibleGroup,
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

  it("sorts by scored accuracy, then alias and effort", () => {
    const rows = [
      comparison({ modelAlias: "beta", scoredAccuracy: 0.5, selectedAccuracy: 0.9 }),
      comparison({ modelAlias: "alpha", reasoningMode: "low", scoredAccuracy: 0.7 }),
      comparison({ modelAlias: "alpha", scoredAccuracy: 0.7 }),
    ];
    expect(sortComparisonRows(rows).map((row) => `${row.modelAlias}:${row.reasoningMode}`)).toEqual(
      ["alpha:high", "alpha:low", "beta:high"],
    );
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

describe("comparison filter sanitization", () => {
  const context = { evaluationIds: new Set(["alpha::high", "alpha::low", "beta::high"]) };

  it("defaults to every evaluation, cost x pass, log scale, and accuracy desc", () => {
    const result = readComparisonFilters(new URLSearchParams(), context);
    expect(result.values).toEqual({
      models: null,
      x: "cost",
      y: "pass",
      scale: "log",
      sort: "accuracy",
      dir: "desc",
    });
    expect(result.invalid).toEqual([]);
    expect(result.ignoredModels).toEqual([]);
  });

  it("keeps known models and reports unknown ones once", () => {
    const result = readComparisonFilters(
      new URLSearchParams({ models: "alpha::high,ghost,beta::high,ghost" }),
      context,
    );
    expect(result.values.models).toEqual(["alpha::high", "beta::high"]);
    expect(result.ignoredModels).toEqual(["ghost"]);
    expect(result.invalid).toEqual([]);
    expect(result.modelsFellBack).toBe(false);
  });

  it("distinguishes an absent parameter (all) from an empty selection (none)", () => {
    expect(readComparisonFilters(new URLSearchParams(), context).values.models).toBeNull();
    expect(
      readComparisonFilters(new URLSearchParams({ models: "" }), context).values.models,
    ).toEqual([]);
  });

  it("falls back to all when every named model is unknown, like the drilldown", () => {
    const result = readComparisonFilters(new URLSearchParams({ models: "ghost" }), context);
    expect(result.values.models).toBeNull();
    expect(result.ignoredModels).toEqual(["ghost"]);
    expect(result.modelsFellBack).toBe(true);
  });

  it("drops unknown enum values and repairs a colliding axis pair", () => {
    const result = readComparisonFilters(
      new URLSearchParams({
        x: "nope",
        y: "cost",
        scale: "sqrt",
        sort: "outcomes",
        dir: "sideways",
      }),
      context,
    );
    expect(result.values.x).toBe("cost");
    expect(result.values.y).toBe("pass");
    expect(result.values.scale).toBe("log");
    expect(result.values.sort).toBe("accuracy");
    expect(result.values.dir).toBe("desc");
    expect(result.invalid).toEqual(["x", "scale", "sort", "dir"]);
    expect(result.repaired).toEqual(["y"]);
  });

  it("reports a valid colliding y as repaired rather than unknown", () => {
    const result = readComparisonFilters(new URLSearchParams({ x: "speed", y: "speed" }), context);
    expect(result.values).toEqual({
      models: null,
      x: "speed",
      y: "cost",
      scale: "log",
      sort: "accuracy",
      dir: "desc",
    });
    expect(result.invalid).toEqual([]);
    expect(result.repaired).toEqual(["y"]);
  });

  it("does not double-report an invalid y that collides after falling back to its default", () => {
    const result = readComparisonFilters(new URLSearchParams({ x: "pass", y: "nope" }), context);
    expect(result.values.x).toBe("pass");
    expect(result.values.y).toBe("cost");
    expect(result.invalid).toEqual(["y"]);
    expect(result.repaired).toEqual([]);
  });

  it("accepts explicit axis, scale, and sort values", () => {
    const result = readComparisonFilters(
      new URLSearchParams({ x: "tokens", y: "speed", scale: "linear", sort: "cost", dir: "asc" }),
      context,
    );
    expect(result.values).toEqual({
      models: null,
      x: "tokens",
      y: "speed",
      scale: "linear",
      sort: "cost",
      dir: "asc",
    });
    expect(result.invalid).toEqual([]);
  });
});

describe("comparison canonicalization", () => {
  it("omits defaults and the all-selected case", () => {
    expect(comparisonQueryString({})).toBe("");
    expect(comparisonQueryString({ models: null })).toBe("");
    expect(
      comparisonQueryString({
        x: "cost",
        y: "pass",
        scale: "log",
        sort: "accuracy",
        dir: "desc",
      }),
    ).toBe("");
    expect(comparisonHref({})).toBe("/");
  });

  it("sorts and deduplicates the selected model IDs", () => {
    expect(comparisonQueryString({ models: ["beta::high", "alpha::high", "beta::high"] })).toBe(
      "models=alpha%3A%3Ahigh%2Cbeta%3A%3Ahigh",
    );
    expect(comparisonQueryString({ models: [] })).toBe("models=");
  });

  it("keeps non-default state and round-trips it through parsing", () => {
    const state = {
      models: ["alpha::high"],
      x: "tokens" as const,
      y: "cost" as const,
      scale: "linear" as const,
      sort: "cost" as const,
      dir: "asc" as const,
    };
    const query = comparisonQueryString(state);
    expect(query).not.toBe("");
    expect(comparisonHref(state)).toBe(`/?${query}`);
    const parsed = readComparisonFilters(new URLSearchParams(query), {
      evaluationIds: new Set(["alpha::high"]),
    });
    expect(parsed.values).toEqual(state);
    expect(parsed.invalid).toEqual([]);
  });
});

describe("comparison sorting", () => {
  function sortableRows(): EvaluationComparison[] {
    return [
      comparison({
        evaluationId: "beta::high",
        modelAlias: "beta",
        knownUsd: 0.5,
        totalTokens: 300,
        meanRequestLatencyMs: 500,
        scoredAccuracy: 0.5,
      }),
      comparison({
        evaluationId: "alpha::low",
        modelAlias: "alpha",
        reasoningMode: "low",
        knownUsd: null,
        totalTokens: null,
        meanRequestLatencyMs: null,
        scoredAccuracy: 0.9,
      }),
      comparison({
        evaluationId: "alpha::high",
        modelAlias: "alpha",
        knownUsd: 0.1,
        totalTokens: 100,
        meanRequestLatencyMs: 2000,
        scoredAccuracy: 0.9,
      }),
    ];
  }

  const ids = (rows: EvaluationComparison[]) => rows.map((row) => row.evaluationId);

  it("defaults to scored accuracy descending with alias and effort tie-breaks", () => {
    expect(ids(sortComparisonRows(sortableRows()))).toEqual([
      "alpha::high",
      "alpha::low",
      "beta::high",
    ]);
  });

  it("sorts text columns in both directions", () => {
    expect(ids(sortComparisonRows(sortableRows(), "model", "asc"))).toEqual([
      "alpha::high",
      "alpha::low",
      "beta::high",
    ]);
    expect(ids(sortComparisonRows(sortableRows(), "model", "desc"))).toEqual([
      "beta::high",
      "alpha::high",
      "alpha::low",
    ]);
    expect(ids(sortComparisonRows(sortableRows(), "effort", "asc"))).toEqual([
      "alpha::high",
      "beta::high",
      "alpha::low",
    ]);
  });

  it("keeps nulls last for cost, tokens, and latency in both directions", () => {
    expect(ids(sortComparisonRows(sortableRows(), "cost", "asc"))).toEqual([
      "alpha::high",
      "beta::high",
      "alpha::low",
    ]);
    expect(ids(sortComparisonRows(sortableRows(), "cost", "desc"))).toEqual([
      "beta::high",
      "alpha::high",
      "alpha::low",
    ]);
    expect(ids(sortComparisonRows(sortableRows(), "tokens", "asc"))).toEqual([
      "alpha::high",
      "beta::high",
      "alpha::low",
    ]);
    expect(ids(sortComparisonRows(sortableRows(), "tokens", "desc"))).toEqual([
      "beta::high",
      "alpha::high",
      "alpha::low",
    ]);
    expect(ids(sortComparisonRows(sortableRows(), "latency", "asc"))).toEqual([
      "beta::high",
      "alpha::high",
      "alpha::low",
    ]);
    expect(ids(sortComparisonRows(sortableRows(), "latency", "desc"))).toEqual([
      "alpha::high",
      "beta::high",
      "alpha::low",
    ]);
  });

  it("breaks remaining ties deterministically by alias, effort, then evaluation ID", () => {
    const rows = [
      comparison({ evaluationId: "zeta::high", modelAlias: "same", scoredAccuracy: 0.4 }),
      comparison({ evaluationId: "alpha::high", modelAlias: "same", scoredAccuracy: 0.4 }),
      comparison({
        evaluationId: "alpha::low",
        modelAlias: "same",
        reasoningMode: "low",
        scoredAccuracy: 0.4,
      }),
    ];
    expect(ids(sortComparisonRows(rows, "accuracy", "desc"))).toEqual([
      "alpha::high",
      "zeta::high",
      "alpha::low",
    ]);
  });

  it("uses natural first-activation directions and toggles the active column", () => {
    const current = { sort: "cost" as const, dir: "desc" as const };
    expect(nextComparisonSort("model", current)).toEqual({ sort: "model", dir: "asc" });
    expect(nextComparisonSort("attempts", current)).toEqual({ sort: "attempts", dir: "desc" });
    expect(nextComparisonSort("cost", current)).toEqual({ sort: "cost", dir: "asc" });
  });
});

describe("cost exclusions and chart series", () => {
  it("classifies reported zero, never reported, and priced costs", () => {
    expect(costExclusion(comparison({ knownUsd: 0 }))).toBe("cost-zero");
    expect(costExclusion(comparison({ knownUsd: null }))).toBe("cost-unknown");
    expect(costExclusion(comparison({ knownUsd: 0.004 }))).toBeNull();
  });

  it("excludes zero and unknown costs with distinct reasons", () => {
    const rows = [
      comparison({ evaluationId: "free", modelAlias: "free", knownUsd: 0 }),
      comparison({ evaluationId: "unpriced", modelAlias: "unpriced", knownUsd: null }),
      comparison({
        evaluationId: "paid",
        modelAlias: "paid",
        knownUsd: 0.25,
        scoredAccuracy: 0.5,
      }),
    ];
    const series = comparisonChartSeries(rows, "cost", "pass");
    expect(series.points.map((point) => point.evaluationId)).toEqual(["paid"]);
    expect(series.excluded).toEqual([
      { evaluationId: "free", label: "free · high", reason: { kind: "cost-zero" } },
      { evaluationId: "unpriced", label: "unpriced · high", reason: { kind: "cost-unknown" } },
    ]);
    expect(chartExclusionText({ kind: "cost-zero" })).toBe("reported as $0");
    expect(chartExclusionText({ kind: "cost-unknown" })).toBe("cost never reported");
  });

  it("treats a missing non-cost axis value as unplottable, never as zero", () => {
    const rows = [comparison({ evaluationId: "alpha::high", totalTokens: null, knownUsd: 1 })];
    const series = comparisonChartSeries(rows, "tokens", "pass");
    expect(series.points).toEqual([]);
    expect(series.excluded[0]?.reason).toEqual({ kind: "metric-unknown", metric: "tokens" });
    expect(chartExclusionText({ kind: "metric-unknown", metric: "tokens" })).toBe(
      "Token usage not reported",
    );
  });

  it("plots a point with all four metric values when every axis value is known", () => {
    const series = comparisonChartSeries([comparison({ knownUsd: 0.25 })], "cost", "pass");
    expect(series.excluded).toEqual([]);
    expect(series.points[0]?.metrics).toEqual({
      cost: 0.25,
      speed: 1200,
      tokens: 150,
      pass: 0.6,
    });
  });
});

describe("chart helpers", () => {
  it("takes the median of odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5])).toBe(5);
    expect(median([])).toBeNull();
  });

  it("builds a log cost scale with ticks inside the visible range", () => {
    const scale = buildChartAxisScale([0.0004, 0.12], true);
    expect(scale?.log).toBe(true);
    expect(scale?.position(0.0004)).toBeCloseTo(0);
    expect(scale?.position(0.12)).toBeCloseTo(1);
    expect(scale?.ticks.length).toBeGreaterThan(1);
    expect(scale?.ticks.every((tick) => tick.value >= 0.0004 && tick.value <= 0.12)).toBe(true);
  });

  it("refuses a log scale over non-positive values and pads a single value", () => {
    expect(buildChartAxisScale([0], true)).toBeNull();
    const linear = buildChartAxisScale([7], false);
    expect(linear?.position(7)).toBeCloseTo(0.5);
    expect(linear?.ticks.length).toBeGreaterThan(1);
  });

  it("keeps bounded ticks inside the metric's limits", () => {
    const bounds = { min: 0, max: 1 };
    for (const values of [[1], [0, 0], [0.99], [0.5, 1]]) {
      const scale = buildChartAxisScale(values, false, bounds);
      expect(scale).not.toBeNull();
      const ticks = scale?.ticks ?? [];
      expect(ticks.length).toBeGreaterThan(1);
      expect(ticks.every((tick) => tick.value >= 0 && tick.value <= 1)).toBe(true);
      // Rounding to display precision can move a tick a hair outside the domain.
      const epsilon = 1e-9;
      expect(ticks.every((tick) => tick.position >= -epsilon && tick.position <= 1 + epsilon)).toBe(
        true,
      );
    }
  });

  it("keeps linear ticks unique and monotonic for a large base with a small step", () => {
    const scale = buildChartAxisScale([1e12, 1e12 + 0.5], false);
    const values = scale?.ticks.map((tick) => tick.value) ?? [];
    expect(values.length).toBeGreaterThan(1);
    expect(new Set(values).size).toBe(values.length);
    expect(
      values.every((value, index) => {
        const previous = values[index - 1];
        return previous === undefined || value > previous;
      }),
    ).toBe(true);
  });
});

describe("comparison selection transitions", () => {
  const all = ["alpha::high", "alpha::low", "beta::high"];

  it("toggles one evaluation and collapses a full selection to null", () => {
    expect(toggleComparisonSelection(null, all, "alpha::low")).toEqual([
      "alpha::high",
      "beta::high",
    ]);
    expect(toggleComparisonSelection(["alpha::high", "beta::high"], all, "alpha::low")).toBeNull();
    expect(toggleComparisonSelection(["alpha::high"], all, "alpha::low")).toEqual([
      "alpha::high",
      "alpha::low",
    ]);
  });

  it("toggles whole groups from the full, partial, and empty states", () => {
    expect(toggleComparisonVisibleGroup(null, all, ["alpha::high", "alpha::low"])).toEqual([
      "beta::high",
    ]);
    expect(
      toggleComparisonVisibleGroup(["beta::high"], all, ["alpha::high", "alpha::low"]),
    ).toBeNull();
    expect(toggleComparisonVisibleGroup(["alpha::high"], all, ["alpha::low"])).toEqual([
      "alpha::high",
      "alpha::low",
    ]);
    expect(toggleComparisonVisibleGroup([], all, ["alpha::low", "beta::high"])).toEqual([
      "alpha::low",
      "beta::high",
    ]);
  });
});

describe("comparison picker helpers", () => {
  function pickerRows(): EvaluationComparison[] {
    return [
      comparison({
        evaluationId: "alpha::max",
        modelAlias: "alpha",
        openRouterId: "vendor/alpha",
        reasoningMode: "max",
      }),
      comparison({
        evaluationId: "alpha::high",
        modelAlias: "alpha",
        openRouterId: "vendor/alpha",
        reasoningMode: "high",
      }),
      comparison({
        evaluationId: "alpha::default",
        modelAlias: "alpha",
        openRouterId: "vendor/alpha",
        reasoningMode: "default",
      }),
      comparison({
        evaluationId: "beta::none",
        modelAlias: "beta",
        openRouterId: "vendor/beta",
        reasoningMode: "none",
      }),
      comparison({
        evaluationId: "beta::bogus",
        modelAlias: "beta",
        openRouterId: "vendor/beta",
        reasoningMode: "bogus",
      }),
    ];
  }

  const all = pickerRows().map((row) => row.evaluationId);

  it("orders efforts by intensity with unknown modes last", () => {
    const groups = groupEvaluations(pickerRows());
    expect(groups.map((group) => group.alias)).toEqual(["alpha", "beta"]);
    expect(groups[0]?.rows.map((row) => row.reasoningMode)).toEqual(["default", "high", "max"]);
    expect(groups[1]?.rows.map((row) => row.reasoningMode)).toEqual(["none", "bogus"]);
    expect(compareReasoningModes("xhigh", "max")).toBeLessThan(0);
    expect(compareReasoningModes("bogus", "max")).toBeGreaterThan(0);
    expect(compareReasoningModes("bogus-a", "bogus-b")).toBeLessThan(0);
  });

  it("matches alias and OpenRouter ID case-insensitively, keeping every effort", () => {
    const groups = groupEvaluations(pickerRows());
    const byAlias = filterComparisonGroups(groups, " ALPHA ", null);
    expect(byAlias.map((group) => group.alias)).toEqual(["alpha"]);
    expect(byAlias[0]?.rows.map((row) => row.reasoningMode)).toEqual(["default", "high", "max"]);

    const byId = filterComparisonGroups(groups, "vendor/BETA", null);
    expect(byId.map((group) => group.alias)).toEqual(["beta"]);
    expect(byId[0]?.rows.map((row) => row.reasoningMode)).toEqual(["none", "bogus"]);

    expect(filterComparisonGroups(groups, "nothing-matches", null)).toEqual([]);
  });

  it("matches effort names and keeps only the matching rows", () => {
    const filtered = filterComparisonGroups(groupEvaluations(pickerRows()), "HIGH", null);
    expect(filtered.map((group) => group.alias)).toEqual(["alpha"]);
    expect(filtered[0]?.rows.map((row) => row.reasoningMode)).toEqual(["high"]);
    expect(filtered[0]?.visibleCount).toBe(1);
  });

  it("shows one matching row per model for an effort query", () => {
    const groups = groupEvaluations([
      comparison({ evaluationId: "alpha::high", modelAlias: "alpha", reasoningMode: "high" }),
      comparison({ evaluationId: "alpha::low", modelAlias: "alpha", reasoningMode: "low" }),
      comparison({ evaluationId: "beta::high", modelAlias: "beta", reasoningMode: "high" }),
      comparison({ evaluationId: "beta::none", modelAlias: "beta", reasoningMode: "none" }),
    ]);
    const filtered = filterComparisonGroups(groups, "high", null);
    expect(
      filtered.map((group) => [group.alias, group.rows.map((row) => row.reasoningMode)]),
    ).toEqual([
      ["alpha", ["high"]],
      ["beta", ["high"]],
    ]);
    expect(filtered.map((group) => group.visibleCount)).toEqual([1, 1]);
  });

  it("counts selected rows among the visible subset", () => {
    const groups = groupEvaluations(pickerRows());
    const byEffort = filterComparisonGroups(groups, "high", ["alpha::default", "alpha::high"]);
    expect(byEffort[0]).toMatchObject({ alias: "alpha", visibleCount: 1, selectedCount: 1 });
    const byAlias = filterComparisonGroups(groups, "alpha", ["alpha::default"]);
    expect(byAlias[0]).toMatchObject({ visibleCount: 3, selectedCount: 1 });
    const noneSelected = filterComparisonGroups(groups, "max", ["alpha::high"]);
    expect(noneSelected[0]).toMatchObject({ visibleCount: 1, selectedCount: 0 });
  });

  it("toggles exactly the visible rows and collapses a full selection to null", () => {
    expect(toggleComparisonVisibleGroup(null, all, ["alpha::high"])).toEqual([
      "alpha::max",
      "alpha::default",
      "beta::none",
      "beta::bogus",
    ]);
    expect(
      toggleComparisonVisibleGroup(
        ["alpha::max", "alpha::default", "beta::none", "beta::bogus"],
        all,
        ["alpha::high"],
      ),
    ).toBeNull();
    // A partial visible subset is completed, not inverted.
    expect(
      toggleComparisonVisibleGroup(["alpha::high"], all, ["alpha::high", "alpha::max"]),
    ).toEqual(["alpha::max", "alpha::high"]);
  });

  it("computes the matching action label and intent for mixed and full rows", () => {
    const visible = ["alpha::default", "alpha::high"];
    expect(selectMatchingAction(visible, null)).toEqual({
      count: 2,
      intent: "deselect",
      label: "Deselect 2 matching",
    });
    expect(selectMatchingAction(visible, ["alpha::default"])).toEqual({
      count: 2,
      intent: "select",
      label: "Select 2 matching",
    });
    expect(selectMatchingAction(visible, [...visible])).toMatchObject({ intent: "deselect" });
    expect(selectMatchingAction([], null)).toBeNull();
  });
});

describe("comparison axes and matrix visibility", () => {
  it("swaps the pair when the metric already on the other axis is chosen", () => {
    const axes = { x: "cost" as const, y: "pass" as const };
    expect(nextComparisonAxes(axes, "x", "pass")).toEqual({ x: "pass", y: "cost" });
    expect(nextComparisonAxes(axes, "y", "cost")).toEqual({ x: "pass", y: "cost" });
  });

  it("changes one axis without colliding, and keeps the same pair for a no-op", () => {
    const axes = { x: "cost" as const, y: "pass" as const };
    expect(nextComparisonAxes(axes, "x", "tokens")).toEqual({ x: "tokens", y: "pass" });
    expect(nextComparisonAxes(axes, "y", "speed")).toEqual({ x: "cost", y: "speed" });
    expect(nextComparisonAxes(axes, "x", "cost")).toEqual(axes);
  });

  it("hides matrix rows only for an explicit selection", () => {
    expect(matrixRowHidden(null, "alpha::high")).toBe(false);
    expect(matrixRowHidden(new Set(["alpha::high"]), "alpha::high")).toBe(false);
    expect(matrixRowHidden(new Set(["alpha::high"]), "alpha::low")).toBe(true);
    expect(matrixEmptySelection(null)).toBe(false);
    expect(matrixEmptySelection(new Set())).toBe(true);
    expect(matrixEmptySelection(new Set(["alpha::high"]))).toBe(false);
  });
});

describe("comparison labels and ignored-filter notices", () => {
  it("formats the comparison count for the kicker and the island", () => {
    expect(comparisonCountLabel(3, 3)).toBe("3 of 3 evaluations");
    expect(comparisonCountLabel(0, 1)).toBe("0 of 1 evaluations");
  });

  it("distinguishes a partial model match from a full fallback", () => {
    expect(
      comparisonIgnoredNotices({
        invalid: [],
        ignoredModels: ["ghost"],
        modelsFellBack: false,
        repaired: [],
      }),
    ).toEqual([
      "model ghost did not match the current results, so the selection kept only the known evaluations.",
    ]);
    expect(
      comparisonIgnoredNotices({
        invalid: [],
        ignoredModels: ["ghost"],
        modelsFellBack: true,
        repaired: [],
      }),
    ).toEqual(["model ghost did not match the current results, so every evaluation is selected."]);
  });

  it("reports invalid parameters separately from ignored models", () => {
    expect(
      comparisonIgnoredNotices({
        invalid: ["x", "sort"],
        ignoredModels: ["ghost", "phantom"],
        modelsFellBack: false,
        repaired: [],
      }),
    ).toEqual([
      "model ghost, model phantom did not match the current results, so the selection kept only the known evaluations.",
      "x, sort did not match the current results, so the defaults were used for those parameters.",
    ]);
    expect(
      comparisonIgnoredNotices({
        invalid: [],
        ignoredModels: [],
        modelsFellBack: false,
        repaired: [],
      }),
    ).toEqual([]);
  });

  it("reports a repaired axis separately from unknown parameters", () => {
    expect(
      comparisonIgnoredNotices({
        invalid: ["x"],
        ignoredModels: [],
        modelsFellBack: false,
        repaired: ["y"],
      }),
    ).toEqual([
      "y was adjusted because the two axes cannot show the same metric.",
      "x did not match the current results, so the defaults were used for those parameters.",
    ]);
  });
});

describe("chart empty states", () => {
  it("names the cost-axis rule when only cost exclusions remain", () => {
    expect(
      chartEmptyMessage([
        { evaluationId: "a", label: "a · high", reason: { kind: "cost-zero" } },
        { evaluationId: "b", label: "b · high", reason: { kind: "cost-unknown" } },
      ]),
    ).toBe(
      "Cost axes exclude evaluations reported as $0 and evaluations with no reported cost, so there is nothing to plot.",
    );
  });

  it("falls back to the selection and axis-metric messages", () => {
    expect(chartEmptyMessage([])).toBe(
      "No evaluation is selected; select at least one model to plot.",
    );
    expect(
      chartEmptyMessage([
        {
          evaluationId: "a",
          label: "a · high",
          reason: { kind: "metric-unknown", metric: "tokens" },
        },
        { evaluationId: "b", label: "b · high", reason: { kind: "cost-zero" } },
      ]),
    ).toBe("No selected evaluation reports both axis metrics, so there is nothing to plot.");
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
