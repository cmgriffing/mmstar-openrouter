/**
 * Publication projection, import, image extraction, and full-publish tests.
 *
 * These drive the real `node:sqlite` binding (available in Node and Bun) and
 * the real filesystem under a temp directory, so the schema, views, atomic
 * swap, and verification path are exercised, not mocked.
 */
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluationPlan, ExecutionConfig } from "@mmstar/config";
import { afterEach, describe, expect, it } from "vitest";
import { PublicationConflictError, PublicationImageError } from "../errors";
import type { AttemptRecord, EvaluationRecord, OutcomeRecord, RunManifest } from "../records";
import { writeImageAssets } from "./images";
import { publishPublication } from "./publish";
import {
  buildFixtureRows,
  buildPublicationRows,
  type PublicationFixtureInput,
  type PublicationRunProjection,
} from "./rows";
import { createPublicationSchema } from "./schema";
import { openSqliteDatabase } from "./sqlite-node";
import { verifyPublication } from "./verify";
import { importPublicationRows } from "./write";

const EXECUTION: ExecutionConfig = {
  maxConcurrentGroups: 4,
  maxRetries: 3,
  requestTimeoutMs: 120_000,
  maxRequestsPerMinute: null,
  resultsRoot: "results",
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString(
  "base64",
);

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mmstar-publication-"));
  created.push(dir);
  return dir;
}

function fixtureInput(
  fixtureId: string,
  base64 = TINY_PNG_BASE64,
  mediaType = "image/png",
): PublicationFixtureInput {
  return {
    fixtureId,
    question: `question ${fixtureId}`,
    answer: "A",
    category: fixtureId === "0" ? "biology" : "chemistry",
    l2Category: "l2",
    bench: "mmstar",
    image: { mediaType, base64 },
  };
}

function makePlan(
  setName: string,
  fixtureIds: readonly string[],
  evaluations: EvaluationPlan["evaluations"],
  datasetSha256 = "dataset-sha",
): EvaluationPlan {
  return {
    planVersion: 1,
    setName,
    promptVersion: 1,
    scorerVersion: 1,
    dataset: {
      path: "MMStar.tsv",
      sha256: datasetSha256,
      fixtureCount: fixtureIds.length,
      fixtureIds: [...fixtureIds],
    },
    configSha256: null,
    evaluations,
  };
}

const EVALUATION = {
  evaluationId: "alpha::high",
  modelAlias: "alpha",
  openRouterId: "vendor/model",
  reasoningMode: "high" as const,
  rateLimitGroup: "g-alpha",
  provider: null,
};

function makeManifest(overrides: {
  runId: string;
  createdAt?: string;
  fixtureIds?: readonly string[];
  lineage?: RunManifest["lineage"];
  evaluations?: EvaluationPlan["evaluations"];
}): RunManifest {
  return {
    manifestVersion: 1,
    runId: overrides.runId,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    lineage: overrides.lineage ?? {
      kind: "primary",
      parentRunId: null,
      recoveredFixtureIds: null,
    },
    code: { revision: "abc123", dirty: false },
    configuration: { source: null, sha256: null, execution: EXECUTION },
    plan: makePlan("default", overrides.fixtureIds ?? ["0"], overrides.evaluations ?? [EVALUATION]),
    capabilities: [],
    lifecycle: { state: "completed", updatedAt: "2026-01-01T00:00:00.000Z" },
  };
}

function makeAttempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    attemptId: "alpha::high:0:1",
    evaluationId: "alpha::high",
    fixtureId: "0",
    attemptNumber: 1,
    state: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    submittedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: "2026-01-01T00:00:02.000Z",
    requestedModel: "vendor/model",
    modelUsed: "vendor/model",
    upstreamProvider: "provider-a",
    finishReason: "stop",
    requestLatencyMs: 1000,
    usage: {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      reasoningTokens: 5,
    },
    cost: { kind: "reported", usd: 0.002 },
    failure: null,
    rawResponseRef: "raw/alpha-high-0-1.json",
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    fixtureId: "0",
    evaluationId: "alpha::high",
    state: "settled",
    kind: "correct",
    responseText: "A",
    parsedAnswer: "A",
    expectedAnswer: "A",
    usage: {
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      reasoningTokens: 5,
    },
    cost: { kind: "reported", usd: 0.002 },
    requestLatencyMs: 1000,
    totalFixtureTimeMs: 1100,
    attemptCount: 1,
    indeterminate: false,
    failure: null,
    lineage: { sourceRunId: null, sourceOutcomeId: null },
    updatedAt: "2026-01-01T00:00:02.000Z",
    ...overrides,
  };
}

