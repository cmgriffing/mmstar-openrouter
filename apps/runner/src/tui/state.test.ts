import type { EngineEvent } from "@mmstar/benchmark";
import { describe, expect, it } from "vitest";
import {
  activeCooldown,
  applyEngineEvent,
  applyLifecycleEvent,
  completedCount,
  estimateRemainingMs,
  initialViewState,
  MAX_ACTIVITY,
  type RunnerViewState,
  RunViewStore,
  rowStatus,
} from "./state";

const AT = "2026-09-23T00:00:00.000Z";

type Payload<T extends EngineEvent["type"]> = Omit<
  Extract<EngineEvent, { type: T }>,
  "type" | "version" | "at"
>;

function event<T extends EngineEvent["type"]>(
  type: T,
  payload: Payload<T>,
  at: string = AT,
): EngineEvent {
  return { type, version: 1, at, ...payload } as EngineEvent;
}

function started(): RunnerViewState {
  return applyEngineEvent(
    initialViewState(),
    event("run.started", { runId: "run-1", totalEvaluations: 2, totalFixtures: 4 }),
  );
}

function withEvaluation(state: RunnerViewState, alias = "alpha", group = "g1") {
  return applyEngineEvent(
    state,
    event("evaluation.started", {
      evaluationId: `${alias}::high`,
      modelAlias: alias,
      openRouterId: `vendor/${alias}`,
      reasoningMode: "high",
      rateLimitGroup: group,
    }),
  );
}

function attemptFinished(
  state: RunnerViewState,
  fixtureId: string,
  provider: string | null = "provider-x",
  alias = "alpha",
) {
  return applyEngineEvent(
    state,
    event("attempt.finished", {
      evaluationId: `${alias}::high`,
      fixtureId,
      attemptNumber: 1,
      state: "completed",
      failure: null,
      usage: null,
      cost: { kind: "unknown", usd: null },
      modelUsed: provider === null ? null : "vendor/x",
      upstreamProvider: provider,
    }),
  );
}

function settle(
  state: RunnerViewState,
  fixtureId: string,
  outcomeState: "settled" | "failed" | "indeterminate" | "cancelled",
  kind: "correct" | "incorrect" | null = null,
  alias = "alpha",
) {
  return applyEngineEvent(
    state,
    event("outcome.settled", {
      evaluationId: `${alias}::high`,
      fixtureId,
      state: outcomeState,
      kind,
      requestLatencyMs: null,
      totalFixtureTimeMs: null,
    }),
  );
}

