/**
 * Metric aggregation for a run.
 *
 * Metrics are derived from durable records, not from renderer state: counts and
 * denominators come from outcomes, token/cost totals come from attempts (every
 * submitted request may be billed), and missing values stay null rather than
 * becoming zero. While a run is still executing the snapshot is provisional,
 * and denominators are always disclosed alongside accuracy.
 */
import type {
  AttemptRecord,
  EvaluationRecord,
  FailureCategory,
  OutcomeKind,
  OutcomeState,
  UsageRecord,
} from "@mmstar/results";
import { FAILURE_CATEGORIES, OUTCOME_KINDS, OUTCOME_STATES } from "@mmstar/results";

export interface MetricFixture {
  fixtureId: string;
  category: string;
}

export interface MetricsInput {
  evaluations: readonly EvaluationRecord[];
  fixtures: readonly MetricFixture[];
  /** True while work can still change the result. */
  provisional: boolean;
}

export interface OutcomeKindCount {
  kind: OutcomeKind;
  count: number;
}

export interface OutcomeStateCount {
  state: OutcomeState;
  count: number;
}

export interface FailureCategoryCount {
  category: FailureCategory;
  count: number;
}

export interface CategoryMetric {
  category: string;
  /** Selected fixture-evaluation pairs in this category. */
  selected: number;
  settled: number;
  correct: number;
  /** settled / selected. */
  coverage: number;
  /** correct / selected; null when nothing is selected. */
  accuracy: number | null;
}

