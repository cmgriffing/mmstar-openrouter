/**
 * Pure projection from durable run records into publication rows.
 *
 * This module owns the public whitelist: it decides which fields leave the local
 * JSON (for example, responses are bounded and `rawResponseRef` never leaves),
 * flattens nullable usage/cost/failure records, and computes the per-run content
 * fingerprint used for idempotent import and conflict detection.
 *
 * Row shapes are snake_case because they map 1:1 onto SQLite columns; the
 * runtime-neutral schema in `schema.ts` is their only consumer.
 */
import { sha256Hex } from "@mmstar/config";
import { PublicationValidationError } from "../errors";
import type {
  AttemptRecord,
  CostRecord,
  EvaluationRecord,
  FailureRecord,
  OutcomeRecord,
  RunKind,
  RunManifest,
  RunState,
  UsageRecord,
} from "../records";
import { PUBLICATION_RESPONSE_LIMIT_CHARS } from "./schema";

/** Fixture input carrying original base64 bytes, used by the image extractor. */
export interface PublicationFixtureInput {
  fixtureId: string;
  question: string;
  answer: string;
  category: string;
  l2Category: string;
  bench: string;
  image: {
    mediaType: string;
    base64: string;
  };
}

/** One written, validated image asset keyed by fixture. */
export interface PublicationImageAsset {
  fixtureId: string;
  sha256: string;
  /** Path relative to the publication root, e.g. `benchmark-images/<hash>.jpg`. */
  relativePath: string;
  mediaType: string;
  byteLength: number;
}

export interface PublicationRunRow {
  run_id: string;
  root_run_id: string;
  run_kind: RunKind;
  parent_run_id: string | null;
  created_at: string;
  updated_at: string;
  lifecycle_state: RunState;
  set_name: string;
  dataset_path: string;
  dataset_sha256: string;
  fixture_count: number;
  prompt_version: number;
  scorer_version: number;
  config_sha256: string | null;
  code_revision: string | null;
  code_dirty: number;
  recovered_fixture_count: number;
  content_sha256: string;
}

export interface PublicationRecoveredFixtureRow {
  run_id: string;
  fixture_id: string;
}

export interface PublicationEvaluationRow {
  evaluation_id: string;
  model_alias: string;
  open_router_id: string;
  reasoning_mode: string;
  rate_limit_group: string;
  provider_json: string | null;
}

export interface PublicationFixtureRow {
  fixture_id: string;
  question: string;
  answer: string;
  category: string;
  l2_category: string;
  bench: string;
  image_sha256: string;
  image_path: string;
  image_media_type: string;
  image_byte_length: number;
}

export interface PublicationOutcomeRow {
  run_id: string;
  evaluation_id: string;
  fixture_id: string;
  state: OutcomeRecord["state"];
  kind: OutcomeRecord["kind"];
  response_text: string | null;
  response_truncated: number;
  parsed_answer: string | null;
  usage_known: number;
  usage_prompt_tokens: number | null;
  usage_completion_tokens: number | null;
  usage_total_tokens: number | null;
  usage_reasoning_tokens: number | null;
  cost_kind: CostRecord["kind"];
  cost_usd: number | null;
  request_latency_ms: number | null;
  total_fixture_time_ms: number | null;
  attempt_count: number;
  indeterminate: number;
  failure_category: FailureRecord["category"] | null;
  failure_message: string | null;
  failure_http_status: number | null;
  failure_retry_after_ms: number | null;
  lineage_source_run_id: string | null;
  lineage_source_outcome_id: string | null;
  updated_at: string;
}

export interface PublicationAttemptRow {
  run_id: string;
  attempt_id: string;
  evaluation_id: string;
  fixture_id: string;
  attempt_number: number;
  state: AttemptRecord["state"];
  started_at: string;
  submitted_at: string | null;
  finished_at: string | null;
  requested_model: string;
  model_used: string | null;
  upstream_provider: string | null;
  finish_reason: string | null;
  request_latency_ms: number | null;
  usage_known: number;
  usage_prompt_tokens: number | null;
  usage_completion_tokens: number | null;
  usage_total_tokens: number | null;
  usage_reasoning_tokens: number | null;
  cost_kind: CostRecord["kind"];
  cost_usd: number | null;
  failure_category: FailureRecord["category"] | null;
  failure_message: string | null;
  failure_http_status: number | null;
  failure_retry_after_ms: number | null;
}

