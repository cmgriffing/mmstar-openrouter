/**
 * OpenTUI renderer for a live benchmark run.
 *
 * The component tree only reads `RunViewStore` snapshots and keyboard state; it
 * never schedules, persists, or inspects the engine. `index.tsx` owns the run
 * lifecycle, feeds the store, and fulfills inspection/control requests through
 * the callbacks passed here. Lines are produced by the pure builders in
 * `lines.ts` so layout behavior is unit-testable without a terminal.
 */

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  activityLines,
  compactModelRowLine,
  cooldownLine,
  countsLine,
  detailLines,
  helpLines,
  identityLine,
  layoutFor,
  metricsLines,
  modelRowLine,
  progressLine,
  truncate,
} from "./lines";
import { activeRetryFor, filterActivity, type RunViewStore, selectedActivityEntry } from "./state";

export interface RunnerTuiProps {
  store: RunViewStore;
  /** Bound to `q` and Ctrl-C; the entry point turns this into a graceful stop. */
  onQuit?: (() => void) | undefined;
  /** Bound to `p`; stops launching new requests while in-flight work settles. */
  onPause?: (() => void) | undefined;
  /** Bound to `c`; resumes scheduling after a pause. */
  onResume?: (() => void) | undefined;
  /** Bound to Enter in the activity pane; opens the fixture detail view. */
  onInspect?: ((evaluationId: string, fixtureId: string) => void) | undefined;
  /** Injected clock for deterministic tests. */
  now?: (() => number) | undefined;
  /** Redraw interval for countdowns; 0 disables the ticker in tests. */
  tickMs?: number | undefined;
}

type Pane = "models" | "activity";

