/**
 * Shared view helpers for the results website.
 *
 * These translate publication records into presentation strings and sanitize
 * URL parameters before they reach the bounded query repository. The module is
 * imported by React islands, so it depends only on `@mmstar/results` types
 * (erased at build time) and the pure formatting helpers.
 */
import type {
  CategoryComparison,
  CostKind,
  EvaluationComparison,
  FixtureDetail,
  OutcomeKind,
  OutcomeState,
  RunKind,
  RunSummary,
} from "@mmstar/results";
import {
  formatCount,
  formatFraction,
  formatLatency,
  formatPercent,
  formatTokens,
  formatUsd,
} from "./format";

export const FIXTURE_PAGE_SIZE = 25;

/**
 * Filter vocabularies. These mirror the `OUTCOME_STATES`/`OUTCOME_KINDS`
 * unions in `@mmstar/results`; `view.test.ts` asserts they stay in sync so the
 * client does not import runtime record constants.
 */
export const OUTCOME_STATE_OPTIONS: readonly { value: OutcomeState; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "settled", label: "Settled" },
  { value: "failed", label: "Failed" },
  { value: "indeterminate", label: "Indeterminate" },
  { value: "cancelled", label: "Cancelled" },
];

export const OUTCOME_KIND_OPTIONS: readonly { value: OutcomeKind; label: string }[] = [
  { value: "correct", label: "Correct" },
  { value: "incorrect", label: "Incorrect" },
  { value: "ambiguous", label: "Ambiguous" },
  { value: "invalid", label: "Invalid" },
  { value: "refused", label: "Refused" },
  { value: "truncated", label: "Truncated" },
];

export type OutcomeTone = "good" | "bad" | "warn" | "neutral";

export interface OutcomePresentation {
  label: string;
  symbol: string;
  tone: OutcomeTone;
}

/** Color-independent outcome label: every tone also has a distinct symbol. */
export function outcomePresentation(
  state: OutcomeState,
  kind: OutcomeKind | null,
): OutcomePresentation {
  if (state === "settled") {
    switch (kind) {
      case "correct":
        return { label: "Correct", symbol: "✓", tone: "good" };
      case "incorrect":
        return { label: "Incorrect", symbol: "×", tone: "bad" };
      case "ambiguous":
        return { label: "Ambiguous", symbol: "≈", tone: "warn" };
      case "invalid":
        return { label: "Invalid", symbol: "!", tone: "warn" };
      case "refused":
        return { label: "Refused", symbol: "⊘", tone: "warn" };
      case "truncated":
        return { label: "Truncated", symbol: "…", tone: "warn" };
      default:
        return { label: "Settled", symbol: "•", tone: "neutral" };
    }
  }
  switch (state) {
    case "pending":
      return { label: "Pending", symbol: "·", tone: "neutral" };
    case "failed":
      return { label: "Failed", symbol: "✗", tone: "bad" };
    case "indeterminate":
      return { label: "Indeterminate", symbol: "?", tone: "warn" };
    case "cancelled":
      return { label: "Cancelled", symbol: "—", tone: "neutral" };
    default:
      return { label: state, symbol: "•", tone: "neutral" };
  }
}

/** Work that never reached a scored outcome: still incomplete, not just wrong. */
export function unresolvedCount(comparison: EvaluationComparison): number {
  return comparison.pending + comparison.failed + comparison.indeterminate + comparison.cancelled;
}

export function isIncomplete(comparison: EvaluationComparison): boolean {
  return comparison.settled < comparison.selected || unresolvedCount(comparison) > 0;
}

/**
 * Locale-stable text ordering: the locale is pinned so the Astro server render
 * and the hydrated island always agree on row and evaluation-ID order.
 */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en-US");
}

export function evaluationLabel(input: { modelAlias: string; reasoningMode: string }): string {
  return `${input.modelAlias} · ${input.reasoningMode}`;
}

/* ------------------------------------------------------- comparison selectors */

/** Metrics a comparison chart axis can plot. */
export const COMPARISON_METRICS = ["cost", "speed", "tokens", "pass"] as const;
export type ComparisonMetric = (typeof COMPARISON_METRICS)[number];