function firstRow(state: RunnerViewState): NonNullable<RunnerViewState["rows"][number]> {
  const row = state.rows[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

describe("RunViewStore engine-state reduction", () => {
  it("initializes identity and work totals from run.started", () => {
    const state = applyEngineEvent(
      initialViewState(),
      event("run.started", { runId: "run-1", totalEvaluations: 2, totalFixtures: 4 }),
    );

    expect(state.status).toBe("running");
    expect(state.runId).toBe("run-1");
    expect(state.totalEvaluations).toBe(2);
    expect(state.totalFixtures).toBe(4);
    expect(state.startedAtMs).toBe(Date.parse(AT));
  });

  it("adds a model/group row with the frozen fixture total", () => {
    const state = withEvaluation(started());

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      evaluationId: "alpha::high",
      modelAlias: "alpha",
      openRouterId: "vendor/alpha",
      reasoningMode: "high",
      group: "g1",
      actualProvider: null,
      total: 4,
      attempts: 0,
      inFlight: 0,
    });
  });

  it("tracks attempts, in-flight state, and the last observed provider", () => {
    let state = withEvaluation(started());
    state = applyEngineEvent(
      state,
      event("attempt.started", {
        evaluationId: "alpha::high",
        fixtureId: "0",
        attemptNumber: 1,
      }),
    );
    expect(state.rows[0]).toMatchObject({ attempts: 1, inFlight: 1 });

    state = attemptFinished(state, "0");
    expect(state.rows[0]).toMatchObject({
      attempts: 1,
      inFlight: 0,
      actualProvider: "provider-x",
    });
  });

  it("keeps the last known provider when a later attempt never reached one", () => {
    let state = withEvaluation(started());
    state = attemptFinished(state, "0", "provider-x");
    state = attemptFinished(state, "1", null);

    expect(state.rows[0]?.actualProvider).toBe("provider-x");
  });

  it("counts terminal outcomes per state without double counting", () => {
    let state = withEvaluation(started());
    state = settle(state, "0", "settled", "correct");
    state = settle(state, "1", "settled", "incorrect");
    state = settle(state, "2", "failed");
    state = settle(state, "3", "cancelled");

    expect(state.counts).toMatchObject({
      pending: 0,
      settled: 2,
      failed: 1,
      indeterminate: 0,
      cancelled: 1,
    });
    expect(completedCount(state)).toBe(4);
  });

  it("tracks and clears group cooldowns with their reason", () => {
    let state = started();
    state = applyEngineEvent(
      state,
      event("group.cooldown.started", {
        group: "g1",
        until: "2026-09-23T00:00:05.000Z",
        reason: "rate_limit",
      }),
    );

    expect(activeCooldown(state, "g1", Date.parse(AT))).toMatchObject({
      group: "g1",
      reason: "rate_limit",
      untilMs: Date.parse("2026-09-23T00:00:05.000Z"),
    });
    expect(activeCooldown(state, "g2", Date.parse(AT))).toBeNull();
    expect(activeCooldown(state, "g1", Date.parse("2026-09-23T00:00:06.000Z"))).toBeNull();

    state = applyEngineEvent(state, event("group.cooldown.ended", { group: "g1" }));
    expect(state.cooldowns).toHaveLength(0);
  });

  it("derives a row status that never depends on color", () => {
    let state = withEvaluation(started());
    expect(rowStatus(state, firstRow(state), Date.parse(AT))).toBe("queued");

    state = applyEngineEvent(
      state,
      event("attempt.started", {
        evaluationId: "alpha::high",
        fixtureId: "0",
        attemptNumber: 1,
      }),
    );
    expect(rowStatus(state, firstRow(state), Date.parse(AT))).toBe("running");

    state = attemptFinished(state, "0");
    state = settle(state, "0", "settled", "correct");
    expect(rowStatus(state, firstRow(state), Date.parse(AT))).toBe("queued");

    state = applyEngineEvent(
      state,
      event("group.cooldown.started", {
        group: "g1",
        until: "2026-09-23T00:00:05.000Z",
        reason: "request_cap",
      }),
    );
    expect(rowStatus(state, firstRow(state), Date.parse(AT))).toBe("cooldown");
  });

  it("marks a row done or failed once every fixture is terminal", () => {
    let state = withEvaluation(started());
    for (const fixtureId of ["0", "1", "2"]) state = settle(state, fixtureId, "settled", "correct");
    state = settle(state, "3", "failed");

    expect(rowStatus(state, firstRow(state), Date.parse(AT))).toBe("failed");

    let clean = withEvaluation(
      applyEngineEvent(
        initialViewState(),
        event("run.started", { runId: "run-1", totalEvaluations: 1, totalFixtures: 1 }),
      ),
    );
    clean = settle(clean, "0", "settled", "correct");
    expect(rowStatus(clean, firstRow(clean), Date.parse(AT))).toBe("done");
  });

  it("estimates remaining time from completed work and elapsed time", () => {
    let state = withEvaluation(
      applyEngineEvent(
        initialViewState(),
        event("run.started", { runId: "run-1", totalEvaluations: 1, totalFixtures: 4 }),
      ),
    );
    state = settle(state, "0", "settled", "correct");
    state = settle(state, "1", "settled", "correct");

    expect(estimateRemainingMs(state, Date.parse(AT) + 1_000)).toBe(1_000);
    expect(estimateRemainingMs(state, Date.parse(AT))).toBeNull();

    for (const fixtureId of ["2", "3"]) state = settle(state, fixtureId, "settled", "correct");
    expect(estimateRemainingMs(state, Date.parse(AT) + 2_000)).toBe(0);
  });

  it("freezes estimates and status at run.finished", () => {
    let state = withEvaluation(started());
    state = settle(state, "0", "settled", "correct");
    state = applyEngineEvent(state, event("run.finished", { runId: "run-1", state: "completed" }));

    expect(state.status).toBe("completed");
    expect(state.finished).toBe(true);
    expect(estimateRemainingMs(state, Date.parse(AT) + 60_000)).toBe(0);
  });

  it("bounds activity history while keeping the newest entries", () => {
    let state = withEvaluation(started());
    for (let index = 0; index < MAX_ACTIVITY * 3; index++) {
      state = settle(state, String(index), "failed");
    }

    expect(state.activity.length).toBeLessThanOrEqual(MAX_ACTIVITY);
    expect(state.activity.at(-1)?.summary).toContain(`fixture ${MAX_ACTIVITY * 3 - 1}`);
    expect(state.activity[0]?.summary).not.toContain("fixture 0 ");
  });

  it("logs failures and wrong answers but not every correct answer", () => {
    let state = withEvaluation(started());
    state = settle(state, "0", "settled", "correct");
    const onlyCorrect = state.activity.length;
    state = settle(state, "1", "settled", "incorrect");
    state = settle(state, "2", "failed");

    expect(state.activity.length).toBeGreaterThan(onlyCorrect);
    expect(state.activity.at(-2)?.summary).toContain("incorrect");
    expect(state.activity.at(-1)?.summary).toContain("failed");
  });

  it("mirrors pause, resume, and stop controls", () => {
    let state = started();
    state = applyEngineEvent(state, event("engine.paused", {}));
    expect(state.paused).toBe(true);
    state = applyEngineEvent(state, event("engine.resumed", {}));
    expect(state.paused).toBe(false);
    state = applyEngineEvent(state, event("engine.stopping", { reason: "signal" }));
    expect(state.stopping).toBe("signal");
  });
});