export interface PublicationRows {
  runs: PublicationRunRow[];
  recoveredFixtures: PublicationRecoveredFixtureRow[];
  evaluations: PublicationEvaluationRow[];
  fixtures: PublicationFixtureRow[];
  outcomes: PublicationOutcomeRow[];
  attempts: PublicationAttemptRow[];
}

export interface PublicationRunProjection {
  manifest: RunManifest;
  evaluations: readonly EvaluationRecord[];
  /** SHA-256 over the run's manifest and model-record bytes. */
  sourceSha256: string;
}

export interface BuildPublicationRowsInput {
  runs: readonly PublicationRunProjection[];
  fixtures: readonly PublicationFixtureRow[];
}

/**
 * Bound a response for the public projection. Returns null for null input; the
 * truncation flag is separate so a response that happens to end in the limit is
 * never mislabeled.
 */
export function boundResponseText(text: string | null): {
  text: string | null;
  truncated: boolean;
} {
  if (text === null) return { text: null, truncated: false };
  if (text.length <= PUBLICATION_RESPONSE_LIMIT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, PUBLICATION_RESPONSE_LIMIT_CHARS), truncated: true };
}

/** Build the fixture table from dataset records plus written image assets. */
export function buildFixtureRows(
  fixtures: readonly PublicationFixtureInput[],
  assets: ReadonlyMap<string, PublicationImageAsset>,
): PublicationFixtureRow[] {
  const rows: PublicationFixtureRow[] = [];
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    if (seen.has(fixture.fixtureId)) {
      throw new PublicationValidationError(`fixture ${fixture.fixtureId} appears more than once`);
    }
    seen.add(fixture.fixtureId);
    const asset = assets.get(fixture.fixtureId);
    if (asset === undefined) {
      throw new PublicationValidationError(
        `fixture ${fixture.fixtureId} has no published image asset`,
      );
    }
    rows.push({
      fixture_id: fixture.fixtureId,
      question: fixture.question,
      answer: fixture.answer,
      category: fixture.category,
      l2_category: fixture.l2Category,
      bench: fixture.bench,
      image_sha256: asset.sha256,
      image_path: asset.relativePath,
      image_media_type: asset.mediaType,
      image_byte_length: asset.byteLength,
    });
  }
  rows.sort((a, b) => compareFixtureIds(a.fixture_id, b.fixture_id));
  return rows;
}

/**
 * Build every publication row, validate plan/record consistency, and compute the
 * deterministic per-run fingerprint. Rows come out in plan order so an import is
 * reproducible for identical input.
 */