export const COMPARISON_METRIC_OPTIONS: readonly { value: ComparisonMetric; label: string }[] = [
  { value: "cost", label: "Cost" },
  { value: "speed", label: "Speed" },
  { value: "tokens", label: "Token usage" },
  { value: "pass", label: "Pass rate" },
];

export const DEFAULT_COMPARISON_AXIS_X: ComparisonMetric = "cost";
export const DEFAULT_COMPARISON_AXIS_Y: ComparisonMetric = "pass";

export type CostScale = "log" | "linear";
export const DEFAULT_COST_SCALE: CostScale = "log";
const COST_SCALES: readonly CostScale[] = ["log", "linear"];

/** Sortable comparison columns; Outcomes is deliberately not one of them. */
export const COMPARISON_SORT_COLUMNS = [
  "model",
  "effort",
  "router",
  "accuracy",
  "coverage",
  "latency",
  "tokens",
  "cost",
  "attempts",
] as const;
export type ComparisonSortColumn = (typeof COMPARISON_SORT_COLUMNS)[number];

export const DEFAULT_COMPARISON_SORT: ComparisonSortColumn = "accuracy";

export type SortDirection = "asc" | "desc";
export const DEFAULT_SORT_DIRECTION: SortDirection = "desc";

/** Text columns first-activate ascending; numeric columns first-activate descending. */
const TEXT_SORT_COLUMNS: readonly ComparisonSortColumn[] = ["model", "effort", "router"];

export function comparisonSortDirection(column: ComparisonSortColumn): SortDirection {
  return TEXT_SORT_COLUMNS.includes(column) ? "asc" : "desc";
}

export interface ComparisonSortState {
  sort: ComparisonSortColumn;
  dir: SortDirection;
}

/** First activation uses the column's natural direction; the active column toggles. */
export function nextComparisonSort(
  column: ComparisonSortColumn,
  current: ComparisonSortState,
): ComparisonSortState {
  if (current.sort === column) {
    return { sort: column, dir: current.dir === "asc" ? "desc" : "asc" };
  }
  return { sort: column, dir: comparisonSortDirection(column) };
}

export interface ComparisonFilterValues {
  /** Selected evaluation IDs; `null` means the parameter was absent (all selected). */
  models: string[] | null;
  x: ComparisonMetric;
  y: ComparisonMetric;
  scale: CostScale;
  sort: ComparisonSortColumn;
  dir: SortDirection;
}

export interface ComparisonFilterContext {
  evaluationIds: ReadonlySet<string>;
}

export interface ComparisonFilterResult {
  values: ComparisonFilterValues;
  /** Parameters that were present but invalid. */
  invalid: string[];
  /** Evaluation IDs in `models` that are not part of the publication. */
  ignoredModels: string[];
  /** True when a non-empty `models` parameter named only unknown IDs and fell back to all. */
  modelsFellBack: boolean;
}

function readMetricParam(
  params: URLSearchParams,
  name: string,
  invalid: string[],
): ComparisonMetric | null {
  const raw = params.get(name);
  if (raw === null || raw.length === 0) return null;
  const match = COMPARISON_METRICS.find((metric) => metric === raw);
  if (match === undefined) {
    invalid.push(name);
    return null;
  }
  return match;
}

/**
 * Validate comparison URL parameters against the publication's evaluations,
 * mirroring `readFixtureFilters`: unknown evaluation IDs and unknown metric,
 * sort, direction, or scale values are dropped and reported. An absent `models`
 * parameter means every evaluation is selected; `models=` selects none.
 */