export function RunnerTui(props: RunnerTuiProps) {
  const { store, onQuit, onPause, onResume, onInspect } = props;
  const now = props.now ?? Date.now;
  const tickMs = props.tickMs ?? 250;

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { width, height } = useTerminalDimensions();

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (tickMs <= 0) return;
    const timer = setInterval(() => setTick((value) => value + 1), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);

  const [helpOpen, setHelpOpen] = useState(false);
  const [focusPane, setFocusPane] = useState<Pane>("models");
  const [selectedRow, setSelectedRow] = useState(0);
  const [rowStart, setRowStart] = useState(0);
  const [activityOffset, setActivityOffset] = useState(0);
  const [activitySelected, setActivitySelected] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [detailScroll, setDetailScroll] = useState(0);

  const layout = layoutFor(width, height);
  const contentWidth = Math.max(20, width - 4);

  // Metrics are trimmed, not truncated mid-line, when the terminal cannot fit
  // them alongside the panes. Opening fixture detail may drop to the headline
  // accuracy line so the detail pane stays usable on a small terminal.
  const detailOpen = state.detail !== null;
  let metrics = metricsLines(state, contentWidth, layout.compact);
  const tinyLimit = Math.max(0, height - 11);
  if (metrics.length > tinyLimit) metrics = metrics.slice(0, tinyLimit);
  let headerHeight = 6 + metrics.length;
  const footerHeight = filterOpen ? 2 : 1;
  let bodyHeight = Math.max(4, height - headerHeight - footerHeight);
  if (detailOpen && bodyHeight < 9 && metrics.length > 1) {
    metrics = metrics.slice(0, 1);
    headerHeight = 6 + metrics.length;
    bodyHeight = Math.max(4, height - headerHeight - footerHeight);
  }

  const lowerVisible = layout.showActivity && bodyHeight >= (detailOpen ? 9 : 7);
  const lowerRatio = detailOpen ? 0.55 : 0.4;
  const lowerHeight = lowerVisible
    ? Math.max(detailOpen ? 5 : 4, Math.floor(bodyHeight * lowerRatio))
    : 0;
  const modelBoxHeight = Math.max(4, bodyHeight - lowerHeight);
  const rowCapacity = Math.max(1, modelBoxHeight - 2);
  const lowerCapacity = Math.max(1, lowerHeight - 2);

  const rows = state.rows;
  const selected = rows.length === 0 ? 0 : Math.min(selectedRow, rows.length - 1);

  const nowMs = useMemo(() => now(), [now, state, helpOpen, focusPane, selected, filterOpen, tick]);
  const retryRemainingMs =
    state.detail === null
      ? null
      : (() => {
          const retry = activeRetryFor(
            state,
            state.detail.evaluationId,
            state.detail.fixtureId,
            nowMs,
          );
          return retry === null ? null : retry.retryAtMs - nowMs;
        })();
  const detailAll =
    state.detail === null
      ? null
      : detailLines(
          state.detail,
          { scroll: 0, height: Number.MAX_SAFE_INTEGER },
          contentWidth,
          retryRemainingMs,
        );
  const maxDetailScroll = Math.max(0, (detailAll?.length ?? 0) - lowerCapacity);
  const detailVisible = detailAll?.slice(detailScroll, detailScroll + lowerCapacity) ?? [];

  const filtered = filterActivity(state.activity, filterText);
  const selectedFromNewest = Math.max(0, Math.min(activitySelected, filtered.length - 1));

  useEffect(() => {
    setRowStart((start) => {
      const maxStart = Math.max(0, rows.length - rowCapacity);
      if (selected < start) return selected;
      if (selected >= start + rowCapacity) return Math.max(0, selected - rowCapacity + 1);
      return Math.min(start, maxStart);
    });
  }, [selected, rowCapacity, rows.length]);

  useEffect(() => {
    setActivityOffset((offset) =>
      Math.max(0, Math.min(offset, Math.max(0, filtered.length - lowerCapacity))),
    );
  }, [filtered.length, lowerCapacity]);

  // A newly opened fixture starts at the top; closing resets scroll for the next.
  useEffect(() => {
    setDetailScroll(0);
  }, [state.detail?.evaluationId, state.detail?.fixtureId]);

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    if (key.ctrl && key.name === "c") {
      onQuit?.();
      return;
    }
    if (helpOpen) {
      if (key.name === "escape" || key.name === "?") setHelpOpen(false);
      else if (key.name === "q") onQuit?.();
      return;
    }
    if (filterOpen) {
      if (key.name === "escape") {
        setFilterText("");
        setFilterOpen(false);
        return;
      }
      if (key.name === "return" || key.name === "linefeed") {
        setFilterOpen(false);
        return;
      }
      if (key.name === "backspace") {
        setFilterText((text) => text.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta) return;
      const character = key.name === "space" ? " " : key.name;
      if (character.length === 1) setFilterText((text) => text + character);
      return;
    }
    if (detailOpen) {
      switch (key.name) {
        case "escape":
        case "return":
        case "linefeed":
          store.applyDetail(null);
          return;
        case "q":
          onQuit?.();
          return;
        case "up":
          setDetailScroll((scroll) => Math.max(0, scroll - 1));
          return;
        case "down":
          setDetailScroll((scroll) => Math.min(maxDetailScroll, scroll + 1));
          return;
        case "pageup":
          setDetailScroll((scroll) => Math.max(0, scroll - lowerCapacity));
          return;
        case "pagedown":
          setDetailScroll((scroll) => Math.min(maxDetailScroll, scroll + lowerCapacity));
          return;
        case "home":
          setDetailScroll(0);
          return;
        case "end":
          setDetailScroll(maxDetailScroll);
          return;
        default:
          return;
      }
    }
    switch (key.name) {
      case "?":
      case "/":
        setHelpOpen(true);
        return;
      case "q":
        onQuit?.();
        return;
      case "p":
        onPause?.();
        return;
      case "c":
        onResume?.();
        return;
      case "f":
        setFilterOpen(true);
        return;
      case "tab":
        setFocusPane((pane) => (pane === "models" ? "activity" : "models"));
        return;
      case "up":
        if (focusPane === "models") {
          setSelectedRow(Math.max(0, selected - 1));
        } else {
          const next = Math.min(selectedFromNewest + 1, Math.max(0, filtered.length - 1));
          setActivitySelected(next);
          setActivityOffset((offset) =>
            next >= offset + lowerCapacity ? next - lowerCapacity + 1 : Math.min(offset, next),
          );
        }
        return;
      case "down":
        if (focusPane === "models") {
          setSelectedRow(Math.min(rows.length - 1, selected + 1));
        } else {
          const next = Math.max(0, selectedFromNewest - 1);
          setActivitySelected(next);
          setActivityOffset((offset) => Math.min(offset, next));
        }
        return;
      case "return":
      case "linefeed": {
        if (focusPane !== "activity") return;
        const entry = selectedActivityEntry(state, filterText, selectedFromNewest);
        if (entry !== null && entry.evaluationId !== null && entry.fixtureId !== null) {
          onInspect?.(entry.evaluationId, entry.fixtureId);
        }
        return;
      }
      case "pageup":
        setActivityOffset((offset) =>
          Math.min(offset + lowerCapacity, Math.max(0, filtered.length - lowerCapacity)),
        );
        return;
      case "pagedown":
        setActivityOffset((offset) => Math.max(0, offset - lowerCapacity));
        return;
      case "home":
        setActivityOffset(Math.max(0, filtered.length - lowerCapacity));
        return;
      case "end":
        setActivityOffset(0);
        return;
      case "escape":
        setFilterText("");
        return;
      default:
        return;
    }
  });

  if (helpOpen) {
    return (
      <box
        flexDirection="column"
        width="100%"
        height="100%"
        border
        title="MMStar runner — help"
        paddingLeft={1}
        paddingRight={1}
      >
        {helpLines().map((line, index) => (
          <text key={index}>{line}</text>
        ))}
        <text> </text>
        <text>press ? or Esc to close</text>
      </box>
    );
  }

  const visibleRows = rows.slice(rowStart, rowStart + rowCapacity);
  const activity = activityLines(
    state,
    {
      offset: activityOffset,
      height: lowerCapacity,
      selected: selectedFromNewest,
      filter: filterText,
    },
    contentWidth,
  );

  const footerParts = ["Tab pane", "↑/↓ select", "Enter inspect", "f filter"];
  if (onPause !== undefined && !state.paused) footerParts.push("p pause");
  if (onResume !== undefined && state.paused) footerParts.push("c continue");
  if (onQuit !== undefined) footerParts.push("q quit");
  footerParts.push("? help");
  const footer = footerParts.join("  ·  ");

  const lowerTitle = detailOpen
    ? "Fixture detail — Esc to close"
    : `Activity${filterText.trim() === "" ? "" : ` [filter: ${filterText}]`}`;

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box
        flexDirection="column"
        height={headerHeight}
        border
        title="MMStar runner"
        paddingLeft={1}
        paddingRight={1}
      >
        <text>{identityLine(state, contentWidth)}</text>
        <text>{progressLine(state, nowMs, contentWidth)}</text>
        <text>{countsLine(state, contentWidth)}</text>
        <text>{cooldownLine(state, nowMs, contentWidth)}</text>
        {metrics.map((line, index) => (
          <text key={index}>{line}</text>
        ))}
      </box>

      <box
        flexDirection="column"
        height={modelBoxHeight}
        border
        title={`${focusPane === "models" && !detailOpen ? "* " : ""}Models / groups`}
        paddingLeft={1}
        paddingRight={1}
      >
        {rows.length === 0 ? (
          <text>waiting for evaluations…</text>
        ) : (
          visibleRows.map((row, index) => (
            <text key={row.evaluationId}>
              {layout.compact
                ? compactModelRowLine(row, state, nowMs, contentWidth)
                : modelRowLine({
                    row,
                    state,
                    nowMs,
                    width: contentWidth,
                    selected: rowStart + index === selected,
                  })}
            </text>
          ))
        )}
      </box>

      {lowerVisible ? (
        <box
          flexDirection="column"
          flexGrow={1}
          border
          title={`${focusPane === "activity" && !detailOpen ? "* " : ""}${lowerTitle}`}
          paddingLeft={1}
          paddingRight={1}
        >
          {(detailOpen ? detailVisible : activity).map((line, index) => (
            <text key={index}>{line}</text>
          ))}
        </box>
      ) : null}

      {filterOpen ? (
        <text>{truncate(`filter: ${filterText}_  (Enter apply · Esc clear)`, width)}</text>
      ) : null}
      <text>{truncate(footer, width)}</text>
    </box>
  );
}
