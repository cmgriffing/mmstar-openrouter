/**
 * Fixture inspection assembly.
 *
 * The entry point converts an engine's durable records plus its prompt
 * metadata into the plain `FixtureDetailView` the renderer displays. Keeping
 * this conversion here (and not in React) means the pane stays testable and the
 * renderer never reads the engine.
 */
import type { BenchmarkEngine } from "@mmstar/benchmark";
import type { FixtureDetailView } from "./state";

export interface FixtureInspectionRequest {
  engine: BenchmarkEngine;
  modelAlias: string;
  evaluationId: string;
  fixtureId: string;
}

/** One fixture's recorded outcome and attempts, or null when not recorded yet. */
export function buildFixtureDetail(request: FixtureInspectionRequest): FixtureDetailView | null {
  const { engine, modelAlias, evaluationId, fixtureId } = request;
  const evaluation = engine.getRecords().find((entry) => entry.evaluationId === evaluationId);
  if (evaluation === undefined) return null;
  const outcome = evaluation.outcomes.find((entry) => entry.fixtureId === fixtureId);
  if (outcome === undefined) return null;
  const fixture = engine.getFixtureDetail(fixtureId);

  return {
    evaluationId,
    modelAlias,
    reasoningMode: evaluation.reasoningMode,
    fixtureId,
    category: fixture?.category ?? "unknown",
    question: fixture?.question ?? "(question not available)",
    state: outcome.state,
    kind: outcome.kind,
    parsedAnswer: outcome.parsedAnswer,
    expectedAnswer: outcome.expectedAnswer,
    responseText: outcome.responseText,
    indeterminate: outcome.indeterminate,
    failure: outcome.failure,
    lineage: outcome.lineage,
    retryAtMs: null,
    attempts: evaluation.attempts
      .filter((attempt) => attempt.fixtureId === fixtureId)
      .map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        state: attempt.state,
        failureCategory: attempt.failure?.category ?? null,
        requestLatencyMs: attempt.requestLatencyMs,
        usage: attempt.usage,
        cost: attempt.cost,
        modelUsed: attempt.modelUsed,
        upstreamProvider: attempt.upstreamProvider,
      })),
  };
}
