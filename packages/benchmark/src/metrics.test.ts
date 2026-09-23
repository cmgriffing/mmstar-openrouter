import type { AttemptRecord, EvaluationRecord, OutcomeRecord, UsageRecord } from "@mmstar/results";
import { describe, expect, it } from "vitest";
import { computeEngineMetrics, percentileNearestRank } from "./metrics";

const usage: UsageRecord = {
  promptTokens: 10,
  completionTokens: 1,
  totalTokens: 11,
  reasoningTokens: null,
};

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attemptId: "a::default:0:1",
    evaluationId: "a::default",
    fixtureId: "0",
    attemptNumber: 1,
    state: "completed",
    startedAt: "2026-09-23T00:00:00.000Z",
    submittedAt: "2026-09-23T00:00:00.000Z",
    finishedAt: "2026-09-23T00:00:00.100Z",
    requestedModel: "vendor/a",
    modelUsed: "vendor/a",
    upstreamProvider: "provider-a",
    finishReason: "stop",
    requestLatencyMs: 100,
    usage,
    cost: { kind: "reported", usd: 0.01 },
    failure: null,
    rawResponseRef: null,
    ...overrides,
  };
}

function outcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    fixtureId: "0",
    evaluationId: "a::default",
    state: "settled",
    kind: "correct",
    responseText: "A",
    parsedAnswer: "A",
    expectedAnswer: "A",
    usage,
    cost: { kind: "reported", usd: 0.01 },
    requestLatencyMs: 100,
    totalFixtureTimeMs: 120,
    attemptCount: 1,
    indeterminate: false,
    failure: null,
    lineage: { sourceRunId: null, sourceOutcomeId: null },
    updatedAt: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

function evaluation(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    evaluationId: "a::default",
    reasoningMode: "default",
    provider: null,
    rateLimitGroup: "g1",
    outcomes: [],
    attempts: [],
    ...overrides,
  };
}

const fixtures = [
  { fixtureId: "0", category: "math" },
  { fixtureId: "1", category: "science" },
];

describe("percentileNearestRank", () => {
  it("returns nearest-rank percentiles for sorted and unsorted input", () => {
    const values = [50, 10, 30, 20, 40];
    expect(percentileNearestRank(values, 50)).toBe(30);
    expect(percentileNearestRank(values, 95)).toBe(50);
    expect(percentileNearestRank([7], 95)).toBe(7);
    expect(percentileNearestRank([], 50)).toBeNull();
  });
});