function makeEvaluation(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    evaluationId: "alpha::high",
    reasoningMode: "high",
    provider: null,
    rateLimitGroup: "g-alpha",
    outcomes: [makeOutcome()],
    attempts: [makeAttempt()],
    ...overrides,
  };
}

function makeProjection(
  manifest: RunManifest,
  evaluations: readonly EvaluationRecord[],
  sourceSha256 = `source-${manifest.runId}`,
): PublicationRunProjection {
  return { manifest, evaluations, sourceSha256 };
}

async function importInto(
  database: ReturnType<typeof openSqliteDatabase>,
  projections: readonly PublicationRunProjection[],
  fixtures: readonly PublicationFixtureInput[],
): Promise<ReturnType<typeof importPublicationRows>> {
  const assets = writeImageAssets(fixtures, join(tempDir(), "images"));
  const fixtureRows = buildFixtureRows(
    fixtures,
    new Map(assets.assets.map((asset) => [asset.fixtureId, asset])),
  );
  const rows = await buildPublicationRows({ runs: projections, fixtures: fixtureRows });
  return importPublicationRows(database, rows);
}

describe("publication rows and views", () => {
  it("resolves the newest scored outcome without double-counting and keeps full costs", async () => {
    const source = makeManifest({ runId: "20260101T000000_aaaaaaaa" });
    const recovery = makeManifest({
      runId: "20260102T000000_bbbbbbbb",
      createdAt: "2026-01-02T00:00:00.000Z",
      lineage: {
        kind: "recovery",
        parentRunId: source.runId,
        recoveredFixtureIds: ["0"],
      },
    });
    const failedOutcome = makeOutcome({
      state: "failed",
      kind: null,
      responseText: null,
      parsedAnswer: null,
      usage: null,
      cost: { kind: "reported", usd: 0.001 },
      indeterminate: false,
      failure: {
        category: "timeout",
        message: "request timed out",
        httpStatus: null,
        retryAfterMs: null,
      },
      lineage: { sourceRunId: null, sourceOutcomeId: null },
    });
    const recoveredOutcome = makeOutcome({
      cost: { kind: "reported", usd: 0.003 },
      lineage: { sourceRunId: source.runId, sourceOutcomeId: null },
    });

    const database = openSqliteDatabase(":memory:");
    createPublicationSchema(database);
    const summary = await importInto(
      database,
      [
        makeProjection(source, [
          makeEvaluation({ outcomes: [failedOutcome], attempts: [makeAttempt()] }),
        ]),
        makeProjection(recovery, [
          makeEvaluation({ outcomes: [recoveredOutcome], attempts: [makeAttempt()] }),
        ]),
      ],
      [fixtureInput("0")],
    );

    expect(summary.insertedRuns).toEqual([source.runId, recovery.runId]);
    expect(summary.skippedRuns).toEqual([]);

    const effective = database
      .prepare("SELECT run_id, state, kind FROM v_effective_outcomes")
      .all();
    expect(effective).toEqual([{ run_id: recovery.runId, state: "settled", kind: "correct" }]);

    const original = database.prepare("SELECT run_id, state FROM v_original_outcomes").all();
    expect(original).toEqual([{ run_id: source.runId, state: "failed" }]);

    const recoveryView = database.prepare("SELECT run_id FROM v_recovery_outcomes").all();
    expect(recoveryView).toEqual([{ run_id: recovery.runId }]);

    const summaryView = database
      .prepare("SELECT selected, settled, correct, failed, attempts FROM v_evaluation_summary")
      .get();
    expect(summaryView).toEqual({
      selected: 1,
      settled: 1,
      correct: 1,
      failed: 0,
      attempts: 1,
    });

    // Attempt costs are a ledger: both the failed original and the recovery are
    // counted, while the effective view counts the fixture once.
    const totals = database
      .prepare("SELECT run_id, reported_usd, known_usd FROM v_attempt_totals ORDER BY run_id")
      .all();
    expect(totals).toEqual([
      { run_id: source.runId, reported_usd: 0.002, known_usd: 0.002 },
      { run_id: recovery.runId, reported_usd: 0.002, known_usd: 0.002 },
    ]);

    const drilldown = database
      .prepare(
        "SELECT effective_run_id, expected_answer, category, image_path FROM v_fixture_drilldown",
      )
      .get();
    expect(drilldown?.effective_run_id).toBe(recovery.runId);
    expect(drilldown?.expected_answer).toBe("A");
    expect(drilldown?.category).toBe("biology");
    expect(String(drilldown?.image_path)).toMatch(/^benchmark-images\/[0-9a-f]{64}\.png$/);
    database.close();
  });

  it("is idempotent on repeat import", async () => {
    const source = makeManifest({ runId: "20260101T000000_aaaaaaaa" });
    const database = openSqliteDatabase(":memory:");
    createPublicationSchema(database);
    const projections = [makeProjection(source, [makeEvaluation()])];
    const fixtures = [fixtureInput("0")];

    await importInto(database, projections, fixtures);
    const second = await importInto(database, projections, fixtures);

    expect(second.insertedRuns).toEqual([]);
    expect(second.skippedRuns).toEqual([source.runId]);
    expect(second.insertedOutcomes).toBe(0);
    expect(second.insertedAttempts).toBe(0);
    const counts = database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM runs) AS runs, (SELECT COUNT(*) FROM outcomes) AS outcomes, (SELECT COUNT(*) FROM attempts) AS attempts",
      )
      .get();
    expect(counts).toEqual({ runs: 1, outcomes: 1, attempts: 1 });
    database.close();
  });

  it("fails on conflicting content for an existing ID", async () => {
    const source = makeManifest({ runId: "20260101T000000_aaaaaaaa" });
    const database = openSqliteDatabase(":memory:");
    createPublicationSchema(database);
    await importInto(database, [makeProjection(source, [makeEvaluation()])], [fixtureInput("0")]);

    // A changed outcome changes the run fingerprint.
    await expect(
      importInto(
        database,
        [
          makeProjection(source, [
            makeEvaluation({ outcomes: [makeOutcome({ responseText: "B" })] }),
          ]),
        ],
        [fixtureInput("0")],
      ),
    ).rejects.toBeInstanceOf(PublicationConflictError);

    // A changed fixture row conflicts even when the run graph is unchanged.
    const changedFixture = { ...fixtureInput("0"), question: "different question" };
    const assets = writeImageAssets([changedFixture], join(tempDir(), "images2"));
    const rows = await buildPublicationRows({
      runs: [makeProjection(source, [makeEvaluation()])],
      fixtures: buildFixtureRows(
        [changedFixture],
        new Map(assets.assets.map((asset) => [asset.fixtureId, asset])),
      ),
    });
    expect(() => importPublicationRows(database, rows)).toThrow(PublicationConflictError);
    database.close();
  });

  it("bounds public responses and omits raw response references", async () => {
    const source = makeManifest({ runId: "20260101T000000_aaaaaaaa" });
    const longResponse = "x".repeat(25_000);
    const database = openSqliteDatabase(":memory:");
    createPublicationSchema(database);
    await importInto(
      database,
      [
        makeProjection(source, [
          makeEvaluation({ outcomes: [makeOutcome({ responseText: longResponse })] }),
        ]),
      ],
      [fixtureInput("0")],
    );

    const row = database.prepare("SELECT response_text, response_truncated FROM outcomes").get();
    expect(String(row?.response_text)).toHaveLength(20_000);
    expect(row?.response_truncated).toBe(1);

    const columns = database
      .prepare("PRAGMA table_info(outcomes)")
      .all()
      .map((column) => String(column.name));
    expect(columns).not.toContain("raw_response_ref");
    expect(columns).not.toContain("expected_answer");
    database.close();
  });

  it("refuses a database that is not a publication or uses an unsupported schema", async () => {
    const source = makeManifest({ runId: "20260101T000000_aaaaaaaa" });
    const projections = [makeProjection(source, [makeEvaluation()])];
    const fixtures = [fixtureInput("0")];

    const empty = openSqliteDatabase(":memory:");
    await expect(importInto(empty, projections, fixtures)).rejects.toThrow(/not a publication/);
    empty.close();

    const wrongVersion = openSqliteDatabase(":memory:");
    createPublicationSchema(wrongVersion);
    wrongVersion
      .prepare("UPDATE publication_meta SET value = '999' WHERE key = 'schema_version'")
      .run();
    await expect(importInto(wrongVersion, projections, fixtures)).rejects.toThrow(/schema version/);
    wrongVersion.close();
  });

  it("computes roots deterministically across a family", async () => {
    const source = makeManifest({ runId: "20260101T000000_aaaaaaaa" });
    const recovery = makeManifest({
      runId: "20260102T000000_bbbbbbbb",
      createdAt: "2026-01-02T00:00:00.000Z",
      lineage: {
        kind: "recovery",
        parentRunId: source.runId,
        recoveredFixtureIds: ["0"],
      },
    });
    const database = openSqliteDatabase(":memory:");
    createPublicationSchema(database);
    // Import the child first: root resolution must not depend on insertion order.
    await importInto(
      database,
      [makeProjection(recovery, [makeEvaluation()]), makeProjection(source, [makeEvaluation()])],
      [fixtureInput("0")],
    );
    const roots = database.prepare("SELECT run_id, root_run_id FROM runs ORDER BY run_id").all();
    expect(roots).toEqual([
      { run_id: source.runId, root_run_id: source.runId },
      { run_id: recovery.runId, root_run_id: source.runId },
    ]);
    database.close();
  });
});