export function readComparisonFilters(
  params: URLSearchParams,
  context: ComparisonFilterContext,
): ComparisonFilterResult {
  const invalid: string[] = [];
  const ignoredModels: string[] = [];
  let modelsFellBack = false;

  let models: string[] | null = null;
  const rawModels = params.get("models");
  if (rawModels !== null) {
    const ids = rawModels
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    const known: string[] = [];
    for (const id of ids) {
      if (!context.evaluationIds.has(id)) {
        if (!ignoredModels.includes(id)) ignoredModels.push(id);
        continue;
      }
      if (!known.includes(id)) known.push(id);
    }
    // Mirror the drilldown: a parameter naming only unknown IDs is dropped and
    // the selection falls back to all. `models=` (no IDs at all) is an explicit
    // empty selection.
    if (ids.length > 0 && known.length === 0) {
      modelsFellBack = true;
      models = null;
    } else {
      models = known;
    }
  }

  const x = readMetricParam(params, "x", invalid) ?? DEFAULT_COMPARISON_AXIS_X;
  let y = readMetricParam(params, "y", invalid) ?? DEFAULT_COMPARISON_AXIS_Y;
  if (x === y) {
    // A degenerate pair is repaired instead of rendered: keep x and move y.
    if (params.has("y")) invalid.push("y");
    y = x === DEFAULT_COMPARISON_AXIS_X ? DEFAULT_COMPARISON_AXIS_Y : DEFAULT_COMPARISON_AXIS_X;
  }

  let scale: CostScale = DEFAULT_COST_SCALE;
  const rawScale = params.get("scale");
  if (rawScale !== null && rawScale.length > 0) {
    const match = COST_SCALES.find((option) => option === rawScale);
    if (match === undefined) invalid.push("scale");
    else scale = match;
  }

  let sort: ComparisonSortColumn = DEFAULT_COMPARISON_SORT;
  const rawSort = params.get("sort");
  if (rawSort !== null && rawSort.length > 0) {
    const match = COMPARISON_SORT_COLUMNS.find((column) => column === rawSort);
    if (match === undefined) invalid.push("sort");
    else sort = match;
  }

  let dir: SortDirection = DEFAULT_SORT_DIRECTION;
  const rawDir = params.get("dir");
  if (rawDir !== null && rawDir.length > 0) {
    if (rawDir === "asc" || rawDir === "desc") dir = rawDir;
    else invalid.push("dir");
  }

  return { values: { models, x, y, scale, sort, dir }, invalid, ignoredModels, modelsFellBack };
}

export interface ComparisonIgnoredFilters {
  invalid: string[];
  ignoredModels: string[];
  modelsFellBack: boolean;
}

/**
 * Human-readable notices for dropped parameters. A partial `models` match does
 * not claim a full fallback; an all-unknown `models` parameter does.
 */
export function comparisonIgnoredNotices(result: ComparisonIgnoredFilters): string[] {
  const notices: string[] = [];
  if (result.ignoredModels.length > 0) {
    const names = result.ignoredModels.map((id) => `model ${id}`).join(", ");
    notices.push(
      result.modelsFellBack
        ? `${names} did not match this publication, so every evaluation is selected.`
        : `${names} did not match this publication, so the selection kept only the known evaluations.`,
    );
  }
  if (result.invalid.length > 0) {
    notices.push(
      `${result.invalid.join(", ")} did not match this publication, so the defaults were used for those parameters.`,
    );
  }
  return notices;
}

export interface ComparisonQueryInput {
  /** `undefined` and `null` both omit the parameter (all selected). */
  models?: string[] | null | undefined;
  x?: ComparisonMetric | undefined;
  y?: ComparisonMetric | undefined;
  scale?: CostScale | undefined;
  sort?: ComparisonSortColumn | undefined;
  dir?: SortDirection | undefined;
}

/** Canonical comparison query string: defaults and the all-models case are omitted. */
export function comparisonQueryString(input: ComparisonQueryInput): string {
  const params = new URLSearchParams();
  if (input.models !== undefined && input.models !== null) {
    const unique = [...new Set(input.models)].sort(compareText);
    params.set("models", unique.join(","));
  }
  if (input.x !== undefined && input.x !== DEFAULT_COMPARISON_AXIS_X) params.set("x", input.x);
  if (input.y !== undefined && input.y !== DEFAULT_COMPARISON_AXIS_Y) params.set("y", input.y);
  if (input.scale !== undefined && input.scale !== DEFAULT_COST_SCALE) {
    params.set("scale", input.scale);
  }
  if (input.sort !== undefined && input.sort !== DEFAULT_COMPARISON_SORT) {
    params.set("sort", input.sort);
  }
  if (input.dir !== undefined && input.dir !== DEFAULT_SORT_DIRECTION) params.set("dir", input.dir);
  return params.toString();
}

/** Shareable comparison URL: `/` plus a canonical query when any non-default is set. */
export function comparisonHref(input: ComparisonQueryInput = {}): string {
  const query = comparisonQueryString(input);
  return query === "" ? "/" : `/?${query}`;
}

