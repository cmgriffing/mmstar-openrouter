/**
 * Comparison section island: model-grouped selector, quadrant chart, and
 * sortable table.
 *
 * Server-rendered first from the URL state (Astro renders this component to
 * HTML with the initial props), then hydrated: selection, sorting, and axes
 * update the surfaces in place and keep the URL authoritative without a
 * reload. The full comparison list is passed so the island can re-derive the
 * filtered rows and chart series with the same helpers the server uses.
 *
 * The category matrix lives outside the island in `index.astro`; its rows are
 * marked with `data-matrix-evaluation` and toggled here so one selection state
 * drives all three surfaces.
 */
import type { EvaluationComparison } from "@mmstar/results";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import {
  formatCount,
  formatFraction,
  formatLatency,
  formatPercent,
  formatTokens,
  formatTokensExact,
} from "../lib/format";
import type { ComparisonMetric, ComparisonSortColumn, CostScale, SortDirection } from "../lib/view";
import {
  compareText,
  comparisonChartSeries,
  comparisonCost,
  comparisonCountLabel,
  comparisonHref,
  comparisonQueryString,
  isIncomplete,
  matrixEmptySelection,
  matrixRowHidden,
  nextComparisonAxes,
  nextComparisonSort,
  sortComparisonRows,
  toggleComparisonGroup,
  toggleComparisonSelection,
} from "../lib/view";
import QuadrantChart from "./QuadrantChart";

export interface ComparisonExplorerProps {
  /** Every evaluation in the publication; selection and order are derived. */
  comparisons: EvaluationComparison[];
  /** Selected evaluation IDs; `null` means the URL had no explicit selection. */
  initialSelection: string[] | null;
  initialSort: ComparisonSortColumn;
  initialDir: SortDirection;
  initialAxes: { x: ComparisonMetric; y: ComparisonMetric };
  initialCostScale: CostScale;
}

interface EvaluationGroup {
  alias: string;
  rows: EvaluationComparison[];
}

interface OutcomeChip {
  label: string;
  symbol: string;
  tone: "good" | "bad" | "warn" | "neutral";
  count: number;
}

function groupEvaluations(rows: EvaluationComparison[]): EvaluationGroup[] {
  const byAlias = new Map<string, EvaluationComparison[]>();
  for (const row of rows) {
    const group = byAlias.get(row.modelAlias);
    if (group === undefined) byAlias.set(row.modelAlias, [row]);
    else group.push(row);
  }
  return [...byAlias.entries()]
    .map(([alias, groupRows]) => ({
      alias,
      rows: [...groupRows].sort((a, b) => compareText(a.reasoningMode, b.reasoningMode)),
    }))
    .sort((a, b) => compareText(a.alias, b.alias));
}

function outcomeChips(row: EvaluationComparison): OutcomeChip[] {
  return (
    [
      { label: "Correct", symbol: "✓", tone: "good" as const, count: row.correct },
      { label: "Incorrect", symbol: "×", tone: "bad" as const, count: row.incorrect },
      { label: "Ambiguous", symbol: "≈", tone: "warn" as const, count: row.ambiguous },
      { label: "Invalid", symbol: "!", tone: "warn" as const, count: row.invalid },
      { label: "Refused", symbol: "⊘", tone: "warn" as const, count: row.refused },
      { label: "Truncated", symbol: "…", tone: "warn" as const, count: row.truncated },
      { label: "Pending", symbol: "·", tone: "neutral" as const, count: row.pending },
      { label: "Failed", symbol: "✗", tone: "bad" as const, count: row.failed },
      { label: "Indeterminate", symbol: "?", tone: "warn" as const, count: row.indeterminate },
      { label: "Cancelled", symbol: "—", tone: "neutral" as const, count: row.cancelled },
    ] satisfies OutcomeChip[]
  ).filter((chip) => chip.count > 0);
}

function unresolvedSummary(row: EvaluationComparison): string {
  const parts: string[] = [];
  if (row.pending > 0) parts.push(`${formatCount(row.pending)} pending`);
  if (row.failed > 0) parts.push(`${formatCount(row.failed)} failed`);
  if (row.indeterminate > 0) parts.push(`${formatCount(row.indeterminate)} indeterminate`);
  if (row.cancelled > 0) parts.push(`${formatCount(row.cancelled)} cancelled`);
  return parts.join(" · ");
}