export async function buildPublicationRows(
  input: BuildPublicationRowsInput,
): Promise<PublicationRows> {
  const rows: PublicationRows = {
    runs: [],
    recoveredFixtures: [],
    evaluations: [],
    fixtures: [...input.fixtures].sort((a, b) => compareFixtureIds(a.fixture_id, b.fixture_id)),
    outcomes: [],
    attempts: [],
  };

  const projectedRuns = [...input.runs].sort((a, b) => compareProjectedRuns(a, b));
  for (const projected of projectedRuns) {
    const { manifest, evaluations } = projected;
    const evaluationOrder = new Map(
      manifest.plan.evaluations.map((evaluation, index) => [evaluation.evaluationId, index]),
    );
    const fixtureOrder = new Map(
      manifest.plan.dataset.fixtureIds.map((fixtureId, index) => [fixtureId, index]),
    );
    const fixtureSet = new Set(manifest.plan.dataset.fixtureIds);

    const runEvaluations: PublicationEvaluationRow[] = manifest.plan.evaluations.map(
      (evaluation) => ({
        evaluation_id: evaluation.evaluationId,
        model_alias: evaluation.modelAlias,
        open_router_id: evaluation.openRouterId,
        reasoning_mode: evaluation.reasoningMode,
        rate_limit_group: evaluation.rateLimitGroup,
        provider_json: evaluation.provider === null ? null : canonicalJson(evaluation.provider),
      }),
    );

    const runOutcomes: PublicationOutcomeRow[] = [];
    const runAttempts: PublicationAttemptRow[] = [];
    for (const record of evaluations) {
      if (!evaluationOrder.has(record.evaluationId)) {
        throw new PublicationValidationError(
          `run ${manifest.runId} has outcomes for evaluation ${record.evaluationId}, which is not in the frozen plan`,
        );
      }
      for (const outcome of record.outcomes) {
        if (!fixtureSet.has(outcome.fixtureId)) {
          throw new PublicationValidationError(
            `run ${manifest.runId} has an outcome for fixture ${outcome.fixtureId}, which is not in the frozen plan`,
          );
        }
        runOutcomes.push(outcomeRow(manifest.runId, record.evaluationId, outcome));
      }
      for (const attempt of record.attempts) {
        if (!fixtureSet.has(attempt.fixtureId)) {
          throw new PublicationValidationError(
            `run ${manifest.runId} has an attempt for fixture ${attempt.fixtureId}, which is not in the frozen plan`,
          );
        }
        runAttempts.push(attemptRow(manifest.runId, record.evaluationId, attempt));
      }
    }

    runOutcomes.sort(
      (a, b) =>
        compareOrders(evaluationOrder.get(a.evaluation_id), evaluationOrder.get(b.evaluation_id)) ||
        compareOrders(fixtureOrder.get(a.fixture_id), fixtureOrder.get(b.fixture_id)) ||
        compareStrings(a.fixture_id, b.fixture_id),
    );
    runAttempts.sort(
      (a, b) =>
        compareOrders(evaluationOrder.get(a.evaluation_id), evaluationOrder.get(b.evaluation_id)) ||
        compareOrders(fixtureOrder.get(a.fixture_id), fixtureOrder.get(b.fixture_id)) ||
        a.attempt_number - b.attempt_number ||
        compareStrings(a.attempt_id, b.attempt_id),
    );

    const recoveredFixtureIds = uniqueSorted(
      manifest.lineage.recoveredFixtureIds ?? [],
      fixtureOrder,
    );
    const recoveredFixtures = recoveredFixtureIds.map((fixtureId) => ({
      run_id: manifest.runId,
      fixture_id: fixtureId,
    }));

    const runRow: PublicationRunRow = {
      run_id: manifest.runId,
      root_run_id: manifest.runId,
      run_kind: manifest.lineage.kind,
      parent_run_id: manifest.lineage.parentRunId,
      created_at: manifest.createdAt,
      updated_at: manifest.updatedAt,
      lifecycle_state: manifest.lifecycle.state,
      set_name: manifest.plan.setName,
      dataset_path: manifest.plan.dataset.path,
      dataset_sha256: manifest.plan.dataset.sha256,
      fixture_count: manifest.plan.dataset.fixtureCount,
      prompt_version: manifest.plan.promptVersion,
      scorer_version: manifest.plan.scorerVersion,
      config_sha256: manifest.configuration.sha256,
      code_revision: manifest.code.revision,
      code_dirty: manifest.code.dirty ? 1 : 0,
      recovered_fixture_count: recoveredFixtures.length,
      content_sha256: "",
    };

    runRow.content_sha256 = await sha256Hex(
      canonicalJson({
        run: { ...runRow, content_sha256: undefined, root_run_id: undefined },
        source_sha256: projected.sourceSha256,
        evaluations: runEvaluations,
        recovered_fixtures: recoveredFixtures,
        outcomes: runOutcomes,
        attempts: runAttempts,
      }),
    );

    rows.runs.push(runRow);
    rows.recoveredFixtures.push(...recoveredFixtures);
    rows.evaluations.push(...runEvaluations);
    rows.outcomes.push(...runOutcomes);
    rows.attempts.push(...runAttempts);
  }

  return rows;
}

