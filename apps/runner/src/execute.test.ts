/**
 * Chunk 5 verification: durable execution and recovery commands.
 *
 * Every test drives the real `execute` entry point against a temporary working
 * directory, a synthetic two-fixture dataset, and an in-memory provider. No
 * network, no live API key, and no paid request is involved. Where a scenario
 * needs a crash, the durable files are edited directly, which is exactly what a
 * process killed between two file replacements leaves behind.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionProvider, NormalizedCompletion, ProviderResult } from "@mmstar/benchmark";
import {
  InflightMarkerWriter,
  openSqliteDatabase,
  RunStore,
  verifyPublication,
} from "@mmstar/results/node";
import { describe, expect, it, vi } from "vitest";
import { type EngineObserver, execute, type RunContext } from "../src/execute";
import { executeExport } from "../src/export";
import { executeValidate } from "../src/validate";

const T0 = Date.parse("2026-09-23T03:33:37.000Z");

/** 1x1 baseline JPEG; real bytes so the dataset parser's magic-number check passes. */
const JPEG = [
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL",
  "/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
].join("");

const TSV_HEADER = "index\tquestion\tanswer\tcategory\tl2_category\tbench\timage";

interface FixtureSpec {
  index: number;
  question: string;
  answer: string;
  category: string;
}

const FIXTURES: FixtureSpec[] = [
  { index: 0, question: "Which color is the sky?\nA) red B) blue", answer: "B", category: "color" },
  { index: 1, question: "How many legs does a cat have?", answer: "A", category: "animals" },
];

function buildTsv(): string {
  const rows = FIXTURES.map(
    (fixture) =>
      `${fixture.index}\t"${fixture.question}"\t${fixture.answer}\t${fixture.category}\t${fixture.category}-l2\tMMStar\t${JPEG}`,
  );
  return `${[TSV_HEADER, ...rows].join("\n")}\n`;
}

function buildConfig(): string {
  return `${JSON.stringify(
    {
      version: 1,
      dataset: { path: "fixtures.tsv" },
      execution: {
        maxConcurrentGroups: 2,
        maxRetries: 1,
        requestTimeoutMs: 5000,
        maxRequestsPerMinute: null,
        resultsRoot: "results",
      },
      models: {
        alpha: { openRouterId: "vendor/alpha", reasoningModes: ["default"], rateLimitGroup: "g1" },
        beta: { openRouterId: "vendor/beta", reasoningModes: ["default"], rateLimitGroup: "g2" },
      },
      sets: {
        demo: { models: ["alpha", "beta"] },
      },
    },
    null,
    2,
  )}\n`;
}

interface Harness {
  dir: string;
  context: RunContext;
  events: Record<string, unknown>[];
  stderr: string[];
  store: RunStore;
  cleanup: () => void;
}

let suffixCounter = 0;

