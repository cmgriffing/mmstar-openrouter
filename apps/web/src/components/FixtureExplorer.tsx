/**
 * Fixture drilldown explorer.
 *
 * Server-rendered first page (no loading flash, works without JS) that becomes
 * interactive on hydration: filter changes and pagination re-query the bounded
 * `/api/fixtures.json` endpoint, keep the URL shareable, and expose explicit
 * loading, empty, and error states. It never talks to SQLite directly.
 */
import type { FixturePage, FixtureSummary, OutcomeKind, OutcomeState } from "@mmstar/results";
import { useEffect, useRef, useState } from "react";
import { formatCount, formatLatency, formatRange } from "../lib/format";
import {
  attemptCostLine,
  fixtureQueryString,
  OUTCOME_KIND_OPTIONS,
  OUTCOME_STATE_OPTIONS,
  outcomePresentation,
} from "../lib/view";

export interface FixtureExplorerProps {
  pageSize: number;
  initialPage: FixturePage;
  initialFilters: {
    evaluationId: string;
    category: string;
    state: "" | OutcomeState;
    kind: "" | OutcomeKind;
    offset: number;
  };
  evaluations: { evaluationId: string; label: string }[];
  categories: string[];
}

interface Filters {
  evaluationId: string;
  category: string;
  state: "" | OutcomeState;
  kind: "" | OutcomeKind;
}

interface ApiBody {
  data?: FixturePage;
  error?: { message?: string };
}

