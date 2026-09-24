/**
 * Read-only publication query contracts.
 *
 * The website never composes SQL from request input: this repository exposes a
 * small fixed set of parameterized statements over the versioned views in
 * `publication/schema.ts`, clamps every page size, and validates every filter
 * against the known unions. It depends only on the runtime-neutral
 * `SqliteDatabase` seam, so the same code runs on `node:sqlite` locally and on
 * a WASM reader in the deployed site.
 *
 * Effective-outcome semantics (one winner per family/evaluation/fixture,
 * recovery never double-counts) come from the views; comparisons add the
 * attempt ledger across the whole family so published costs are auditable.
 */
import { QueryValidationError } from "../errors";
import type { SqliteDatabase, SqlRow, SqlValue } from "../publication/driver";
import type { CostKind, OutcomeKind, OutcomeState, RunKind, RunState } from "../records";
import { COST_KINDS, OUTCOME_KINDS, OUTCOME_STATES, RUN_KINDS, RUN_STATES } from "../records";

export const QUERY_LIMIT_DEFAULT = 50;
export const QUERY_LIMIT_MAX = 200;
export const QUERY_ATTEMPT_LIMIT_MAX = 200;
const MAX_ID_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 100;

export interface PublicationMeta {
  schemaVersion: number | null;
  exporterVersion: number | null;
  createdAt: string | null;
}

export interface RunSummary {
  runId: string;
  rootRunId: string;
  runKind: RunKind;
  parentRunId: string | null;
  createdAt: string;
  updatedAt: string;
  lifecycleState: RunState;
  setName: string;
  fixtureCount: number;
  recoveredFixtureCount: number;
  promptVersion: number;
  scorerVersion: number;
  datasetSha256: string;
  codeDirty: boolean;
  isRoot: boolean;
}

export interface EvaluationComparison {
  rootRunId: string;
  evaluationId: string;
  modelAlias: string;
  openRouterId: string;
  reasoningMode: string;
  rateLimitGroup: string;
  selected: number;
  settled: number;
  correct: number;
  incorrect: number;
  ambiguous: number;
  invalid: number;
  refused: number;
  truncated: number;
  pending: number;
  failed: number;
  indeterminate: number;
  cancelled: number;
  attempts: number;
  /** settled / selected, null when nothing was selected. */
  coverage: number | null;
  /** correct / settled, null when nothing settled. */
  scoredAccuracy: number | null;
  /** correct / selected, null when nothing was selected. */
  selectedAccuracy: number | null;
  meanRequestLatencyMs: number | null;
  meanTotalFixtureTimeMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  usageUnknownCount: number;
  reportedUsd: number | null;
  estimatedUsd: number | null;
  knownUsd: number | null;
  costUnknownCount: number;
}

export interface CategoryComparison {
  rootRunId: string;
  evaluationId: string;
  category: string;
  selected: number;
  settled: number;
  correct: number;
  accuracy: number | null;
}

export interface FixtureQuery {
  rootRunId: string;
  evaluationId?: string;
  category?: string;
  state?: OutcomeState;
  kind?: OutcomeKind;
  limit?: number;
  offset?: number;
}

export interface FixtureSummary {
  rootRunId: string;
  evaluationId: string;
  fixtureId: string;
  effectiveRunId: string;
  state: OutcomeState;
  kind: OutcomeKind | null;
  parsedAnswer: string | null;
  attemptCount: number;
  indeterminate: boolean;
  costKind: CostKind;
  costUsd: number | null;
  requestLatencyMs: number | null;
  totalFixtureTimeMs: number | null;
  question: string;
  category: string;
  l2Category: string;
  bench: string;
  imagePath: string;
  imageMediaType: string;
  imageSha256: string;
}

export interface FixturePage {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  rows: FixtureSummary[];
}