describe("RunViewStore lifecycle payloads", () => {
  it("takes run identity from run.created", () => {
    const state = applyLifecycleEvent(initialViewState(), {
      event: "run.created",
      runId: "run-9",
      mode: "resume",
      setName: "smoke",
      evaluations: 3,
      fixtures: 12,
    });

    expect(state).toMatchObject({
      runId: "run-9",
      mode: "resume",
      setName: "smoke",
      status: "initialized",
      totalEvaluations: 3,
    });
    expect(state.activity.at(-1)?.summary).toContain("run-9");
  });

  it("records a halt and final state from run.finished", () => {
    const state = applyLifecycleEvent(initialViewState(), {
      event: "run.finished",
      runId: "run-1",
      state: "failed",
      settled: 3,
      total: 10,
      remaining: 7,
      halt: { category: "auth", message: "invalid key" },
    });

    expect(state.finalState).toBe("failed");
    expect(state.haltMessage).toContain("invalid key");
    expect(state.finished).toBe(true);
  });

  it("treats nothing-to-do as a clean finish", () => {
    const state = applyLifecycleEvent(initialViewState(), {
      event: "run.nothing-to-do",
      runId: "run-1",
      mode: "resume",
      reason: "no pending work remains",
    });

    expect(state.finished).toBe(true);
    expect(state.activity.at(-1)?.summary).toContain("no pending work remains");
  });

  it("keeps errors as bounded notices and activity", () => {
    const state = applyLifecycleEvent(initialViewState(), {
      event: "error",
      kind: "ValidationError",
      message: "config is invalid",
    });

    expect(state.notices.at(-1)).toContain("config is invalid");
    expect(state.activity.at(-1)?.summary).toContain("config is invalid");
  });
});

describe("RunViewStore subscriptions", () => {
  it("notifies subscribers only when state changes and stops after unsubscribe", () => {
    const store = new RunViewStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    store.applyEngineEvent(
      event("run.started", { runId: "run-1", totalEvaluations: 1, totalFixtures: 1 }),
    );
    expect(calls).toBe(1);
    const snapshot = store.getSnapshot();
    unsubscribe();
    store.applyEngineEvent(event("engine.paused", {}));
    expect(calls).toBe(1);
    expect(store.getSnapshot()).not.toBe(snapshot);
  });

  it("trims notices so repeated warnings cannot grow without bound", () => {
    const store = new RunViewStore();
    for (let index = 0; index < 50; index++) store.addNotice(`notice ${index}`);

    const notices = store.getSnapshot().notices;
    expect(notices.length).toBeLessThanOrEqual(8);
    expect(notices.at(-1)).toContain("notice 49");
  });
});
