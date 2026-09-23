/**
 * Pure line builders for the runner TUI.
 *
 * Every screen line is produced here from view state plus a terminal size, so
 * compact layouts, truncation, focus markers, and color-independent status
 * tokens can be asserted without a terminal. `App.tsx` only wires these lines
 * into OpenTUI renderables and keyboard state.
 */

import {
  formatCountdown,
  formatDuration,
  formatProgress,
  formatProgressBar,
  statusToken,
} from "./format";
import type { EvaluationRow, RunnerViewState } from "./state";
import { activeCooldown, completedCount, estimateRemainingMs, rowStatus, totalWork } from "./state";

export interface Layout {
  /** Narrow terminal: shorter rows, smaller header. */
  compact: boolean;
  /** Hide the activity pane when vertical space is tight. */
  showActivity: boolean;
}

export function layoutFor(width: number, height: number): Layout {
  return { compact: width < 72, showActivity: height >= 18 };
}

/** Clip to `width` columns with an ellipsis; width 0 yields the empty string. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}

function rowDone(row: EvaluationRow): number {
  return row.counts.settled + row.counts.failed + row.counts.indeterminate + row.counts.cancelled;
}

export function identityLine(state: RunnerViewState, width: number): string {
  const parts = [
    `run ${state.runId ?? "—"}`,
    `set ${state.setName ?? "—"}`,
    `mode ${state.mode ?? "—"}`,
    `state ${state.status.toUpperCase()}`,
  ];
  return truncate(parts.join("  "), width);
}

export function progressLine(state: RunnerViewState, nowMs: number, width: number): string {
  const done = completedCount(state);
  const total = totalWork(state);
  const remaining = estimateRemainingMs(state, nowMs);
  const barWidth = Math.max(8, Math.min(24, width - 56));
  const parts = [
    `progress [${formatProgressBar(done, total, barWidth)}]`,
    formatProgress(done, total),
    `remaining ${remaining === null ? "—" : `~${formatDuration(remaining)}`}`,
  ];
  return truncate(parts.join("  "), width);
}

export function countsLine(state: RunnerViewState, width: number): string {
  const pending = Math.max(0, totalWork(state) - completedCount(state));
  const counts = { ...state.counts, pending };
  const parts = (["settled", "failed", "indeterminate", "cancelled", "pending"] as const).map(
    (outcomeState) => `${outcomeState} ${counts[outcomeState]}`,
  );
  return truncate(parts.join("  "), width);
}

export function cooldownLine(state: RunnerViewState, nowMs: number, width: number): string {
  const parts: string[] = [];
  if (state.haltMessage !== null) {
    parts.push(`halt ${state.haltMessage}`);
  } else if (state.stopping !== null) {
    parts.push(`stopping (${state.stopping})`);
  } else if (state.paused) {
    parts.push("paused");
  }
  for (const cooldown of state.cooldowns) {
    const active = activeCooldown(state, cooldown.group, nowMs);
    if (active === null) continue;
    parts.push(
      `cooldown ${active.group} [COOL ${formatCountdown(active.untilMs - nowMs)}] (${active.reason})`,
    );
  }
  if (parts.length === 0 && state.notices.length > 0) {
    parts.push(`notice ${state.notices.at(-1) ?? ""}`);
  }
  if (parts.length === 0) parts.push("cooldowns none");
  return truncate(parts.join("  "), width);
}

export interface ModelRowInput {
  row: EvaluationRow;
  state: RunnerViewState;
  nowMs: number;
  width: number;
  selected: boolean;
}

export function modelRowLine(input: ModelRowInput): string {
  const { row, state, nowMs, width, selected } = input;
  const marker = selected ? ">" : " ";
  const status = statusToken(rowStatus(state, row, nowMs));
  const alias = row.modelAlias.padEnd(12);
  const effort = row.reasoningMode.padEnd(8);
  const group = row.group.padEnd(10);
  const provider = `p:${row.actualProvider ?? "—"}`;
  const done = rowDone(row);
  const progress = `${formatProgressBar(done, row.total, 8)} ${done}/${row.total}`;
  const attempts = `x${row.attempts}`;
  const parts = [marker, status, alias, effort, group, provider, progress, attempts];
  return truncate(parts.join(" "), width);
}

export function compactModelRowLine(
  row: EvaluationRow,
  state: RunnerViewState,
  nowMs: number,
  width: number,
): string {
  const status = statusToken(rowStatus(state, row, nowMs));
  const done = rowDone(row);
  const cooldown = activeCooldown(state, row.group, nowMs);
  const parts = [
    status,
    row.modelAlias,
    row.reasoningMode,
    row.group,
    `${done}/${row.total}`,
    `x${row.attempts}`,
  ];
  if (cooldown !== null) parts.push(`(${formatCountdown(cooldown.untilMs - nowMs)})`);
  if (row.actualProvider !== null) parts.push(row.actualProvider);
  return truncate(parts.join(" "), width);
}

export interface ActivityWindow {
  /** 0 shows the newest entries; higher values scroll back in history. */
  offset: number;
  height: number;
}

export function activityLines(
  state: RunnerViewState,
  window: ActivityWindow,
  width: number,
): string[] {
  const entries = state.activity;
  if (entries.length === 0) return ["(no activity yet)"];
  const end = Math.max(0, entries.length - Math.max(0, window.offset));
  const start = Math.max(0, end - Math.max(0, window.height));
  const visible = entries.slice(start, end).map((entry) => {
    const time = entry.at.length >= 19 ? entry.at.slice(11, 19) : entry.at;
    return `${String(entry.seq).padStart(4)} ${time} ${entry.summary}`;
  });
  if (window.offset > 0 && visible.length > 0) {
    visible[visible.length - 1] = `▲${visible[visible.length - 1]}`;
  }
  return visible.map((line) => truncate(line, width));
}

export function helpLines(): string[] {
  return [
    "Keyboard",
    "  up/down      move model/group row focus",
    "  PgUp/PgDn    scroll activity history",
    "  Home/End     jump to oldest / newest activity",
    "  Tab          switch pane focus",
    "  ? / Esc      toggle this help",
    "  q            quit after the current run finishes",
  ];
}
