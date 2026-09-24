/**
 * Transactional publication import.
 *
 * The import is idempotent: importing the same run rows twice leaves one logical
 * copy, because a run's content fingerprint short-circuits the second import.
 * Conflicting content for an existing run/evaluation/fixture ID is an error, not
 * a silent overwrite, so a publication can never silently mix two experiments
 * that claim the same identity.
 *
 * Everything happens inside one transaction: a failure leaves the previous
 * publication rows untouched.
 */
import { PublicationConflictError, PublicationValidationError } from "../errors";
import type { SqliteDatabase, SqlRow, SqlValue } from "./driver";
import type {
  PublicationAttemptRow,
  PublicationEvaluationRow,
  PublicationFixtureRow,
  PublicationOutcomeRow,
  PublicationRows,
  PublicationRunRow,
} from "./rows";
import { canonicalJson } from "./rows";
import { PUBLICATION_META_SCHEMA_VERSION, PUBLICATION_SCHEMA_VERSION } from "./schema";

export interface ImportSummary {
  insertedRuns: string[];
  skippedRuns: string[];
  insertedEvaluations: number;
  insertedFixtures: number;
  insertedOutcomes: number;
  insertedAttempts: number;
}

/**
 * Import publication rows into an open database. The caller owns schema creation
 * and file placement; this function owns transactionality and identity rules.
 */
export function importPublicationRows(
  database: SqliteDatabase,
  rows: PublicationRows,
): ImportSummary {
  assertSchemaVersion(database);

  const summary: ImportSummary = {
    insertedRuns: [],
    skippedRuns: [],
    insertedEvaluations: 0,
    insertedFixtures: 0,
    insertedOutcomes: 0,
    insertedAttempts: 0,
  };

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const run of rows.runs) {
      const existing = database
        .prepare("SELECT content_sha256 FROM runs WHERE run_id = ?")
        .get(run.run_id);
      if (existing !== undefined) {
        if (readText(existing, "content_sha256") !== run.content_sha256) {
          throw new PublicationConflictError(
            run.run_id,
            "an existing run with this ID has different content; export into a fresh publication instead",
          );
        }
        summary.skippedRuns.push(run.run_id);
        continue;
      }
      insertRow(database, "runs", runRow(run));
      summary.insertedRuns.push(run.run_id);
    }

    for (const recovered of rows.recoveredFixtures) {
      if (!summary.insertedRuns.includes(recovered.run_id)) continue;
      insertRow(database, "run_recovered_fixtures", {
        run_id: recovered.run_id,
        fixture_id: recovered.fixture_id,
      });
    }

    for (const evaluation of rows.evaluations) {
      const existing = database
        .prepare("SELECT * FROM evaluations WHERE evaluation_id = ?")
        .get(evaluation.evaluation_id);
      if (existing === undefined) {
        insertRow(database, "evaluations", evaluationRow(evaluation));
        summary.insertedEvaluations += 1;
        continue;
      }
      assertSameRow("evaluations", evaluation.evaluation_id, existing, evaluationRow(evaluation));
    }

    for (const fixture of rows.fixtures) {
      const existing = database
        .prepare("SELECT * FROM fixtures WHERE fixture_id = ?")
        .get(fixture.fixture_id);
      if (existing === undefined) {
        insertRow(database, "fixtures", fixtureRow(fixture));
        summary.insertedFixtures += 1;
        continue;
      }
      assertSameRow("fixtures", fixture.fixture_id, existing, fixtureRow(fixture));
    }

    for (const outcome of rows.outcomes) {
      if (!summary.insertedRuns.includes(outcome.run_id)) continue;
      insertRow(database, "outcomes", outcomeRow(outcome));
      summary.insertedOutcomes += 1;
    }

    for (const attempt of rows.attempts) {
      if (!summary.insertedRuns.includes(attempt.run_id)) continue;
      insertRow(database, "attempts", attemptRow(attempt));
      summary.insertedAttempts += 1;
    }

    // Root resolution is derived from the run graph after every run is present,
    // so importing a family in any order settles on the same roots.
    database.exec(
      "UPDATE runs SET root_run_id = (SELECT computed_root_id FROM v_runs_with_root v WHERE v.run_id = runs.run_id)",
    );

    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // A rollback failure must not mask the original import error.
    }
    throw error;
  }

  return summary;
}

function assertSchemaVersion(database: SqliteDatabase): void {
  let row: SqlRow | undefined;
  try {
    row = database
      .prepare("SELECT value FROM publication_meta WHERE key = ?")
      .get(PUBLICATION_META_SCHEMA_VERSION);
  } catch {
    throw new PublicationValidationError(
      "database is not a publication (publication_meta is missing); create the schema first",
    );
  }
  if (row === undefined) {
    throw new PublicationValidationError("publication schema version is missing");
  }
  const version = Number(readText(row, "value"));
  if (version !== PUBLICATION_SCHEMA_VERSION) {
    throw new PublicationValidationError(
      `publication schema version ${version} is not supported by this exporter (expected ${PUBLICATION_SCHEMA_VERSION})`,
    );
  }
}

