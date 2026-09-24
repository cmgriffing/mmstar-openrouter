/**
 * Read-only repository tests.
 *
 * The database is seeded with explicit SQL rows so expected counts are
 * hand-computed: a root run and a recovery child where a failed outcome is
 * superseded by a recovery success, one attempt with unknown usage/cost, and
 * two categories. `node:sqlite` is the local binding; the same repository runs
 * over a WASM driver in the web gate.
 */
import { afterEach, describe, expect, it } from "vitest";
import { QueryValidationError } from "../errors";
import type { SqliteDatabase, SqlValue } from "../publication/driver";
import { createPublicationSchema } from "../publication/schema";
import { openSqliteDatabase } from "../publication/sqlite-node";
import { createPublicationRepository } from "./repository";

const created: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  created.splice(0);
});

function seedDatabase(): SqliteDatabase {
  const database = openSqliteDatabase(":memory:");
  databases.push(database);
  createPublicationSchema(database);
  database
    .prepare("INSERT INTO publication_meta (key, value) VALUES (?, ?)")
    .run("created_at", "2026-01-01T00:00:00.000Z");
  insertRun(database, {
    runId: "root-run",
    rootRunId: "root-run",
    runKind: "primary",
    parentRunId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
    lifecycleState: "completed",
    fixtureCount: 3,
    recoveredFixtureCount: 0,
  });
  insertRun(database, {
    runId: "recovery-run",
    rootRunId: "root-run",
    runKind: "recovery",
    parentRunId: "root-run",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T01:00:00.000Z",
    lifecycleState: "completed",
    fixtureCount: 1,
    recoveredFixtureCount: 1,
  });
  database
    .prepare(
      `INSERT INTO evaluations
         (evaluation_id, model_alias, open_router_id, reasoning_mode, rate_limit_group)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("eval-a", "alpha", "vendor/alpha", "high", "alpha-group");
  for (const [fixtureId, category] of [
    ["1", "biology"],
    ["2", "biology"],
    ["3", "chemistry"],
  ] as const) {
    database
      .prepare(
        `INSERT INTO fixtures
           (fixture_id, question, answer, category, l2_category, bench,
            image_sha256, image_path, image_media_type, image_byte_length)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fixtureId,
        `question ${fixtureId}`,
        "A",
        category,
        `${category}-l2`,
        "mmstar",
        `sha-${fixtureId}`,
        `benchmark-images/sha-${fixtureId}.png`,
        "image/png",
        10,
      );
  }
  // Root outcomes: 1 correct, 2 incorrect, 3 failed.
  insertOutcome(database, {
    runId: "root-run",
    fixtureId: "1",
    state: "settled",
    kind: "correct",
    parsedAnswer: "A",
    usageKnown: true,
    costKind: "reported",
    costUsd: 0.01,
  });
  insertOutcome(database, {
    runId: "root-run",
    fixtureId: "2",
    state: "settled",
    kind: "incorrect",
    parsedAnswer: "B",
    usageKnown: true,
    costKind: "reported",
    costUsd: 0.01,
  });
  insertOutcome(database, {
    runId: "root-run",
    fixtureId: "3",
    state: "failed",
    kind: null,
    parsedAnswer: null,
    usageKnown: false,
    costKind: "unknown",
    costUsd: null,
    failureCategory: "timeout",
    failureMessage: "request timed out",
  });
  // Recovery supersedes fixture 3 with a settled correct outcome.
  insertOutcome(database, {
    runId: "recovery-run",
    fixtureId: "3",
    state: "settled",
    kind: "correct",
    parsedAnswer: "A",
    usageKnown: true,
    costKind: "reported",
    costUsd: 0.02,
  });
  insertAttempt(database, {
    runId: "root-run",
    attemptId: "root-run:1",
    fixtureId: "1",
    attemptNumber: 1,
    state: "completed",
    usageKnown: true,
    costKind: "reported",
    costUsd: 0.01,
  });
  insertAttempt(database, {
    runId: "root-run",
    attemptId: "root-run:3",
    fixtureId: "3",
    attemptNumber: 1,
    state: "failed",
    usageKnown: false,
    costKind: "unknown",
    costUsd: null,
    failureCategory: "timeout",
    failureMessage: "request timed out",
  });
  insertAttempt(database, {
    runId: "recovery-run",
    attemptId: "recovery-run:3",
    fixtureId: "3",
    attemptNumber: 1,
    state: "completed",
    usageKnown: true,
    costKind: "reported",
    costUsd: 0.02,
  });
  return database;
}

interface RunInput {
  runId: string;
  rootRunId: string;
  runKind: string;
  parentRunId: string | null;
  createdAt: string;
  updatedAt: string;
  lifecycleState: string;
  fixtureCount: number;
  recoveredFixtureCount: number;
}

