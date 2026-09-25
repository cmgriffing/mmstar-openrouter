/**
 * Recovery lineage resolution.
 *
 * A primary run can have many recovery children, and recovery children can
 * themselves be recovered. Resolving "what is the outcome for fixture X" means
 * walking that tree in creation order and taking the newest terminal record,
 * while never letting a later failure overwrite an already-scored response.
 *
 * The exported helpers are the single place `resume`, `retry-failed`, and
 * `restart` decide which fixtures still need work, so the CLI commands cannot
 * drift apart.
 */
import type {
  EvaluationRecord,
  FailureCategory,
  OutcomeKind,
  OutcomeRecord,
  RunManifest,
} from "./records";
import { compareCreation, outcomeIdentity, type RunStore } from "./run-store";

export interface LineageEntry {
  runId: string;
  runKind: RunManifest["lineage"]["kind"];
  evaluationId: string;
  fixtureId: string;
  state: OutcomeRecord["state"];
  kind: OutcomeKind | null;
  failure: FailureCategory | null;
  updatedAt: string;
}

export interface LineageView {
  root: RunManifest;
  /** Every run considered, including the root, sorted by creation order. */
  runs: RunManifest[];
  /** Effective outcome per `evaluationId::fixtureId`, resolved across the lineage. */
  effective: Map<string, LineageEntry>;
}

/**
 * Failure categories that represent unresolved transport/request problems:
 * these are what `retry-failed` reissues. Auth/configuration are not retried
 * because the operator must fix credentials/routing first, and scored outcomes
 * are never retried at all.
 */
export const RETRYABLE_FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "timeout",
  "network",
  "rate_limit",
  "server_error",
  "invalid_request",
  "unknown",
];

/**
 * Failure categories that prove the provider completed the exchange — the
 * request reached upstream and produced a definitive answer (rejection,
 * throttle, or policy refusal). Timeout, network, cancelled, and unknown
 * failures leave upstream completion unknown, and a marker for one of those
 * must still be reported as indeterminate.
 */
const KNOWN_FAILURE_CATEGORIES: readonly FailureCategory[] = [
  "rate_limit",
  "server_error",
  "invalid_request",
  "content_filter",
  "auth",
  "configuration",
];

/**
 * True when a durable attempt failure proves the provider round-trip finished.
 * Used to keep a stale in-flight marker from reporting a known classified
 * failure as an unknown upstream completion.
 */
export function isKnownFailureCategory(category: FailureCategory): boolean {
  return KNOWN_FAILURE_CATEGORIES.includes(category);
}

/** Fixtures a plain `resume` may reissue: never attempted, cancelled, or interrupted. */
export function isResumeCandidate(outcome: OutcomeRecord): boolean {
  return (
    outcome.state === "pending" ||
    outcome.state === "cancelled" ||
    (outcome.state === "indeterminate" && outcome.indeterminate)
  );
}

/** True when an outcome is a request failure that `retry-failed` is responsible for. */
export function isRetryableFailureOutcome(outcome: OutcomeRecord): boolean {
  if (outcome.state === "indeterminate") return true;
  if (outcome.state === "cancelled") return false;
  if (outcome.state !== "failed") return false;
  if (outcome.failure === null) return true;
  return RETRYABLE_FAILURE_CATEGORIES.includes(outcome.failure.category);
}

/** A terminal scored response resolves its fixture permanently. */
export function isResolvedEntry(entry: LineageEntry): boolean {
  return entry.state === "settled" && entry.kind !== null;
}

/** Load a run and every descendant linked by `lineage.parentRunId`. */
export function resolveLineage(store: RunStore, root: RunManifest): LineageView {
  const byId = new Map<string, RunManifest>();
  byId.set(root.runId, root);

  // Load every readable manifest once; corrupt runs are skipped here because
  // lineage resolution is a read-only convenience, and the commands that need
  // a specific run read it directly and fail loudly.
  for (const runId of store.listRunIds()) {
    if (byId.has(runId)) continue;
    try {
      byId.set(runId, store.readManifest(runId));
    } catch {}
  }

  const runs: RunManifest[] = [];
  const visit = (manifest: RunManifest, depth: number): void => {
    if (depth > 64) return;
    runs.push(manifest);
    for (const candidate of byId.values()) {
      if (candidate.lineage.parentRunId === manifest.runId) visit(candidate, depth + 1);
    }
  };
  visit(root, 0);
  runs.sort(compareCreation);

  const effective = new Map<string, LineageEntry>();
  for (const run of runs) {
    let evaluations: EvaluationRecord[];
    try {
      evaluations = store.readModelRecords(run.runId).flatMap((file) => file.evaluations);
    } catch {
      continue;
    }
    for (const evaluation of evaluations) {
      for (const outcome of evaluation.outcomes) {
        const key = outcomeIdentity(evaluation.evaluationId, outcome.fixtureId);
        const entry: LineageEntry = {
          runId: run.runId,
          runKind: run.lineage.kind,
          evaluationId: evaluation.evaluationId,
          fixtureId: outcome.fixtureId,
          state: outcome.state,
          kind: outcome.kind,
          failure: outcome.failure?.category ?? null,
          updatedAt: outcome.updatedAt,
        };
        const existing = effective.get(key);
        if (existing === undefined) {
          effective.set(key, entry);
          continue;
        }
        // A scored response is never replaced by a later failure; otherwise the
        // newest record in creation order wins.
        if (isResolvedEntry(existing) && !isResolvedEntry(entry)) continue;
        effective.set(key, entry);
      }
    }
  }

  return { root, runs, effective };
}

/** Find the effective record for one root-run outcome, if any descendant has one. */
export function effectiveEntryFor(
  view: LineageView,
  evaluationId: string,
  fixtureId: string,
): LineageEntry | undefined {
  return view.effective.get(outcomeIdentity(evaluationId, fixtureId));
}

/**
 * The effective outcome that resolves a fixture after recovery: either a scored
 * response or a newer terminal failure. Returns undefined when the fixture is
 * still pending/cancelled everywhere in the lineage.
 */
export function resolvedEntry(
  view: LineageView,
  evaluationId: string,
  fixtureId: string,
): LineageEntry | undefined {
  const entry = effectiveEntryFor(view, evaluationId, fixtureId);
  if (entry === undefined) return undefined;
  if (isResolvedEntry(entry)) return entry;
  if (entry.state === "failed") return entry;
  return undefined;
}