export interface LatencyDistribution {
  count: number;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface TokenTotals {
  /** Sum of known values, or null when no attempt reported the field. */
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  /** Attempts that reported no usage object at all. */
  usageUnknownCount: number;
}

export interface CostTotals {
  /** Sum of provider-reported attempt costs, or null when none were reported. */
  reportedUsd: number | null;
  /** Sum of documented local estimates, or null when none exist yet. */
  estimatedUsd: number | null;
  /** reportedUsd + estimatedUsd, or null when no attempt cost is known. */
  knownUsd: number | null;
  /** Attempts whose cost is unavailable. */
  unknownCount: number;
}

export interface EngineMetrics {
  provisional: boolean;
  totalSelected: number;
  settledCount: number;
  coverage: number;
  correctCount: number;
  /** correct / totalSelected, the benchmark's headline accuracy denominator. */
  totalSelectedAccuracy: number | null;
  /** Outcomes with a parsed option compared to the key (correct + incorrect). */
  scoredResponseCount: number;
  scoredResponseAccuracy: number | null;
  stateCounts: OutcomeStateCount[];
  outcomeCounts: OutcomeKindCount[];
  failureCounts: FailureCategoryCount[];
  categoryMetrics: CategoryMetric[];
  tokens: TokenTotals;
  costs: CostTotals;
  requestLatency: LatencyDistribution;
  fixtureLatency: LatencyDistribution;
}

export function computeEngineMetrics(input: MetricsInput): EngineMetrics {
  const fixturesById = new Map(input.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const stateCounts = new Map<OutcomeState, number>(OUTCOME_STATES.map((state) => [state, 0]));
  const outcomeCounts = new Map<OutcomeKind, number>(OUTCOME_KINDS.map((kind) => [kind, 0]));
  const failureCounts = new Map<FailureCategory, number>(
    FAILURE_CATEGORIES.map((category) => [category, 0]),
  );
  const categoryTotals = new Map<string, { selected: number; settled: number; correct: number }>();
  const requestLatencies: number[] = [];
  const fixtureLatencies: number[] = [];
  const attempts: AttemptRecord[] = [];

  let totalSelected = 0;
  let settledCount = 0;
  let correctCount = 0;
  let scoredResponseCount = 0;

  for (const evaluation of input.evaluations) {
    attempts.push(...evaluation.attempts);
    for (const outcome of evaluation.outcomes) {
      totalSelected += 1;
      stateCounts.set(outcome.state, (stateCounts.get(outcome.state) ?? 0) + 1);
      if (outcome.kind !== null) {
        outcomeCounts.set(outcome.kind, (outcomeCounts.get(outcome.kind) ?? 0) + 1);
      }
      if (outcome.state === "settled") settledCount += 1;
      if (outcome.kind === "correct") correctCount += 1;
      if (outcome.kind === "correct" || outcome.kind === "incorrect") scoredResponseCount += 1;
      if (outcome.requestLatencyMs !== null) requestLatencies.push(outcome.requestLatencyMs);
      if (outcome.totalFixtureTimeMs !== null) fixtureLatencies.push(outcome.totalFixtureTimeMs);

      const category = fixturesById.get(outcome.fixtureId)?.category ?? "unknown";
      const totals = categoryTotals.get(category) ?? { selected: 0, settled: 0, correct: 0 };
      totals.selected += 1;
      if (outcome.state === "settled") totals.settled += 1;
      if (outcome.kind === "correct") totals.correct += 1;
      categoryTotals.set(category, totals);
    }
  }

  for (const attempt of attempts) {
    if (attempt.failure !== null) {
      const category = attempt.failure.category;
      failureCounts.set(category, (failureCounts.get(category) ?? 0) + 1);
    }
  }

  const categoryMetrics: CategoryMetric[] = [...categoryTotals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([category, totals]) => ({
      category,
      selected: totals.selected,
      settled: totals.settled,
      correct: totals.correct,
      coverage: ratio(totals.settled, totals.selected),
      accuracy: totals.selected === 0 ? null : totals.correct / totals.selected,
    }));

  return {
    provisional: input.provisional,
    totalSelected,
    settledCount,
    coverage: ratio(settledCount, totalSelected),
    correctCount,
    totalSelectedAccuracy: totalSelected === 0 ? null : correctCount / totalSelected,
    scoredResponseCount,
    scoredResponseAccuracy: scoredResponseCount === 0 ? null : correctCount / scoredResponseCount,
    stateCounts: OUTCOME_STATES.map((state) => ({ state, count: stateCounts.get(state) ?? 0 })),
    outcomeCounts: OUTCOME_KINDS.map((kind) => ({ kind, count: outcomeCounts.get(kind) ?? 0 })),
    failureCounts: FAILURE_CATEGORIES.map((category) => ({
      category,
      count: failureCounts.get(category) ?? 0,
    })).filter((entry) => entry.count > 0),
    categoryMetrics,
    tokens: sumTokens(attempts),
    costs: sumCosts(attempts),
    requestLatency: distribution(requestLatencies),
    fixtureLatency: distribution(fixtureLatencies),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function sumTokens(attempts: readonly AttemptRecord[]): TokenTotals {
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalTokens: number | null = null;
  let reasoningTokens: number | null = null;
  let usageUnknownCount = 0;

  for (const attempt of attempts) {
    const usage: UsageRecord | null = attempt.usage;
    if (usage === null) {
      usageUnknownCount += 1;
      continue;
    }
    promptTokens = add(promptTokens, usage.promptTokens);
    completionTokens = add(completionTokens, usage.completionTokens);
    totalTokens = add(totalTokens, usage.totalTokens);
    reasoningTokens = add(reasoningTokens, usage.reasoningTokens);
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    reasoningTokens,
    usageUnknownCount,
  };
}

function sumCosts(attempts: readonly AttemptRecord[]): CostTotals {
  let reportedUsd: number | null = null;
  let estimatedUsd: number | null = null;
  let knownUsd: number | null = null;
  let unknownCount = 0;

  for (const attempt of attempts) {
    const cost = attempt.cost;
    if (cost.kind === "reported" && cost.usd !== null) {
      reportedUsd = add(reportedUsd, cost.usd);
      knownUsd = add(knownUsd, cost.usd);
    } else if (cost.kind === "estimated" && cost.usd !== null) {
      estimatedUsd = add(estimatedUsd, cost.usd);
      knownUsd = add(knownUsd, cost.usd);
    } else {
      unknownCount += 1;
    }
  }

  return { reportedUsd, estimatedUsd, knownUsd, unknownCount };
}

/** Sum with null meaning "no known value yet"; zero is a real value. */
function add(total: number | null, value: number | null): number | null {
  if (value === null) return total;
  return (total ?? 0) + value;
}

function distribution(values: readonly number[]): LatencyDistribution {
  if (values.length === 0) {
    return { count: 0, minMs: null, maxMs: null, meanMs: null, p50Ms: null, p95Ms: null };
  }
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    count: values.length,
    minMs: min,
    maxMs: max,
    meanMs: sum / values.length,
    p50Ms: percentileNearestRank(values, 50),
    p95Ms: percentileNearestRank(values, 95),
  };
}

/** Nearest-rank percentile: sorted[index] with index = ceil(p/100 * n) - 1. */
export function percentileNearestRank(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index] ?? null;
}
