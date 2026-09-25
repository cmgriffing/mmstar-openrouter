import type { ExecutionConfig, ReasoningMode } from "@mmstar/config";
import type { FailureCategory, FailureRecord } from "@mmstar/results";
import { describe, expect, it } from "vitest";
import {
  BenchmarkEngine,
  type BenchmarkEngineOptions,
  type CompletionProvider,
  type EngineClock,
  type EngineFixture,
  type EngineRunResult,
} from "./engine";
import type { EngineEvent } from "./events";
import type { ProviderResult } from "./provider-failure";
import type { PreflightEvaluation } from "./provider-preflight";
import type { ChatCompletionRequestPayload } from "./provider-request";
import type { NormalizedCompletion } from "./provider-response";

const T0 = Date.parse("2026-09-23T00:00:00.000Z");

/** Deterministic manual clock: time only moves when a test advances it. */
class TestClock implements EngineClock {
  private current = T0;
  private waiters: { at: number; resolve: () => void }[] = [];

  now(): number {
    return this.current;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { at: this.current + ms, resolve: () => resolve() };
      if (signal?.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Advance to the earliest pending sleep and resolve every waiter due. */
  advanceToNext(): boolean {
    if (this.waiters.length === 0) return false;
    const next = this.waiters.reduce((min, waiter) => Math.min(min, waiter.at), Number.MAX_VALUE);
    this.current = Math.max(this.current, next);
    const due = this.waiters.filter((waiter) => waiter.at <= this.current);
    this.waiters = this.waiters.filter((waiter) => waiter.at > this.current);
    for (const waiter of due) waiter.resolve();
    return true;
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function driveRun(clock: TestClock, run: Promise<EngineRunResult>): Promise<EngineRunResult> {
  let done = false;
  run.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let i = 0; i < 2_000 && !done; i++) {
    await flush();
    if (done) break;
    clock.advanceToNext();
  }
  return run;
}

interface RecordedCall {
  payload: ChatCompletionRequestPayload;
  startedAt: number;
  finishedAt: number;
}

function makeProvider(options: {
  clock: TestClock;
  latencyMs?: number;
  respond: (call: RecordedCall, index: number) => ProviderResult<NormalizedCompletion>;
}): { provider: CompletionProvider; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const provider: CompletionProvider = async (payload, control) => {
    const index = calls.length;
    const call: RecordedCall = {
      payload,
      startedAt: options.clock.now(),
      finishedAt: options.clock.now(),
    };
    calls.push(call);
    const latency = options.latencyMs ?? 0;
    if (latency > 0) await options.clock.sleep(latency, control.signal);
    call.finishedAt = options.clock.now();
    if (control.signal.aborted) return fail("cancelled");
    return options.respond(call, index);
  };
  return { provider, calls };
}

function ok(text: string, finishReason = "stop"): ProviderResult<NormalizedCompletion> {
  return {
    ok: true,
    value: {
      responseId: "gen-1",
      modelUsed: "vendor/x",
      upstreamProvider: "provider-x",
      finishReason,
      responseText: text,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, reasoningTokens: null },
      cost: { kind: "reported", usd: 0.001 },
      rawResponse: null,
    },
  };
}

function okUnknownCost(text: string): ProviderResult<NormalizedCompletion> {
  const base = ok(text);
  if (!base.ok) return base;
  return {
    ok: true,
    value: { ...base.value, usage: null, cost: { kind: "unknown", usd: null } },
  };
}

function fail(
  category: FailureCategory,
  overrides: Partial<FailureRecord> = {},
): ProviderResult<NormalizedCompletion> {
  return {
    ok: false,
    failure: {
      category,
      message: `${category} failure`,
      httpStatus: null,
      retryAfterMs: null,
      ...overrides,
    },
    rawResponse: null,
  };
}

function evaluation(
  alias: string,
  group: string,
  mode: ReasoningMode = "default",
): PreflightEvaluation {
  return {
    evaluationId: `${alias}::${mode}`,
    modelAlias: alias,
    openRouterId: `vendor/${alias}`,
    reasoningMode: mode,
    rateLimitGroup: group,
    provider: null,
    reasoning: null,
  };
}

function fixture(id: string, expectedAnswer = "A", category = "math"): EngineFixture {
  return {
    fixtureId: id,
    category,
    expectedAnswer,
    prompt: {
      fixtureId: id,
      question: `Question ${id}?`,
      image: { mediaType: "image/png" as const, base64: "aGVsbG8=" },
    },
  };
}

function execution(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    maxConcurrentGroups: 4,
    maxRetries: 3,
    requestTimeoutMs: 120_000,
    maxRequestsPerMinute: null,
    resultsRoot: "results",
    ...overrides,
  };
}

interface Harness {
  engine: BenchmarkEngine;
  clock: TestClock;
  calls: RecordedCall[];
  events: EngineEvent[];
  run: () => Promise<EngineRunResult>;
}

function harness(options: {
  evaluations: PreflightEvaluation[];
  fixtures: ReturnType<typeof fixture>[];
  execution?: Partial<ExecutionConfig>;
  respond: (call: RecordedCall, index: number) => ProviderResult<NormalizedCompletion>;
  latencyMs?: number;
  random?: () => number;
  beforeSubmitAttempt?: BenchmarkEngineOptions["beforeSubmitAttempt"];
}): Harness {
  const clock = new TestClock();
  const events: EngineEvent[] = [];
  const { provider, calls } = makeProvider({
    clock,
    ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
    respond: options.respond,
  });
  const engine = new BenchmarkEngine({
    runId: "run-1",
    evaluations: options.evaluations,
    fixtures: options.fixtures,
    execution: execution(options.execution),
    provider,
    clock,
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.beforeSubmitAttempt === undefined
      ? {}
      : { beforeSubmitAttempt: options.beforeSubmitAttempt }),
    sink: (event) => events.push(event),
  });
  return { engine, clock, calls, events, run: () => driveRun(clock, engine.run()) };
}

