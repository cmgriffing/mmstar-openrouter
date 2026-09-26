/**
 * Server-render coverage for the comparison island.
 *
 * The repo has no DOM test harness, so these tests exercise the components the
 * way Astro does: render them with real props and assert the markup. Pure
 * interaction logic lives in `view.test.ts`; browser-only behavior is recorded
 * in the manual pass in `docs/website.md`.
 */
import type { EvaluationComparison } from "@mmstar/results";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ComparisonChartPoint, groupEvaluations } from "../lib/view";
import ComparisonExplorer from "./ComparisonExplorer";
import ModelPicker from "./ModelPicker";
import QuadrantChart from "./QuadrantChart";

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

const alpha = comparison({ evaluationId: "alpha::high", scoredAccuracy: 0.9 });
const beta = comparison({
  evaluationId: "beta::high",
  modelAlias: "beta",
  openRouterId: "vendor/beta",
  scoredAccuracy: 0.4,
});
const noop = (): void => {};

describe("comparison island render", () => {
  const props = {
    comparisons: [beta, alpha],
    initialSelection: null,
    initialSort: "accuracy" as const,
    initialDir: "desc" as const,
    initialAxes: { x: "cost" as const, y: "pass" as const },
    initialCostScale: "log" as const,
  };

  it("renders the picker count, chart points, and table in the initial sort order", () => {
    const html = renderToStaticMarkup(createElement(ComparisonExplorer, props));
    expect(html).toContain("2 of 2 evaluations");
    expect(html.match(/chart-point-button/g) ?? []).toHaveLength(2);
    const table = html.slice(html.indexOf("comparison-table"));
    expect(table.indexOf("alpha")).toBeLessThan(table.indexOf("beta"));
  });

  it("renders explicit empty states for an empty selection", () => {
    const html = renderToStaticMarkup(
      createElement(ComparisonExplorer, { ...props, initialSelection: [] }),
    );
    expect(html).toContain("0 of 2 evaluations");
    expect(html).toContain("No models selected");
    expect(html).not.toContain("comparison-table");
  });
});

describe("ModelPicker initial render", () => {
  it("renders the closed trigger without the option list", () => {
    const groups = groupEvaluations([alpha, beta]);
    const html = renderToStaticMarkup(
      createElement(ModelPicker, {
        groups,
        selection: null,
        selectedCount: groups.length,
        total: groups.length,
        onToggleEvaluation: noop,
        onToggleVisibleGroup: noop,
        onSelectAll: noop,
        onClearAll: noop,
      }),
    );
    expect(html).toContain("2 of 2 evaluations");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Models and reasoning efforts");
  });
});

describe("QuadrantChart bounded axis render", () => {
  it("keeps a lone 100% pass point inside a 0–100% axis", () => {
    const point: ComparisonChartPoint = {
      evaluationId: "demo::low",
      modelAlias: "demo",
      reasoningMode: "low",
      label: "demo · low",
      x: 0.0093,
      y: 1,
      metrics: { cost: 0.0093, speed: 1200, tokens: 150, pass: 1 },
      coverage: 1,
      attempts: 12,
    };
    const html = renderToStaticMarkup(
      createElement(QuadrantChart, {
        points: [point],
        excluded: [],
        x: "cost",
        y: "pass",
        costScale: "log",
        onAxisChange: noop,
        onCostScaleChange: noop,
      }),
    );
    expect(html).toContain("100%");
    expect(html).not.toContain("105%");
    expect(html).not.toContain("110%");
  });
});