export interface OutcomeLine {
  runId: string;
  runCreatedAt: string;
  state: OutcomeState;
  kind: OutcomeKind | null;
  parsedAnswer: string | null;
  attemptCount: number;
  updatedAt: string;
  isEffective: boolean;
}

export interface AttemptLine {
  runId: string;
  attemptId: string;
  attemptNumber: number;
  state: string;
  startedAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
  requestedModel: string;
  modelUsed: string | null;
  upstreamProvider: string | null;
  finishReason: string | null;
  requestLatencyMs: number | null;
  usageKnown: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  costKind: CostKind;
  costUsd: number | null;
  failureCategory: string | null;
  failureMessage: string | null;
  failureHttpStatus: number | null;
  failureRetryAfterMs: number | null;
}

/** The effective outcome plus enough lineage to separate original from recovered. */
export interface FixtureDetail extends FixtureSummary {
  expectedAnswer: string;
  responseText: string | null;
  responseTruncated: boolean;
  usageKnown: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  lineageSourceRunId: string | null;
  lineageSourceOutcomeId: string | null;
  failureCategory: string | null;
  failureMessage: string | null;
  failureHttpStatus: number | null;
  failureRetryAfterMs: number | null;
  outcomes: OutcomeLine[];
  attempts: AttemptLine[];
}

export interface PublicationRepository {
  meta(): PublicationMeta;
  listRuns(rootRunId?: string): RunSummary[];
  listComparisons(rootRunId: string): EvaluationComparison[];
  listCategories(input: { rootRunId: string; evaluationId?: string }): CategoryComparison[];
  listFixtures(query: FixtureQuery): FixturePage;
  getFixtureDetail(input: {
    rootRunId: string;
    evaluationId: string;
    fixtureId: string;
  }): FixtureDetail | null;
}

