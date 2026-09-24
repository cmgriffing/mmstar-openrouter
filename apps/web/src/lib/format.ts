/**
 * Display formatting for the results website.
 *
 * The publication distinguishes "unknown" from "zero" everywhere: missing
 * usage or cost is `null` in the records and must never render as `0`. Every
 * helper here returns a visible "not reported"/"—" marker for `null` and keeps
 * a real zero as `0`/`$0.00`.
 *
 * This module is imported by React islands, so it stays pure and dependency
 * free.
 */

const COUNT_FORMAT = new Intl.NumberFormat("en-US");
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** `1,500`; `—` when unknown. */
export function formatCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return COUNT_FORMAT.format(value);
}

/** `66.7%`; `—` when the denominator is unknown/zero. */
export function formatPercent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

/** `1,000 / 1,500`. */
export function formatFraction(numerator: number, denominator: number): string {
  return `${COUNT_FORMAT.format(numerator)} / ${COUNT_FORMAT.format(denominator)}`;
}

/**
 * `$1.26`; small non-zero costs keep their significant digits so a fraction of
 * a cent never reads as `$0.00`. `null` is "not reported", never `$0.00`.
 */
export function formatUsd(value: number | null, digits?: number): string {
  if (value === null || !Number.isFinite(value)) return "not reported";
  const places = digits ?? (value !== 0 && Math.abs(value) < 0.01 ? 4 : 2);
  return `$${value.toFixed(places)}`;
}

/** `840 ms`, `1.23 s`, or `2m 05s`; `—` when unknown. */
export function formatLatency(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  if (milliseconds < 1000) return `${COUNT_FORMAT.format(Math.round(milliseconds))} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds - minutes * 60);
  return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
}

/** Compact token counts (`12.3k`, `1.05M`); `—` when usage is unknown. */
export function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value < 1_000) return COUNT_FORMAT.format(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 100_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** Exact token breakdown for tooltips. */
export function formatTokensExact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "not reported";
  return COUNT_FORMAT.format(value);
}

/** `23 Sep 2026, 05:58 UTC`; `—` for a missing timestamp. */
export function formatDateTime(iso: string | null): string {
  if (iso === null || iso.length === 0) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${DATE_FORMAT.format(date)} UTC`;
}

/** `a1b2c3d4e5f6`; full value when shorter than the requested length. */
export function shortHash(value: string, length = 12): string {
  return value.length > length ? value.slice(0, length) : value;
}

/** `1–25 of 1,500` for the current page window. */
export function formatRange(offset: number, count: number, total: number): string {
  if (total === 0) return "0 fixtures";
  const first = offset + 1;
  const last = offset + count;
  return `${COUNT_FORMAT.format(first)}–${COUNT_FORMAT.format(last)} of ${COUNT_FORMAT.format(total)}`;
}