/** Maximum simultaneous calls, optionally filtered; intervals are half-open. */
function maxConcurrent(calls: RecordedCall[], filter?: (call: RecordedCall) => boolean): number {
  const events: { at: number; delta: number }[] = [];
  for (const call of calls) {
    if (filter !== undefined && !filter(call)) continue;
    events.push({ at: call.startedAt, delta: 1 }, { at: call.finishedAt, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let max = 0;
  for (const event of events) {
    active += event.delta;
    max = Math.max(max, active);
  }
  return max;
}

function groupOf(model: string): string {
  return model.replace("vendor/", "");
}

function outcomeFor(result: EngineRunResult, evaluationId: string, fixtureId: string) {
  const record = result.evaluations.find((entry) => entry.evaluationId === evaluationId);
  return record?.outcomes.find((outcome) => outcome.fixtureId === fixtureId);
}

describe("BenchmarkEngine scheduling", () => {
  it("runs independent groups concurrently under the global group cap", async () => {
    const groups = ["g1", "g2", "g3"];
    const h = harness({
      evaluations: groups.map((group) => evaluation(group, group)),
      fixtures: [fixture("0")],
      execution: { maxConcurrentGroups: 2 },
      latencyMs: 100,
      respond: () => ok("A"),
    });

    const result = await h.run();

    expect(result.state).toBe("completed");
    expect(h.calls).toHaveLength(3);
    expect(maxConcurrent(h.calls)).toBe(2);
    expect(h.events[0]?.type).toBe("run.started");
    expect(h.events.at(-1)?.type).toBe("run.finished");
    expect(h.events.every((event) => event.version === 1)).toBe(true);
  });

  it("keeps one request in flight per group and processes variants in configured order", async () => {
    const h = harness({
      evaluations: [evaluation("a", "shared"), evaluation("b", "shared")],
      fixtures: [fixture("0"), fixture("1"), fixture("2")],
      latencyMs: 50,
      respond: () => ok("A"),
    });

    const result = await h.run();

    const inGroup = h.calls.filter((call) => call.payload.model.startsWith("vendor/"));
    expect(inGroup).toHaveLength(6);
    expect(maxConcurrent(inGroup)).toBe(1);
    expect(h.calls.map((call) => call.payload.messages[0]?.content[0])).toMatchObject([
      { text: expect.stringContaining("Question 0?") },
      { text: expect.stringContaining("Question 1?") },
      { text: expect.stringContaining("Question 2?") },
      { text: expect.stringContaining("Question 0?") },
      { text: expect.stringContaining("Question 1?") },
      { text: expect.stringContaining("Question 2?") },
    ]);
    expect(result.state).toBe("completed");
  });

  it("scopes fixtures to the evaluations that selected them", async () => {
    const h = harness({
      evaluations: [evaluation("a", "shared"), evaluation("b", "shared")],
      fixtures: [fixture("0"), { ...fixture("1"), evaluationIds: ["b::default"] }],
      respond: () => ok("A"),
    });

    const result = await h.run();

    // Fixture 1 belongs to evaluation b only: three calls instead of four.
    const models = h.calls.map((call) => call.payload.model);
    expect(models.filter((model) => model === "vendor/a")).toHaveLength(1);
    expect(models.filter((model) => model === "vendor/b")).toHaveLength(2);
    const callTexts = h.calls.map((call) => {
      const part = call.payload.messages[0]?.content[0];
      return part?.type === "text" ? part.text : "";
    });
    expect(callTexts.filter((text) => text.includes("Question 1?"))).toHaveLength(1);
    expect(outcomeFor(result, "b::default", "1")?.state).toBe("settled");
  });

  it("shares a 429 cooldown across every model in the group while independent groups progress", async () => {
    const h = harness({
      evaluations: [evaluation("a", "shared"), evaluation("b", "shared"), evaluation("c", "g2")],
      fixtures: [fixture("0"), fixture("1"), fixture("2")],
      execution: { maxConcurrentGroups: 2 },
      latencyMs: 10,
      respond: (call, index) => {
        if (groupOf(call.payload.model) === "a" && index === 0) {
          return fail("rate_limit", { httpStatus: 429, retryAfterMs: 1000 });
        }
        return ok("A");
      },
    });

    const result = await h.run();

    const sharedCalls = h.calls.filter((call) => groupOf(call.payload.model) !== "c");
    const firstFailureAt = sharedCalls[0]?.finishedAt ?? 0;
    // The whole group waits: no shared-group request starts during the cooldown.
    const sharedDuringCooldown = sharedCalls.filter(
      (call) => call.startedAt > firstFailureAt && call.startedAt < firstFailureAt + 1000,
    );
    expect(sharedDuringCooldown).toHaveLength(0);
    expect((sharedCalls[1]?.startedAt ?? 0) - firstFailureAt).toBeGreaterThanOrEqual(1000);

    // The independent group keeps progressing while the shared group cools down.
    const independentDuringCooldown = h.calls.filter(
      (call) =>
        groupOf(call.payload.model) === "c" &&
        call.startedAt >= firstFailureAt &&
        call.startedAt < firstFailureAt + 1000,
    );
    expect(independentDuringCooldown.length).toBeGreaterThan(0);

    const cooldownStarted = h.events.find((event) => event.type === "group.cooldown.started");
    expect(cooldownStarted).toMatchObject({ group: "shared", reason: "rate_limit" });
    expect(h.events.some((event) => event.type === "group.cooldown.ended")).toBe(true);
    expect(result.state).toBe("completed");
  });

  it("caps account-wide request rate with a sliding window", async () => {
    const h = harness({
      evaluations: [evaluation("a", "g1")],
      fixtures: [fixture("0"), fixture("1"), fixture("2"), fixture("3")],
      execution: { maxConcurrentGroups: 1, maxRequestsPerMinute: 2 },
      latencyMs: 10,
      respond: () => ok("A"),
    });

    const result = await h.run();

    expect(h.calls).toHaveLength(4);
    for (const call of h.calls) {
      const inWindow = h.calls.filter(
        (other) => other.startedAt > call.startedAt - 60_000 && other.startedAt <= call.startedAt,
      );
      expect(inWindow.length).toBeLessThanOrEqual(2);
    }
    expect((h.calls[2]?.startedAt ?? 0) - (h.calls[0]?.startedAt ?? 0)).toBeGreaterThanOrEqual(
      60_000,
    );
    expect(
      h.events.some(
        (event) => event.type === "group.cooldown.started" && event.reason === "request_cap",
      ),
    ).toBe(true);
    expect(result.state).toBe("completed");
  });
});

describe("BenchmarkEngine events", () => {
  it("carries evaluation group/model and observed provider for live monitoring", async () => {
    const h = harness({
      evaluations: [evaluation("alpha", "group-a", "high")],
      fixtures: [fixture("0")],
      respond: () => ok("A"),
    });

    await h.run();

    expect(h.events.find((event) => event.type === "evaluation.started")).toMatchObject({
      evaluationId: "alpha::high",
      modelAlias: "alpha",
      openRouterId: "vendor/alpha",
      reasoningMode: "high",
      rateLimitGroup: "group-a",
    });
    expect(h.events.find((event) => event.type === "attempt.finished")).toMatchObject({
      modelUsed: "vendor/x",
      upstreamProvider: "provider-x",
    });
  });

  it("lists planned evaluations with scoped fixture counts on run.started", async () => {
    const h = harness({
      evaluations: [evaluation("alpha", "group-a"), evaluation("beta", "group-b")],
      fixtures: [{ ...fixture("0"), evaluationIds: ["alpha::default"] }, fixture("1")],
      respond: () => ok("A"),
    });

    await h.run();

    const started = h.events.find((event) => event.type === "run.started");
    if (started?.type !== "run.started") throw new Error("no run.started event");
    expect(started.totalEvaluations).toBe(2);
    expect(started.totalFixtures).toBe(2);
    expect(started.evaluations).toEqual([
      {
        evaluationId: "alpha::default",
        modelAlias: "alpha",
        openRouterId: "vendor/alpha",
        reasoningMode: "default",
        rateLimitGroup: "group-a",
        fixtures: 2,
      },
      {
        evaluationId: "beta::default",
        modelAlias: "beta",
        openRouterId: "vendor/beta",
        reasoningMode: "default",
        rateLimitGroup: "group-b",
        fixtures: 1,
      },
    ]);
  });

  it("reports no observed provider when an attempt never reached a provider", async () => {
    const h = harness({
      evaluations: [evaluation("alpha", "group-a")],
      fixtures: [fixture("0")],
      respond: () => fail("timeout"),
    });

    await h.run();

    const finished = h.events.filter((event) => event.type === "attempt.finished");
    expect(finished.length).toBeGreaterThan(0);
    for (const event of finished) {
      expect(event).toMatchObject({ modelUsed: null, upstreamProvider: null });
    }
  });

  it("advertises the scheduled retry time only while a retry is pending", async () => {
    const h = harness({
      evaluations: [evaluation("alpha", "group-a")],
      fixtures: [fixture("0")],
      execution: { maxRetries: 1 },
      latencyMs: 10,
      random: () => 0.5,
      respond: (_call, index) => (index === 0 ? fail("network") : ok("A")),
    });

    await h.run();

    const finished = h.events.filter((event) => event.type === "attempt.finished");
    expect(finished).toHaveLength(2);
    const first = finished[0];
    const second = finished[1];
    if (first?.type !== "attempt.finished" || second?.type !== "attempt.finished") {
      throw new Error("expected attempt.finished events");
    }
    expect(first.retryAt).toBe(new Date(T0 + 10 + 250 + 0.5 * (1_000 - 250)).toISOString());
    expect(second.retryAt).toBeNull();
  });

  it("exposes read-only fixture metadata without the image bytes", () => {
    const h = harness({
      evaluations: [evaluation("alpha", "group-a")],
      fixtures: [fixture("7", "B", "physics")],
      respond: () => ok("B"),
    });

    expect(h.engine.getFixtureDetail("7")).toEqual({
      fixtureId: "7",
      category: "physics",
      question: "Question 7?",
      expectedAnswer: "B",
    });
    expect(h.engine.getFixtureDetail("missing")).toBeNull();
  });

  it("awaits beforeSubmitAttempt after attempt.started and before the provider", async () => {
    const order: string[] = [];
    let eventsAtHook: string[] = [];
    let h: Harness;
    h = harness({
      evaluations: [evaluation("alpha", "group-a")],
      fixtures: [fixture("0")],
      respond: () => {
        order.push("provider");
        return ok("A");
      },
      beforeSubmitAttempt: async (attempt) => {
        order.push("hook");
        eventsAtHook = h.events.map((event) => event.type);
        expect(attempt).toEqual({
          evaluationId: "alpha::default",
          fixtureId: "0",
          attemptNumber: 1,
          submittedAt: new Date(T0).toISOString(),
        });
      },
    });

    const result = await h.run();

    expect(result.state).toBe("completed");
    expect(order).toEqual(["hook", "provider"]);
    expect(eventsAtHook).toContain("attempt.started");
    expect(eventsAtHook).toContain("evaluation.started");
    expect(eventsAtHook).not.toContain("attempt.finished");
  });

  it("fails the run and skips the provider when the submission hook rejects", async () => {
    let called = false;
    const h = harness({
      evaluations: [evaluation("alpha", "group-a")],
      fixtures: [fixture("0")],
      respond: () => {
        called = true;
        return ok("A");
      },
      beforeSubmitAttempt: async () => {
        throw new Error("marker write failed");
      },
    });

    await expect(h.run()).rejects.toThrow("marker write failed");
    expect(called).toBe(false);
  });

  it("stops and drains every in-flight group when one item's submission hook rejects", async () => {
    const h = harness({
      evaluations: [evaluation("alpha", "group-a"), evaluation("beta", "group-b")],
      fixtures: [fixture("0")],
      // Both groups launch together and stay in flight until the clock advances,
      // so the alpha rejection lands while beta's request is open.
      latencyMs: 10_000,
      respond: () => ok("A"),
      beforeSubmitAttempt: async (attempt) => {
        if (attempt.evaluationId.startsWith("alpha::")) {
          throw new Error("marker write failed");
        }
      },
    });

    await expect(h.run()).rejects.toThrow("marker write failed");
    // Alpha never submitted (its marker failed). Beta's marker was recorded and
    // its provider call aborted by the drain: no request may still be live once
    // run() rejects, or the caller would release the run lock while the engine
    // is still writing.
    expect(h.calls).toHaveLength(1);
    const cancelled = h.events.find(
      (event): event is Extract<EngineEvent, { type: "attempt.finished" }> =>
        event.type === "attempt.finished" && event.evaluationId.startsWith("beta::"),
    );
    expect(cancelled?.state).toBe("cancelled");
    expect(h.events.some((e) => e.type === "engine.stopping" && e.reason === "error")).toBe(true);
    expect(h.engine.state).toBe("stopped");
  });
});

describe("BenchmarkEngine retries and outcomes", () => {
  it("retries transient failures with jittered backoff up to the attempt ceiling", async () => {
    const h = harness({
      evaluations: [evaluation("a", "g1")],
      fixtures: [fixture("0")],
      execution: { maxConcurrentGroups: 1, maxRetries: 3 },
      respond: () => fail("server_error", { httpStatus: 503 }),
      random: () => 0.5,
    });

    const result = await h.run();

    expect(h.calls).toHaveLength(4);
    const deltas = h.calls
      .slice(1)
      .map((call, index) => call.startedAt - (h.calls[index]?.finishedAt ?? 0));
    expect(deltas).toEqual([625, 1125, 2125]);

    const record = result.evaluations[0];
    expect(record?.attempts).toHaveLength(4);
    expect(record?.attempts.every((attempt) => attempt.state === "failed")).toBe(true);
    const outcome = outcomeFor(result, "a::default", "0");
    expect(outcome).toMatchObject({
      state: "failed",
      kind: null,
      attemptCount: 4,
      indeterminate: false,
    });
    expect(outcome?.failure?.category).toBe("server_error");
    expect(result.state).toBe("completed");
  });

  it("honors Retry-After for a rate limit instead of the jittered backoff", async () => {
    let failed = false;
    const h = harness({
      evaluations: [evaluation("a", "g1")],
      fixtures: [fixture("0")],
      execution: { maxConcurrentGroups: 1, maxRetries: 3 },
      respond: () => {
        if (!failed) {
          failed = true;
          return fail("rate_limit", { httpStatus: 429, retryAfterMs: 5000 });
        }
        return ok("A");
      },
      random: () => 0.5,
    });

    const result = await h.run();

    const gap = (h.calls[1]?.startedAt ?? 0) - (h.calls[0]?.finishedAt ?? 0);
    expect(gap).toBe(5000);
    expect(outcomeFor(result, "a::default", "0")?.kind).toBe("correct");
    expect(result.state).toBe("completed");
  });

  it("does not retry permanent request failures but keeps scheduling other fixtures", async () => {
    const h = harness({
      evaluations: [evaluation("a", "g1")],
      fixtures: [fixture("0"), fixture("1")],
      execution: { maxConcurrentGroups: 1, maxRetries: 3 },
      respond: (_call, index) =>
        index === 0 ? fail("invalid_request", { httpStatus: 400 }) : ok("A"),
    });

    const result = await h.run();

    expect(h.calls).toHaveLength(2);
    expect(outcomeFor(result, "a::default", "0")).toMatchObject({
      state: "failed",
      attemptCount: 1,
    });
    expect(outcomeFor(result, "a::default", "1")?.kind).toBe("correct");
  });

  it("halts new scheduling on an authentication failure with an actionable run result", async () => {
    const h = harness({
      evaluations: [evaluation("a", "g1"), evaluation("b", "g2")],
      fixtures: [fixture("0"), fixture("1")],
      execution: { maxConcurrentGroups: 1 },
      respond: () => fail("auth", { httpStatus: 401, message: "Invalid API key" }),
    });

    const result = await h.run();

    expect(h.calls).toHaveLength(1);
    expect(result.state).toBe("failed");
    expect(result.halt?.category).toBe("auth");
    expect(outcomeFor(result, "a::default", "0")?.state).toBe("failed");
    expect(outcomeFor(result, "a::default", "1")?.state).toBe("pending");
    expect(
      h.events.some((event) => event.type === "engine.stopping" && event.reason === "error"),
    ).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", state: "failed" });
  });

  it("marks exhausted timeout uncertainty as indeterminate instead of failed", async () => {
    const h = harness({
      evaluations: [evaluation("a", "g1")],
      fixtures: [fixture("0")],
      execution: { maxConcurrentGroups: 1, maxRetries: 0 },
      respond: () => fail("timeout", { message: "timed out" }),
    });

    const result = await h.run();

    expect(h.calls).toHaveLength(1);
    expect(outcomeFor(result, "a::default", "0")).toMatchObject({
      state: "indeterminate",
      kind: null,
      indeterminate: true,
      attemptCount: 1,
    });
    expect(result.evaluations[0]?.attempts[0]?.state).toBe("indeterminate");
    expect(result.state).toBe("completed");
  });

  it("halts new scheduling on a configuration failure", async () => {
    const h = harness({
      evaluations: [evaluation("a", "g1"), evaluation("b", "g2")],
      fixtures: [fixture("0")],
      execution: { maxConcurrentGroups: 1 },
      respond: () => fail("configuration", { httpStatus: 402, message: "Insufficient credits" }),
    });

    const result = await h.run();

    expect(h.calls).toHaveLength(1);
    expect(result.state).toBe("failed");
    expect(result.halt?.category).toBe("configuration");
    expect(outcomeFor(result, "a::default", "0")?.state).toBe("failed");
    expect(outcomeFor(result, "b::default", "0")?.state).toBe("pending");
  });

  it("does not retry a scored wrong answer or an invalid response", async () => {
    const h = harness({
      evaluations: [evaluation("a", "g1")],
      fixtures: [fixture("0"), fixture("1")],
      respond: (_call, index) => ok(index === 0 ? "B" : "I cannot answer."),
    });

    const result = await h.run();

    expect(h.calls).toHaveLength(2);
    expect(outcomeFor(result, "a::default", "0")).toMatchObject({
      state: "settled",
      kind: "incorrect",
      parsedAnswer: "B",
      attemptCount: 1,
    });
    expect(outcomeFor(result, "a::default", "1")).toMatchObject({
      state: "settled",
      kind: "refused",
      attemptCount: 1,
    });
  });

  it("separates request latency from total fixture time across retries", async () => {
    let failed = false;
    const h = harness({
      evaluations: [evaluation("a", "g1")],
      fixtures: [fixture("0")],
      execution: { maxConcurrentGroups: 1 },
      latencyMs: 100,
      respond: () => {
        if (!failed) {
          failed = true;
          return fail("server_error", { httpStatus: 502 });
        }
        return ok("A");
      },
      random: () => 0.5,
    });

    const result = await h.run();

    const outcome = outcomeFor(result, "a::default", "0");
    expect(outcome?.requestLatencyMs).toBe(100);
    // Retry backoff (625ms) plus both request latencies.
    expect(outcome?.totalFixtureTimeMs).toBeGreaterThanOrEqual(625 + 200);
    expect(outcome?.attemptCount).toBe(2);
  });
});

describe("BenchmarkEngine controls", () => {
  it("stops launching new requests while paused and resumes on demand", async () => {
    const h = harness({
      evaluations: [evaluation("a", "g1"), evaluation("b", "g2")],
      fixtures: [fixture("0"), fixture("1")],
      execution: { maxConcurrentGroups: 2 },
      latencyMs: 200,
      respond: () => ok("A"),
    });

    const run = h.engine.run();
    await flush();
    expect(h.calls).toHaveLength(2);

    h.engine.pause();
    expect(h.events.at(-1)?.type).toBe("engine.paused");
    await flush();
    h.clock.advanceToNext();
    await flush();
    await flush();
    expect(h.calls).toHaveLength(2);

    h.engine.resume();
    expect(h.events.at(-1)?.type).toBe("engine.resumed");
    const result = await driveRun(h.clock, run);
    expect(h.calls).toHaveLength(4);
    expect(result.state).toBe("completed");
  });

  it("gracefully stops: aborts in-flight attempts and leaves unfinished work pending", async () => {
    const h = harness({
      evaluations: [evaluation("a", "g1")],
      fixtures: [fixture("0"), fixture("1")],
      execution: { maxConcurrentGroups: 1 },
      latencyMs: 5000,
      respond: () => ok("A"),
    });

    const run = h.engine.run();
    await flush();
    expect(h.calls).toHaveLength(1);

    h.engine.stop("user");
    const result = await driveRun(h.clock, run);

    expect(result.state).toBe("stopped");
    expect(h.calls).toHaveLength(1);
    expect(outcomeFor(result, "a::default", "0")).toMatchObject({
      state: "cancelled",
      attemptCount: 1,
    });
    expect(result.evaluations[0]?.attempts[0]?.state).toBe("cancelled");
    expect(outcomeFor(result, "a::default", "1")).toMatchObject({
      state: "pending",
      attemptCount: 0,
    });
    expect(
      h.events.some((event) => event.type === "engine.stopping" && event.reason === "user"),
    ).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ type: "run.finished", state: "stopped" });
  });
});

describe("BenchmarkEngine metrics", () => {
  it("aggregates provisional and final metrics from terminal outcomes and attempts", async () => {
    const h = harness({
      evaluations: [evaluation("a", "g1")],
      fixtures: [
        fixture("0", "A", "math"),
        fixture("1", "A", "science"),
        fixture("2", "A", "science"),
      ],
      respond: (_call, index) => {
        if (index === 0) return ok("A");
        if (index === 1) return okUnknownCost("B");
        const base = ok("no option here");
        if (!base.ok) return base;
        return { ok: true, value: { ...base.value, cost: { kind: "estimated", usd: 0.05 } } };
      },
    });

    const result = await h.run();

    expect(result.state).toBe("completed");
    expect(result.metrics).toMatchObject({
      provisional: false,
      totalSelected: 3,
      settledCount: 3,
      coverage: 1,
      correctCount: 1,
      totalSelectedAccuracy: 1 / 3,
      scoredResponseCount: 2,
      scoredResponseAccuracy: 0.5,
      costs: { reportedUsd: 0.001, estimatedUsd: 0.05, knownUsd: 0.001 + 0.05, unknownCount: 1 },
    });
    expect(result.metrics.outcomeCounts).toContainEqual({ kind: "correct", count: 1 });
    expect(result.metrics.outcomeCounts).toContainEqual({ kind: "incorrect", count: 1 });
    expect(result.metrics.outcomeCounts).toContainEqual({ kind: "invalid", count: 1 });
    expect(result.metrics.categoryMetrics).toEqual([
      { category: "math", selected: 1, settled: 1, correct: 1, coverage: 1, accuracy: 1 },
      { category: "science", selected: 2, settled: 2, correct: 0, coverage: 1, accuracy: 0 },
    ]);
    expect(result.metrics.requestLatency.count).toBe(3);
  });
});
