/**
 * Pure line builders for the runner TUI.
 *
 * Every screen line is produced here from view state plus a terminal size, so
 * compact layouts, truncation, focus markers, and color-independent status
 * tokens can be asserted without a terminal. `App.tsx` only wires these lines
 * into OpenTUI renderables and keyboard state.
 */

import type { EngineMetrics, LatencyDistribution, TokenTotals } from "@mmstar/benchmark";
import {
  formatCount,
  formatCountdown,
  formatDuration,
  formatPercent,
  formatProgress,
  formatProgressBar,
  formatUsd,
  statusToken,
} from "./format";
import type { EvaluationRow, FixtureDetailView, RunnerViewState } from "./state";
import {
  activeCooldown,
  activeRetries,
  completedCount,
  estimateRemainingMs,
  filterActivity,
  rowStatus,
  totalWork,
} from "./state";

/** Response text beyond this length is cut with an explicit marker, keeping
 * wrapping cost bounded even for a pathological response. */
export const MAX_DETAIL_RESPONSE_CHARS = 20_000;

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
  for (const retry of activeRetries(state, nowMs).slice(0, 2)) {
    const label = rowLabelFor(state, retry.evaluationId);
    parts.push(`retry ${label}/${retry.fixtureId} in ${formatCountdown(retry.retryAtMs - nowMs)}`);
  }
  if (parts.length === 0 && state.notices.length > 0) {
    parts.push(`notice ${state.notices.at(-1) ?? ""}`);
  }
  if (parts.length === 0) parts.push("cooldowns none");
  return truncate(parts.join("  "), width);
}

function rowLabelFor(state: RunnerViewState, evaluationId: string): string {
  const row = state.rows.find((entry) => entry.evaluationId === evaluationId);
  if (row === undefined) return evaluationId;
  return `${row.modelAlias}/${row.reasoningMode}`;
}

/**
 * Metrics banner: accuracy with explicit denominators, latency distribution,
 * token usage, and cost kinds kept distinct. The first token says whether the
 * numbers can still change. Compact terminals drop the category breakdown but
 * keep every required metric.
 */
export function metricsLines(state: RunnerViewState, width: number, compact = false): string[] {
  const metrics = state.metrics;
  if (metrics === null) return [truncate("metrics waiting for engine records…", width)];

  const status = metrics.provisional ? "[PROVISIONAL]" : "[FINAL]";
  const lines = [
    `${status} accuracy ${formatPercent(metrics.scoredResponseAccuracy)} scored (${metrics.correctCount}/${metrics.scoredResponseCount})  total ${formatPercent(metrics.totalSelectedAccuracy)} (${metrics.correctCount}/${metrics.totalSelected})  coverage ${formatPercent(metrics.coverage)} (${metrics.settledCount}/${metrics.totalSelected})`,
    `latency ${latencySummary(metrics.requestLatency)}  usage ${tokenSummary(metrics.tokens)}`,
    `cost known ${formatUsd(metrics.costs.knownUsd)}  reported ${formatUsd(metrics.costs.reportedUsd)}  estimated ${formatUsd(metrics.costs.estimatedUsd)}  unknown ${metrics.costs.unknownCount}`,
  ];
  if (!compact) lines.push(`categories ${categorySummary(metrics)}`);
  return lines.map((line) => truncate(line, width));
}

function latencySummary(distribution: LatencyDistribution): string {
  return `p50 ${formatDuration(distribution.p50Ms)}  p95 ${formatDuration(distribution.p95Ms)}  max ${formatDuration(distribution.maxMs)}  n ${distribution.count}`;
}

function tokenSummary(tokens: TokenTotals): string {
  return `in ${formatCount(tokens.promptTokens)}  out ${formatCount(tokens.completionTokens)}  reason ${formatCount(tokens.reasoningTokens)} (unknown ${tokens.usageUnknownCount})`;
}

function categorySummary(metrics: EngineMetrics): string {
  const parts = metrics.categoryMetrics.map(
    (category) =>
      `${category.category} ${formatPercent(category.accuracy)} (${category.correct}/${category.selected})`,
  );
  return parts.length === 0 ? "(none yet)" : parts.join("  ");
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
  if (row.inFlight > 0) parts.push(`flight ${row.inFlight}`);
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
  if (row.inFlight > 0) parts.push(`fl${row.inFlight}`);
  if (cooldown !== null) parts.push(`(${formatCountdown(cooldown.untilMs - nowMs)})`);
  if (row.actualProvider !== null) parts.push(row.actualProvider);
  return truncate(parts.join(" "), width);
}

export interface ActivityWindow {
  /** 0 shows the newest entries; higher values scroll back in history. */
  offset: number;
  height: number;
  /** Index from the newest entry (0 = newest) marked as selected. */
  selected?: number | undefined;
  /** Case-insensitive filter over kind, summary, fixture and evaluation IDs. */
  filter?: string | null | undefined;
}