/* ------------------------------------------------------- comparison selection */

/** Selected evaluation IDs; `null` is the implicit full selection (the URL default). */
export type ComparisonSelection = string[] | null;

export interface ComparisonAxes {
  x: ComparisonMetric;
  y: ComparisonMetric;
}

/** `3 of 4 evaluations`; shared by the server kicker and the island status line. */
export function comparisonCountLabel(selected: number, total: number): string {
  return `${formatCount(selected)} of ${formatCount(total)} evaluations`;
}

/**
 * Toggle one evaluation. A selection covering every evaluation collapses to
 * `null` so the canonical URL stays short.
 */
export function toggleComparisonSelection(
  selection: ComparisonSelection,
  allIds: readonly string[],
  evaluationId: string,
): ComparisonSelection {
  const selected = new Set(selection ?? allIds);
  if (selected.has(evaluationId)) selected.delete(evaluationId);
  else selected.add(evaluationId);
  return selected.size === allIds.length ? null : allIds.filter((id) => selected.has(id));
}

/** Toggle a whole model group; a partially selected group gains its missing rows. */
export function toggleComparisonGroup(
  selection: ComparisonSelection,
  allIds: readonly string[],
  groupIds: readonly string[],
): ComparisonSelection {
  const selected = new Set(selection ?? allIds);
  const allSelected = groupIds.every((id) => selected.has(id));
  for (const id of groupIds) {
    if (allSelected) selected.delete(id);
    else selected.add(id);
  }
  return selected.size === allIds.length ? null : allIds.filter((id) => selected.has(id));
}

/** Choosing the metric already on the other axis swaps the pair; never collides. */
export function nextComparisonAxes(
  axes: ComparisonAxes,
  axis: "x" | "y",
  metric: ComparisonMetric,
): ComparisonAxes {
  if (axis === "x") {
    return metric === axes.y ? { x: metric, y: axes.x } : { ...axes, x: metric };
  }
  return metric === axes.x ? { x: axes.y, y: metric } : { ...axes, y: metric };
}

/** Matrix row visibility: hidden when an explicit selection excludes the evaluation. */
export function matrixRowHidden(
  selectedIds: ReadonlySet<string> | null,
  evaluationId: string,
): boolean {
  return selectedIds !== null && !selectedIds.has(evaluationId);
}

/** An explicit empty selection hides the matrix table and shows its empty panel. */
export function matrixEmptySelection(selectedIds: ReadonlySet<string> | null): boolean {
  return selectedIds !== null && selectedIds.size === 0;
}

/* -------------------------------------------------------- comparison sorting */

function comparisonTextValue(
  row: EvaluationComparison,
  column: ComparisonSortColumn,
): string | null {
  switch (column) {
    case "model":
      return row.modelAlias;
    case "effort":
      return row.reasoningMode;
    case "router":
      return row.openRouterId;
    default:
      return null;
  }
}

function comparisonMetricValue(
  row: EvaluationComparison,
  column: ComparisonSortColumn,
): number | null {
  const value = ((): number | null => {
    switch (column) {
      case "accuracy":
        return row.scoredAccuracy;
      case "coverage":
        return row.coverage;
      case "latency":
        return row.meanRequestLatencyMs;
      case "tokens":
        return row.totalTokens;
      case "cost":
        return row.knownUsd;
      case "attempts":
        return row.attempts;
      default:
        return null;
    }
  })();
  return value !== null && Number.isFinite(value) ? value : null;
}

/**
 * Shared server/island comparator. Null metric values (cost, tokens, latency,
 * accuracy, coverage) sort after every known value in both directions, never as
 * zero. Remaining ties break on alias, reasoning mode, then evaluation ID, so
 * every ordering is deterministic.
 */
