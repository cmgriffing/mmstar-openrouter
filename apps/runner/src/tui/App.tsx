/**
 * OpenTUI renderer for a live benchmark run.
 *
 * The component tree only reads `RunViewStore` snapshots and keyboard state; it
 * never schedules, persists, or inspects the engine. `index.tsx` owns the run
 * lifecycle and feeds the store. Lines are produced by the pure builders in
 * `lines.ts` so layout behavior is unit-testable without a terminal.
 */

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  activityLines,
  compactModelRowLine,
  cooldownLine,
  countsLine,
  helpLines,
  identityLine,
  layoutFor,
  modelRowLine,
  progressLine,
} from "./lines";
import type { RunViewStore } from "./state";

export interface RunnerTuiProps {
  store: RunViewStore;
  /** Bound to `q`; absent while controls are still being wired. */
  onQuit?: (() => void) | undefined;
  /** Injected clock for deterministic tests. */
  now?: (() => number) | undefined;
  /** Redraw interval for countdowns; 0 disables the ticker in tests. */
  tickMs?: number | undefined;
}

type Pane = "models" | "activity";

export function RunnerTui(props: RunnerTuiProps) {
  const { store, onQuit } = props;
  const now = props.now ?? Date.now;
  const tickMs = props.tickMs ?? 250;

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { width, height } = useTerminalDimensions();

  const [, setTick] = useState(0);
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

  const layout = layoutFor(width, height);
  const headerHeight = 6;
  const footerHeight = 1;
  const activityHeight = layout.showActivity
    ? Math.max(5, Math.floor((height - headerHeight - footerHeight) * 0.4))
    : 0;
  const modelBoxHeight = Math.max(4, height - headerHeight - footerHeight - activityHeight);
  const rowCapacity = Math.max(1, modelBoxHeight - 2);
  const activityCapacity = Math.max(1, activityHeight - 2);
  const contentWidth = Math.max(20, width - 4);

  const rows = state.rows;
  const selected = rows.length === 0 ? 0 : Math.min(selectedRow, rows.length - 1);

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
      Math.max(0, Math.min(offset, Math.max(0, state.activity.length - activityCapacity))),
    );
  }, [state.activity.length, activityCapacity]);

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
    switch (key.name) {
      case "?":
      case "/":
        setHelpOpen(true);
        return;
      case "q":
        onQuit?.();
        return;
      case "tab":
        setFocusPane((pane) => (pane === "models" ? "activity" : "models"));
        return;
      case "up":
        if (focusPane === "models") setSelectedRow(Math.max(0, selected - 1));
        else setActivityOffset((offset) => offset + 1);
        return;
      case "down":
        if (focusPane === "models") setSelectedRow(Math.min(rows.length - 1, selected + 1));
        else setActivityOffset((offset) => Math.max(0, offset - 1));
        return;
      case "pageup":
        setActivityOffset((offset) =>
          Math.min(
            offset + activityCapacity,
            Math.max(0, state.activity.length - activityCapacity),
          ),
        );
        return;
      case "pagedown":
        setActivityOffset((offset) => Math.max(0, offset - activityCapacity));
        return;
      case "home":
        setActivityOffset(Math.max(0, state.activity.length - activityCapacity));
        return;
      case "end":
        setActivityOffset(0);
        return;
      case "escape":
        setHelpOpen(true);
        return;
      default:
        return;
    }
  });

  const nowMs = useMemo(() => now(), [now, state, helpOpen, focusPane, selected, activityOffset]);

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
    { offset: activityOffset, height: activityCapacity },
    contentWidth,
  );
  const footer = `↑/↓ ${focusPane}  ·  Tab pane  ·  PgUp/PgDn scroll  ·  ? help${
    onQuit === undefined ? "" : "  ·  q quit"
  }`;

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
      </box>

      <box
        flexDirection="column"
        height={modelBoxHeight}
        border
        title={`${focusPane === "models" ? "* " : ""}Models / groups`}
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

      {layout.showActivity ? (
        <box
          flexDirection="column"
          flexGrow={1}
          border
          title={`${focusPane === "activity" ? "* " : ""}Activity`}
          paddingLeft={1}
          paddingRight={1}
        >
          {activity.map((line, index) => (
            <text key={index}>{line}</text>
          ))}
        </box>
      ) : null}

      <text>{footer}</text>
    </box>
  );
}