export function activityLines(
  state: RunnerViewState,
  window: ActivityWindow,
  width: number,
): string[] {
  const entries = filterActivity(state.activity, window.filter ?? null);
  if (entries.length === 0) {
    return [window.filter ? "(no matching activity)" : "(no activity yet)"];
  }
  const end = Math.max(0, entries.length - Math.max(0, window.offset));
  const start = Math.max(0, end - Math.max(0, window.height));
  const selected = window.selected ?? 0;
  const visible = entries.slice(start, end).map((entry, index) => {
    const fromNewest = entries.length - 1 - (start + index);
    const marker = fromNewest === selected ? ">" : " ";
    const time = entry.at.length >= 19 ? entry.at.slice(11, 19) : entry.at;
    return `${marker}${String(entry.seq).padStart(4)} ${time} ${entry.summary}`;
  });
  if (window.offset > 0 && visible.length > 0) {
    visible[visible.length - 1] = `▲ ${visible[visible.length - 1]}`;
  }
  return visible.map((line) => truncate(line, width));
}

/** Wrap text to `width` columns, preserving explicit newlines. */
export function wrapText(text: string, width: number): string[] {
  const usable = Math.max(1, Math.floor(width));
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part !== "")) {
      if (current === "") {
        current = word;
      } else if (current.length + 1 + word.length <= usable) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== "") lines.push(current);
  }
  return lines.length === 0 ? [""] : lines;
}

export interface DetailWindow {
  /** 0 shows the first detail lines; higher values scroll down. */
  scroll: number;
  height: number;
}

/**
 * Fixture inspection lines: question, response, parsed/expected answer, every
 * attempt, failure, lineage, and a live retry countdown when one is pending.
 * Wrapping happens here so a long response is reachable with the same scrolling
 * keys as the activity pane.
 */
export function detailLines(
  detail: FixtureDetailView,
  window: DetailWindow,
  width: number,
  retryRemainingMs: number | null,
): string[] {
  const lines: string[] = [];
  const pushWrapped = (prefix: string, text: string): void => {
    const wrapped = wrapText(text, Math.max(1, width - prefix.length));
    lines.push(`${prefix}${wrapped[0] ?? ""}`);
    for (const continuation of wrapped.slice(1)) lines.push(`${prefix}${continuation}`);
  };

  lines.push(
    `fixture ${detail.fixtureId}  category ${detail.category}  eval ${detail.modelAlias}/${detail.reasoningMode}`,
  );
  const answers = [
    `state ${detail.state}`,
    `parsed ${detail.parsedAnswer ?? "—"}`,
    `expected ${detail.expectedAnswer}`,
    `attempts ${detail.attempts.length}`,
  ];
  if (detail.kind !== null) answers.splice(1, 0, `outcome ${detail.kind}`);
  if (detail.indeterminate) answers.push("indeterminate request");
  lines.push(answers.join("  "));
  lines.push(lineageLine(detail));
  if (retryRemainingMs !== null) {
    lines.push(`retry pending in ${formatCountdown(Math.max(0, retryRemainingMs))}`);
  }
  lines.push("question:");
  pushWrapped("  ", detail.question);
  lines.push("response:");
  if (detail.responseText === null || detail.responseText === "") {
    lines.push("  (no response retained)");
  } else {
    pushWrapped("  ", clipDetailText(detail.responseText));
  }
  lines.push("attempts:");
  if (detail.attempts.length === 0) {
    lines.push("  (no attempts recorded)");
  } else {
    for (const attempt of detail.attempts) lines.push(`  ${attemptLine(attempt)}`);
  }
  if (detail.failure !== null) {
    pushWrapped("failure: ", `${detail.failure.category} ${detail.failure.message}`);
  }

  const scroll = Math.max(0, Math.floor(window.scroll));
  const height = Math.max(0, Math.floor(window.height));
  return lines.slice(scroll, scroll + height).map((line) => truncate(line, width));
}

function lineageLine(detail: FixtureDetailView): string {
  const source = detail.lineage.sourceRunId;
  if (source === null) return "lineage original";
  const outcome = detail.lineage.sourceOutcomeId;
  return `lineage recovery from ${source}${outcome === null ? "" : ` / ${outcome}`}`;
}

function clipDetailText(text: string): string {
  if (text.length <= MAX_DETAIL_RESPONSE_CHARS) return text;
  return `${text.slice(0, MAX_DETAIL_RESPONSE_CHARS)}… [truncated at ${MAX_DETAIL_RESPONSE_CHARS} characters]`;
}

function attemptLine(attempt: FixtureDetailView["attempts"][number]): string {
  const usage = attempt.usage;
  const tokens =
    usage === null
      ? "tokens —"
      : `tokens ${formatCount(usage.promptTokens)}/${formatCount(usage.completionTokens)}`;
  const cost = `cost ${attempt.cost.kind} ${formatUsd(attempt.cost.usd)}`;
  const provider = attempt.upstreamProvider ?? attempt.modelUsed ?? "—";
  const failure = attempt.failureCategory === null ? "" : ` (${attempt.failureCategory})`;
  return [
    `#${attempt.attemptNumber}`,
    `${attempt.state}${failure}`,
    provider,
    formatDuration(attempt.requestLatencyMs),
    tokens,
    cost,
  ].join("  ");
}

export function helpLines(): string[] {
  return [
    "Keyboard",
    "  up/down      move row focus / activity selection",
    "  Enter        inspect the selected activity entry",
    "  f            filter activity (kind, fixture, model, failure)",
    "  p / c        pause / continue scheduling",
    "  q / Ctrl-C   graceful quit (stops scheduling, checkpoints)",
    "  PgUp/PgDn    scroll activity or fixture detail",
    "  Home/End     jump to oldest / newest",
    "  Tab          switch pane focus",
    "  ? / Esc      toggle this help",
  ];
}
