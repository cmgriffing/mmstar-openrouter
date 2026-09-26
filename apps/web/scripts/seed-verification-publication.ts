/**
 * Deterministic verification publication for the results website.
 *
 * The committed `publication/` artifact is a complete 1,500-fixture snapshot,
 * but it contains no recovery lineage, request failures, indeterminate work, or
 * unknown costs. This script builds a small SQLite publication that exercises
 * every presentation state the website must render (and that
 * `repository.test.ts` covers at the query layer):
 *
 * - root family with correct/incorrect/ambiguous/truncated outcomes, a timeout
 *   failure recovered by a linked recovery run, indeterminate submissions, and
 *   unknown/estimated/reported costs;
 * - a restart family that is still running, with pending work for every
 *   evaluation and a recovery child whose frozen settings differ (the "mixed
 *   settings" warning) and which has settled only `demo::low`, so the newer
 *   family shadows the older family's complete `demo::low` results with 3/30
 *   coverage while `demo::high` and `demo::none` stay on the older family — the
 *   global winner rule and its reduced coverage in one publication;
 * - two deduplicated content-addressed images shared across fixtures.
 *
 * It writes only the files the website needs (`benchmark.sqlite` and
 * `benchmark-images/`); it is a UI fixture, not a validated publication and not
 * a substitute for `mmstar export`. Use it to verify frontend behavior:
 *
 *   bun apps/web/scripts/seed-verification-publication.ts /tmp/mmstar-verification
 *   MMSTAR_PUBLICATION_DIR=/tmp/mmstar-verification pnpm --filter @mmstar/web build:node
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SqlValue } from "@mmstar/results";
import { createPublicationSchema } from "@mmstar/results";
import { openSqliteDatabase } from "@mmstar/results/node";

const outputDir = resolve(process.argv[2] ?? "/tmp/mmstar-verification-publication");
const FIXTURE_COUNT = 30;
const DATASET_SHA = "a11ce0de5e7ab1ec0ffee0d15ea5e00000000000000000000000000000000cafe".slice(
  0,
  64,
);

const ROOT_RUN = "2026-01-01T00-00-00-000Z_roota";
const RECOVERY_RUN = "2026-01-02T00-00-00-000Z_recova";
const RESTART_RUN = "2026-01-03T00-00-00-000Z_rootb";
const RESTART_RECOVERY_RUN = "2026-01-04T00-00-00-000Z_recovb";

const EVALUATIONS = [
  {
    evaluationId: "demo::high",
    modelAlias: "demo",
    openRouterId: "demo/vision-model",
    reasoningMode: "high",
    rateLimitGroup: "g-demo",
  },
  {
    evaluationId: "demo::none",
    modelAlias: "demo",
    openRouterId: "demo/vision-model",
    reasoningMode: "none",
    rateLimitGroup: "g-demo",
  },
  {
    evaluationId: "demo::low",
    modelAlias: "demo",
    openRouterId: "demo/vision-model",
    reasoningMode: "low",
    rateLimitGroup: "g-demo",
  },
] as const;

// Distinct valid 1x1 PNGs; hashes become the content-addressed asset names.
const IMAGES = [
  {
    mediaType: "image/png",
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  },
  {
    mediaType: "image/png",
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  },
] as const;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function optionAnswer(index: number): string {
  return ["A", "B", "C", "D"][index % 4] ?? "A";
}

function wrongAnswer(index: number): string {
  return optionAnswer(index + 1);
}

function timestamp(day: string, seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${day}T00:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}.000Z`;
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(join(outputDir, "benchmark-images"), { recursive: true });

const imageAssets = IMAGES.map((image) => {
  const sha256 = sha256Hex(image.bytes);
  const fileName = `${sha256}.png`;
  writeFileSync(join(outputDir, "benchmark-images", fileName), image.bytes);
  return {
    sha256,
    path: `benchmark-images/${fileName}`,
    mediaType: image.mediaType,
    byteLength: image.bytes.byteLength,
  };
});

const database = openSqliteDatabase(join(outputDir, "benchmark.sqlite"));
createPublicationSchema(database);

const insert = (sql: string, params: SqlValue[]): void => {
  database.prepare(sql).run(...params);
};

// `createPublicationSchema` already records the schema/exporter versions.
insert("INSERT OR REPLACE INTO publication_meta (key, value) VALUES (?, ?)", [
  "created_at",
  "2026-01-05T00:00:00.000Z",
]);

interface RunInput {
  runId: string;
  rootRunId: string;
  runKind: string;
  parentRunId: string | null;
  createdAt: string;
  lifecycleState: string;
  fixtureCount: number;
  recoveredFixtureCount: number;
  promptVersion: number;
}

function insertRun(run: RunInput): void {
  insert(
    `INSERT INTO runs
       (run_id, root_run_id, run_kind, parent_run_id, created_at, updated_at,
        lifecycle_state, set_name, dataset_path, dataset_sha256, fixture_count,
        prompt_version, scorer_version, config_sha256, code_revision, code_dirty,
        recovered_fixture_count, content_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      run.runId,
      run.rootRunId,
      run.runKind,
      run.parentRunId,
      run.createdAt,
      run.createdAt,
      run.lifecycleState,
      "verification-set",
      "MMStar.tsv",
      DATASET_SHA,
      run.fixtureCount,
      run.promptVersion,
      1,
      "config-sha",
      "verify123",
      0,
      run.recoveredFixtureCount,
      `content-${run.runId}`,
    ],
  );
}

insertRun({
  runId: ROOT_RUN,
  rootRunId: ROOT_RUN,
  runKind: "primary",
  parentRunId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lifecycleState: "completed",
  fixtureCount: FIXTURE_COUNT,
  recoveredFixtureCount: 0,
  promptVersion: 1,
});
insertRun({
  runId: RECOVERY_RUN,
  rootRunId: ROOT_RUN,
  runKind: "recovery",
  parentRunId: ROOT_RUN,
  createdAt: "2026-01-02T00:00:00.000Z",
  lifecycleState: "completed",
  fixtureCount: 6,
  recoveredFixtureCount: 6,
  promptVersion: 1,
});
insertRun({
  runId: RESTART_RUN,
  rootRunId: RESTART_RUN,
  runKind: "restart",
  parentRunId: ROOT_RUN,
  createdAt: "2026-01-03T00:00:00.000Z",
  lifecycleState: "running",
  fixtureCount: FIXTURE_COUNT,
  recoveredFixtureCount: 0,
  promptVersion: 1,
});
insertRun({
  runId: RESTART_RECOVERY_RUN,
  rootRunId: RESTART_RUN,
  runKind: "recovery",
  parentRunId: RESTART_RUN,
  createdAt: "2026-01-04T00:00:00.000Z",
  lifecycleState: "completed",
  fixtureCount: 3,
  recoveredFixtureCount: 3,
  // Deliberately different frozen settings so the mixed-settings notice renders.
  promptVersion: 2,
});

for (const evaluation of EVALUATIONS) {
  insert(
    `INSERT INTO evaluations
       (evaluation_id, model_alias, open_router_id, reasoning_mode, rate_limit_group, provider_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      evaluation.evaluationId,
      evaluation.modelAlias,
      evaluation.openRouterId,
      evaluation.reasoningMode,
      evaluation.rateLimitGroup,
      null,
    ],
  );
}

for (let index = 0; index < FIXTURE_COUNT; index += 1) {
  const fixtureId = String(index + 1).padStart(3, "0");
  const asset = imageAssets[index % imageAssets.length];
  if (asset === undefined) throw new Error("missing image asset");
  insert(
    `INSERT INTO fixtures
       (fixture_id, question, answer, category, l2_category, bench,
        image_sha256, image_path, image_media_type, image_byte_length)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixtureId,
      `Demo question ${fixtureId}: choose the option that matches the image.`,
      optionAnswer(index),
      index % 2 === 0 ? "physics" : "math",
      `${index % 2 === 0 ? "mechanics" : "algebra"}-l2`,
      "mmstar",
      asset.sha256,
      asset.path,
      asset.mediaType,
      asset.byteLength,
    ],
  );
}

interface OutcomeInput {
  runId: string;
  evaluationId: string;
  fixtureId: string;
  state: string;
  kind: string | null;
  parsedAnswer: string | null;
  responseText: string | null;
  responseTruncated?: boolean;
  usageKnown: boolean;
  costKind: string;
  costUsd: number | null;
  requestLatencyMs: number | null;
  totalFixtureTimeMs: number | null;
  attemptCount: number;
  indeterminate?: boolean;
  failureCategory?: string | null;
  failureMessage?: string | null;
  failureHttpStatus?: number | null;
  failureRetryAfterMs?: number | null;
  lineageSourceRunId?: string | null;
  updatedAt: string;
}

function insertOutcome(outcome: OutcomeInput): void {
  insert(
    `INSERT INTO outcomes
       (run_id, evaluation_id, fixture_id, state, kind, response_text,
        response_truncated, parsed_answer, usage_known, usage_prompt_tokens,
        usage_completion_tokens, usage_total_tokens, usage_reasoning_tokens,
        cost_kind, cost_usd, request_latency_ms, total_fixture_time_ms,
        attempt_count, indeterminate, failure_category, failure_message,
        failure_http_status, failure_retry_after_ms, lineage_source_run_id,
        lineage_source_outcome_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      outcome.runId,
      outcome.evaluationId,
      outcome.fixtureId,
      outcome.state,
      outcome.kind,
      outcome.responseText,
      outcome.responseTruncated === true ? 1 : 0,
      outcome.parsedAnswer,
      outcome.usageKnown ? 1 : 0,
      outcome.usageKnown ? 100 : null,
      outcome.usageKnown ? 12 : null,
      outcome.usageKnown ? 112 : null,
      outcome.usageKnown ? 8 : null,
      outcome.costKind,
      outcome.costUsd,
      outcome.requestLatencyMs,
      outcome.totalFixtureTimeMs,
      outcome.attemptCount,
      outcome.indeterminate === true ? 1 : 0,
      outcome.failureCategory ?? null,
      outcome.failureMessage ?? null,
      outcome.failureHttpStatus ?? null,
      outcome.failureRetryAfterMs ?? null,
      outcome.lineageSourceRunId ?? null,
      null,
      outcome.updatedAt,
    ],
  );
}

interface AttemptInput {
  runId: string;
  evaluationId: string;
  fixtureId: string;
  attemptNumber: number;
  state: string;
  submitted: boolean;
  finished: boolean;
  usageKnown: boolean;
  costKind: string;
  costUsd: number | null;
  failureCategory?: string | null;
  failureMessage?: string | null;
  failureHttpStatus?: number | null;
  failureRetryAfterMs?: number | null;
  modelUsed?: string | null;
}

function insertAttempt(attempt: AttemptInput): void {
  const startedAt = timestamp("2026-01-01", attempt.attemptNumber * 3);
  insert(
    `INSERT INTO attempts
       (run_id, attempt_id, evaluation_id, fixture_id, attempt_number, state,
        started_at, submitted_at, finished_at, requested_model, model_used,
        upstream_provider, finish_reason, request_latency_ms, usage_known,
        usage_prompt_tokens, usage_completion_tokens, usage_total_tokens,
        usage_reasoning_tokens, cost_kind, cost_usd, failure_category,
        failure_message, failure_http_status, failure_retry_after_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      attempt.runId,
      `${attempt.runId}-${attempt.evaluationId}-${attempt.fixtureId}-${attempt.attemptNumber}`,
      attempt.evaluationId,
      attempt.fixtureId,
      attempt.attemptNumber,
      attempt.state,
      startedAt,
      attempt.submitted ? timestamp("2026-01-01", attempt.attemptNumber * 3 + 1) : null,
      attempt.finished ? timestamp("2026-01-01", attempt.attemptNumber * 3 + 2) : null,
      "demo/vision-model",
      attempt.modelUsed ?? "demo/vision-model",
      attempt.state === "completed" ? "demo-provider" : null,
      attempt.state === "completed" ? "stop" : null,
      attempt.state === "completed" ? 850 : null,
      attempt.usageKnown ? 1 : 0,
      attempt.usageKnown ? 100 : null,
      attempt.usageKnown ? 12 : null,
      attempt.usageKnown ? 112 : null,
      attempt.usageKnown ? 8 : null,
      attempt.costKind,
      attempt.costUsd,
      attempt.failureCategory ?? null,
      attempt.failureMessage ?? null,
      attempt.failureHttpStatus ?? null,
      attempt.failureRetryAfterMs ?? null,
    ],
  );
}

for (let index = 0; index < FIXTURE_COUNT; index += 1) {
  const fixtureId = String(index + 1).padStart(3, "0");
  const pattern = index % 5;
  const updatedAt = timestamp("2026-01-01", 100 + index * 4);

  // demo::high on the original run: every state the UI distinguishes.
  if (pattern === 3) {
    insertOutcome({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      state: "failed",
      kind: null,
      parsedAnswer: null,
      responseText: null,
      usageKnown: false,
      costKind: "unknown",
      costUsd: null,
      requestLatencyMs: null,
      totalFixtureTimeMs: 120_000,
      attemptCount: 2,
      failureCategory: "timeout",
      failureMessage: "request exceeded the 120s deadline",
      updatedAt,
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      attemptNumber: 1,
      state: "failed",
      submitted: true,
      finished: true,
      usageKnown: false,
      costKind: "unknown",
      costUsd: null,
      failureCategory: "timeout",
      failureMessage: "request exceeded the 120s deadline",
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      attemptNumber: 2,
      state: "failed",
      submitted: false,
      finished: true,
      usageKnown: false,
      costKind: "unknown",
      costUsd: null,
      failureCategory: "timeout",
      failureMessage: "request exceeded the 120s deadline",
    });
  } else if (pattern === 4) {
    insertOutcome({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      state: "settled",
      kind: "correct",
      parsedAnswer: optionAnswer(index),
      responseText: `Answer: ${optionAnswer(index)}`,
      usageKnown: false,
      costKind: "unknown",
      costUsd: null,
      requestLatencyMs: 940,
      totalFixtureTimeMs: 980,
      attemptCount: 1,
      updatedAt,
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      submitted: true,
      finished: true,
      usageKnown: false,
      costKind: "unknown",
      costUsd: null,
    });
  } else if (pattern === 2) {
    insertOutcome({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      state: "settled",
      kind: "ambiguous",
      parsedAnswer: null,
      responseText: "Both A and B could fit the image.",
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0018,
      requestLatencyMs: 810,
      totalFixtureTimeMs: 860,
      attemptCount: 1,
      updatedAt,
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      submitted: true,
      finished: true,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0018,
    });
  } else if (pattern === 1) {
    insertOutcome({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      state: "settled",
      kind: "incorrect",
      parsedAnswer: wrongAnswer(index),
      responseText: `Answer: ${wrongAnswer(index)}`,
      usageKnown: true,
      costKind: "estimated",
      costUsd: 0.0022,
      requestLatencyMs: 1020,
      totalFixtureTimeMs: 1080,
      attemptCount: 1,
      updatedAt,
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      submitted: true,
      finished: true,
      usageKnown: true,
      costKind: "estimated",
      costUsd: 0.0022,
    });
  } else {
    insertOutcome({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      state: "settled",
      kind: "correct",
      parsedAnswer: optionAnswer(index),
      responseText: `Answer: ${optionAnswer(index)}\n\nBecause it matches.`,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0021,
      requestLatencyMs: 780 + index,
      totalFixtureTimeMs: 830 + index,
      attemptCount: 1,
      updatedAt,
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::high",
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      submitted: true,
      finished: true,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0021,
    });
  }

  // demo::none on the original run: indeterminate submissions and truncation.
  if (pattern === 2) {
    insertOutcome({
      runId: ROOT_RUN,
      evaluationId: "demo::none",
      fixtureId,
      state: "indeterminate",
      kind: null,
      parsedAnswer: null,
      responseText: null,
      usageKnown: false,
      costKind: "unknown",
      costUsd: null,
      requestLatencyMs: null,
      totalFixtureTimeMs: null,
      attemptCount: 1,
      indeterminate: true,
      failureCategory: null,
      failureMessage: "submitted before interruption; upstream completion unknown",
      updatedAt,
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::none",
      fixtureId,
      attemptNumber: 1,
      state: "submitted",
      submitted: true,
      finished: false,
      usageKnown: false,
      costKind: "unknown",
      costUsd: null,
    });
  } else if (pattern === 3) {
    insertOutcome({
      runId: ROOT_RUN,
      evaluationId: "demo::none",
      fixtureId,
      state: "settled",
      kind: "truncated",
      parsedAnswer: null,
      responseText: "The answer is likely",
      responseTruncated: true,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0016,
      requestLatencyMs: 1500,
      totalFixtureTimeMs: 1540,
      attemptCount: 1,
      updatedAt,
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::none",
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      submitted: true,
      finished: true,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0016,
    });
  } else if (pattern === 1) {
    insertOutcome({
      runId: ROOT_RUN,
      evaluationId: "demo::none",
      fixtureId,
      state: "settled",
      kind: "incorrect",
      parsedAnswer: wrongAnswer(index),
      responseText: `Answer: ${wrongAnswer(index)}`,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0015,
      requestLatencyMs: 760,
      totalFixtureTimeMs: 800,
      attemptCount: 1,
      updatedAt,
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::none",
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      submitted: true,
      finished: true,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0015,
    });
  } else if (pattern === 4) {
    insertOutcome({
      runId: ROOT_RUN,
      evaluationId: "demo::none",
      fixtureId,
      state: "settled",
      kind: "correct",
      parsedAnswer: optionAnswer(index),
      responseText: `Answer: ${optionAnswer(index)}`,
      usageKnown: true,
      costKind: "estimated",
      costUsd: 0.0014,
      requestLatencyMs: 700,
      totalFixtureTimeMs: 740,
      attemptCount: 1,
      updatedAt,
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::none",
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      submitted: true,
      finished: true,
      usageKnown: true,
      costKind: "estimated",
      costUsd: 0.0014,
    });
  } else {
    insertOutcome({
      runId: ROOT_RUN,
      evaluationId: "demo::none",
      fixtureId,
      state: "settled",
      kind: "correct",
      parsedAnswer: optionAnswer(index),
      responseText: `Answer: ${optionAnswer(index)}`,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0013,
      requestLatencyMs: 690,
      totalFixtureTimeMs: 730,
      attemptCount: 1,
      updatedAt,
    });
    insertAttempt({
      runId: ROOT_RUN,
      evaluationId: "demo::none",
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      submitted: true,
      finished: true,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0013,
    });
  }

  // demo::low on the original run: a complete older result set the restart
  // family shadows (its recovery child settles the same evaluation).
  insertOutcome({
    runId: ROOT_RUN,
    evaluationId: "demo::low",
    fixtureId,
    state: "settled",
    kind: "correct",
    parsedAnswer: optionAnswer(index),
    responseText: `Answer: ${optionAnswer(index)}`,
    usageKnown: true,
    costKind: "reported",
    costUsd: 0.0011,
    requestLatencyMs: 720,
    totalFixtureTimeMs: 760,
    attemptCount: 1,
    updatedAt,
  });
  insertAttempt({
    runId: ROOT_RUN,
    evaluationId: "demo::low",
    fixtureId,
    attemptNumber: 1,
    state: "completed",
    submitted: true,
    finished: true,
    usageKnown: true,
    costKind: "reported",
    costUsd: 0.0011,
  });

  // Recovery run: every timeout failure from demo::high gets a linked outcome.
  if (pattern === 3) {
    const recoveredCorrect = index % 2 === 0;
    insertOutcome({
      runId: RECOVERY_RUN,
      evaluationId: "demo::high",
      fixtureId,
      state: "settled",
      kind: recoveredCorrect ? "correct" : "incorrect",
      parsedAnswer: recoveredCorrect ? optionAnswer(index) : wrongAnswer(index),
      responseText: `Recovered answer: ${recoveredCorrect ? optionAnswer(index) : wrongAnswer(index)}`,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0024,
      requestLatencyMs: 1180,
      totalFixtureTimeMs: 1230,
      attemptCount: 1,
      lineageSourceRunId: ROOT_RUN,
      updatedAt: timestamp("2026-01-02", 200 + index),
    });
    insertAttempt({
      runId: RECOVERY_RUN,
      evaluationId: "demo::high",
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      submitted: true,
      finished: true,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0024,
    });
  }

  // Restart family: pending work on every fixture and every evaluation. The
  // recovery child settles only demo::low, so that evaluation resolves to this
  // newer family wholesale — shadowing the older family's complete demo::low
  // results — while the older family supplies the other two.
  for (const evaluation of EVALUATIONS) {
    insertOutcome({
      runId: RESTART_RUN,
      evaluationId: evaluation.evaluationId,
      fixtureId,
      state: "pending",
      kind: null,
      parsedAnswer: null,
      responseText: null,
      usageKnown: false,
      costKind: "unknown",
      costUsd: null,
      requestLatencyMs: null,
      totalFixtureTimeMs: null,
      attemptCount: 0,
      updatedAt: timestamp("2026-01-03", 100 + index),
    });
  }
  if (index < 3) {
    insertOutcome({
      runId: RESTART_RECOVERY_RUN,
      evaluationId: "demo::low",
      fixtureId,
      state: "settled",
      kind: "correct",
      parsedAnswer: optionAnswer(index),
      responseText: `Answer: ${optionAnswer(index)}`,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0031,
      requestLatencyMs: 890,
      totalFixtureTimeMs: 930,
      attemptCount: 1,
      lineageSourceRunId: RESTART_RUN,
      updatedAt: timestamp("2026-01-04", 100 + index),
    });
    insertAttempt({
      runId: RESTART_RECOVERY_RUN,
      evaluationId: "demo::low",
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      submitted: true,
      finished: true,
      usageKnown: true,
      costKind: "reported",
      costUsd: 0.0031,
    });
  }
}

database.close();
console.log(`[seed-verification] wrote ${outputDir} (${FIXTURE_COUNT} fixtures, 4 runs)`);