export default function FixtureExplorer(props: FixtureExplorerProps) {
  const { pageSize, initialPage, evaluations, categories } = props;
  const [filters, setFilters] = useState<Filters>({
    evaluationId: props.initialFilters.evaluationId,
    category: props.initialFilters.category,
    state: props.initialFilters.state,
    kind: props.initialFilters.kind,
  });
  const [offset, setOffset] = useState(props.initialFilters.offset);
  const [page, setPage] = useState<FixturePage>(initialPage);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const skipInitialFetch = useRef(true);

  const hasFilters =
    filters.evaluationId !== "" ||
    filters.category !== "" ||
    filters.state !== "" ||
    filters.kind !== "";

  useEffect(() => {
    if (skipInitialFetch.current) {
      skipInitialFetch.current = false;
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    setErrorMessage(null);
    const query = fixtureQueryString({
      evaluationId: filters.evaluationId === "" ? undefined : filters.evaluationId,
      category: filters.category === "" ? undefined : filters.category,
      state: filters.state === "" ? undefined : filters.state,
      kind: filters.kind === "" ? undefined : filters.kind,
      limit: pageSize,
      offset,
    });
    fetch(`/api/fixtures.json?${query}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as ApiBody | null;
        if (!response.ok || body?.data === undefined) {
          throw new Error(body?.error?.message ?? `Fixture query failed (${response.status})`);
        }
        return body.data;
      })
      .then((next) => {
        setPage(next);
        setStatus("idle");
        window.history.replaceState(null, "", `/fixtures?${query}`);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("error");
        setErrorMessage(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [filters, offset, reloadToken]);

  function updateFilter(patch: Partial<Filters>): void {
    setFilters((previous) => ({ ...previous, ...patch }));
    setOffset(0);
  }

  function resetFilters(): void {
    setFilters({ evaluationId: "", category: "", state: "", kind: "" });
    setOffset(0);
  }

  function detailHref(row: FixtureSummary): string {
    const backQuery = fixtureQueryString({
      evaluationId: filters.evaluationId === "" ? undefined : filters.evaluationId,
      category: filters.category === "" ? undefined : filters.category,
      state: filters.state === "" ? undefined : filters.state,
      kind: filters.kind === "" ? undefined : filters.kind,
      limit: pageSize,
      offset,
    });
    const params = new URLSearchParams({
      evaluationId: row.evaluationId,
      fixtureId: row.fixtureId,
      back: `/fixtures?${backQuery}`,
    });
    return `/fixture?${params.toString()}`;
  }

  const pageNumber = Math.floor(offset / pageSize) + 1;
  const pageCount = Math.max(1, Math.ceil(page.total / pageSize));

  return (
    <section aria-label="Fixture drilldown">
      <div className="filter-bar">
        <div className="field">
          <label htmlFor="filter-evaluation">Evaluation</label>
          <select
            id="filter-evaluation"
            value={filters.evaluationId}
            onChange={(event) => updateFilter({ evaluationId: event.target.value })}
          >
            <option value="">All evaluations</option>
            {evaluations.map((evaluation) => (
              <option key={evaluation.evaluationId} value={evaluation.evaluationId}>
                {evaluation.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-category">Category</label>
          <select
            id="filter-category"
            value={filters.category}
            onChange={(event) => updateFilter({ category: event.target.value })}
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-state">Outcome state</label>
          <select
            id="filter-state"
            value={filters.state}
            onChange={(event) => updateFilter({ state: event.target.value as "" | OutcomeState })}
          >
            <option value="">Any state</option>
            {OUTCOME_STATE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-kind">Scored kind</label>
          <select
            id="filter-kind"
            value={filters.kind}
            onChange={(event) => updateFilter({ kind: event.target.value as "" | OutcomeKind })}
          >
            <option value="">Any kind</option>
            {OUTCOME_KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {hasFilters && (
          <button type="button" className="button button--quiet" onClick={resetFilters}>
            Reset filters
          </button>
        )}
      </div>

      <p
        className="status-line"
        role="status"
        aria-live="polite"
        data-loading={status === "loading"}
      >
        {status === "loading"
          ? "Loading fixtures…"
          : status === "error"
            ? "Fixture query failed"
            : `${formatCount(page.total)} fixture${page.total === 1 ? "" : "s"} match${
                page.total === 1 ? "es" : ""
              }`}
      </p>

      <div className="results" aria-busy={status === "loading"}>
        {status === "error" ? (
          <div className="empty-panel" role="alert">
            <h2>Could not load fixtures</h2>
            <p className="mono">{errorMessage}</p>
            <button
              type="button"
              className="button"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              Retry
            </button>
          </div>
        ) : page.rows.length === 0 ? (
          <div className="empty-panel">
            <h2>No fixtures match</h2>
            <p>Try a different evaluation, category, or outcome.</p>
            {hasFilters && (
              <button type="button" className="button" onClick={resetFilters}>
                Reset filters
              </button>
            )}
          </div>
        ) : (
          <>
            <section className="table-wrap" aria-label="Fixture results">
              <table className="data-table fixture-table">
                <caption>
                  Effective outcomes across the whole publication; recovered fixtures count once.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Fixture</th>
                    <th scope="col">Category</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Parsed answer</th>
                    <th scope="col" className="num">
                      Attempts
                    </th>
                    <th scope="col">Latency</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row) => {
                    const outcome = outcomePresentation(row.state, row.kind);
                    const recovered = row.effectiveRunId !== row.rootRunId;
                    return (
                      <tr key={`${row.evaluationId}/${row.fixtureId}`}>
                        <td data-label="Fixture">
                          <a className="fixture-id" href={detailHref(row)}>
                            #{row.fixtureId}
                          </a>
                          <span className="fixture-question">{row.question}</span>
                        </td>
                        <td data-label="Category">
                          {row.category}
                          <span className="figure-sub">{row.l2Category}</span>
                        </td>
                        <td data-label="Outcome">
                          <span className={`badge badge--${outcome.tone}`}>
                            {outcome.symbol} {outcome.label}
                          </span>
                          {(recovered || row.indeterminate) && (
                            <span className="badge-row">
                              {recovered && (
                                <span className="badge badge--accent">↺ recovered</span>
                              )}
                              {row.indeterminate && row.state !== "indeterminate" && (
                                <span className="badge badge--warn">? indeterminate</span>
                              )}
                            </span>
                          )}
                        </td>
                        <td data-label="Parsed answer">
                          <span className="mono">{row.parsedAnswer ?? "—"}</span>
                        </td>
                        <td data-label="Attempts" className="num">
                          <span className="mono">{formatCount(row.attemptCount)}</span>
                        </td>
                        <td data-label="Latency">
                          <span className="mono">{formatLatency(row.requestLatencyMs)}</span>
                          <span className="figure-sub">
                            {formatLatency(row.totalFixtureTimeMs)} total
                          </span>
                        </td>
                        <td data-label="Cost">
                          <span className="mono">{attemptCostLine(row.costKind, row.costUsd)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            <nav className="pagination" aria-label="Fixture pages">
              <button
                type="button"
                className="button"
                onClick={() => setOffset(0)}
                disabled={offset === 0}
              >
                First
              </button>
              <button
                type="button"
                className="button"
                onClick={() => setOffset(Math.max(0, offset - pageSize))}
                disabled={offset === 0}
              >
                Previous
              </button>
              <span className="pagination-status mono">
                Page {pageNumber} / {pageCount} ·{" "}
                {formatRange(offset, page.rows.length, page.total)}
              </span>
              <button
                type="button"
                className="button"
                onClick={() => setOffset(offset + pageSize)}
                disabled={!page.hasMore}
              >
                Next
              </button>
              <button
                type="button"
                className="button"
                onClick={() => setOffset((pageCount - 1) * pageSize)}
                disabled={!page.hasMore}
              >
                Last
              </button>
            </nav>
          </>
        )}
      </div>
    </section>
  );
}
