import { describe, expect, it } from "vitest";
import type { ModelRecordFile, RunManifest } from "./index";
import {
  ATTEMPT_STATES,
  CAPABILITY_SNAPSHOT_VERSION,
  COST_KINDS,
  FAILURE_CATEGORIES,
  MODEL_RECORD_VERSION,
  OUTCOME_KINDS,
  OUTCOME_STATES,
  RUN_KINDS,
  RUN_MANIFEST_VERSION,
  RUN_STATES,
} from "./index";

const manifest: RunManifest = {
  manifestVersion: RUN_MANIFEST_VERSION,
  runId: "2026-09-23T00-00-00Z_abcd1234",
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:00:00.000Z",
  lineage: { kind: "primary", parentRunId: null, recoveredFixtureIds: null },
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
    dataset: { path: "MMStar.tsv", sha256: "dataset-sha", fixtureCount: 1, fixtureIds: ["0"] },
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
      snapshotVersion: CAPABILITY_SNAPSHOT_VERSION,
      modelId: "vendor/a",
      fetchedAt: "2026-09-23T00:00:00.000Z",
      imageInput: true,
      inputModalities: ["text", "image"],
      reasoning: {
        supportedEfforts: ["high", "medium", "low"],
        defaultEffort: "medium",
        defaultEnabled: true,
        supportsMaxTokens: false,
        mandatory: false,
      },
    },
  ],
  lifecycle: { state: "running", updatedAt: "2026-09-23T00:00:00.000Z" },
};

const modelRecord: ModelRecordFile = {
  recordVersion: MODEL_RECORD_VERSION,
  runId: manifest.runId,
  modelAlias: "a",
  openRouterId: "vendor/a",
  updatedAt: manifest.updatedAt,
  evaluations: [
    {
      evaluationId: "a::default",
      reasoningMode: "default",
      provider: null,
      rateLimitGroup: "g",
      attempts: [
        {
          attemptId: "a::default:0:1",
          evaluationId: "a::default",
          fixtureId: "0",
          attemptNumber: 1,
          state: "completed",
          startedAt: manifest.createdAt,
          submittedAt: manifest.createdAt,
          finishedAt: manifest.createdAt,
          requestedModel: "vendor/a",
          modelUsed: "vendor/a",
          upstreamProvider: "provider-a",
          finishReason: "stop",
          requestLatencyMs: 1200,
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, reasoningTokens: null },
          cost: { kind: "reported", usd: 0.001 },
          failure: null,
          rawResponseRef: null,
        },
      ],
      outcomes: [
        {
          fixtureId: "0",
          evaluationId: "a::default",
          state: "settled",
          kind: "correct",
          responseText: "A",
          parsedAnswer: "A",
          expectedAnswer: "A",
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, reasoningTokens: null },
          cost: { kind: "reported", usd: 0.001 },
          requestLatencyMs: 1200,
          totalFixtureTimeMs: 1210,
          attemptCount: 1,
          indeterminate: false,
          failure: null,
          lineage: { sourceRunId: null, sourceOutcomeId: null },
          updatedAt: manifest.updatedAt,
        },
      ],
    },
  ],
};

describe("run record contracts", () => {
  it("round-trips through JSON without losing unknown-versus-zero distinctions", () => {
    const parsed = JSON.parse(JSON.stringify({ manifest, modelRecord })) as {
      manifest: RunManifest;
      modelRecord: ModelRecordFile;
    };
    expect(parsed.manifest).toEqual(manifest);
    expect(parsed.modelRecord).toEqual(modelRecord);

    const unknownCost = { kind: "unknown", usd: null };
    expect(JSON.parse(JSON.stringify(unknownCost))).toEqual(unknownCost);
    expect(parsed.modelRecord.evaluations[0]?.outcomes[0]?.usage?.reasoningTokens).toBeNull();
  });

  it("keeps versioned enum vocabularies stable and complete", () => {
    expect(RUN_KINDS).toEqual(["primary", "recovery", "restart"]);
    expect(RUN_STATES).toEqual([
      "initialized",
      "running",
      "paused",
      "completed",
      "stopped",
      "failed",
    ]);
    expect(OUTCOME_STATES).toEqual(["pending", "settled", "failed", "indeterminate", "cancelled"]);
    expect(OUTCOME_KINDS).toEqual([
      "correct",
      "incorrect",
      "ambiguous",
      "invalid",
      "refused",
      "truncated",
    ]);
    expect(ATTEMPT_STATES).toContain("submitted");
    expect(FAILURE_CATEGORIES).toContain("rate_limit");
    expect(COST_KINDS).toEqual(["reported", "estimated", "unknown"]);
    expect(CAPABILITY_SNAPSHOT_VERSION).toBe(1);
    expect(parsedCapability(manifest)).toEqual({
      supportedEfforts: ["high", "medium", "low"],
      mandatory: false,
    });
  });
});

function parsedCapability(value: RunManifest): { supportedEfforts: unknown; mandatory: unknown } {
  const snapshot = value.capabilities[0];
  if (snapshot === undefined) throw new Error("manifest fixture is missing a capability snapshot");
  return {
    supportedEfforts: snapshot.reasoning.supportedEfforts,
    mandatory: snapshot.reasoning.mandatory,
  };
}