function harness(options: { provider?: CompletionProvider } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "mmstar-runner-"));
  writeFileSync(join(dir, "fixtures.tsv"), buildTsv());
  writeFileSync(join(dir, "mmstar.config.json"), buildConfig());

  const events: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const context: RunContext = {
    resultsRoot: join(dir, "results"),
    cwd: dir,
    configPath: join(dir, "mmstar.config.json"),
    apiKey: null,
    skipPreflight: true,
    force: false,
    now: () => T0 + suffixCounter * 1000,
    suffix: () => {
      suffixCounter += 1;
      return suffixCounter.toString(16).padStart(8, "0");
    },
    stderr: { write: (text) => stderr.push(text) },
    emit: (payload) => events.push(payload),
    revision: async () => ({ revision: "test-revision", dirty: true }),
    provider: options.provider ?? answerWith("B"),
  };

  return {
    dir,
    context,
    events,
    stderr,
    store: new RunStore({ root: context.resultsRoot }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Deterministic provider: every fixture answered with `letter`. */
function answerWith(letter: string): CompletionProvider {
  return async () => success(letter);
}

function success(text: string): ProviderResult<NormalizedCompletion> {
  return {
    ok: true,
    value: {
      responseId: "test-response",
      modelUsed: "vendor/alpha",
      upstreamProvider: "test-provider",
      finishReason: "stop",
      responseText: text,
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, reasoningTokens: null },
      cost: { kind: "reported", usd: 0.001 },
      rawResponse: { id: "test-response" },
    },
  };
}

function failure(category: string): ProviderResult<NormalizedCompletion> {
  return {
    ok: false,
    failure: {
      category: category as never,
      message: `${category} failure`,
      httpStatus: null,
      retryAfterMs: null,
    },
    rawResponse: null,
  };
}

function lastRunId(harnessRef: Harness): string {
  const ids = harnessRef.store.listRunIds();
  const id = ids[ids.length - 1];
  if (id === undefined) throw new Error("no run was created");
  return id;
}

function readManifest(harnessRef: Harness, runId: string) {
  return JSON.parse(readFileSync(harnessRef.store.paths(runId).manifestFile, "utf8")) as Record<
    string,
    unknown
  >;
}

function allOutcomes(harnessRef: Harness, runId: string) {
  return harnessRef.store
    .readModelRecords(runId)
    .flatMap((file) => file.evaluations)
    .flatMap((evaluation) => evaluation.outcomes)
    .map((outcome) => ({
      evaluationId: outcome.evaluationId,
      fixtureId: outcome.fixtureId,
      state: outcome.state,
      kind: outcome.kind,
      failure: outcome.failure?.category ?? null,
    }));
}

describe("run command (5.1, 5.2)", () => {
  it("reports missing credentials without making a network request", async () => {
    const h = harness();
    delete h.context.provider;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await execute({ mode: "run", set: "demo" }, h.context);
      expect(result.exitCode).not.toBe(0);
      const outcomes = allOutcomes(h, lastRunId(h));
      expect(outcomes.some((outcome) => outcome.failure === "configuration")).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      h.cleanup();
    }
  });

  it("uses OpenRouter when no test provider is injected", async () => {
    const h = harness();
    delete h.context.provider;
    h.context.apiKey = "test-only-key";
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "completion-test",
        model: "vendor/alpha",
        choices: [{ message: { content: "B" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const records = h.store
        .readModelRecords(lastRunId(h))
        .flatMap((file) => file.evaluations)
        .flatMap((evaluation) => evaluation.outcomes);
      expect(records.map((record) => record.failure)).toEqual([null, null, null, null]);
      expect(records.every((record) => record.state === "settled")).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://openrouter.ai/api/v1/chat/completions",
        expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.unstubAllGlobals();
      h.cleanup();
    }
  });

  it("creates a durable run with a frozen manifest and terminal records", async () => {
    const h = harness();
    try {
      const result = await execute({ mode: "run", set: "demo" }, h.context);
      expect(result.exitCode).toBe(0);

      const runId = lastRunId(h);
      const manifest = readManifest(h, runId);
      expect(manifest.lifecycle).toMatchObject({ state: "completed" });
      expect((manifest.plan as { evaluations: unknown[] }).evaluations).toHaveLength(2);
      expect(
        (manifest.configuration as { execution: { maxRetries: number } }).execution.maxRetries,
      ).toBe(1);
      expect(manifest.code).toMatchObject({ revision: "test-revision", dirty: true });

      const outcomes = allOutcomes(h, runId);
      expect(outcomes).toHaveLength(4); // 2 evaluations x 2 fixtures
      expect(outcomes.every((outcome) => outcome.state === "settled")).toBe(true);
      // Fixture 0 expects B and fixture 1 expects A.
      const fixture0 = outcomes.filter((outcome) => outcome.fixtureId === "0");
      expect(fixture0.every((outcome) => outcome.kind === "correct")).toBe(true);

      const stored = h.store.readModelRecords(runId);
      expect(stored.map((file) => file.modelAlias).sort()).toEqual(["alpha", "beta"]);
      expect(
        stored.flatMap((file) => file.evaluations).flatMap((evaluation) => evaluation.attempts),
      ).toHaveLength(4);

      // The run finished event carries the durable counts.
      const finished = h.events.find((event) => event.event === "run.finished");
      expect(finished).toMatchObject({ state: "completed", settled: 4, total: 4, remaining: 0 });
    } finally {
      h.cleanup();
    }
  });

  it("releases the run lock when the baseline checkpoint fails", async () => {
    const h = harness();
    try {
      const emit = h.context.emit;
      let runId: string | null = null;
      h.context.emit = (payload) => {
        if (payload.event === "run.created") {
          runId = String(payload.runId);
          // Occupy the models path with a file so the baseline model write fails
          // before any request is submitted.
          writeFileSync(h.store.paths(runId).modelsDir, "not a directory");
        }
        emit(payload);
      };

      const result = await execute({ mode: "run", set: "demo" }, h.context);
      expect(result.exitCode).toBe(1);
      if (runId === null) throw new Error("no run was created");
      // The single-writer lock must not be stranded by the failed checkpoint.
      const lock = h.store.acquireLock(runId);
      lock.release();
    } finally {
      h.cleanup();
    }
  });

  it("surfaces a marker write failure as a run error without submitting", async () => {
    const h = harness();
    try {
      let providerCalls = 0;
      h.context.provider = async () => {
        providerCalls += 1;
        return success("B");
      };
      const emit = h.context.emit;
      h.context.emit = (payload) => {
        if (payload.event === "run.created") {
          // Occupy the marker path with a directory so the atomic rename fails.
          mkdirSync(h.store.paths(String(payload.runId)).inflightFile);
        }
        emit(payload);
      };

      const result = await execute({ mode: "run", set: "demo" }, h.context);
      expect(result.exitCode).toBe(1);
      expect(providerCalls).toBe(0);
      expect(h.events.some((event) => event.event === "error")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("awaits the final checkpoint before emitting run.finished", async () => {
    const h = harness();
    try {
      let durableStates: string[] = [];
      let durableLifecycle: string | null = null;
      const emit = h.context.emit;
      h.context.emit = (payload) => {
        if (payload.event === "run.finished") {
          const runId = String(payload.runId);
          durableStates = h.store
            .readModelRecords(runId)
            .flatMap((file) => file.evaluations)
            .flatMap((evaluation) => evaluation.outcomes)
            .map((outcome) => outcome.state);
          durableLifecycle = h.store.readManifest(runId).lifecycle.state;
        }
        emit(payload);
      };

      const result = await execute({ mode: "run", set: "demo" }, h.context);
      expect(result.exitCode).toBe(0);
      expect(durableStates).toEqual(["settled", "settled", "settled", "settled"]);
      expect(durableLifecycle).toBe("completed");
    } finally {
      h.cleanup();
    }
  });

  it("exposes engine controls to an observer and treats a user stop as interrupted", async () => {
    // The provider waits for the abort signal, so the engine is still running
    // when the observer's stop request arrives — the real TUI quit path.
    const hangingProvider: CompletionProvider = async (_payload, control) => {
      await new Promise<void>((resolve) => {
        if (control.signal.aborted) {
          resolve();
          return;
        }
        control.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        failure: {
          category: "cancelled",
          message: "cancelled by observer",
          httpStatus: null,
          retryAfterMs: null,
        },
        rawResponse: null,
      };
    };
    const h = harness({ provider: hangingProvider });
    try {
      const holder: { control: EngineObserver | null } = { control: null };
      const observed: string[] = [];
      const runPromise = execute(
        { mode: "run", set: "demo" },
        {
          ...h.context,
          observeEngine: (_engine, control) => {
            holder.control = control;
            observed.push("observed");
          },
        },
      );

      // Config/dataset loading is async, so wait for the engine to exist.
      for (let i = 0; i < 100 && holder.control === null; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(observed).toEqual(["observed"]);

      holder.control?.pause();
      holder.control?.resume();
      holder.control?.stop("user");

      const result = await runPromise;
      expect(result.exitCode).toBe(130);
      const finished = h.events.find((event) => event.event === "run.finished");
      expect(finished?.state).toBe("stopped");
      expect(h.events.some((event) => event.event === "engine.stop-requested")).toBe(true);
      // Shutdown checkpoints leave the cancelled work durable and resumable.
      const runId = lastRunId(h);
      const manifest = readManifest(h, runId);
      expect(manifest.lifecycle).toMatchObject({ state: "stopped" });
    } finally {
      h.cleanup();
    }
  });

  it("reports a usage error when --set is missing", async () => {
    const h = harness();
    try {
      const { requestFromArgs } = await import("../src/execute");
      const parsed = requestFromArgs("benchmark", []);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain("--set");
    } finally {
      h.cleanup();
    }
  });

  it("rejects a dataset that does not match the frozen hash on resume", async () => {
    const h = harness();
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);
      writeFileSync(join(h.dir, "fixtures.tsv"), buildTsv().replace("sky", "ocean"));

      const resumed = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(resumed.exitCode).toBe(1);
      expect(h.events.some((event) => event.kind === "DatasetChangedError")).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe("abortable loading (3.2)", () => {
  it("aborts during dataset loading without creating a run", async () => {
    const h = harness();
    try {
      const controller = new AbortController();
      h.context.signal = controller.signal;
      const promise = execute({ mode: "run", set: "demo" }, h.context);
      // Abort before the async dataset read can complete: the signal is checked
      // around the read and before the run directory is created.
      controller.abort();
      const result = await promise;
      expect(result.exitCode).toBe(130);
      expect(h.store.listRunIds()).toEqual([]);
      expect(h.events.filter((event) => event.event === "run.created")).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("aborts a hanging capability fetch without creating a run", async () => {
    const h = harness();
    h.context.skipPreflight = false;
    h.context.apiKey = "test-only-key";
    const controller = new AbortController();
    h.context.signal = controller.signal;
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const promise = execute({ mode: "run", set: "demo" }, h.context);
      setTimeout(() => controller.abort(), 10);
      const result = await promise;
      expect(result.exitCode).toBe(130);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(h.store.listRunIds()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      h.cleanup();
    }
  });

  it("aborts a continuation before its child run is created", async () => {
    const h = harness();
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);
      const controller = new AbortController();
      controller.abort();
      const result = await execute(
        { mode: "resume", selector: { runId } },
        { ...h.context, signal: controller.signal },
      );
      expect(result.exitCode).toBe(130);
      expect(h.store.listRunIds()).toEqual([runId]);
    } finally {
      h.cleanup();
    }
  });
});

describe("resume (5.3)", () => {
  it("fills only pending and interrupted work and preserves completed records", async () => {
    const h = harness();
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);

      // Simulate a crash that lost one model file: reconciliation must report
      // the fixture as pending again and leave the other evaluation untouched.
      const modelPath = join(h.store.paths(runId).modelsDir, "alpha.json");
      const alpha = JSON.parse(readFileSync(modelPath, "utf8")) as {
        evaluations: { outcomes: { fixtureId: string; state: string }[] }[];
      };
      const dropped = alpha.evaluations[0]?.outcomes.pop();
      expect(dropped?.fixtureId).toBe("1");
      writeFileSync(modelPath, JSON.stringify(alpha));

      const result = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(result.exitCode).toBe(0);

      const resumedId = lastRunId(h);
      expect(resumedId).not.toBe(runId);
      const resumed = h.store.readManifest(resumedId);
      expect(resumed.lineage.parentRunId).toBe(runId);
      expect(resumed.lineage.recoveredFixtureIds).toEqual(["1"]);

      // The original run is immutable; the resumed run carries both fixtures.
      const original = allOutcomes(h, runId);
      const recovered = allOutcomes(h, resumedId);
      expect(recovered).toHaveLength(4);
      expect(recovered.filter((outcome) => outcome.fixtureId === "1").length).toBe(2);
      expect(original.filter((outcome) => outcome.fixtureId === "1").length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("resumes work interrupted before any terminal record was written", async () => {
    const h = harness({ provider: async () => failure("network") });
    try {
      // Reproduce a killed process: a durable run directory whose first attempt
      // started but no outcome was ever settled.
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);
      const modelPath = join(h.store.paths(runId).modelsDir, "alpha.json");
      const alpha = JSON.parse(readFileSync(modelPath, "utf8")) as {
        evaluations: {
          outcomes: unknown[];
          attempts: {
            attemptId: string;
            state: string;
            startedAt: string;
            finishedAt: string | null;
          }[];
        }[];
      };
      const evaluation = alpha.evaluations[0];
      if (evaluation === undefined) throw new Error("model file has no evaluation");
      const startedAttempt = evaluation.attempts[0];
      if (startedAttempt === undefined) throw new Error("model file has no attempt");
      startedAttempt.state = "submitted";
      startedAttempt.finishedAt = null;
      const pending = {
        fixtureId: "0",
        evaluationId: "alpha::default",
        state: "pending",
        kind: null,
        responseText: null,
        parsedAnswer: null,
        expectedAnswer: "B",
        usage: null,
        cost: { kind: "unknown", usd: null },
        requestLatencyMs: null,
        totalFixtureTimeMs: null,
        attemptCount: 1,
        indeterminate: false,
        failure: null,
        lineage: { sourceRunId: null, sourceOutcomeId: null },
        updatedAt: new Date(T0).toISOString(),
      };
      evaluation.outcomes = [pending];
      writeFileSync(modelPath, JSON.stringify(alpha));

      h.context.provider = answerWith("B");
      const result = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(result.exitCode).toBe(0);

      const resumedId = lastRunId(h);
      const reconciled = h.store.readModelRecords(resumedId).flatMap((file) => file.evaluations);
      const alphaEvaluation = reconciled.find((record) => record.evaluationId === "alpha::default");
      expect(alphaEvaluation?.outcomes.filter((outcome) => outcome.fixtureId === "0")).toHaveLength(
        1,
      );

      // The interrupted attempt stays in the run that made it...
      const sourceEvaluation = h.store
        .readModelRecords(runId)
        .flatMap((file) => file.evaluations)
        .find((record) => record.evaluationId === "alpha::default");
      const sourceAttempt = sourceEvaluation?.attempts.find(
        (attempt) => attempt.attemptId === startedAttempt.attemptId,
      );
      expect(sourceAttempt).toMatchObject({ state: "submitted", finishedAt: null });

      // ...and the child records its own fresh attempt, with the same
      // deterministic attempt ID. Carrying the parent's attempt instead would
      // drop the child's real request from the billing ledger.
      const childAttempt = alphaEvaluation?.attempts.find((attempt) =>
        attempt.attemptId.startsWith("alpha::default:0:"),
      );
      expect(childAttempt?.state).toBe("completed");
      expect(childAttempt?.finishedAt).not.toBeNull();
      expect(childAttempt?.startedAt).not.toBe(startedAttempt.startedAt);
      expect(alphaEvaluation?.attempts).toHaveLength(2); // fixture 0 and fixture 1
    } finally {
      h.cleanup();
    }
  });

  it("classifies a marked submission without a durable terminal outcome as indeterminate", async () => {
    const h = harness();
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);

      // Reproduce a crash after the marker write but before the outcome
      // checkpoint: fixture 0 is still pending and the marker records that its
      // request was submitted.
      const modelPath = join(h.store.paths(runId).modelsDir, "alpha.json");
      const alpha = JSON.parse(readFileSync(modelPath, "utf8")) as {
        evaluations: { outcomes: Record<string, unknown>[] }[];
      };
      const evaluation = alpha.evaluations[0];
      const first = evaluation?.outcomes[0];
      if (evaluation === undefined || first === undefined) {
        throw new Error("model file has no evaluation outcome");
      }
      evaluation.outcomes = [
        {
          ...first,
          state: "pending",
          kind: null,
          responseText: null,
          parsedAnswer: null,
          requestLatencyMs: null,
          totalFixtureTimeMs: null,
          indeterminate: false,
          failure: null,
        },
      ];
      writeFileSync(modelPath, JSON.stringify(alpha));

      const marker = new InflightMarkerWriter({
        file: h.store.paths(runId).inflightFile,
        runId,
        now: () => T0,
      });
      await marker.record({
        evaluationId: "alpha::default",
        fixtureId: "0",
        attemptNumber: 1,
        submittedAt: new Date(T0).toISOString(),
      });

      h.context.provider = answerWith("B");
      const result = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(result.exitCode).toBe(0);

      const disclosure = h.events.find((event) => event.event === "run.indeterminate-disclosure");
      expect(disclosure?.indeterminateCount).toBe(1);
      expect(h.stderr.join("")).toContain("unknown upstream completion");
    } finally {
      h.cleanup();
    }
  });

  it("does not disclose a marked attempt whose durable attempt is a classified failure", async () => {
    const h = harness();
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);

      // Reproduce a crash during retry backoff: the durable attempt records a
      // classified rate-limit failure, the outcome is still pending, and the
      // marker file has not been rewritten since the attempt finished. The
      // request's completion is known, so resume must not call it unknown.
      const modelPath = join(h.store.paths(runId).modelsDir, "alpha.json");
      const alpha = JSON.parse(readFileSync(modelPath, "utf8")) as {
        evaluations: {
          outcomes: Record<string, unknown>[];
          attempts: Record<string, unknown>[];
        }[];
      };
      const evaluation = alpha.evaluations[0];
      const outcome = evaluation?.outcomes.find((entry) => entry.fixtureId === "0");
      const attempt = evaluation?.attempts.find(
        (entry) => entry.fixtureId === "0" && entry.attemptNumber === 1,
      );
      if (evaluation === undefined || outcome === undefined || attempt === undefined) {
        throw new Error("model file has no fixture 0 records");
      }
      attempt.state = "failed";
      attempt.failure = {
        category: "rate_limit",
        message: "too many requests",
        httpStatus: 429,
        retryAfterMs: null,
      };
      evaluation.outcomes = [
        { ...outcome, state: "pending", kind: null, indeterminate: false, failure: null },
      ];
      writeFileSync(modelPath, JSON.stringify(alpha));

      const marker = new InflightMarkerWriter({
        file: h.store.paths(runId).inflightFile,
        runId,
        now: () => T0,
      });
      await marker.record({
        evaluationId: "alpha::default",
        fixtureId: "0",
        attemptNumber: 1,
        submittedAt: new Date(T0).toISOString(),
      });

      const result = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(result.exitCode).toBe(0);
      expect(h.events.some((event) => event.event === "run.indeterminate-disclosure")).toBe(false);
      expect(h.stderr.join("")).not.toContain("unknown upstream completion");
    } finally {
      h.cleanup();
    }
  });

  it("is a no-op when nothing remains", async () => {
    const h = harness();
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);
      const before = h.store.listRunIds().length;

      const result = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(result.exitCode).toBe(0);
      expect(h.store.listRunIds()).toHaveLength(before);
      expect(h.events.some((event) => event.event === "run.nothing-to-do")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("discloses indeterminate reissue cost uncertainty", async () => {
    const h = harness({ provider: async () => failure("timeout") });
    try {
      // maxRetries is 1 in the fixture config, so each fixture exhausts attempts
      // into an indeterminate outcome.
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);
      const indeterminate = allOutcomes(h, runId).filter(
        (outcome) => outcome.state === "indeterminate",
      );
      expect(indeterminate.length).toBeGreaterThan(0);

      h.context.provider = answerWith("B");
      const result = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(result.exitCode).toBe(0);
      expect(h.stderr.join("")).toContain("unknown upstream completion");
    } finally {
      h.cleanup();
    }
  });
});

describe("retry-failed (5.4)", () => {
  it("creates a recovery run for unresolved failures only and is a no-op after resolution", async () => {
    let calls = 0;
    const h = harness({
      provider: async () => {
        calls += 1;
        // The initial run cannot succeed: it exhausts maxRetries (1) on all
        // four work items (4 items x 2 attempts = 8 calls). Every call after
        // that is the explicitly requested recovery, which must succeed.
        return calls <= 8 ? failure("network") : success("B");
      },
    });
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const primaryId = lastRunId(h);
      expect(
        allOutcomes(h, primaryId).filter((outcome) => outcome.state !== "settled").length,
      ).toBe(4);

      const recovered = await execute(
        { mode: "retry-failed", selector: { runId: primaryId } },
        h.context,
      );
      expect(recovered.exitCode).toBe(0);
      const recoveryId = lastRunId(h);
      expect(recoveryId).not.toBe(primaryId);
      const recovery = h.store.readManifest(recoveryId);
      expect(recovery.lineage.kind).toBe("recovery");
      expect(recovery.lineage.recoveredFixtureIds?.sort()).toEqual(["0", "1"]);

      // The recovery run's own records are terminal, and the original primary
      // run is untouched.
      const recoveredOutcomes = allOutcomes(h, recoveryId);
      expect(recoveredOutcomes).toHaveLength(4);
      expect(recoveredOutcomes.every((outcome) => outcome.state === "settled")).toBe(true);
      expect(allOutcomes(h, primaryId).every((outcome) => outcome.state !== "settled")).toBe(true);

      // Selecting the primary again resolves the whole lineage: nothing left.
      const again = await execute(
        { mode: "retry-failed", selector: { runId: primaryId } },
        h.context,
      );
      expect(again.exitCode).toBe(0);
      expect(h.events.filter((event) => event.event === "run.nothing-to-do")).toHaveLength(1);
      expect(h.store.listRunIds().length).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  it("does not retry an already-scored response", async () => {
    const h = harness({ provider: answerWith("C") }); // always wrong, never retried
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);
      const outcomes = allOutcomes(h, runId);
      expect(outcomes.every((outcome) => outcome.kind === "incorrect")).toBe(true);

      const attempts = h.store
        .readModelRecords(runId)
        .flatMap((file) => file.evaluations)
        .flatMap((evaluation) => evaluation.attempts);
      expect(attempts.every((attempt) => attempt.attemptNumber === 1)).toBe(true);

      const result = await execute({ mode: "retry-failed", selector: { runId } }, h.context);
      expect(result.exitCode).toBe(0);
      expect(h.events.some((event) => event.event === "run.nothing-to-do")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("reissues only the evaluations with unresolved failures for a fixture", async () => {
    const h = harness({
      provider: async (payload) => {
        const part = payload.messages[0]?.content[0];
        const text = part?.type === "text" ? part.text : "";
        if (text.includes("sky") && payload.model === "vendor/alpha") return failure("network");
        return success(text.includes("sky") ? "B" : "A");
      },
    });
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const primaryId = lastRunId(h);
      expect(
        allOutcomes(h, primaryId)
          .filter((outcome) => outcome.state !== "settled")
          .map((outcome) => outcome.fixtureId),
      ).toEqual(["0"]);

      let recoveryCalls = 0;
      const recoveryProvider: CompletionProvider = async (payload) => {
        recoveryCalls += 1;
        const part = payload.messages[0]?.content[0];
        const text = part?.type === "text" ? part.text : "";
        return success(text.includes("sky") ? "B" : "A");
      };
      const result = await execute(
        { mode: "retry-failed", selector: { runId: primaryId } },
        { ...h.context, provider: recoveryProvider },
      );
      expect(result.exitCode).toBe(0);

      const recoveryId = lastRunId(h);
      // Beta already scored fixture 0, so only alpha is reissued for it.
      expect(recoveryCalls).toBe(1);
      const attempts = h.store
        .readModelRecords(recoveryId)
        .flatMap((file) => file.evaluations)
        .flatMap((evaluation) => evaluation.attempts);
      expect(attempts.map((attempt) => attempt.evaluationId)).toEqual(["alpha::default"]);
      expect(h.store.readManifest(recoveryId).lineage.recoveredFixtureIds).toEqual(["0"]);
    } finally {
      h.cleanup();
    }
  });
});

describe("restart (5.4)", () => {
  it("creates a new primary run with the original selection and leaves history intact", async () => {
    const h = harness();
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const originalId = lastRunId(h);

      const result = await execute({ mode: "restart", selector: { runId: originalId } }, h.context);
      expect(result.exitCode).toBe(0);
      const restartedId = lastRunId(h);
      const restarted = h.store.readManifest(restartedId);
      expect(restarted.lineage).toMatchObject({ kind: "restart", parentRunId: originalId });
      expect(restarted.plan.dataset.fixtureIds).toEqual(["0", "1"]);

      // Latest must now select the restart, not the older primary.
      expect(h.store.resolveSelector({ latest: true }).runId).toBe(restartedId);
      expect(allOutcomes(h, originalId)).toHaveLength(4);
      expect(allOutcomes(h, restartedId)).toHaveLength(4);
    } finally {
      h.cleanup();
    }
  });
});

describe("selection and locking errors (5.5)", () => {
  it("rejects conflicting or absent selectors without starting a run", async () => {
    const h = harness();
    try {
      const { requestFromArgs } = await import("../src/execute");
      expect(requestFromArgs("resume", []).ok).toBe(false);
      expect(requestFromArgs("resume", ["id", "--latest"]).ok).toBe(false);
      expect(requestFromArgs("resume", ["a", "b"]).ok).toBe(false);

      const result = await execute({ mode: "resume", selector: { runId: "missing" } }, h.context);
      expect(result.exitCode).toBe(1);
      expect(h.store.listRunIds()).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("refuses a locked run without starting a competing run", async () => {
    const h = harness({ provider: async () => failure("network") });
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);
      const runsBefore = h.store.listRunIds().length;

      const held = h.store.acquireLock(runId);
      const locked = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(locked.exitCode).toBe(1);
      expect(h.events.some((event) => event.kind === "RunLockedError")).toBe(true);
      // The lock was respected: resume neither created a run nor submitted work.
      expect(h.store.listRunIds()).toHaveLength(runsBefore);
      held.release();
    } finally {
      h.cleanup();
    }
  });

  it("reports a corrupt manifest instead of guessing another run", async () => {
    const h = harness();
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);
      writeFileSync(h.store.paths(runId).manifestFile, "{ broken");

      const corrupt = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(corrupt.exitCode).toBe(1);
      expect(h.events.some((event) => event.kind === "RunCorruptError")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("keeps --latest on the primary run after a recovery child exists", async () => {
    let calls = 0;
    const h = harness({
      provider: async () => {
        calls += 1;
        return calls <= 8 ? failure("network") : success("B");
      },
    });
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const primaryId = lastRunId(h);
      await execute({ mode: "retry-failed", selector: { runId: primaryId } }, h.context);
      expect(h.store.resolveSelector({ latest: true }).runId).toBe(primaryId);
    } finally {
      h.cleanup();
    }
  });
});

describe("validate command", () => {
  it("reports the dataset hash and set expansion without creating a run", async () => {
    const h = harness();
    try {
      const result = await executeValidate(h.context, { preflight: false });
      expect(result.exitCode).toBe(0);
      const ok = h.events.find((event) => event.event === "validate.ok");
      if (ok === undefined) throw new Error("validate did not emit a summary event");
      expect((ok.dataset as { fixtures: number }).fixtures).toBe(2);
      expect((ok.sets as unknown[]).length).toBe(1);
      expect(h.store.listRunIds()).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("reports an invalid config as a validation error", async () => {
    const h = harness();
    try {
      writeFileSync(join(h.dir, "mmstar.config.json"), JSON.stringify({ version: 2 }));
      const result = await executeValidate(h.context, { preflight: false });
      expect(result.exitCode).toBe(2);
      expect(h.events.some((event) => event.kind === "ValidationError")).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

/** Chunk 11.2: error paths across the command, persistence, and export boundaries. */
describe("hardening boundaries (11.2)", () => {
  function buildReasoningNoneConfig(): string {
    return `${JSON.stringify(
      {
        version: 1,
        dataset: { path: "fixtures.tsv" },
        execution: {
          maxConcurrentGroups: 2,
          maxRetries: 1,
          requestTimeoutMs: 5000,
          maxRequestsPerMinute: null,
          resultsRoot: "results",
        },
        models: {
          alpha: {
            openRouterId: "vendor/alpha",
            reasoningModes: ["default"],
            rateLimitGroup: "g1",
          },
          beta: { openRouterId: "vendor/beta", reasoningModes: ["default"], rateLimitGroup: "g2" },
          gamma: { openRouterId: "vendor/gamma", reasoningModes: ["none"], rateLimitGroup: "g3" },
        },
        sets: { demo: { models: ["alpha", "beta", "gamma"] } },
      },
      null,
      2,
    )}\n`;
  }

  it("halts on an authentication failure, keeps the partial run auditable, and publishes it", async () => {
    let calls = 0;
    const h = harness({
      provider: async () => {
        calls += 1;
        return calls === 1 ? failure("auth") : success("B");
      },
    });
    try {
      const result = await execute({ mode: "run", set: "demo" }, h.context);
      expect(result.exitCode).toBe(1);

      const runId = lastRunId(h);
      expect(readManifest(h, runId).lifecycle).toMatchObject({ state: "failed" });
      const finished = h.events.find((event) => event.event === "run.finished");
      expect(finished?.halt).not.toBeNull();

      const outcomes = allOutcomes(h, runId);
      expect(outcomes.filter((outcome) => outcome.state === "failed")).toHaveLength(1);
      expect(outcomes.find((outcome) => outcome.state === "failed")?.failure).toBe("auth");
      expect(outcomes.some((outcome) => outcome.state === "pending")).toBe(true);
      const authAttempts = h.store
        .readModelRecords(runId)
        .flatMap((file) => file.evaluations)
        .flatMap((evaluation) => evaluation.attempts)
        .filter((attempt) => attempt.failure?.category === "auth");
      expect(authAttempts).toHaveLength(1);

      // An operator must fix credentials first; retry-failed must not reissue it.
      const retry = await execute({ mode: "retry-failed", selector: { runId } }, h.context);
      expect(retry.exitCode).toBe(0);
      expect(h.events.some((event) => event.event === "run.nothing-to-do")).toBe(true);
      expect(h.store.listRunIds()).toHaveLength(1);

      // The halted family still exports: a partial run is publishable evidence.
      const outDir = join(h.dir, "publication");
      const exported = await executeExport(h.context, { latest: true, all: false, outDir });
      expect(exported.exitCode).toBe(0);
      verifyPublication(outDir);
      const database = openSqliteDatabase(join(outDir, "benchmark.sqlite"), { readOnly: true });
      try {
        const row = database
          .prepare("SELECT COUNT(*) AS n FROM outcomes WHERE failure_category = 'auth'")
          .get();
        expect(Number(row?.n)).toBe(1);
        const attempts = database.prepare("SELECT COUNT(*) AS n FROM attempts").get();
        expect(Number(attempts?.n)).toBeGreaterThanOrEqual(1);
      } finally {
        database.close();
      }
    } finally {
      h.cleanup();
    }
  });

  it("fails closed on a corrupt model file before resuming any work", async () => {
    const h = harness();
    try {
      await execute({ mode: "run", set: "demo" }, h.context);
      const runId = lastRunId(h);
      const runsBefore = h.store.listRunIds().length;

      writeFileSync(join(h.store.paths(runId).modelsDir, "alpha.json"), "{ broken");
      h.context.provider = async () => {
        throw new Error("provider must not be called for a corrupt run");
      };
      const result = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(result.exitCode).toBe(1);
      expect(h.events.some((event) => event.kind === "RunCorruptError")).toBe(true);
      expect(h.store.listRunIds()).toHaveLength(runsBefore);
    } finally {
      h.cleanup();
    }
  });

  it("rejects a continuation when frozen capabilities no longer support the plan", async () => {
    const h = harness();
    try {
      writeFileSync(join(h.dir, "mmstar.config.json"), buildReasoningNoneConfig());
      const first = await execute({ mode: "run", set: "demo" }, h.context);
      expect(first.exitCode).toBe(0);
      const runId = lastRunId(h);

      // Lose one outcome so resume has work, then mark the model's reasoning as
      // mandatory in the frozen snapshot: `none` can no longer be requested.
      const modelPath = join(h.store.paths(runId).modelsDir, "alpha.json");
      const alpha = JSON.parse(readFileSync(modelPath, "utf8")) as {
        evaluations: { outcomes: unknown[] }[];
      };
      alpha.evaluations[0]?.outcomes.pop();
      writeFileSync(modelPath, JSON.stringify(alpha));
      const manifestPath = h.store.paths(runId).manifestFile;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        capabilities: { modelId: string; reasoning: { mandatory: boolean } }[];
      };
      const gamma = manifest.capabilities.find((item) => item.modelId === "vendor/gamma");
      if (gamma === undefined) throw new Error("gamma capability snapshot missing");
      gamma.reasoning.mandatory = true;
      writeFileSync(manifestPath, JSON.stringify(manifest));

      let calls = 0;
      h.context.provider = async () => {
        calls += 1;
        return success("B");
      };
      const resumed = await execute({ mode: "resume", selector: { runId } }, h.context);
      expect(resumed.exitCode).toBe(2);
      expect(h.events.some((event) => event.kind === "ValidationError")).toBe(true);
      expect(calls).toBe(0);
      expect(h.store.listRunIds()).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});