function insertRun(database: SqliteDatabase, run: RunInput): void {
  database
    .prepare(
      `INSERT INTO runs
         (run_id, root_run_id, run_kind, parent_run_id, created_at, updated_at,
          lifecycle_state, set_name, dataset_path, dataset_sha256, fixture_count,
          prompt_version, scorer_version, config_sha256, code_revision, code_dirty,
          recovered_fixture_count, content_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.runId,
      run.rootRunId,
      run.runKind,
      run.parentRunId,
      run.createdAt,
      run.updatedAt,
      run.lifecycleState,
      "smoke",
      "MMStar.tsv",
      "dataset-sha",
      run.fixtureCount,
      1,
      1,
      null,
      "abc123",
      0,
      run.recoveredFixtureCount,
      `content-${run.runId}`,
    );
}

function insertOutcome(
  database: SqliteDatabase,
  outcome: {
    runId: string;
    fixtureId: string;
    state: string;
    kind: string | null;
    parsedAnswer: string | null;
    usageKnown: boolean;
    costKind: string;
    costUsd: number | null;
    failureCategory?: string;
    failureMessage?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO outcomes
         (run_id, evaluation_id, fixture_id, state, kind, response_text,
          response_truncated, parsed_answer, usage_known, usage_prompt_tokens,
          usage_completion_tokens, usage_total_tokens, usage_reasoning_tokens,
          cost_kind, cost_usd, request_latency_ms, total_fixture_time_ms,
          attempt_count, indeterminate, failure_category, failure_message,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      outcome.runId,
      "eval-a",
      outcome.fixtureId,
      outcome.state,
      outcome.kind,
      outcome.kind === null ? null : `response for ${outcome.fixtureId}`,
      0,
      outcome.parsedAnswer,
      outcome.usageKnown ? 1 : 0,
      outcome.usageKnown ? 100 : null,
      outcome.usageKnown ? 10 : null,
      outcome.usageKnown ? 110 : null,
      null,
      outcome.costKind,
      outcome.costUsd,
      500,
      600,
      1,
      0,
      outcome.failureCategory ?? null,
      outcome.failureMessage ?? null,
      "2026-01-01T00:00:00.000Z",
    );
}

function insertAttempt(
  database: SqliteDatabase,
  attempt: {
    runId: string;
    attemptId: string;
    fixtureId: string;
    attemptNumber: number;
    state: string;
    usageKnown: boolean;
    costKind: string;
    costUsd: number | null;
    failureCategory?: string;
    failureMessage?: string;
  },
): void {
  const params: SqlValue[] = [
    attempt.runId,
    attempt.attemptId,
    "eval-a",
    attempt.fixtureId,
    attempt.attemptNumber,
    attempt.state,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:01.000Z",
    "2026-01-01T00:00:02.000Z",
    "vendor/alpha",
    "vendor/alpha",
    "vendor-serving",
    "stop",
    500,
    attempt.usageKnown ? 1 : 0,
    attempt.usageKnown ? 100 : null,
    attempt.usageKnown ? 10 : null,
    attempt.usageKnown ? 110 : null,
    null,
    attempt.costKind,
    attempt.costUsd,
    attempt.failureCategory ?? null,
    attempt.failureMessage ?? null,
    null,
    null,
  ];
  database
    .prepare(
      `INSERT INTO attempts
         (run_id, attempt_id, evaluation_id, fixture_id, attempt_number, state,
          started_at, submitted_at, finished_at, requested_model, model_used,
          upstream_provider, finish_reason, request_latency_ms, usage_known,
          usage_prompt_tokens, usage_completion_tokens, usage_total_tokens,
          usage_reasoning_tokens, cost_kind, cost_usd, failure_category,
          failure_message, failure_http_status, failure_retry_after_ms)
       VALUES (${params.map(() => "?").join(", ")})`,
    )
    .run(...params);
}

describe("createPublicationRepository", () => {
  it("reports publication metadata", () => {
    const repository = createPublicationRepository(seedDatabase());
    expect(repository.meta()).toEqual({
      schemaVersion: 1,
      exporterVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("lists runs newest first with family roles", () => {
    const repository = createPublicationRepository(seedDatabase());
    const runs = repository.listRuns();
    expect(runs.map((run) => run.runId)).toEqual(["recovery-run", "root-run"]);
    expect(runs[0]).toMatchObject({
      runKind: "recovery",
      parentRunId: "root-run",
      isRoot: false,
      recoveredFixtureCount: 1,
    });
    expect(runs[1]).toMatchObject({ runKind: "primary", isRoot: true });
    expect(repository.listRuns("root-run")).toHaveLength(2);
    expect(repository.listRuns("missing")).toEqual([]);
  });

  it("builds family comparisons over effective outcomes and the full attempt ledger", () => {
    const repository = createPublicationRepository(seedDatabase());
    const comparisons = repository.listComparisons("root-run");
    expect(comparisons).toHaveLength(1);
    const comparison = comparisons[0];
    expect(comparison).toMatchObject({
      evaluationId: "eval-a",
      modelAlias: "alpha",
      reasoningMode: "high",
      rateLimitGroup: "alpha-group",
      selected: 3,
      settled: 3,
      correct: 2,
      incorrect: 1,
      failed: 0,
      attempts: 3,
      usageUnknownCount: 1,
      costUnknownCount: 1,
      reportedUsd: 0.03,
      estimatedUsd: null,
      knownUsd: 0.03,
    });
    expect(comparison?.coverage).toBe(1);
    expect(comparison?.scoredAccuracy).toBeCloseTo(2 / 3);
    expect(comparison?.selectedAccuracy).toBeCloseTo(2 / 3);
    expect(comparison?.totalTokens).toBe(220);
  });

  it("groups category accuracy by evaluation", () => {
    const repository = createPublicationRepository(seedDatabase());
    const categories = repository.listCategories({ rootRunId: "root-run" });
    expect(categories.map((category) => category.category)).toEqual(["biology", "chemistry"]);
    expect(categories[0]).toMatchObject({ selected: 2, settled: 2, correct: 1, accuracy: 0.5 });
    expect(categories[1]).toMatchObject({ selected: 1, settled: 1, correct: 1, accuracy: 1 });
    expect(
      repository.listCategories({ rootRunId: "root-run", evaluationId: "eval-a" }),
    ).toHaveLength(2);
  });

  it("paginates fixture drilldown deterministically and filters by category and kind", () => {
    const repository = createPublicationRepository(seedDatabase());
    const first = repository.listFixtures({ rootRunId: "root-run", limit: 2 });
    expect(first.total).toBe(3);
    expect(first.rows.map((row) => row.fixtureId)).toEqual(["1", "2"]);
    expect(first.hasMore).toBe(true);
    const second = repository.listFixtures({ rootRunId: "root-run", limit: 2, offset: 2 });
    expect(second.rows.map((row) => row.fixtureId)).toEqual(["3"]);
    expect(second.hasMore).toBe(false);
    expect(second.rows[0]).toMatchObject({
      state: "settled",
      kind: "correct",
      effectiveRunId: "recovery-run",
      attemptCount: 1,
    });
    const chemistry = repository.listFixtures({
      rootRunId: "root-run",
      category: "chemistry",
    });
    expect(chemistry.rows.map((row) => row.fixtureId)).toEqual(["3"]);
    const correct = repository.listFixtures({ rootRunId: "root-run", kind: "correct" });
    expect(correct.rows.map((row) => row.fixtureId)).toEqual(["1", "3"]);
    const failed = repository.listFixtures({ rootRunId: "root-run", state: "failed" });
    expect(failed.total).toBe(0);
  });

  it("returns effective detail with family outcomes and ordered attempts", () => {
    const repository = createPublicationRepository(seedDatabase());
    const detail = repository.getFixtureDetail({
      rootRunId: "root-run",
      evaluationId: "eval-a",
      fixtureId: "3",
    });
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      expectedAnswer: "A",
      state: "settled",
      kind: "correct",
      effectiveRunId: "recovery-run",
      responseText: "response for 3",
      attemptCount: 1,
      imagePath: "benchmark-images/sha-3.png",
    });
    expect(
      detail?.outcomes.map((outcome) => [outcome.runId, outcome.state, outcome.isEffective]),
    ).toEqual([
      ["root-run", "failed", false],
      ["recovery-run", "settled", true],
    ]);
    expect(detail?.attempts.map((attempt) => [attempt.runId, attempt.costUsd])).toEqual([
      ["root-run", null],
      ["recovery-run", 0.02],
    ]);
    expect(
      repository.getFixtureDetail({
        rootRunId: "root-run",
        evaluationId: "eval-a",
        fixtureId: "999",
      }),
    ).toBeNull();
  });

  it("rejects out-of-range and unknown query parameters before querying", () => {
    const repository = createPublicationRepository(seedDatabase());
    const root = "root-run";
    expect(() => repository.listFixtures({ rootRunId: root, limit: 0 })).toThrow(
      QueryValidationError,
    );
    expect(() => repository.listFixtures({ rootRunId: root, limit: 201 })).toThrow(
      QueryValidationError,
    );
    expect(() => repository.listFixtures({ rootRunId: root, limit: 1.5 })).toThrow(
      QueryValidationError,
    );
    expect(() => repository.listFixtures({ rootRunId: root, offset: -1 })).toThrow(
      QueryValidationError,
    );
    expect(() => repository.listFixtures({ rootRunId: root, state: "broken" as never })).toThrow(
      QueryValidationError,
    );
    expect(() => repository.listFixtures({ rootRunId: root, kind: "maybe" as never })).toThrow(
      QueryValidationError,
    );
    expect(() => repository.listFixtures({ rootRunId: "" })).toThrow(QueryValidationError);
    expect(() => repository.listComparisons("")).toThrow(QueryValidationError);
    expect(() =>
      repository.listCategories({ rootRunId: root, evaluationId: "x".repeat(201) }),
    ).toThrow(QueryValidationError);
  });
});
