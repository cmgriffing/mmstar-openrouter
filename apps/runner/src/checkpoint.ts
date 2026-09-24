/**
 * Run persistence glue: engine snapshot -> durable files.
 *
 * The engine owns scheduling and in-memory records; this module owns the
 * translation into `manifest.json` + per-model files, the atomic checkpoint, and
 * the merge that preserves prior outcomes when only part of a run is reissued.
 */
import type {
  EvaluationRecord,
  ModelRecordFile,
  OutcomeRecord,
  RunManifest,
} from "@mmstar/results";
import { buildModelFiles, type RunStore } from "@mmstar/results/node";

export interface CheckpointSnapshot {
  manifest: RunManifest;
  evaluations: readonly EvaluationRecord[];
}

/** Build the per-model files for a full snapshot. */
export function modelFilesFor(
  manifest: RunManifest,
  evaluations: readonly EvaluationRecord[],
  updatedAt: string,
): ModelRecordFile[] {
  return buildModelFiles(manifest, evaluations, updatedAt);
}

/**
 * Merge a partial execution into the full plan. Every fixture in the frozen
 * plan keeps a slot: a reissued fixture takes its new outcome, and every other
 * fixture keeps the prior durable outcome verbatim. Without this a recovery
 * run's model files would contain only the recovered fixtures and silently drop
 * history.
 *
 * Attempts are the ones this execution actually made. Ancestor attempts stay in
 * the ancestor's model files: copying them into the child would double-count the
 * family billing ledger, and because attempt IDs are deterministic
 * (`evaluation:fixture:number`) the carried copy would also shadow the attempt
 * the child really made. Outcomes are still carried, because the child must be
 * able to count plan progress without reissuing resolved work.
 */
export function mergePlanEvaluations(
  manifest: RunManifest,
  previous: readonly EvaluationRecord[],
  work: readonly EvaluationRecord[],
): EvaluationRecord[] {
  const previousById = new Map(previous.map((evaluation) => [evaluation.evaluationId, evaluation]));
  const workById = new Map(work.map((evaluation) => [evaluation.evaluationId, evaluation]));

  return manifest.plan.evaluations.map((plan) => {
    const previousEvaluation = previousById.get(plan.evaluationId);
    const workEvaluation = workById.get(plan.evaluationId);
    const fixtureIds = planFixtureIds(
      manifest,
      plan.evaluationId,
      previousEvaluation,
      workEvaluation,
    );

    const outcomes: OutcomeRecord[] = fixtureIds.map((fixtureId) => {
      const reissued = workEvaluation?.outcomes.find((outcome) => outcome.fixtureId === fixtureId);
      if (reissued !== undefined) return reissued;
      const carried = previousEvaluation?.outcomes.find(
        (outcome) => outcome.fixtureId === fixtureId,
      );
      if (carried !== undefined) return carried;
      return emptyPendingOutcome(plan.evaluationId, fixtureId);
    });

    const attempts = [...(workEvaluation?.attempts ?? [])];

    return {
      evaluationId: plan.evaluationId,
      reasoningMode: plan.reasoningMode,
      provider: plan.provider,
      rateLimitGroup: plan.rateLimitGroup,
      outcomes,
      attempts,
    };
  });
}

function planFixtureIds(
  manifest: RunManifest,
  evaluationId: string,
  previous: EvaluationRecord | undefined,
  work: EvaluationRecord | undefined,
): string[] {
  const fromPlan = manifest.plan.dataset.fixtureIds;
  if (fromPlan.length > 0) return [...fromPlan];
  const seen: string[] = [];
  for (const evaluation of [previous, work]) {
    for (const outcome of evaluation?.outcomes ?? []) {
      if (!seen.includes(outcome.fixtureId)) seen.push(outcome.fixtureId);
    }
  }
  void evaluationId;
  return seen;
}

function emptyPendingOutcome(evaluationId: string, fixtureId: string): OutcomeRecord {
  return {
    fixtureId,
    evaluationId,
    state: "pending",
    kind: null,
    responseText: null,
    parsedAnswer: null,
    expectedAnswer: "",
    usage: null,
    cost: { kind: "unknown", usd: null },
    requestLatencyMs: null,
    totalFixtureTimeMs: null,
    attemptCount: 0,
    indeterminate: false,
    failure: null,
    lineage: { sourceRunId: null, sourceOutcomeId: null },
    updatedAt: new Date(0).toISOString(),
  };
}

/**
 * Write a checkpoint. Model files are written before the manifest so a crash
 * between them leaves newer model files under the older manifest; reconciliation
 * reads the model files and never trusts the manifest alone for outcomes.
 */
export function writeSnapshot(store: RunStore, snapshot: CheckpointSnapshot): void {
  const files = buildModelFiles(
    snapshot.manifest,
    snapshot.evaluations,
    snapshot.manifest.updatedAt,
  );
  store.writeCheckpoint({ manifest: snapshot.manifest, files });
}