function outcomeRow(
  runId: string,
  evaluationId: string,
  outcome: OutcomeRecord,
): PublicationOutcomeRow {
  const response = boundResponseText(outcome.responseText);
  const usage = outcome.usage;
  return {
    run_id: runId,
    evaluation_id: evaluationId,
    fixture_id: outcome.fixtureId,
    state: outcome.state,
    kind: outcome.kind,
    response_text: response.text,
    response_truncated: response.truncated ? 1 : 0,
    parsed_answer: outcome.parsedAnswer,
    usage_known: usage === null ? 0 : 1,
    usage_prompt_tokens: usage?.promptTokens ?? null,
    usage_completion_tokens: usage?.completionTokens ?? null,
    usage_total_tokens: usage?.totalTokens ?? null,
    usage_reasoning_tokens: usage?.reasoningTokens ?? null,
    cost_kind: outcome.cost.kind,
    cost_usd: outcome.cost.usd,
    request_latency_ms: outcome.requestLatencyMs,
    total_fixture_time_ms: outcome.totalFixtureTimeMs,
    attempt_count: outcome.attemptCount,
    indeterminate: outcome.indeterminate ? 1 : 0,
    failure_category: outcome.failure?.category ?? null,
    failure_message: outcome.failure?.message ?? null,
    failure_http_status: outcome.failure?.httpStatus ?? null,
    failure_retry_after_ms: outcome.failure?.retryAfterMs ?? null,
    lineage_source_run_id: outcome.lineage.sourceRunId,
    lineage_source_outcome_id: outcome.lineage.sourceOutcomeId,
    updated_at: outcome.updatedAt,
  };
}

function attemptRow(
  runId: string,
  evaluationId: string,
  attempt: AttemptRecord,
): PublicationAttemptRow {
  const usage: UsageRecord | null = attempt.usage;
  return {
    run_id: runId,
    attempt_id: attempt.attemptId,
    evaluation_id: evaluationId,
    fixture_id: attempt.fixtureId,
    attempt_number: attempt.attemptNumber,
    state: attempt.state,
    started_at: attempt.startedAt,
    submitted_at: attempt.submittedAt,
    finished_at: attempt.finishedAt,
    requested_model: attempt.requestedModel,
    model_used: attempt.modelUsed,
    upstream_provider: attempt.upstreamProvider,
    finish_reason: attempt.finishReason,
    request_latency_ms: attempt.requestLatencyMs,
    usage_known: usage === null ? 0 : 1,
    usage_prompt_tokens: usage?.promptTokens ?? null,
    usage_completion_tokens: usage?.completionTokens ?? null,
    usage_total_tokens: usage?.totalTokens ?? null,
    usage_reasoning_tokens: usage?.reasoningTokens ?? null,
    cost_kind: attempt.cost.kind,
    cost_usd: attempt.cost.usd,
    failure_category: attempt.failure?.category ?? null,
    failure_message: attempt.failure?.message ?? null,
    failure_http_status: attempt.failure?.httpStatus ?? null,
    failure_retry_after_ms: attempt.failure?.retryAfterMs ?? null,
  };
}

/**
 * Canonical JSON with recursively sorted object keys. Used for fingerprints and
 * provider routing, so re-importing the same logical input always hashes the
 * same regardless of property insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortValue(entry)]));
  }
  return value;
}

function compareProjectedRuns(a: PublicationRunProjection, b: PublicationRunProjection): number {
  const at = Date.parse(a.manifest.createdAt);
  const bt = Date.parse(b.manifest.createdAt);
  if (at !== bt) return at < bt ? -1 : 1;
  return compareStrings(a.manifest.runId, b.manifest.runId);
}

function compareFixtureIds(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
  return compareStrings(a, b);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareOrders(a: number | undefined, b: number | undefined): number {
  const av = a ?? Number.MAX_SAFE_INTEGER;
  const bv = b ?? Number.MAX_SAFE_INTEGER;
  return av - bv;
}

function uniqueSorted(values: readonly string[], order: ReadonlyMap<string, number>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  unique.sort((a, b) => compareOrders(order.get(a), order.get(b)) || compareStrings(a, b));
  return unique;
}