/** Create a bounded, read-only repository over an already-opened database. */
export function createPublicationRepository(database: SqliteDatabase): PublicationRepository {
  const listRuns = (rootRunId?: string): RunSummary[] => {
    const filter = rootRunId === undefined ? "" : "WHERE runs.root_run_id = ?";
    const params = rootRunId === undefined ? [] : [requireId(rootRunId, "rootRunId")];
    const rows = query(
      database,
      `SELECT runs.* FROM runs ${filter} ORDER BY runs.created_at DESC, runs.run_id DESC`,
      params,
    );
    return rows.map(toRunSummary);
  };

  const listComparisons = (rootRunId: string): EvaluationComparison[] => {
    const root = requireId(rootRunId, "rootRunId");
    const rows = query(
      database,
      `SELECT
         summary.*,
         evaluations.model_alias,
         evaluations.open_router_id,
         evaluations.reasoning_mode,
         evaluations.rate_limit_group,
         totals.prompt_tokens AS family_prompt_tokens,
         totals.completion_tokens AS family_completion_tokens,
         totals.total_tokens AS family_total_tokens,
         totals.reasoning_tokens AS family_reasoning_tokens,
         totals.usage_unknown_count AS family_usage_unknown_count,
         totals.reported_usd AS family_reported_usd,
         totals.estimated_usd AS family_estimated_usd,
         totals.known_usd AS family_known_usd,
         totals.cost_unknown_count AS family_cost_unknown_count
       FROM v_evaluation_summary summary
       JOIN evaluations ON evaluations.evaluation_id = summary.evaluation_id
       LEFT JOIN (
         SELECT
           runs.root_run_id,
           attempt_totals.evaluation_id,
           SUM(attempt_totals.prompt_tokens) AS prompt_tokens,
           SUM(attempt_totals.completion_tokens) AS completion_tokens,
           SUM(attempt_totals.total_tokens) AS total_tokens,
           SUM(attempt_totals.reasoning_tokens) AS reasoning_tokens,
           SUM(attempt_totals.usage_unknown_count) AS usage_unknown_count,
           SUM(attempt_totals.reported_usd) AS reported_usd,
           SUM(attempt_totals.estimated_usd) AS estimated_usd,
           SUM(attempt_totals.known_usd) AS known_usd,
           SUM(attempt_totals.cost_unknown_count) AS cost_unknown_count
         FROM v_attempt_totals attempt_totals
         JOIN runs ON runs.run_id = attempt_totals.run_id
         GROUP BY runs.root_run_id, attempt_totals.evaluation_id
       ) totals
         ON totals.root_run_id = summary.root_run_id
        AND totals.evaluation_id = summary.evaluation_id
       WHERE summary.root_run_id = ?
       ORDER BY evaluations.model_alias, evaluations.reasoning_mode, summary.evaluation_id`,
      [root],
    );
    return rows.map(toEvaluationComparison);
  };

  const listCategories = (input: {
    rootRunId: string;
    evaluationId?: string;
  }): CategoryComparison[] => {
    const root = requireId(input.rootRunId, "rootRunId");
    const filters = ["summary.root_run_id = ?"];
    const params: SqlValue[] = [root];
    if (input.evaluationId !== undefined) {
      filters.push("summary.evaluation_id = ?");
      params.push(requireId(input.evaluationId, "evaluationId"));
    }
    const rows = query(
      database,
      `SELECT summary.*
       FROM v_category_summary summary
       WHERE ${filters.join(" AND ")}
       ORDER BY summary.evaluation_id, summary.category`,
      params,
    );
    return rows.map(toCategoryComparison);
  };

  const listFixtures = (input: FixtureQuery): FixturePage => {
    const root = requireId(input.rootRunId, "rootRunId");
    const limit = clampLimit(input.limit);
    const offset = clampOffset(input.offset);
    const filters = ["drilldown.root_run_id = ?"];
    const params: SqlValue[] = [root];
    if (input.evaluationId !== undefined) {
      filters.push("drilldown.evaluation_id = ?");
      params.push(requireId(input.evaluationId, "evaluationId"));
    }
    if (input.category !== undefined) {
      filters.push("drilldown.category = ?");
      params.push(requireText(input.category, "category", MAX_CATEGORY_LENGTH));
    }
    if (input.state !== undefined) {
      filters.push("drilldown.state = ?");
      params.push(requireEnum(input.state, OUTCOME_STATES, "state"));
    }
    if (input.kind !== undefined) {
      filters.push("drilldown.kind = ?");
      params.push(requireEnum(input.kind, OUTCOME_KINDS, "kind"));
    }
    const where = filters.join(" AND ");
    const totalRow = query(
      database,
      `SELECT COUNT(*) AS total FROM v_fixture_drilldown drilldown WHERE ${where}`,
      params,
    )[0];
    const total = readNumber(totalRow?.total ?? 0);
    const rows = query(
      database,
      `SELECT
         drilldown.root_run_id,
         drilldown.evaluation_id,
         drilldown.fixture_id,
         drilldown.effective_run_id,
         drilldown.state,
         drilldown.kind,
         drilldown.parsed_answer,
         drilldown.attempt_count,
         drilldown.indeterminate,
         drilldown.cost_kind,
         drilldown.cost_usd,
         drilldown.request_latency_ms,
         drilldown.total_fixture_time_ms,
         drilldown.question,
         drilldown.category,
         drilldown.l2_category,
         drilldown.bench,
         drilldown.image_path,
         drilldown.image_media_type,
         drilldown.image_sha256
       FROM v_fixture_drilldown drilldown
       WHERE ${where}
       ORDER BY drilldown.evaluation_id,
                CAST(drilldown.fixture_id AS INTEGER),
                drilldown.fixture_id
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return {
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      rows: rows.map(toFixtureSummary),
    };
  };

  const getFixtureDetail = (input: {
    rootRunId: string;
    evaluationId: string;
    fixtureId: string;
  }): FixtureDetail | null => {
    const root = requireId(input.rootRunId, "rootRunId");
    const evaluationId = requireId(input.evaluationId, "evaluationId");
    const fixtureId = requireId(input.fixtureId, "fixtureId");
    const outcomeRows = query(
      database,
      `SELECT drilldown.*
       FROM v_fixture_drilldown drilldown
       WHERE drilldown.root_run_id = ?
         AND drilldown.evaluation_id = ?
         AND drilldown.fixture_id = ?`,
      [root, evaluationId, fixtureId],
    );
    const row = outcomeRows[0];
    if (row === undefined) return null;
    const outcomes = query(
      database,
      `SELECT
         outcomes.run_id,
         runs.created_at AS run_created_at,
         outcomes.state,
         outcomes.kind,
         outcomes.parsed_answer,
         outcomes.attempt_count,
         outcomes.updated_at
       FROM outcomes
       JOIN runs ON runs.run_id = outcomes.run_id
       WHERE runs.root_run_id = ?
         AND outcomes.evaluation_id = ?
         AND outcomes.fixture_id = ?
       ORDER BY runs.created_at ASC, outcomes.run_id ASC
       LIMIT ?`,
      [root, evaluationId, fixtureId, QUERY_ATTEMPT_LIMIT_MAX],
    );
    const attempts = query(
      database,
      `SELECT
         attempts.*,
         runs.created_at AS run_created_at
       FROM attempts
       JOIN runs ON runs.run_id = attempts.run_id
       WHERE runs.root_run_id = ?
         AND attempts.evaluation_id = ?
         AND attempts.fixture_id = ?
       ORDER BY runs.created_at ASC,
                attempts.attempt_number ASC,
                attempts.attempt_id ASC
       LIMIT ?`,
      [root, evaluationId, fixtureId, QUERY_ATTEMPT_LIMIT_MAX],
    );
    const effectiveRunId = readString(row.effective_run_id);
    return {
      ...toFixtureSummary(row),
      expectedAnswer: readString(row.expected_answer),
      responseText: readNullableString(row.response_text),
      responseTruncated: readBoolean(row.response_truncated),
      usageKnown: readBoolean(row.usage_known),
      promptTokens: readNullableNumber(row.usage_prompt_tokens),
      completionTokens: readNullableNumber(row.usage_completion_tokens),
      totalTokens: readNullableNumber(row.usage_total_tokens),
      reasoningTokens: readNullableNumber(row.usage_reasoning_tokens),
      lineageSourceRunId: readNullableString(row.lineage_source_run_id),
      lineageSourceOutcomeId: readNullableString(row.lineage_source_outcome_id),
      failureCategory: readNullableString(row.failure_category),
      failureMessage: readNullableString(row.failure_message),
      failureHttpStatus: readNullableNumber(row.failure_http_status),
      failureRetryAfterMs: readNullableNumber(row.failure_retry_after_ms),
      outcomes: outcomes.map((outcome) => ({
        runId: readString(outcome.run_id),
        runCreatedAt: readString(outcome.run_created_at),
        state: readEnum(outcome.state, OUTCOME_STATES, "state"),
        kind: readNullableEnum(outcome.kind, OUTCOME_KINDS, "kind"),
        parsedAnswer: readNullableString(outcome.parsed_answer),
        attemptCount: readNumber(outcome.attempt_count),
        updatedAt: readString(outcome.updated_at),
        isEffective: readString(outcome.run_id) === effectiveRunId,
      })),
      attempts: attempts.map(toAttemptLine),
    };
  };

  return {
    meta: () => {
      const rows = query(database, "SELECT key, value FROM publication_meta", []);
      const values = new Map(rows.map((row) => [readString(row.key), row.value]));
      return {
        schemaVersion: readNumericText(values.get("schema_version")),
        exporterVersion: readNumericText(values.get("exporter_version")),
        createdAt: readMetaString(values.get("created_at")),
      };
    },
    listRuns,
    listComparisons,
    listCategories,
    listFixtures,
    getFixtureDetail,
  };
}

function query(database: SqliteDatabase, sql: string, params: readonly SqlValue[]): SqlRow[] {
  return database.prepare(sql).all(...params);
}

function toRunSummary(row: SqlRow): RunSummary {
  return {
    runId: readString(row.run_id),
    rootRunId: readString(row.root_run_id),
    runKind: readEnum(row.run_kind, RUN_KINDS, "run_kind"),
    parentRunId: readNullableString(row.parent_run_id),
    createdAt: readString(row.created_at),
    updatedAt: readString(row.updated_at),
    lifecycleState: readEnum(row.lifecycle_state, RUN_STATES, "lifecycle_state"),
    setName: readString(row.set_name),
    fixtureCount: readNumber(row.fixture_count),
    recoveredFixtureCount: readNumber(row.recovered_fixture_count),
    promptVersion: readNumber(row.prompt_version),
    scorerVersion: readNumber(row.scorer_version),
    datasetSha256: readString(row.dataset_sha256),
    codeDirty: readBoolean(row.code_dirty),
    isRoot: readString(row.run_id) === readString(row.root_run_id),
  };
}

function toEvaluationComparison(row: SqlRow): EvaluationComparison {
  const selected = readNumber(row.selected);
  const settled = readNumber(row.settled);
  const correct = readNumber(row.correct);
  return {
    rootRunId: readString(row.root_run_id),
    evaluationId: readString(row.evaluation_id),
    modelAlias: readString(row.model_alias),
    openRouterId: readString(row.open_router_id),
    reasoningMode: readString(row.reasoning_mode),
    rateLimitGroup: readString(row.rate_limit_group),
    selected,
    settled,
    correct,
    incorrect: readNumber(row.incorrect),
    ambiguous: readNumber(row.ambiguous),
    invalid: readNumber(row.invalid),
    refused: readNumber(row.refused),
    truncated: readNumber(row.truncated),
    pending: readNumber(row.pending),
    failed: readNumber(row.failed),
    indeterminate: readNumber(row.indeterminate),
    cancelled: readNumber(row.cancelled),
    attempts: readNumber(row.attempts),
    coverage: ratio(settled, selected),
    scoredAccuracy: ratio(correct, settled),
    selectedAccuracy: ratio(correct, selected),
    meanRequestLatencyMs: readNullableNumber(row.mean_request_latency_ms),
    meanTotalFixtureTimeMs: readNullableNumber(row.mean_total_fixture_time_ms),
    promptTokens: readNullableNumber(row.family_prompt_tokens),
    completionTokens: readNullableNumber(row.family_completion_tokens),
    totalTokens: readNullableNumber(row.family_total_tokens),
    reasoningTokens: readNullableNumber(row.family_reasoning_tokens),
    usageUnknownCount: readNumber(row.family_usage_unknown_count ?? 0),
    reportedUsd: readNullableNumber(row.family_reported_usd),
    estimatedUsd: readNullableNumber(row.family_estimated_usd),
    knownUsd: readNullableNumber(row.family_known_usd),
    costUnknownCount: readNumber(row.family_cost_unknown_count ?? 0),
  };
}

function toCategoryComparison(row: SqlRow): CategoryComparison {
  const selected = readNumber(row.selected);
  const settled = readNumber(row.settled);
  const correct = readNumber(row.correct);
  return {
    rootRunId: readString(row.root_run_id),
    evaluationId: readString(row.evaluation_id),
    category: readString(row.category),
    selected,
    settled,
    correct,
    accuracy: ratio(correct, settled),
  };
}

function toFixtureSummary(row: SqlRow): FixtureSummary {
  return {
    rootRunId: readString(row.root_run_id),
    evaluationId: readString(row.evaluation_id),
    fixtureId: readString(row.fixture_id),
    effectiveRunId: readString(row.effective_run_id),
    state: readEnum(row.state, OUTCOME_STATES, "state"),
    kind: readNullableEnum(row.kind, OUTCOME_KINDS, "kind"),
    parsedAnswer: readNullableString(row.parsed_answer),
    attemptCount: readNumber(row.attempt_count),
    indeterminate: readBoolean(row.indeterminate),
    costKind: readEnum(row.cost_kind, COST_KINDS, "cost_kind"),
    costUsd: readNullableNumber(row.cost_usd),
    requestLatencyMs: readNullableNumber(row.request_latency_ms),
    totalFixtureTimeMs: readNullableNumber(row.total_fixture_time_ms),
    question: readString(row.question),
    category: readString(row.category),
    l2Category: readString(row.l2_category),
    bench: readString(row.bench),
    imagePath: readString(row.image_path),
    imageMediaType: readString(row.image_media_type),
    imageSha256: readString(row.image_sha256),
  };
}

function toAttemptLine(row: SqlRow): AttemptLine {
  return {
    runId: readString(row.run_id),
    attemptId: readString(row.attempt_id),
    attemptNumber: readNumber(row.attempt_number),
    state: readString(row.state),
    startedAt: readString(row.started_at),
    submittedAt: readNullableString(row.submitted_at),
    finishedAt: readNullableString(row.finished_at),
    requestedModel: readString(row.requested_model),
    modelUsed: readNullableString(row.model_used),
    upstreamProvider: readNullableString(row.upstream_provider),
    finishReason: readNullableString(row.finish_reason),
    requestLatencyMs: readNullableNumber(row.request_latency_ms),
    usageKnown: readBoolean(row.usage_known),
    promptTokens: readNullableNumber(row.usage_prompt_tokens),
    completionTokens: readNullableNumber(row.usage_completion_tokens),
    totalTokens: readNullableNumber(row.usage_total_tokens),
    reasoningTokens: readNullableNumber(row.usage_reasoning_tokens),
    costKind: readEnum(row.cost_kind, COST_KINDS, "cost_kind"),
    costUsd: readNullableNumber(row.cost_usd),
    failureCategory: readNullableString(row.failure_category),
    failureMessage: readNullableString(row.failure_message),
    failureHttpStatus: readNullableNumber(row.failure_http_status),
    failureRetryAfterMs: readNullableNumber(row.failure_retry_after_ms),
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return QUERY_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_LIMIT_MAX) {
    throw new QueryValidationError("limit", `must be an integer between 1 and ${QUERY_LIMIT_MAX}`);
  }
  return limit;
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new QueryValidationError("offset", "must be a non-negative integer");
  }
  return offset;
}

function requireId(value: string, field: string): string {
  return requireText(value, field, MAX_ID_LENGTH);
}

function requireText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new QueryValidationError(
      field,
      `must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value;
}

function requireEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new QueryValidationError(field, `must be one of ${allowed.join(", ")}`);
  }
  return match;
}

function readString(value: SqlValue | undefined): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function readMetaString(value: SqlValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `publication_meta` stores every value as TEXT, so version numbers need parsing. */
function readNumericText(value: SqlValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readNullableString(value: SqlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: SqlValue | undefined): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readNullableNumber(value: SqlValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: SqlValue | undefined): boolean {
  return readNumber(value) !== 0;
}

function readEnum<T extends string>(
  value: SqlValue | undefined,
  allowed: readonly T[],
  field: string,
): T {
  const text = readString(value);
  const match = allowed.find((candidate) => candidate === text);
  if (match === undefined) {
    throw new QueryValidationError(field, `database holds unknown value ${JSON.stringify(text)}`);
  }
  return match;
}

function readNullableEnum<T extends string>(
  value: SqlValue | undefined,
  allowed: readonly T[],
  field: string,
): T | null {
  if (value === null || value === undefined) return null;
  return readEnum(value, allowed, field);
}
