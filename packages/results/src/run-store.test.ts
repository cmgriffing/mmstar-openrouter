import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluationRecord, ModelRecordFile, RunManifest } from "@mmstar/results";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildModelFiles,
  countProgress,
  formatRunId,
  InflightMarkerWriter,
  isProcessAlive,
  modelFileName,
  outcomeIdentity,
  parseRunId,
  RunConflictError,
  RunCorruptError,
  RunLockedError,
  RunNotFoundError,
  RunStore,
  RunVersionError,
  reconcileRun,
  resolveLineage,
} from "../src/node";

const T0 = Date.parse("2026-09-23T03:33:37.000Z");
const RUN_ID = formatRunId(T0, "c17c454e");

let root: string;
let store: RunStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mmstar-run-store-"));
  store = new RunStore({ root, pid: 4242, host: "test-host" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("run paths", () => {
  it("formats and parses run IDs in timestamp order", () => {
    const earlier = formatRunId(T0, "00000000");
    const later = formatRunId(T0 + 1, "00000000");
    expect(later > earlier).toBe(true);
    const parsed = parseRunId(RUN_ID);
    expect(parsed?.createdAtIso).toBe("2026-09-23T03:33:37.000Z");
    expect(parsed?.suffix).toBe("c17c454e");
  });

  it("rejects malformed IDs and traversal attempts", () => {
    expect(parseRunId("../../etc")).toBeNull();
    expect(parseRunId("2026-09-23T03-33-37-000Z_short")).toBeNull();
    expect(parseRunId("2026-13-45T99-99-99-000Z_00000000")).toBeNull();
    expect(() => store.paths("../escape")).toThrow(RunCorruptError);
  });

  it("encodes aliases into safe single-segment filenames", () => {
    expect(modelFileName("gpt-4o")).toBe("gpt-4o.json");
    expect(modelFileName("a/b..c")).toBe("a_2fb..c.json");
    expect(modelFileName("a/b..c").includes("/")).toBe(false);
    expect(modelFileName("a.b-c_d")).toBe("a.b-c_d.json");
  });

  it("builds stable outcome identities", () => {
    expect(outcomeIdentity("a::default", "7")).toBe("a::default::7");
  });
});

describe("run creation and checkpointing", () => {
  it("creates a run, writes model files, and reads them back", () => {
    const manifest = makeManifest();
    store.createRun({ runId: RUN_ID, manifest });
    const [file] = buildModelFiles(manifest, [makeEvaluation()], manifest.updatedAt);
    expect(file).toBeDefined();
    store.writeCheckpoint({ manifest, files: file === undefined ? [] : [file] });

    const reconciled = reconcileRun(store, RUN_ID);
    expect(reconciled.manifest.runId).toBe(RUN_ID);
    expect(reconciled.evaluations).toEqual([makeEvaluation()]);
    expect(reconciled.missingModelFiles).toEqual([]);
  });

  it("refuses to overwrite an existing run ID", () => {
    store.createRun({ runId: RUN_ID, manifest: makeManifest() });
    expect(() => store.createRun({ runId: RUN_ID, manifest: makeManifest() })).toThrow(
      RunConflictError,
    );
  });

  it("leaves no temp files after checkpointing", () => {
    const manifest = makeManifest();
    store.createRun({ runId: RUN_ID, manifest });
    const [file] = buildModelFiles(manifest, [makeEvaluation()], manifest.updatedAt);
    store.writeCheckpoint({ manifest, files: file === undefined ? [] : [file] });
    const runDir = store.paths(RUN_ID).dir;
    expect(readdirSync(runDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
    const modelsDir = store.paths(RUN_ID).modelsDir;
    expect(readdirSync(modelsDir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("reports model files missing relative to the plan", () => {
    const manifest = makeManifest();
    store.createRun({ runId: RUN_ID, manifest });
    const reconciled = reconcileRun(store, RUN_ID);
    expect(reconciled.missingModelFiles).toEqual(["a"]);
  });

  it("rejects manifests whose runId does not match the directory", () => {
    const manifest = makeManifest();
    store.createRun({ runId: RUN_ID, manifest });
    const paths = store.paths(RUN_ID);
    writeFileSync(
      paths.manifestFile,
      JSON.stringify({ ...manifest, runId: formatRunId(T0 + 1, "c17c454e") }),
    );
    expect(() => store.readManifest(RUN_ID)).toThrow(RunCorruptError);
  });

  it("distinguishes corrupt JSON, unsupported versions, and missing files", () => {
    store.createRun({ runId: RUN_ID, manifest: makeManifest() });
    const paths = store.paths(RUN_ID);
    writeFileSync(paths.manifestFile, "{ not json");
    expect(() => store.readManifest(RUN_ID)).toThrow(RunCorruptError);

    writeFileSync(paths.manifestFile, JSON.stringify({ manifestVersion: 99, runId: RUN_ID }));
    expect(() => store.readManifest(RUN_ID)).toThrow(RunVersionError);

    rmSync(paths.manifestFile);
    expect(() => store.readManifest(RUN_ID)).toThrow(RunCorruptError);
  });

  it("rejects duplicate evaluation identities across model files", () => {
    const manifest = makeManifest();
    store.createRun({ runId: RUN_ID, manifest });
    const evaluation = makeEvaluation();
    const base: ModelRecordFile = {
      recordVersion: 1,
      runId: RUN_ID,
      modelAlias: "a",
      openRouterId: "vendor/a",
      evaluations: [evaluation],
      updatedAt: manifest.updatedAt,
    };
    store.writeModelRecord(RUN_ID, base);
    store.writeModelRecord(RUN_ID, { ...base, modelAlias: "b" });
    expect(() => reconcileRun(store, RUN_ID)).toThrow(RunConflictError);
  });
});

describe("in-flight markers and reconciliation", () => {
  it("reports marked submissions next to the persisted outcomes", async () => {
    const manifest = makeManifest();
    store.createRun({ runId: RUN_ID, manifest });
    const evaluation = makeEvaluation();
    const outcome = evaluation.outcomes[0];
    if (outcome === undefined) throw new Error("fixture missing");
    store.writeCheckpoint({
      manifest,
      files: buildModelFiles(
        manifest,
        [{ ...evaluation, outcomes: [{ ...outcome, state: "pending", kind: null }] }],
        manifest.updatedAt,
      ),
    });
    const writer = new InflightMarkerWriter({
      file: store.paths(RUN_ID).inflightFile,
      runId: RUN_ID,
      now: () => T0,
    });
    await writer.record({
      evaluationId: "a::default",
      fixtureId: "0",
      attemptNumber: 1,
      submittedAt: new Date(T0).toISOString(),
    });

    const reconciled = reconcileRun(store, RUN_ID);
    expect(reconciled.inflightAttempts).toEqual([
      {
        evaluationId: "a::default",
        fixtureId: "0",
        attemptNumber: 1,
        submittedAt: new Date(T0).toISOString(),
      },
    ]);
    expect(reconciled.evaluations[0]?.outcomes[0]?.state).toBe("pending");
  });

  it("treats a legacy run without a marker as having no in-flight work", () => {
    store.createRun({ runId: RUN_ID, manifest: makeManifest() });
    expect(reconcileRun(store, RUN_ID).inflightAttempts).toEqual([]);
  });
});

describe("locking", () => {
  it("prevents a second live writer and releases cleanly", () => {
    store.createRun({ runId: RUN_ID, manifest: makeManifest() });
    const liveStore = new RunStore({ root, pid: process.pid, host: "test-host" });
    const lock = liveStore.acquireLock(RUN_ID);
    expect(() => liveStore.acquireLock(RUN_ID)).toThrow(RunLockedError);
    lock.release();
    expect(store.readLock(RUN_ID)).toBeNull();
    const second = liveStore.acquireLock(RUN_ID);
    second.release();
  });

  it("reclaims a lock held by a dead process", () => {
    store.createRun({ runId: RUN_ID, manifest: makeManifest() });
    const paths = store.paths(RUN_ID);
    writeFileSync(
      paths.lockFile,
      JSON.stringify({
        version: 1,
        runId: RUN_ID,
        // A PID that cannot exist: above the Linux/Node process table ceiling.
        pid: 2_147_483_646,
        acquiredAt: new Date(T0).toISOString(),
        host: "test-host",
      }),
    );
    expect(isProcessAlive(2_147_483_646)).toBe(false);
    const lock = store.acquireLock(RUN_ID);
    expect(store.readLock(RUN_ID)?.pid).toBe(4242);
    lock.release();
  });

  it("refuses a live foreign host's lock without force, allows with force", () => {
    store.createRun({ runId: RUN_ID, manifest: makeManifest() });
    const paths = store.paths(RUN_ID);
    const foreignPid = 4_949_949;
    writeFileSync(
      paths.lockFile,
      JSON.stringify({
        version: 1,
        runId: RUN_ID,
        pid: foreignPid,
        acquiredAt: new Date(T0).toISOString(),
        host: "other-host",
      }),
    );
    expect(() => store.acquireLock(RUN_ID)).toThrow(RunLockedError);
    const forced = store.acquireLock(RUN_ID, { force: true });
    forced.release();
  });
});

describe("run selection", () => {
  it("lists runs in timestamp order and ignores other entries", () => {
    writeFileSync(join(root, "not-a-run.txt"), "x");
    store.createRun({
      runId: formatRunId(T0 + 5000, "22222222"),
      manifest: makeManifestAt(T0 + 5000, undefined, formatRunId(T0 + 5000, "22222222")),
    });
    store.createRun({
      runId: formatRunId(T0, "11111111"),
      manifest: makeManifestAt(T0, undefined, formatRunId(T0, "11111111")),
    });
    expect(store.listRunIds()).toEqual([
      formatRunId(T0, "11111111"),
      formatRunId(T0 + 5000, "22222222"),
    ]);
  });

  it("selects --latest by creation time and excludes recovery children", () => {
    const primaryId = formatRunId(T0, "11111111");
    const recoveryId = formatRunId(T0 + 1000, "33333333");
    store.createRun({ runId: primaryId, manifest: makeManifestAt(T0, undefined, primaryId) });
    store.createRun({
      runId: recoveryId,
      manifest: makeManifestAt(
        T0 + 1000,
        {
          kind: "recovery",
          parentRunId: primaryId,
          recoveredFixtureIds: ["0"],
        },
        recoveryId,
      ),
    });
    expect(store.resolveSelector({ latest: true }).runId).toBe(primaryId);
  });

  it("breaks creation-time ties with the run ID", () => {
    const low = formatRunId(T0, "11111111");
    const high = formatRunId(T0, "ffffffff");
    store.createRun({ runId: high, manifest: makeManifestAt(T0, undefined, high) });
    store.createRun({ runId: low, manifest: makeManifestAt(T0, undefined, low) });
    expect(store.resolveSelector({ latest: true }).runId).toBe(high);
  });

  it("rejects conflicting selectors and absent runs", () => {
    expect(() => store.resolveSelector({ runId: RUN_ID, latest: true })).toThrow(RunConflictError);
    expect(() => store.resolveSelector({ latest: true })).toThrow(RunNotFoundError);
    expect(() => store.resolveSelector({ runId: RUN_ID })).toThrow(RunCorruptError);
  });
});

describe("lineage resolution", () => {
  it("resolves a fixture through a recovery child without overwriting the original", () => {
    const primaryId = formatRunId(T0, "11111111");
    const recoveryId = formatRunId(T0 + 1000, "33333333");
    const primary = makeManifestAt(T0, undefined, primaryId);
    const recovery = makeManifestAt(
      T0 + 1000,
      { kind: "recovery", parentRunId: primaryId, recoveredFixtureIds: ["0"] },
      recoveryId,
    );

    store.createRun({ runId: primaryId, manifest: primary });
    store.writeCheckpoint({
      manifest: primary,
      files: buildModelFiles(primary, [makeEvaluation("failed")], primary.updatedAt),
    });

    store.createRun({ runId: recoveryId, manifest: recovery });
    const recovered = makeEvaluation("settled");
    const [file] = buildModelFiles(recovery, [recovered], recovery.updatedAt);
    store.writeCheckpoint({ manifest: recovery, files: file === undefined ? [] : [file] });

    const view = resolveLineage(store, store.readManifest(primaryId));
    const entry = view.effective.get(outcomeIdentity("a::default", "0"));
    expect(entry?.state).toBe("settled");
    expect(entry?.kind).toBe("correct");
    expect(entry?.runId).toBe(recoveryId);

    // The original primary record is untouched.
    const original = reconcileRun(store, primaryId);
    expect(original.evaluations[0]?.outcomes[0]?.state).toBe("failed");
  });
});

describe("progress accounting", () => {
  it("counts pending, settled, and terminal outcomes per plan evaluation", () => {
    const manifest = makeManifest();
    const progress = countProgress(manifest, []);
    expect(progress).toEqual({ total: 1, settled: 0, terminal: 0, remaining: 1 });

    const evaluation = makeEvaluation();
    const firstOutcome = evaluation.outcomes[0];
    if (firstOutcome === undefined) throw new Error("fixture evaluation is missing its outcome");
    evaluation.outcomes.push({ ...firstOutcome, fixtureId: "1", state: "pending" });
    manifest.plan.dataset.fixtureIds.push("1");
    expect(countProgress(manifest, [evaluation])).toEqual({
      total: 2,
      settled: 1,
      terminal: 1,
      remaining: 1,
    });
  });
});

describe("atomic writes", () => {
  it("never exposes a partial manifest (temp file then rename)", () => {
    store.createRun({ runId: RUN_ID, manifest: makeManifest() });
    const manifest = store.readManifest(RUN_ID);
    store.writeManifest(RUN_ID, { ...manifest, lifecycle: { state: "completed", updatedAt: "x" } });
    const text = readFileSync(store.paths(RUN_ID).manifestFile, "utf8");
    expect(JSON.parse(text).lifecycle.state).toBe("completed");
    expect(text.endsWith("\n")).toBe(true);
  });
});

function makeManifest(): RunManifest {
  return makeManifestAt(T0);
}

function makeManifestAt(
  epochMs: number,
  lineage?: RunManifest["lineage"],
  runId?: string,
): RunManifest {
  const iso = new Date(epochMs).toISOString();
  return {
    manifestVersion: 1,
    runId: runId ?? RUN_ID,
    createdAt: iso,
    updatedAt: iso,
    lineage: lineage ?? { kind: "primary", parentRunId: null, recoveredFixtureIds: null },
    code: { revision: null, dirty: true },
    configuration: {
      source: "mmstar.config.json",
      sha256: "config-sha",
      execution: {
        maxConcurrentGroups: 4,
        maxRetries: 3,
        requestTimeoutMs: 120_000,
        maxRequestsPerMinute: null,
        resultsRoot: "results",
      },
    },
    plan: {
      planVersion: 1,
      setName: "demo",
      promptVersion: 1,
      scorerVersion: 1,
      dataset: {
        path: "MMStar.tsv",
        sha256: "dataset-sha",
        fixtureCount: 1,
        fixtureIds: ["0"],
      },
      configSha256: "config-sha",
      evaluations: [
        {
          evaluationId: "a::default",
          modelAlias: "a",
          openRouterId: "vendor/a",
          reasoningMode: "default",
          rateLimitGroup: "g",
          provider: null,
        },
      ],
    },
    capabilities: [
      {
        snapshotVersion: 1,
        modelId: "vendor/a",
        fetchedAt: iso,
        imageInput: true,
        inputModalities: ["text", "image"],
        reasoning: {
          supportedEfforts: ["high"],
          defaultEffort: "high",
          defaultEnabled: true,
          supportsMaxTokens: false,
          mandatory: false,
        },
      },
    ],
    lifecycle: { state: "running", updatedAt: iso },
  };
}

function makeEvaluation(state: "settled" | "failed" = "settled"): EvaluationRecord {
  const settled = state === "settled";
  return {
    evaluationId: "a::default",
    reasoningMode: "default",
    provider: null,
    rateLimitGroup: "g",
    outcomes: [
      {
        fixtureId: "0",
        evaluationId: "a::default",
        state,
        kind: settled ? "correct" : null,
        responseText: settled ? "A" : null,
        parsedAnswer: settled ? "A" : null,
        expectedAnswer: "A",
        usage: null,
        cost: { kind: "unknown", usd: null },
        requestLatencyMs: settled ? 100 : null,
        totalFixtureTimeMs: settled ? 100 : null,
        attemptCount: 1,
        indeterminate: false,
        failure: settled
          ? null
          : { category: "network", message: "boom", httpStatus: null, retryAfterMs: null },
        lineage: { sourceRunId: null, sourceOutcomeId: null },
        updatedAt: new Date(T0).toISOString(),
      },
    ],
    attempts: [],
  };
}
