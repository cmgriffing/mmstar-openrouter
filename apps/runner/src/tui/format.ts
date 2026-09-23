/**
 * Pure display formatting for the runner TUI.
 *
 * These helpers never read the clock or terminal: callers pass elapsed or
 * remaining milliseconds, so a deterministic test can assert exact labels and
 * the renderer stays the only place with terminal state.
 */
import type { OutcomeState } from "@mmstar/results";
import type { RowStatus } from "./state";

const EM_DASH = "—";

/** Human duration: `12.4s`, `1m 05s`, `1h 02m`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return EM_DASH;
  const total = Math.max(0, ms);
  if (total < 60_000) return `${(total / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.floor(total / 1_000);
  if (totalSeconds < 3_600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** Cooldown/retry countdown that rounds up so it never reads 0 while waiting. */
export function formatCountdown(ms: number | null): string {
  if (ms === null) return "0s";
  const totalSeconds = Math.max(0, Math.ceil(ms / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Rounded percentage, or a placeholder when the denominator is unknown. */
export function formatPercent(ratio: number | null): string {
  if (ratio === null) return EM_DASH;
  return `${Math.round(ratio * 100)}%`;
}

/** Fixed-width ASCII progress bar; no color or wide glyphs required. */
export function formatProgressBar(done: number, total: number, width: number): string {
  const columns = Math.max(0, Math.floor(width));
  if (columns === 0) return "";
  if (total <= 0) return "-".repeat(columns);
  const clamped = Math.max(0, Math.min(done, total));
  const filled = Math.round((clamped / total) * columns);
  return `${"#".repeat(filled)}${"-".repeat(columns - filled)}`;
}

/** `done/total percent` with a placeholder percentage for an empty selection. */
export function formatProgress(done: number, total: number): string {
  const ratio = total === 0 ? null : done / total;
  return `${done}/${total} ${formatPercent(ratio)}`;
}

const ROW_STATUS_TOKENS: Record<RowStatus, string> = {
  queued: "[WAIT]",
  running: "[RUN]",
  cooldown: "[COOL]",
  done: "[DONE]",
  failed: "[FAIL]",
};

/** Color-independent status token for a model/group row. */
export function statusToken(status: RowStatus): string {
  return ROW_STATUS_TOKENS[status];
}

const OUTCOME_STATE_TOKENS: Record<OutcomeState, string> = {
  pending: "PEND",
  settled: "OK",
  failed: "FAIL",
  indeterminate: "INDET",
  cancelled: "CANCEL",
};

/** Color-independent token for an outcome state count. */
export function outcomeStateToken(state: OutcomeState): string {
  return OUTCOME_STATE_TOKENS[state];
}