export default function ComparisonExplorer(props: ComparisonExplorerProps) {
  const { comparisons } = props;
  const [selection, setSelection] = useState<string[] | null>(props.initialSelection);
  const [sort, setSort] = useState<ComparisonSortColumn>(props.initialSort);
  const [dir, setDir] = useState<SortDirection>(props.initialDir);
  const [axes, setAxes] = useState(props.initialAxes);
  const [costScale, setCostScale] = useState<CostScale>(props.initialCostScale);
  const skipInitialUrlSync = useRef(true);

  const allIds = useMemo(() => comparisons.map((row) => row.evaluationId), [comparisons]);
  const selectedSet = useMemo(() => (selection === null ? null : new Set(selection)), [selection]);
  const selectedRows = useMemo(
    () =>
      selectedSet === null
        ? comparisons
        : comparisons.filter((row) => selectedSet.has(row.evaluationId)),
    [comparisons, selectedSet],
  );
  const rows = useMemo(
    () => sortComparisonRows(selectedRows, sort, dir),
    [selectedRows, sort, dir],
  );
  const series = useMemo(
    () => comparisonChartSeries(selectedRows, axes.x, axes.y),
    [selectedRows, axes],
  );
  const groups = useMemo(() => groupEvaluations(comparisons), [comparisons]);

  // Keep the URL authoritative for selection, sort, and axes without reloads.
  useEffect(() => {
    if (skipInitialUrlSync.current) {
      skipInitialUrlSync.current = false;
      return;
    }
    const query = comparisonQueryString({
      models: selection,
      x: axes.x,
      y: axes.y,
      scale: costScale,
      sort,
      dir,
    });
    const url = query === "" ? window.location.pathname : `${window.location.pathname}?${query}`;
    window.history.replaceState(null, "", url);
  }, [selection, axes, costScale, sort, dir]);

  // The category matrix is server-rendered outside this island; one selection
  // state drives it by toggling row visibility and its empty state.
  useEffect(() => {
    document.querySelectorAll<HTMLElement>("[data-matrix-evaluation]").forEach((element) => {
      element.hidden = matrixRowHidden(selectedSet, element.dataset.matrixEvaluation ?? "");
    });
    const selectionEmpty = matrixEmptySelection(selectedSet);
    const table = document.querySelector<HTMLElement>("[data-matrix-table]");
    if (table !== null) table.hidden = selectionEmpty;
    const empty = document.querySelector<HTMLElement>("[data-matrix-empty]");
    if (empty !== null) empty.hidden = !selectionEmpty;
    const count = document.querySelector<HTMLElement>("[data-comparison-count]");
    if (count !== null) {
      count.textContent = comparisonCountLabel(selectedRows.length, comparisons.length);
    }
  }, [selectedSet, selectedRows.length, comparisons.length]);

  function isSelected(evaluationId: string): boolean {
    return selectedSet === null || selectedSet.has(evaluationId);
  }

  function toggleEvaluation(evaluationId: string): void {
    setSelection(toggleComparisonSelection(selection, allIds, evaluationId));
  }

  function toggleGroup(groupIds: string[]): void {
    setSelection(toggleComparisonGroup(selection, allIds, groupIds));
  }

  function changeAxis(axis: "x" | "y", metric: ComparisonMetric): void {
    setAxes((previous) => nextComparisonAxes(previous, axis, metric));
  }

  function sortHeader(
    column: ComparisonSortColumn,
    label: string,
    className?: string,
  ): ReactElement {
    const next = nextComparisonSort(column, { sort, dir });
    const href = comparisonHref({
      models: selection,
      x: axes.x,
      y: axes.y,
      scale: costScale,
      sort: next.sort,
      dir: next.dir,
    });
    const active = sort === column;
    return (
      <th
        scope="col"
        className={className}
        aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
      >
        <a
          className="sort-anchor"
          href={href}
          onClick={(event) => {
            event.preventDefault();
            setSort(next.sort);
            setDir(next.dir);
          }}
        >
          {label}
          <span className="sort-mark" aria-hidden="true">
            {active ? (dir === "asc" ? "▲" : "▼") : "↕"}
          </span>
        </a>
      </th>
    );
  }

  const selectionEmpty = selectedRows.length === 0;

  return (
    <div className="comparison-island">
      <div className="selector-bar">
        <fieldset className="model-selector">
          <legend className="kicker">Models &amp; reasoning efforts</legend>
          <div className="model-groups">
            {groups.map((group) => {
              const selectedCount = group.rows.filter((row) => isSelected(row.evaluationId)).length;
              const groupAll = selectedCount === group.rows.length;
              const groupSome = selectedCount > 0 && selectedCount < group.rows.length;
              return (
                <div className="model-group" key={group.alias}>
                  <label className="model-group-toggle">
                    <input
                      type="checkbox"
                      checked={groupAll}
                      ref={(input) => {
                        if (input !== null) input.indeterminate = groupSome;
                      }}
                      onChange={() => toggleGroup(group.rows.map((row) => row.evaluationId))}
                    />
                    <span className="model-group-name">{group.alias}</span>
                    <span className="model-group-count mono">
                      {selectedCount}/{group.rows.length}
                    </span>
                  </label>
                  <div className="effort-list">
                    {group.rows.map((row) => (
                      <label className="effort-toggle" key={row.evaluationId}>
                        <input
                          type="checkbox"
                          checked={isSelected(row.evaluationId)}
                          aria-label={`${group.alias} · ${row.reasoningMode}`}
                          onChange={() => toggleEvaluation(row.evaluationId)}
                        />
                        <span className="mono">{row.reasoningMode}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
        <div className="selector-tools">
          <p className="status-line" role="status" aria-live="polite">
            {comparisonCountLabel(selectedRows.length, comparisons.length)} selected
          </p>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setSelection(null)}
            disabled={selection === null}
          >
            Select all
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setSelection([])}
            disabled={selection !== null && selection.length === 0}
          >
            Clear all
          </button>
        </div>
      </div>

      <QuadrantChart
        points={series.points}
        excluded={series.excluded}
        x={axes.x}
        y={axes.y}
        costScale={costScale}
        onAxisChange={changeAxis}
        onCostScaleChange={setCostScale}
      />

      {selectionEmpty ? (
        <div className="empty-panel">
          <h2>No models selected</h2>
          <p>Select at least one model above to compare evaluations.</p>
        </div>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the comparison table can scroll horizontally and must stay keyboard-scrollable.
        <section className="table-wrap" tabIndex={0} aria-label="Model comparisons">
          <table className="data-table comparison-table">
            <caption>
              One winning family per evaluation: the newest family with terminal outcomes supplies
              every fixture; recovered results resolve once.
            </caption>
            <thead>
              <tr>
                {sortHeader("model", "Model")}
                {sortHeader("effort", "Effort")}
                {sortHeader("router", "Router / group")}
                {sortHeader("accuracy", "Scored accuracy")}
                {sortHeader("coverage", "Coverage")}
                <th scope="col">Outcomes</th>
                {sortHeader("latency", "Latency")}
                {sortHeader("tokens", "Tokens")}
                {sortHeader("cost", "Cost")}
                {sortHeader("attempts", "Attempts", "num")}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const cost = comparisonCost(row);
                const chips = outcomeChips(row);
                const incomplete = isIncomplete(row);
                return (
                  <tr key={row.evaluationId} className={incomplete ? "is-incomplete" : undefined}>
                    <td data-label="Model">
                      <span className="model-name">{row.modelAlias}</span>
                      <span className="badge-row">
                        {incomplete && (
                          <span className="badge badge--warn" title={unresolvedSummary(row)}>
                            ! incomplete
                          </span>
                        )}
                      </span>
                      <a
                        className="figure-sub"
                        href={`/fixtures?${new URLSearchParams({
                          evaluationId: row.evaluationId,
                        }).toString()}`}
                      >
                        inspect fixtures →
                      </a>
                      <span className="figure-sub" title={row.rootRunId}>
                        family {row.rootRunId.slice(0, 14)}
                      </span>
                    </td>
                    <td data-label="Effort">
                      <span className="mono">{row.reasoningMode}</span>
                    </td>
                    <td data-label="Router / group">
                      <span className="mono">{row.openRouterId}</span>
                      <span className="figure-sub">group {row.rateLimitGroup}</span>
                    </td>
                    <td data-label="Scored accuracy">
                      <span className="figure">{formatPercent(row.scoredAccuracy)}</span>
                      <span className="figure-sub">
                        {formatFraction(row.correct, row.settled)} settled
                      </span>
                      <span className="figure-sub">
                        {formatFraction(row.correct, row.selected)} selected
                      </span>
                    </td>
                    <td data-label="Coverage">
                      <span className="figure">{formatPercent(row.coverage)}</span>
                      <span className="figure-sub">
                        {formatFraction(row.settled, row.selected)} settled
                      </span>
                    </td>
                    <td data-label="Outcomes">
                      <span className="badge-row">
                        {chips.map((chip) => (
                          <span className={`badge badge--${chip.tone}`} key={chip.label}>
                            {chip.symbol} {formatCount(chip.count)}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td data-label="Latency">
                      <span className="mono">{formatLatency(row.meanRequestLatencyMs)}</span>
                      <span className="figure-sub">
                        request · {formatLatency(row.meanTotalFixtureTimeMs)} fixture
                      </span>
                    </td>
                    <td data-label="Tokens">
                      {row.totalTokens === null ? (
                        <>
                          <span className="mono">not reported</span>
                          <span className="figure-sub">
                            {formatCount(row.usageUnknownCount)} without usage
                          </span>
                        </>
                      ) : (
                        <>
                          <span
                            className="mono"
                            title={`${formatTokensExact(row.totalTokens)} total`}
                          >
                            {formatTokens(row.totalTokens)}
                          </span>
                          <span className="figure-sub">
                            {formatTokens(row.promptTokens)} in ·{" "}
                            {formatTokens(row.completionTokens)} out
                          </span>
                        </>
                      )}
                    </td>
                    <td data-label="Cost">
                      <span className="mono">{cost.text}</span>
                      {cost.detail !== null && <span className="figure-sub">{cost.detail}</span>}
                    </td>
                    <td data-label="Attempts" className="num">
                      <span className="mono">{formatCount(row.attempts)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <p className="footnote">
        Scored accuracy = correct / settled; selected accuracy = correct / selected; coverage =
        settled / selected. Attempts counts effective outcomes. Cost and token totals come from the
        winning family's full attempt ledger, including superseded attempts from retries and
        recovery; unknown cost counts attempts without a reported or estimated price.
      </p>
    </div>
  );
}
