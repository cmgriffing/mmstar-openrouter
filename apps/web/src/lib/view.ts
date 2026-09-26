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
import { formatCount, formatFraction, formatPercent, formatUsd } from "./format";

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

/** Accuracy first (selected denominator), then a deterministic alias order. */
export function sortComparisons(rows: EvaluationComparison[]): EvaluationComparison[] {
  return [...rows].sort((a, b) => {
    const accuracyA = a.selectedAccuracy ?? a.scoredAccuracy ?? -1;
    const accuracyB = b.selectedAccuracy ?? b.scoredAccuracy ?? -1;
    if (accuracyA !== accuracyB) return accuracyB - accuracyA;
    if (a.modelAlias !== b.modelAlias) return a.modelAlias.localeCompare(b.modelAlias);
    return a.reasoningMode.localeCompare(b.reasoningMode);
  });
}

export function evaluationLabel(input: { modelAlias: string; reasoningMode: string }): string {
  return `${input.modelAlias} · ${input.reasoningMode}`;
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
