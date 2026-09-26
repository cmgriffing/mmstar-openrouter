/**
 * Searchable picker for the comparison selector: a count-only trigger that
 * opens a dialog panel with a search field, tri-state model groups, effort
 * checkboxes, and bulk actions.
 *
 * Presentational over selection: the parent owns the selected evaluation IDs
 * and the URL sync. This component owns only ephemeral panel state (open,
 * query, collapsed groups), which never enters the URL. The grouped option
 * list renders only while the panel is open, so pages that never touch the
 * picker do not pay for the full option markup.
 */
import { type ReactElement, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ComparisonGroup, ComparisonSelection } from "../lib/view";
import { comparisonCountLabel, filterComparisonGroups, selectMatchingAction } from "../lib/view";

export interface ModelPickerProps {
  /** Every evaluation grouped by alias, in display order. */
  groups: ComparisonGroup[];
  /** Selected evaluation IDs; `null` means every evaluation is selected. */
  selection: ComparisonSelection;
  /** Selected evaluations for the trigger count. */
  selectedCount: number;
  /** Evaluations in the publication for the trigger count. */
  total: number;
  onToggleEvaluation(evaluationId: string): void;
  /** Toggle exactly the given visible rows, preserving the `null` collapse. */
  onToggleVisibleGroup(visibleIds: string[]): void;
  onSelectAll(): void;
  onClearAll(): void;
}

export default function ModelPicker(props: ModelPickerProps): ReactElement {
  const { groups, selection, selectedCount, total } = props;
  const [opened, setOpened] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const panelId = useId();
  const searchId = `${panelId}-search`;
  const countLabel = comparisonCountLabel(selectedCount, total);
  const filtering = query.trim() !== "";

  const selectedSet = useMemo(() => (selection === null ? null : new Set(selection)), [selection]);
  const visibleGroups = useMemo(
    () => filterComparisonGroups(groups, query, selection),
    [groups, query, selection],
  );
  const visibleIds = useMemo(
    () => visibleGroups.flatMap((group) => group.rows.map((row) => row.evaluationId)),
    [visibleGroups],
  );
  const matchingAction = useMemo(
    () => (filtering ? selectMatchingAction(visibleIds, selection) : null),
    [filtering, visibleIds, selection],
  );

  // Opening focuses the search field so a query can be typed immediately.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Escape closes and returns focus to the trigger; outside activation closes
  // without moving focus. Focus moving to another control closes the panel so
  // keyboard navigation never operates controls hidden behind it.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
    function onFocusOut(event: FocusEvent): void {
      const next = event.relatedTarget;
      // A null related target means focus left the document or landed on a
      // non-focusable element; the outside pointerdown handler owns that case,
      // so panel chrome can be clicked without dismissing it.
      if (next === null) return;
      if (next instanceof Node && rootRef.current?.contains(next)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  function toggleOpen(): void {
    if (open) {
      setOpen(false);
      return;
    }
    setOpened(true);
    setOpen(true);
  }

  function toggleCollapsed(alias: string): void {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  }

  function isSelected(evaluationId: string): boolean {
    return selectedSet === null || selectedSet.has(evaluationId);
  }

  return (
    <div className="picker" ref={rootRef}>
      <button
        type="button"
        className="picker-trigger"
        ref={triggerRef}
        aria-expanded={open}
        aria-controls={opened ? panelId : undefined}
        onClick={toggleOpen}
      >
        <span className="picker-trigger-count mono">{countLabel}</span>
        <span className="picker-trigger-caret" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>

      {opened && (
        <div
          className="picker-panel"
          id={panelId}
          role="dialog"
          aria-label="Models and reasoning efforts"
          hidden={!open}
        >
          <div className="picker-search">
            <label className="picker-search-label" htmlFor={searchId}>
              Search models and efforts
            </label>
            <input
              id={searchId}
              ref={searchRef}
              type="search"
              className="picker-search-input"
              placeholder="alias, OpenRouter ID, or effort"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <div className="picker-list">
            {visibleGroups.length === 0 ? (
              <p className="picker-empty">No model or effort matches “{query.trim()}”.</p>
            ) : (
              visibleGroups.map((group) => {
                // The filter is the collapse while it is active; with no query
                // the per-group disclosure controls expansion.
                const expanded = filtering || !collapsed.has(group.alias);
                const allSelected = group.selectedCount === group.visibleCount;
                return (
                  <div className="picker-group" key={group.alias}>
                    <div className="picker-group-header">
                      {!filtering && (
                        <button
                          type="button"
                          className="picker-group-disclosure"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? "Collapse" : "Expand"} ${group.alias}`}
                          onClick={() => toggleCollapsed(group.alias)}
                        >
                          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
                        </button>
                      )}
                      <label className="picker-group-toggle">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={(input) => {
                            if (input !== null) {
                              input.indeterminate = group.selectedCount > 0 && !allSelected;
                            }
                          }}
                          onChange={() =>
                            props.onToggleVisibleGroup(group.rows.map((row) => row.evaluationId))
                          }
                        />
                        <span className="picker-group-name">{group.alias}</span>
                        <span className="picker-group-count mono">
                          {group.selectedCount}/{group.visibleCount}
                        </span>
                      </label>
                      <span className="picker-group-id mono">{group.openRouterId}</span>
                    </div>
                    {expanded && (
                      <div className="picker-effort-list">
                        {group.rows.map((row) => (
                          <label className="picker-effort" key={row.evaluationId}>
                            <input
                              type="checkbox"
                              checked={isSelected(row.evaluationId)}
                              aria-label={`${group.alias} · ${row.reasoningMode}`}
                              onChange={() => props.onToggleEvaluation(row.evaluationId)}
                            />
                            <span className="mono">{row.reasoningMode}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="picker-footer">
            <button
              type="button"
              className="button button--quiet"
              onClick={props.onSelectAll}
              disabled={selection === null}
            >
              Select all
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={props.onClearAll}
              disabled={selection !== null && selection.length === 0}
            >
              Clear all
            </button>
            {matchingAction !== null && (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => props.onToggleVisibleGroup(visibleIds)}
              >
                {matchingAction.label}
              </button>
            )}
          </div>
        </div>
      )}

      <p className="visually-hidden" role="status" aria-live="polite">
        {countLabel}
      </p>
    </div>
  );
}