export function compareComparisonRows(
  a: EvaluationComparison,
  b: EvaluationComparison,
  sort: ComparisonSortColumn,
  dir: SortDirection,
): number {
  const textA = comparisonTextValue(a, sort);
  const textB = comparisonTextValue(b, sort);
  if (textA !== null && textB !== null) {
    const compared = compareText(textA, textB);
    if (compared !== 0) return dir === "asc" ? compared : -compared;
  } else {
    const metricA = comparisonMetricValue(a, sort);
    const metricB = comparisonMetricValue(b, sort);
    if (metricA === null && metricB !== null) return 1;
    if (metricA !== null && metricB === null) return -1;
    if (metricA !== null && metricB !== null && metricA !== metricB) {
      const compared = metricA - metricB;
      return dir === "asc" ? compared : -compared;
    }
  }
  const alias = compareText(a.modelAlias, b.modelAlias);
  if (alias !== 0) return alias;
  const effort = compareText(a.reasoningMode, b.reasoningMode);
  if (effort !== 0) return effort;
  return compareText(a.evaluationId, b.evaluationId);
}

export function sortComparisonRows(
  rows: EvaluationComparison[],
  sort: ComparisonSortColumn = DEFAULT_COMPARISON_SORT,
  dir: SortDirection = DEFAULT_SORT_DIRECTION,
): EvaluationComparison[] {
  return [...rows].sort((a, b) => compareComparisonRows(a, b, sort, dir));
}

/* -------------------------------------------------------- comparison metrics */

export function metricValue(row: EvaluationComparison, metric: ComparisonMetric): number | null {
  switch (metric) {
    case "cost":
      return row.knownUsd;
    case "speed":
      return row.meanRequestLatencyMs;
    case "tokens":
      return row.totalTokens;
    case "pass":
      return row.scoredAccuracy;
  }
}

export function metricLabel(metric: ComparisonMetric): string {
  return COMPARISON_METRIC_OPTIONS.find((option) => option.value === metric)?.label ?? metric;
}

/** Lower is better for cost, speed, and tokens; higher is better for pass rate. */
export function metricDirection(metric: ComparisonMetric): "lower" | "higher" {
  return metric === "pass" ? "higher" : "lower";
}

export function metricDirectionLabel(metric: ComparisonMetric): string {
  return metricDirection(metric) === "lower" ? "lower is better" : "higher is better";
}

/** Display value for a metric; unknown stays "not reported", never `0`. */
export function metricValueLabel(metric: ComparisonMetric, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "not reported";
  switch (metric) {
    case "cost":
      return formatUsd(value);
    case "speed":
      return formatLatency(value);
    case "tokens":
      return formatTokens(value);
    case "pass":
      return formatPercent(value);
  }
}

export type CostExclusionReason = "cost-zero" | "cost-unknown";

/** Cost-axis classification: reported free, never priced, or plottable. */
export function costExclusion(row: EvaluationComparison): CostExclusionReason | null {
  if (row.knownUsd === null || !Number.isFinite(row.knownUsd)) return "cost-unknown";
  if (row.knownUsd <= 0) return "cost-zero";
  return null;
}

export function costExclusionText(reason: CostExclusionReason): string {
  return reason === "cost-zero" ? "reported as $0" : "cost never reported";
}

/* ---------------------------------------------------------- comparison chart */

export type ChartExclusionReason =
  | { kind: "cost-zero" }
  | { kind: "cost-unknown" }
  | { kind: "metric-unknown"; metric: ComparisonMetric };

export interface ChartExclusion {
  evaluationId: string;
  label: string;
  reason: ChartExclusionReason;
}

export interface ComparisonChartPoint {
  evaluationId: string;
  modelAlias: string;
  reasoningMode: string;
  label: string;
  /** Plotted coordinates, already known to be finite and (for cost) positive. */
  x: number;
  y: number;
  metrics: Record<ComparisonMetric, number | null>;
  coverage: number | null;
  attempts: number;
}

export interface ComparisonChartSeries {
  points: ComparisonChartPoint[];
  excluded: ChartExclusion[];
}