function insertRow(
  database: SqliteDatabase,
  table: string,
  values: Readonly<Record<string, SqlValue>>,
): void {
  const columns = Object.keys(values);
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
    .map(() => "?")
    .join(", ")})`;
  database.prepare(sql).run(...columns.map((column) => values[column] ?? null));
}

function assertSameRow(
  table: string,
  id: string,
  existing: SqlRow,
  expected: Readonly<Record<string, SqlValue>>,
): void {
  for (const [column, value] of Object.entries(expected)) {
    if (normalize(existing[column]) !== normalize(value)) {
      throw new PublicationConflictError(
        id,
        `existing ${table} row differs at "${column}" (existing ${canonicalJson(
          normalize(existing[column]),
        )}, incoming ${canonicalJson(normalize(value))})`,
      );
    }
  }
}

/** SQLite drivers disagree on number/bigint/null representations; normalize them. */
function normalize(value: SqlValue | undefined): SqlValue | undefined {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function readText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new PublicationValidationError(
      `expected string column "${column}", found ${typeof value}`,
    );
  }
  return value;
}

function runRow(run: PublicationRunRow): Record<string, SqlValue> {
  return {
    run_id: run.run_id,
    root_run_id: run.root_run_id,
    run_kind: run.run_kind,
    parent_run_id: run.parent_run_id,
    created_at: run.created_at,
    updated_at: run.updated_at,
    lifecycle_state: run.lifecycle_state,
    set_name: run.set_name,
    dataset_path: run.dataset_path,
    dataset_sha256: run.dataset_sha256,
    fixture_count: run.fixture_count,
    prompt_version: run.prompt_version,
    scorer_version: run.scorer_version,
    config_sha256: run.config_sha256,
    code_revision: run.code_revision,
    code_dirty: run.code_dirty,
    recovered_fixture_count: run.recovered_fixture_count,
    content_sha256: run.content_sha256,
  };
}

function evaluationRow(evaluation: PublicationEvaluationRow): Record<string, SqlValue> {
  return {
    evaluation_id: evaluation.evaluation_id,
    model_alias: evaluation.model_alias,
    open_router_id: evaluation.open_router_id,
    reasoning_mode: evaluation.reasoning_mode,
    rate_limit_group: evaluation.rate_limit_group,
    provider_json: evaluation.provider_json,
  };
}

function fixtureRow(fixture: PublicationFixtureRow): Record<string, SqlValue> {
  return {
    fixture_id: fixture.fixture_id,
    question: fixture.question,
    answer: fixture.answer,
    category: fixture.category,
    l2_category: fixture.l2_category,
    bench: fixture.bench,
    image_sha256: fixture.image_sha256,
    image_path: fixture.image_path,
    image_media_type: fixture.image_media_type,
    image_byte_length: fixture.image_byte_length,
  };
}

function outcomeRow(outcome: PublicationOutcomeRow): Record<string, SqlValue> {
  return {
    run_id: outcome.run_id,
    evaluation_id: outcome.evaluation_id,
    fixture_id: outcome.fixture_id,
    state: outcome.state,
    kind: outcome.kind,
    response_text: outcome.response_text,
    response_truncated: outcome.response_truncated,
    parsed_answer: outcome.parsed_answer,
    usage_known: outcome.usage_known,
    usage_prompt_tokens: outcome.usage_prompt_tokens,
    usage_completion_tokens: outcome.usage_completion_tokens,
    usage_total_tokens: outcome.usage_total_tokens,
    usage_reasoning_tokens: outcome.usage_reasoning_tokens,
    cost_kind: outcome.cost_kind,
    cost_usd: outcome.cost_usd,
    request_latency_ms: outcome.request_latency_ms,
    total_fixture_time_ms: outcome.total_fixture_time_ms,
    attempt_count: outcome.attempt_count,
    indeterminate: outcome.indeterminate,
    failure_category: outcome.failure_category,
    failure_message: outcome.failure_message,
    failure_http_status: outcome.failure_http_status,
    failure_retry_after_ms: outcome.failure_retry_after_ms,
    lineage_source_run_id: outcome.lineage_source_run_id,
    lineage_source_outcome_id: outcome.lineage_source_outcome_id,
    updated_at: outcome.updated_at,
  };
}

function attemptRow(attempt: PublicationAttemptRow): Record<string, SqlValue> {
  return {
    run_id: attempt.run_id,
    attempt_id: attempt.attempt_id,
    evaluation_id: attempt.evaluation_id,
    fixture_id: attempt.fixture_id,
    attempt_number: attempt.attempt_number,
    state: attempt.state,
    started_at: attempt.started_at,
    submitted_at: attempt.submitted_at,
    finished_at: attempt.finished_at,
    requested_model: attempt.requested_model,
    model_used: attempt.model_used,
    upstream_provider: attempt.upstream_provider,
    finish_reason: attempt.finish_reason,
    request_latency_ms: attempt.request_latency_ms,
    usage_known: attempt.usage_known,
    usage_prompt_tokens: attempt.usage_prompt_tokens,
    usage_completion_tokens: attempt.usage_completion_tokens,
    usage_total_tokens: attempt.usage_total_tokens,
    usage_reasoning_tokens: attempt.usage_reasoning_tokens,
    cost_kind: attempt.cost_kind,
    cost_usd: attempt.cost_usd,
    failure_category: attempt.failure_category,
    failure_message: attempt.failure_message,
    failure_http_status: attempt.failure_http_status,
    failure_retry_after_ms: attempt.failure_retry_after_ms,
  };
}