describe("image extraction", () => {
  it("deduplicates identical bytes and validates media types", () => {
    const directory = join(tempDir(), "images");
    const result = writeImageAssets(
      [fixtureInput("0"), fixtureInput("1"), fixtureInput("2", TINY_JPEG_BASE64, "image/jpeg")],
      directory,
    );
    expect(result.fileCount).toBe(2);
    expect(result.assets[0]?.relativePath).toBe(result.assets[1]?.relativePath);
    expect(result.assets[2]?.relativePath).toMatch(/\.jpg$/);
    const firstPath = result.assets[0]?.relativePath.split("/")[1] ?? "";
    expect(readFileSync(join(directory, firstPath)).byteLength).toBeGreaterThan(0);

    expect(() =>
      writeImageAssets([fixtureInput("3", TINY_JPEG_BASE64, "image/png")], directory),
    ).toThrow(PublicationImageError);
    expect(() => writeImageAssets([fixtureInput("4", "not-base64!")], directory)).toThrow(
      PublicationImageError,
    );
  });
});

describe("publishPublication", () => {
  it("publishes, verifies, replaces atomically, and preserves the old artifact on failure", async () => {
    const root = tempDir();
    const outputDir = join(root, "publication");
    const source = makeManifest({ runId: "20260101T000000_aaaaaaaa" });
    const projections = [makeProjection(source, [makeEvaluation()])];
    const fixtures = [fixtureInput("0")];
    const dataset = { path: "MMStar.tsv", sha256: "dataset-sha" };

    const first = await publishPublication({
      outputDir,
      resultsRoot: join(root, "results"),
      dataset,
      runs: projections,
      fixtures,
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    expect(first.manifest.images.fileCount).toBe(1);
    expect(first.manifest.runs.rootRunIds).toEqual([source.runId]);
    const verified = verifyPublication(outputDir);
    expect(verified.manifest.dataset.sha256).toBe("dataset-sha");
    expect(verified.manifest.createdAt).toBe("2026-01-03T00:00:00.000Z");

    // A repeat publish replaces the directory but stays verifiable.
    await publishPublication({
      outputDir,
      resultsRoot: join(root, "results"),
      dataset,
      runs: projections,
      fixtures,
      now: () => new Date("2026-01-04T00:00:00.000Z"),
    });
    expect(verifyPublication(outputDir).manifest.createdAt).toBe("2026-01-04T00:00:00.000Z");

    // Corrupt image input fails, and the previous publication is untouched.
    const badFixture = fixtureInput("0", TINY_JPEG_BASE64, "image/png");
    await expect(
      publishPublication({
        outputDir,
        resultsRoot: join(root, "results"),
        dataset,
        runs: projections,
        fixtures: [badFixture],
        now: () => new Date("2026-01-05T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(PublicationImageError);
    expect(verifyPublication(outputDir).manifest.createdAt).toBe("2026-01-04T00:00:00.000Z");

    // A tampered image is caught by verification.
    const manifest = verifyPublication(outputDir).manifest;
    const imagePath = join(outputDir, manifest.images.entries[0]?.path ?? "");
    writeFileSync(imagePath, Buffer.from([0x00, 0x01, 0x02]));
    expect(() => verifyPublication(outputDir)).toThrow();

    // A missing image file is equally fatal.
    rmSync(imagePath);
    expect(() => verifyPublication(outputDir)).toThrow(/image directory/);
  });

  it("restores a publication left moved aside by a crash before rebuilding", async () => {
    const root = tempDir();
    const outputDir = join(root, "publication");
    const source = makeManifest({ runId: "20260101T000000_aaaaaaaa" });
    const input = {
      outputDir,
      resultsRoot: join(root, "results"),
      dataset: { path: "MMStar.tsv", sha256: "dataset-sha" },
      runs: [makeProjection(source, [makeEvaluation()])],
      fixtures: [fixtureInput("0")],
    };

    await publishPublication({ ...input, now: () => new Date("2026-01-03T00:00:00.000Z") });
    // Simulate a crash between the two renames: the old artifact is a sibling
    // and the canonical path is gone.
    renameSync(outputDir, `${outputDir}.old-crash`);
    await publishPublication({ ...input, now: () => new Date("2026-01-06T00:00:00.000Z") });
    expect(verifyPublication(outputDir).manifest.createdAt).toBe("2026-01-06T00:00:00.000Z");
    expect(existsSync(`${outputDir}.old-crash`)).toBe(false);
  });
});