function plotValue(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

export function chartExclusionText(reason: ChartExclusionReason): string {
  switch (reason.kind) {
    case "cost-zero":
      return costExclusionText("cost-zero");
    case "cost-unknown":
      return costExclusionText("cost-unknown");
    case "metric-unknown":
      return `${metricLabel(reason.metric)} not reported`;
  }
}

/**
 * Empty-chart copy: a cost-only exclusion list names the cost-axis rule
 * explicitly, since `$0` and unpriced evaluations are omitted on both scales.
 */
export function chartEmptyMessage(excluded: ChartExclusion[]): string {
  if (excluded.length === 0) {
    return "No evaluation is selected; select at least one model to plot.";
  }
  const costOnly = excluded.every(
    (item) => item.reason.kind === "cost-zero" || item.reason.kind === "cost-unknown",
  );
  if (costOnly) {
    return "Cost axes exclude evaluations reported as $0 and evaluations with no reported cost, so there is nothing to plot.";
  }
  return "No selected evaluation reports both axis metrics, so there is nothing to plot.";
}

/**
 * Build the plot data for the current selection and axes. Cost on either axis
 * excludes non-positive and never-priced evaluations with an explicit reason;
 * a null on either axis excludes the point rather than plotting it as zero.
 */
export function comparisonChartSeries(
  rows: EvaluationComparison[],
  x: ComparisonMetric,
  y: ComparisonMetric,
): ComparisonChartSeries {
  const points: ComparisonChartPoint[] = [];
  const excluded: ChartExclusion[] = [];
  const costOnAxis = x === "cost" || y === "cost";
  for (const row of rows) {
    const label = evaluationLabel(row);
    if (costOnAxis) {
      const reason = costExclusion(row);
      if (reason !== null) {
        excluded.push({ evaluationId: row.evaluationId, label, reason: { kind: reason } });
        continue;
      }
    }
    const xValue = plotValue(metricValue(row, x));
    if (xValue === null) {
      excluded.push({
        evaluationId: row.evaluationId,
        label,
        reason: { kind: "metric-unknown", metric: x },
      });
      continue;
    }
    const yValue = plotValue(metricValue(row, y));
    if (yValue === null) {
      excluded.push({
        evaluationId: row.evaluationId,
        label,
        reason: { kind: "metric-unknown", metric: y },
      });
      continue;
    }
    points.push({
      evaluationId: row.evaluationId,
      modelAlias: row.modelAlias,
      reasoningMode: row.reasoningMode,
      label,
      x: xValue,
      y: yValue,
      metrics: {
        cost: metricValue(row, "cost"),
        speed: metricValue(row, "speed"),
        tokens: metricValue(row, "tokens"),
        pass: metricValue(row, "pass"),
      },
      coverage: row.coverage,
      attempts: row.attempts,
    });
  }
  return { points, excluded };
}

/** Median of the visible values; an even count uses the midpoint of the centre pair. */
export function median(values: number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export interface ChartTick {
  value: number;
  /** Normalized 0–1 position along the axis. */
  position: number;
}

export interface ChartAxisScale {
  min: number;
  max: number;
  log: boolean;
  position(value: number): number;
  ticks: ChartTick[];
}

function niceStep(range: number, targetCount: number): number {
  const rough = range / Math.max(1, targetCount);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Linear or log10 axis scale with readable ticks. Log axes require positive
 * values (cost exclusions guarantee that); a single value is padded so a lone
 * point sits mid-axis instead of degenerating.
 */
export function buildChartAxisScale(values: number[], log: boolean): ChartAxisScale | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  let min = Math.min(...finite);
  let max = Math.max(...finite);

  if (log) {
    if (min <= 0) return null;
    if (min === max) {
      min /= 2;
      max *= 2;
    }
    const minLog = Math.log10(min);
    const maxLog = Math.log10(max);
    const span = maxLog - minLog;
    const position = (value: number): number => {
      if (!Number.isFinite(value) || value <= 0) return 0;
      return Math.min(1, Math.max(0, (Math.log10(value) - minLog) / span));
    };
    const ticks: ChartTick[] = [];
    for (let power = Math.floor(minLog); power <= Math.ceil(maxLog); power += 1) {
      for (const mantissa of [1, 2, 5]) {
        const value = mantissa * 10 ** power;
        if (value < min || value > max) continue;
        if (ticks.some((tick) => tick.value === value)) continue;
        ticks.push({ value, position: position(value) });
      }
    }
    if (ticks.length < 2) {
      ticks.length = 0;
      ticks.push({ value: min, position: 0 }, { value: max, position: 1 });
    }
    ticks.sort((a, b) => a.value - b.value);
    return { min, max, log: true, position, ticks };
  }

  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 0.5;
    min -= pad;
    max += pad;
  }
  let step = niceStep(max - min, 5);
  let domainMin = Math.floor(min / step) * step;
  let domainMax = Math.ceil(max / step) * step;
  while (Math.round((domainMax - domainMin) / step) > 8) {
    step *= 2;
    domainMin = Math.floor(min / step) * step;
    domainMax = Math.ceil(max / step) * step;
  }
  if (domainMin === domainMax) domainMax = domainMin + step;
  const position = (value: number): number => (value - domainMin) / (domainMax - domainMin);
  const count = Math.round((domainMax - domainMin) / step);
  const decimals = Math.min(20, Math.max(0, Math.ceil(-Math.log10(step)) + 1));
  const ticks: ChartTick[] = [];
  for (let index = 0; index <= count; index += 1) {
    const value = Number((domainMin + index * step).toFixed(decimals));
    const previous = ticks[ticks.length - 1];
    // Rounding must never collapse two ticks into one label or React key.
    if (previous !== undefined && value <= previous.value) continue;
    ticks.push({ value, position: position(value) });
  }
  if (ticks.length < 2) {
    return {
      min: domainMin,
      max: domainMax,
      log: false,
      position,
      ticks: [
        { value: domainMin, position: 0 },
        { value: domainMax, position: 1 },
      ],
    };
  }
  return { min: domainMin, max: domainMax, log: false, position, ticks };
}

export function runKindLabel(kind: RunKind): string {
  switch (kind) {
    case "primary":
      return "Primary";
    case "recovery":
      return "Recovery";
    case "restart":
      return "Restart";
    default:
      return kind;
  }
}

export interface CostView {
  /** Primary cost figure, or a missing marker. */
  text: string;
  /** Reported/estimated/unknown breakdown, when any detail exists. */
  detail: string | null;
  unknownCount: number;
  missing: boolean;
}

/** Family-level cost: known total plus how much is unknown, never a bare zero. */
export function comparisonCost(comparison: EvaluationComparison): CostView {
  const unknownCount = comparison.costUnknownCount;
  if (comparison.knownUsd === null) {
    return {
      text: unknownCount > 0 ? "—" : "not reported",
      detail:
        unknownCount > 0
          ? `${formatCount(unknownCount)} attempt${unknownCount === 1 ? "" : "s"} with unknown cost`
          : "no priced attempts",
      unknownCount,
      missing: true,
    };
  }
  const parts: string[] = [`known ${formatUsd(comparison.knownUsd)}`];
  if (comparison.reportedUsd !== null) parts.push(`reported ${formatUsd(comparison.reportedUsd)}`);
  if (comparison.estimatedUsd !== null) {
    parts.push(`estimated ${formatUsd(comparison.estimatedUsd)}`);
  }
  if (unknownCount > 0) parts.push(`${formatCount(unknownCount)} unknown`);
  return {
    text: formatUsd(comparison.knownUsd),
    detail: parts.join(" · "),
    unknownCount,
    missing: false,
  };
}

/** Per-attempt cost: reported exact, estimated approximate, unknown explicit. */
export function attemptCostLine(costKind: CostKind, costUsd: number | null): string {
  if (costKind === "unknown" || costUsd === null) return "not reported";
  if (costKind === "estimated") return `≈ ${formatUsd(costUsd, 4)}`;
  return formatUsd(costUsd, 4);
}

export interface SettingIssue {
  field: string;
  values: string[];
}

/**
 * Frozen experiment settings that must match across the winning families.
 * Recovery and restart runs are expected to repeat the same prompt/scorer/dataset
 * contract; when publication-wide winners do not, aggregated comparisons are not
 * like-for-like. The caller passes the runs belonging to the winning families
 * (every run whose root won at least one evaluation).
 */
export function publicationSettingIssues(runs: RunSummary[]): SettingIssue[] {
  const fields: { field: string; read: (run: RunSummary) => string }[] = [
    { field: "set", read: (run) => run.setName },
    { field: "prompt version", read: (run) => `v${run.promptVersion}` },
    { field: "scorer version", read: (run) => `v${run.scorerVersion}` },
    { field: "dataset hash", read: (run) => run.datasetSha256 },
  ];
  const issues: SettingIssue[] = [];
  for (const field of fields) {
    const values = [...new Set(runs.map(field.read))];
    if (values.length > 1) issues.push({ field: field.field, values });
  }
  return issues;
}

export interface FixtureFilterValues {
  evaluationId?: string;
  category?: string;
  state?: OutcomeState;
  kind?: OutcomeKind;
  offset: number;
}

export interface FixtureFilterContext {
  evaluationIds: ReadonlySet<string>;
  categories: ReadonlySet<string>;
}

/**
 * Validate drilldown URL parameters against the publication's actual values.
 * Unknown filters are dropped and reported instead of reaching the repository,
 * so a stale bookmark degrades to "all fixtures" with a notice.
 */
export function readFixtureFilters(
  params: URLSearchParams,
  context: FixtureFilterContext,
): { values: FixtureFilterValues; invalid: string[] } {
  const invalid: string[] = [];
  const values: FixtureFilterValues = { offset: 0 };

  const evaluationId = params.get("evaluationId");
  if (evaluationId !== null && evaluationId.length > 0) {
    if (context.evaluationIds.has(evaluationId)) values.evaluationId = evaluationId;
    else invalid.push("evaluationId");
  }

  const category = params.get("category");
  if (category !== null && category.length > 0) {
    if (context.categories.has(category)) values.category = category;
    else invalid.push("category");
  }

  const state = params.get("state");
  if (state !== null && state.length > 0) {
    const match = OUTCOME_STATE_OPTIONS.find((option) => option.value === state);
    if (match === undefined) invalid.push("state");
    else values.state = match.value;
  }

  const kind = params.get("kind");
  if (kind !== null && kind.length > 0) {
    const match = OUTCOME_KIND_OPTIONS.find((option) => option.value === kind);
    if (match === undefined) invalid.push("kind");
    else values.kind = match.value;
  }

  const offset = params.get("offset");
  if (offset !== null && offset.length > 0) {
    const parsed = Number(offset);
    if (Number.isInteger(parsed) && parsed >= 0) values.offset = parsed;
    else invalid.push("offset");
  }

  return { values, invalid };
}

export interface FixtureQueryInput {
  evaluationId?: string | undefined;
  category?: string | undefined;
  state?: OutcomeState | undefined;
  kind?: OutcomeKind | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** Canonical drilldown query string used for links and URL sync. */
export function fixtureQueryString(input: FixtureQueryInput): string {
  const params = new URLSearchParams();
  if (input.evaluationId !== undefined) params.set("evaluationId", input.evaluationId);
  if (input.category !== undefined) params.set("category", input.category);
  if (input.state !== undefined) params.set("state", input.state);
  if (input.kind !== undefined) params.set("kind", input.kind);
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.offset !== undefined && input.offset > 0) {
    params.set("offset", String(input.offset));
  }
  return params.toString();
}

/** Only allow same-site return paths, so `back` cannot become an open redirect. */
export function parseBackTarget(value: string | null): string | null {
  if (value === null) return null;
  if (!value.startsWith("/fixtures")) return null;
  if (value.startsWith("//")) return null;
  return value;
}

/** Recovery lineage text for the fixture detail header, when recovered. */
export function recoveryLineage(detail: FixtureDetail): string | null {
  if (detail.effectiveRunId === detail.rootRunId) return null;
  const source =
    detail.lineageSourceRunId === null
      ? "an earlier run"
      : `original run ${detail.lineageSourceRunId}`;
  return `Recovered in ${detail.effectiveRunId} from ${source}`;
}

/** Category rows grouped per evaluation for the comparison matrix. */
export function categoryMatrix(categories: CategoryComparison[]): {
  names: string[];
  byEvaluation: Map<string, Map<string, CategoryComparison>>;
} {
  const names = [...new Set(categories.map((row) => row.category))].sort((a, b) =>
    a.localeCompare(b),
  );
  const byEvaluation = new Map<string, Map<string, CategoryComparison>>();
  for (const row of categories) {
    let rows = byEvaluation.get(row.evaluationId);
    if (rows === undefined) {
      rows = new Map();
      byEvaluation.set(row.evaluationId, rows);
    }
    rows.set(row.category, row);
  }
  return { names, byEvaluation };
}

/** Compact accuracy cell text for the category matrix. */
export function categoryCell(row: CategoryComparison | undefined): string {
  if (row === undefined) return "—";
  return `${formatPercent(row.accuracy)} · ${formatFraction(row.correct, row.settled)}`;
}