describe("computeEngineMetrics", () => {
  const evaluations: EvaluationRecord[] = [
    evaluation({
      outcomes: [
        outcome({ fixtureId: "0", kind: "correct" }),
        outcome({
          fixtureId: "1",
          state: "failed",
          kind: null,
          responseText: null,
          parsedAnswer: null,
          usage: null,
          cost: { kind: "unknown", usd: null },
          requestLatencyMs: null,
          totalFixtureTimeMs: null,
          failure: {
            category: "network",
            message: "down",
            httpStatus: null,
            retryAfterMs: null,
          },
        }),
      ],
      attempts: [
        attempt(),
        attempt({
          attemptId: "a::default:1:1",
          fixtureId: "1",
          state: "failed",
          finishReason: null,
          requestLatencyMs: null,
          usage: null,
          cost: { kind: "unknown", usd: null },
          failure: {
            category: "network",
            message: "down",
            httpStatus: null,
            retryAfterMs: null,
          },
        }),
      ],
    }),
    evaluation({
      evaluationId: "b::default",
      outcomes: [
        outcome({
          evaluationId: "b::default",
          fixtureId: "0",
          state: "pending",
          kind: null,
          responseText: null,
          parsedAnswer: null,
          usage: null,
          cost: { kind: "unknown", usd: null },
          requestLatencyMs: null,
          totalFixtureTimeMs: null,
          attemptCount: 0,
        }),
        outcome({
          evaluationId: "b::default",
          fixtureId: "1",
          state: "indeterminate",
          kind: null,
          responseText: null,
          parsedAnswer: null,
          usage: null,
          cost: { kind: "unknown", usd: null },
          requestLatencyMs: null,
          totalFixtureTimeMs: null,
          indeterminate: true,
          failure: {
            category: "timeout",
            message: "timed out",
            httpStatus: null,
            retryAfterMs: null,
          },
        }),
      ],
      attempts: [
        attempt({
          attemptId: "b::default:1:1",
          evaluationId: "b::default",
          fixtureId: "1",
          state: "indeterminate",
          finishReason: null,
          requestLatencyMs: null,
          usage: null,
          cost: { kind: "unknown", usd: null },
          failure: {
            category: "timeout",
            message: "timed out",
            httpStatus: null,
            retryAfterMs: null,
          },
        }),
      ],
    }),
  ];

  it("discloses denominators, coverage, and unknown-versus-zero values", () => {
    const metrics = computeEngineMetrics({
      evaluations,
      fixtures,
      provisional: true,
    });

    expect(metrics.provisional).toBe(true);
    expect(metrics.totalSelected).toBe(4);
    expect(metrics.settledCount).toBe(1);
    expect(metrics.coverage).toBe(0.25);
    expect(metrics.correctCount).toBe(1);
    expect(metrics.totalSelectedAccuracy).toBe(0.25);
    expect(metrics.scoredResponseCount).toBe(1);
    expect(metrics.scoredResponseAccuracy).toBe(1);
    expect(metrics.stateCounts).toEqual([
      { state: "pending", count: 1 },
      { state: "settled", count: 1 },
      { state: "failed", count: 1 },
      { state: "indeterminate", count: 1 },
      { state: "cancelled", count: 0 },
    ]);
    expect(metrics.outcomeCounts.find((entry) => entry.kind === "correct")?.count).toBe(1);
    expect(metrics.failureCounts).toEqual([
      { category: "timeout", count: 1 },
      { category: "network", count: 1 },
    ]);
  });

  it("keeps category denominators and accuracy explicit", () => {
    const metrics = computeEngineMetrics({ evaluations, fixtures, provisional: false });
    expect(metrics.categoryMetrics).toEqual([
      { category: "math", selected: 2, settled: 1, correct: 1, coverage: 0.5, accuracy: 0.5 },
      {
        category: "science",
        selected: 2,
        settled: 0,
        correct: 0,
        coverage: 0,
        accuracy: 0,
      },
    ]);
  });

  it("sums known attempts and counts unavailable cost and usage", () => {
    const metrics = computeEngineMetrics({ evaluations, fixtures, provisional: false });
    expect(metrics.costs).toEqual({
      reportedUsd: 0.01,
      estimatedUsd: null,
      knownUsd: 0.01,
      unknownCount: 2,
    });
    expect(metrics.tokens).toEqual({
      promptTokens: 10,
      completionTokens: 1,
      totalTokens: 11,
      reasoningTokens: null,
      usageUnknownCount: 2,
    });
  });

  it("reports latency distributions without inventing values for missing timings", () => {
    const metrics = computeEngineMetrics({ evaluations, fixtures, provisional: false });
    expect(metrics.requestLatency).toEqual({
      count: 1,
      minMs: 100,
      maxMs: 100,
      meanMs: 100,
      p50Ms: 100,
      p95Ms: 100,
    });
    expect(metrics.fixtureLatency).toEqual({
      count: 1,
      minMs: 120,
      maxMs: 120,
      meanMs: 120,
      p50Ms: 120,
      p95Ms: 120,
    });
  });

  it("returns null accuracy when no fixture was selected", () => {
    const metrics = computeEngineMetrics({ evaluations: [], fixtures: [], provisional: true });
    expect(metrics.totalSelected).toBe(0);
    expect(metrics.coverage).toBe(0);
    expect(metrics.totalSelectedAccuracy).toBeNull();
    expect(metrics.scoredResponseAccuracy).toBeNull();
  });
});
