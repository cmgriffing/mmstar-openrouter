/**
 * Versioned SQLite publication schema.
 *
 * The publication is a normalized, read-only projection of durable run JSON:
 * runs and their lineage, one row per evaluation, one row per fixture, outcomes
 * keyed by `(run, evaluation, fixture)`, and the attempt ledger keyed by
 * `(run, attempt)`. Attempt IDs repeat across a lineage (a recovery reissues the
 * same evaluation/fixture/number), so run scoping is part of the key.
 *
 * Views resolve the two questions the website asks:
 *
 * - `v_original_outcomes`: the first execution of each family (a run without a
 *   live parent).
 * - `v_effective_outcomes`: exactly one deterministic winner per
 *   `(family, evaluation, fixture)` — the newest scored outcome, or the newest
 *   terminal outcome when nothing scored — so recovery history never
 *   double-counts a fixture.
 * - `v_evaluation_family_ranking`: for each evaluation, the family roots with at
 *   least one terminal outcome, ranked newest-first.
 * - `v_global_effective_outcomes` and the `v_global_*` summaries/drilldown: one
 *   row per `(evaluation, fixture)` across the whole publication. The newest
 *   family with terminal outcomes for an evaluation wins it wholesale; rows are
 *   never stitched across families.
 *
 * All statements are `IF NOT EXISTS`; `createPublicationSchema` additionally
 * sets `PRAGMA user_version` and the schema-version meta row.
 */

import type { SqliteDatabase } from "./driver";

/** Bump when a table, column, index, or view changes shape. */
export const PUBLICATION_SCHEMA_VERSION = 2;
/** Bump when the exporter's projection/validation behavior changes. */
export const EXPORTER_VERSION = 2;
/** Bump when the publication manifest shape changes. */
export const PUBLICATION_MANIFEST_VERSION = 1;

export const PUBLICATION_DATABASE_FILE = "benchmark.sqlite";
export const PUBLICATION_MANIFEST_FILE = "manifest.json";
export const PUBLICATION_IMAGES_DIR = "benchmark-images";
export const PUBLICATION_IMAGES_PREFIX = `${PUBLICATION_IMAGES_DIR}/`;

/**
 * Public responses are bounded so one runaway completion cannot inflate the
 * query database without limit; the local JSON audit keeps the full text and
 * the row records that truncation happened.
 */
export const PUBLICATION_RESPONSE_LIMIT_CHARS = 20_000;

export const PUBLICATION_META_SCHEMA_VERSION = "schema_version";
export const PUBLICATION_META_EXPORTER_VERSION = "exporter_version";
export const PUBLICATION_META_CREATED_AT = "created_at";

export const PUBLICATION_TABLES = [
  "publication_meta",
  "runs",
  "run_recovered_fixtures",
  "evaluations",
  "fixtures",
  "outcomes",
  "attempts",
] as const;

export const PUBLICATION_VIEWS = [
  "v_runs_with_root",
  "v_original_outcomes",
  "v_recovery_outcomes",
  "v_effective_outcomes",
  "v_evaluation_summary",
  "v_category_summary",
  "v_attempt_totals",
  "v_fixture_drilldown",
  "v_evaluation_family_ranking",
  "v_global_effective_outcomes",
  "v_global_evaluation_summary",
  "v_global_category_summary",
  "v_global_fixture_drilldown",
] as const;

const TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS publication_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS runs (
     run_id TEXT PRIMARY KEY,
     root_run_id TEXT NOT NULL,
     run_kind TEXT NOT NULL CHECK (run_kind IN ('primary', 'recovery', 'restart')),
     parent_run_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     lifecycle_state TEXT NOT NULL,
     set_name TEXT NOT NULL,
     dataset_path TEXT NOT NULL,
     dataset_sha256 TEXT NOT NULL,
     fixture_count INTEGER NOT NULL,
     prompt_version INTEGER NOT NULL,
     scorer_version INTEGER NOT NULL,
     config_sha256 TEXT,
     code_revision TEXT,
     code_dirty INTEGER NOT NULL,
     recovered_fixture_count INTEGER NOT NULL,
     content_sha256 TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS run_recovered_fixtures (
     run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
     fixture_id TEXT NOT NULL,
     PRIMARY KEY (run_id, fixture_id)
   )`,
  `CREATE TABLE IF NOT EXISTS evaluations (
     evaluation_id TEXT PRIMARY KEY,
     model_alias TEXT NOT NULL,
     open_router_id TEXT NOT NULL,
     reasoning_mode TEXT NOT NULL,
     rate_limit_group TEXT NOT NULL,
     provider_json TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS fixtures (
     fixture_id TEXT PRIMARY KEY,
     question TEXT NOT NULL,
     answer TEXT NOT NULL,
     category TEXT NOT NULL,
     l2_category TEXT NOT NULL,
     bench TEXT NOT NULL,
     image_sha256 TEXT NOT NULL,
     image_path TEXT NOT NULL,
     image_media_type TEXT NOT NULL,
     image_byte_length INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS outcomes (
     run_id TEXT NOT NULL REFERENCES runs(run_id),
     evaluation_id TEXT NOT NULL REFERENCES evaluations(evaluation_id),
     fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
     state TEXT NOT NULL,
     kind TEXT,
     response_text TEXT,
     response_truncated INTEGER NOT NULL,
     parsed_answer TEXT,
     usage_known INTEGER NOT NULL,
     usage_prompt_tokens INTEGER,
     usage_completion_tokens INTEGER,
     usage_total_tokens INTEGER,
     usage_reasoning_tokens INTEGER,
     cost_kind TEXT NOT NULL,
     cost_usd REAL,
     request_latency_ms INTEGER,
     total_fixture_time_ms INTEGER,
     attempt_count INTEGER NOT NULL,
     indeterminate INTEGER NOT NULL,
     failure_category TEXT,
     failure_message TEXT,
     failure_http_status INTEGER,
     failure_retry_after_ms INTEGER,
     lineage_source_run_id TEXT,
     lineage_source_outcome_id TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (run_id, evaluation_id, fixture_id)
   )`,
  `CREATE TABLE IF NOT EXISTS attempts (
     run_id TEXT NOT NULL REFERENCES runs(run_id),
     attempt_id TEXT NOT NULL,
     evaluation_id TEXT NOT NULL REFERENCES evaluations(evaluation_id),
     fixture_id TEXT NOT NULL REFERENCES fixtures(fixture_id),
     attempt_number INTEGER NOT NULL,
     state TEXT NOT NULL,
     started_at TEXT NOT NULL,
     submitted_at TEXT,
     finished_at TEXT,
     requested_model TEXT NOT NULL,
     model_used TEXT,
     upstream_provider TEXT,
     finish_reason TEXT,
     request_latency_ms INTEGER,
     usage_known INTEGER NOT NULL,
     usage_prompt_tokens INTEGER,
     usage_completion_tokens INTEGER,
     usage_total_tokens INTEGER,
     usage_reasoning_tokens INTEGER,
     cost_kind TEXT NOT NULL,
     cost_usd REAL,
     failure_category TEXT,
     failure_message TEXT,
     failure_http_status INTEGER,
     failure_retry_after_ms INTEGER,
     PRIMARY KEY (run_id, attempt_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_outcomes_fixture ON outcomes (fixture_id)`,
  `CREATE INDEX IF NOT EXISTS idx_outcomes_evaluation ON outcomes (evaluation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_outcome ON attempts (run_id, evaluation_id, fixture_id)`,
];

/**
 * Root resolution walks parents upward and treats a missing parent as a root,
 * so a publication imported from a partial family still resolves
 * deterministically instead of dropping rows.
 */
const VIEW_STATEMENTS: readonly string[] = [
  `CREATE VIEW IF NOT EXISTS v_runs_with_root AS
   WITH RECURSIVE ancestry(run_id, current_id) AS (
     SELECT run_id, run_id FROM runs
     UNION ALL
     SELECT ancestry.run_id, runs.parent_run_id
     FROM ancestry
     JOIN runs ON runs.run_id = ancestry.current_id
     WHERE runs.parent_run_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM runs parent WHERE parent.run_id = runs.parent_run_id)
   )
   SELECT runs.*, ancestry.current_id AS computed_root_id
   FROM runs
   JOIN ancestry ON ancestry.run_id = runs.run_id
   WHERE NOT EXISTS (
     SELECT 1 FROM runs parent
     WHERE parent.run_id = (
       SELECT current.parent_run_id FROM runs current WHERE current.run_id = ancestry.current_id
     )
   )`,
  `CREATE VIEW IF NOT EXISTS v_original_outcomes AS
   SELECT outcomes.*, runs.root_run_id, runs.created_at AS run_created_at
   FROM outcomes
   JOIN runs ON runs.run_id = outcomes.run_id
   WHERE runs.run_id = runs.root_run_id`,
  `CREATE VIEW IF NOT EXISTS v_recovery_outcomes AS
   SELECT outcomes.*, runs.root_run_id, runs.created_at AS run_created_at
   FROM outcomes
   JOIN runs ON runs.run_id = outcomes.run_id
   WHERE runs.run_id <> runs.root_run_id`,
  `CREATE VIEW IF NOT EXISTS v_effective_outcomes AS
   SELECT * FROM (
     SELECT
       outcomes.*,
       runs.root_run_id,
       runs.created_at AS run_created_at,
       MAX(CASE WHEN outcomes.state = 'settled' AND outcomes.kind IS NOT NULL THEN 1 ELSE 0 END)
         OVER (PARTITION BY runs.root_run_id, outcomes.evaluation_id, outcomes.fixture_id)
         AS has_resolved,
       ROW_NUMBER() OVER (
         PARTITION BY runs.root_run_id, outcomes.evaluation_id, outcomes.fixture_id
         ORDER BY
           CASE WHEN outcomes.state = 'settled' AND outcomes.kind IS NOT NULL THEN 0 ELSE 1 END,
           runs.created_at DESC,
           runs.run_id DESC
       ) AS resolved_rank,
       ROW_NUMBER() OVER (
         PARTITION BY runs.root_run_id, outcomes.evaluation_id, outcomes.fixture_id
         ORDER BY runs.created_at DESC, runs.run_id DESC
       ) AS latest_rank
     FROM outcomes
     JOIN runs ON runs.run_id = outcomes.run_id
   ) ranked
   WHERE (has_resolved = 1 AND resolved_rank = 1)
      OR (has_resolved = 0 AND latest_rank = 1)`,
  `CREATE VIEW IF NOT EXISTS v_evaluation_summary AS
   SELECT
     effective.root_run_id,
     effective.evaluation_id,
     COUNT(*) AS selected,
     SUM(CASE WHEN effective.state = 'settled' THEN 1 ELSE 0 END) AS settled,
     SUM(CASE WHEN effective.kind = 'correct' THEN 1 ELSE 0 END) AS correct,
     SUM(CASE WHEN effective.kind = 'incorrect' THEN 1 ELSE 0 END) AS incorrect,
     SUM(CASE WHEN effective.kind = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
     SUM(CASE WHEN effective.kind = 'invalid' THEN 1 ELSE 0 END) AS invalid,
     SUM(CASE WHEN effective.kind = 'refused' THEN 1 ELSE 0 END) AS refused,
     SUM(CASE WHEN effective.kind = 'truncated' THEN 1 ELSE 0 END) AS truncated,
     SUM(CASE WHEN effective.state = 'pending' THEN 1 ELSE 0 END) AS pending,
     SUM(CASE WHEN effective.state = 'failed' THEN 1 ELSE 0 END) AS failed,
     SUM(CASE WHEN effective.state = 'indeterminate' THEN 1 ELSE 0 END) AS indeterminate,
     SUM(CASE WHEN effective.state = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
     SUM(effective.attempt_count) AS attempts,
     AVG(effective.request_latency_ms) AS mean_request_latency_ms,
     AVG(effective.total_fixture_time_ms) AS mean_total_fixture_time_ms
   FROM v_effective_outcomes effective
   GROUP BY effective.root_run_id, effective.evaluation_id`,
  `CREATE VIEW IF NOT EXISTS v_category_summary AS
   SELECT
     effective.root_run_id,
     effective.evaluation_id,
     fixtures.category,
     COUNT(*) AS selected,
     SUM(CASE WHEN effective.state = 'settled' THEN 1 ELSE 0 END) AS settled,
     SUM(CASE WHEN effective.kind = 'correct' THEN 1 ELSE 0 END) AS correct
   FROM v_effective_outcomes effective
   JOIN fixtures ON fixtures.fixture_id = effective.fixture_id
   GROUP BY effective.root_run_id, effective.evaluation_id, fixtures.category`,
  `CREATE VIEW IF NOT EXISTS v_attempt_totals AS
   SELECT
     run_id,
     evaluation_id,
     COUNT(*) AS attempts,
     SUM(CASE WHEN usage_known = 1 THEN usage_prompt_tokens END) AS prompt_tokens,
     SUM(CASE WHEN usage_known = 1 THEN usage_completion_tokens END) AS completion_tokens,
     SUM(CASE WHEN usage_known = 1 THEN usage_total_tokens END) AS total_tokens,
     SUM(CASE WHEN usage_known = 1 THEN usage_reasoning_tokens END) AS reasoning_tokens,
     SUM(CASE WHEN usage_known = 0 THEN 1 ELSE 0 END) AS usage_unknown_count,
     SUM(CASE WHEN cost_kind = 'reported' AND cost_usd IS NOT NULL THEN cost_usd END)
       AS reported_usd,
     SUM(CASE WHEN cost_kind = 'estimated' AND cost_usd IS NOT NULL THEN cost_usd END)
       AS estimated_usd,
     SUM(CASE WHEN cost_kind IN ('reported', 'estimated') AND cost_usd IS NOT NULL THEN cost_usd END)
       AS known_usd,
     SUM(CASE WHEN cost_kind = 'unknown' OR cost_usd IS NULL THEN 1 ELSE 0 END)
       AS cost_unknown_count
   FROM attempts
   GROUP BY run_id, evaluation_id`,
  `CREATE VIEW IF NOT EXISTS v_fixture_drilldown AS
   SELECT
     effective.root_run_id,
     effective.evaluation_id,
     effective.fixture_id,
     effective.run_id AS effective_run_id,
     effective.state,
     effective.kind,
     effective.parsed_answer,
     effective.response_text,
     effective.response_truncated,
     effective.usage_known,
     effective.usage_prompt_tokens,
     effective.usage_completion_tokens,
     effective.usage_total_tokens,
     effective.usage_reasoning_tokens,
     effective.cost_kind,
     effective.cost_usd,
     effective.request_latency_ms,
     effective.total_fixture_time_ms,
     effective.attempt_count,
     effective.indeterminate,
     effective.lineage_source_run_id,
     effective.lineage_source_outcome_id,
     fixtures.question,
     fixtures.answer AS expected_answer,
     fixtures.category,
     fixtures.l2_category,
     fixtures.bench,
     fixtures.image_path,
     fixtures.image_media_type,
     fixtures.image_sha256,
     fixtures.image_byte_length
   FROM v_effective_outcomes effective
   JOIN fixtures ON fixtures.fixture_id = effective.fixture_id`,
  `CREATE VIEW IF NOT EXISTS v_evaluation_family_ranking AS
   WITH terminal_families AS (
     SELECT DISTINCT
       runs.root_run_id,
       outcomes.evaluation_id,
       roots.created_at AS root_created_at
     FROM outcomes
     JOIN runs ON runs.run_id = outcomes.run_id
     JOIN runs roots ON roots.run_id = runs.root_run_id
     WHERE outcomes.state <> 'pending'
   ),
   ranked AS (
     SELECT
       root_run_id,
       evaluation_id,
       root_created_at,
       ROW_NUMBER() OVER (
         PARTITION BY evaluation_id
         ORDER BY root_created_at DESC, root_run_id DESC
       ) AS winner_rank
     FROM terminal_families
   )
   SELECT root_run_id, evaluation_id, root_created_at, winner_rank FROM ranked`,
  `CREATE VIEW IF NOT EXISTS v_global_effective_outcomes AS
   SELECT effective.*
   FROM v_effective_outcomes effective
   JOIN v_evaluation_family_ranking ranking
     ON ranking.evaluation_id = effective.evaluation_id
    AND ranking.root_run_id = effective.root_run_id
   WHERE ranking.winner_rank = 1`,
  `CREATE VIEW IF NOT EXISTS v_global_evaluation_summary AS
   SELECT
     effective.root_run_id,
     effective.evaluation_id,
     COUNT(*) AS selected,
     SUM(CASE WHEN effective.state = 'settled' THEN 1 ELSE 0 END) AS settled,
     SUM(CASE WHEN effective.kind = 'correct' THEN 1 ELSE 0 END) AS correct,
     SUM(CASE WHEN effective.kind = 'incorrect' THEN 1 ELSE 0 END) AS incorrect,
     SUM(CASE WHEN effective.kind = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
     SUM(CASE WHEN effective.kind = 'invalid' THEN 1 ELSE 0 END) AS invalid,
     SUM(CASE WHEN effective.kind = 'refused' THEN 1 ELSE 0 END) AS refused,
     SUM(CASE WHEN effective.kind = 'truncated' THEN 1 ELSE 0 END) AS truncated,
     SUM(CASE WHEN effective.state = 'pending' THEN 1 ELSE 0 END) AS pending,
     SUM(CASE WHEN effective.state = 'failed' THEN 1 ELSE 0 END) AS failed,
     SUM(CASE WHEN effective.state = 'indeterminate' THEN 1 ELSE 0 END) AS indeterminate,
     SUM(CASE WHEN effective.state = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
     SUM(effective.attempt_count) AS attempts,
     AVG(effective.request_latency_ms) AS mean_request_latency_ms,
     AVG(effective.total_fixture_time_ms) AS mean_total_fixture_time_ms
   FROM v_global_effective_outcomes effective
   GROUP BY effective.root_run_id, effective.evaluation_id`,
  `CREATE VIEW IF NOT EXISTS v_global_category_summary AS
   SELECT
     effective.root_run_id,
     effective.evaluation_id,
     fixtures.category,
     COUNT(*) AS selected,
     SUM(CASE WHEN effective.state = 'settled' THEN 1 ELSE 0 END) AS settled,
     SUM(CASE WHEN effective.kind = 'correct' THEN 1 ELSE 0 END) AS correct
   FROM v_global_effective_outcomes effective
   JOIN fixtures ON fixtures.fixture_id = effective.fixture_id
   GROUP BY effective.root_run_id, effective.evaluation_id, fixtures.category`,
  `CREATE VIEW IF NOT EXISTS v_global_fixture_drilldown AS
   SELECT
     effective.root_run_id,
     effective.evaluation_id,
     effective.fixture_id,
     effective.run_id AS effective_run_id,
     effective.state,
     effective.kind,
     effective.parsed_answer,
     effective.response_text,
     effective.response_truncated,
     effective.usage_known,
     effective.usage_prompt_tokens,
     effective.usage_completion_tokens,
     effective.usage_total_tokens,
     effective.usage_reasoning_tokens,
     effective.cost_kind,
     effective.cost_usd,
     effective.request_latency_ms,
     effective.total_fixture_time_ms,
     effective.attempt_count,
     effective.indeterminate,
     effective.lineage_source_run_id,
     effective.lineage_source_outcome_id,
     fixtures.question,
     fixtures.answer AS expected_answer,
     fixtures.category,
     fixtures.l2_category,
     fixtures.bench,
     fixtures.image_path,
     fixtures.image_media_type,
     fixtures.image_sha256,
     fixtures.image_byte_length
   FROM v_global_effective_outcomes effective
   JOIN fixtures ON fixtures.fixture_id = effective.fixture_id`,
];

export const PUBLICATION_SCHEMA_STATEMENTS: readonly string[] = [
  ...TABLE_STATEMENTS,
  ...VIEW_STATEMENTS,
];

/** Create every table/view (idempotent) and record the schema version. */
export function createPublicationSchema(database: SqliteDatabase): void {
  database.exec("PRAGMA foreign_keys = ON");
  for (const statement of PUBLICATION_SCHEMA_STATEMENTS) database.exec(statement);
  database.exec(`PRAGMA user_version = ${PUBLICATION_SCHEMA_VERSION}`);
  database
    .prepare("INSERT OR IGNORE INTO publication_meta (key, value) VALUES (?, ?)")
    .run(PUBLICATION_META_SCHEMA_VERSION, String(PUBLICATION_SCHEMA_VERSION));
  database
    .prepare("INSERT OR IGNORE INTO publication_meta (key, value) VALUES (?, ?)")
    .run(PUBLICATION_META_EXPORTER_VERSION, String(EXPORTER_VERSION));
}
