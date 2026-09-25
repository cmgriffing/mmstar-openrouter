/**
 * Frame-level tests for the OpenTUI runner components.
 *
 * These run under Bun because the OpenTUI native test renderer is Bun-only;
 * the pure line/state logic is covered by Vitest. Each test drives the real
 * component tree through a test renderer and asserts on captured frames, so
 * focus markers, compact layouts, help, cooldowns, and bounded activity are
 * verified as rendered — not just as computed strings.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { EngineEvent, EngineMetrics } from "@mmstar/benchmark";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { RunnerTui } from "./App";
import { MAX_ACTIVITY, RunViewStore } from "./state";

const AT = "2026-09-23T00:00:00.000Z";
const setups: TestRendererSetup[] = [];

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
});

function event<T extends EngineEvent["type"]>(
  type: T,
  payload: Omit<Extract<EngineEvent, { type: T }>, "type" | "version" | "at">,
): EngineEvent {
  return { type, version: 1, at: AT, ...payload } as EngineEvent;
}

function seededStore(): RunViewStore {
  const store = new RunViewStore();
  store.applyEngineEvent(
    event("run.started", {
      runId: "2026-09-23T00:00:00.000Z_8a716225",
      totalEvaluations: 2,
      totalFixtures: 4,
    }),
  );
  store.applyEngineEvent(
    event("evaluation.started", {
      evaluationId: "alpha::high",
      modelAlias: "alpha",
      openRouterId: "vendor/alpha",
      reasoningMode: "high",
      rateLimitGroup: "group-a",
    }),
  );
  store.applyEngineEvent(
    event("evaluation.started", {
      evaluationId: "beta::default",
      modelAlias: "beta",
      openRouterId: "vendor/beta",
      reasoningMode: "default",
      rateLimitGroup: "group-b",
    }),
  );
  store.applyEngineEvent(
    event("attempt.finished", {
      evaluationId: "alpha::high",
      fixtureId: "0",
      attemptNumber: 1,
      state: "completed",
      failure: null,
      usage: null,
      cost: { kind: "unknown", usd: null },
      modelUsed: "vendor/x",
      upstreamProvider: "provider-x",
    }),
  );
  store.applyEngineEvent(
    event("group.cooldown.started", {
      group: "group-a",
      until: "2026-09-23T00:00:10.000Z",
      reason: "rate_limit",
    }),
  );
  store.applyEngineEvent(
    event("outcome.settled", {
      evaluationId: "alpha::high",
      fixtureId: "3",
      state: "failed",
      kind: null,
      requestLatencyMs: null,
      totalFixtureTimeMs: null,
    }),
  );
  return store;
}

async function renderApp(
  store: RunViewStore,
  width: number,
  height: number,
  callbacks: {
    onQuit?: () => void;
    onPause?: () => void;
    onResume?: () => void;
    onInspect?: (evaluationId: string, fixtureId: string) => void;
  } = {},
) {
  const setup = await testRender(
    <RunnerTui store={store} now={() => Date.parse(AT)} tickMs={0} {...callbacks} />,
    { width, height },
  );
  setups.push(setup);
  await act(async () => {
    await setup.flush();
  });
  return setup;
}

function linesWith(frame: string, needle: string): string[] {
  return frame.split("\n").filter((line) => line.includes(needle));
}

/** The stdin parser flushes buffered input on a short timeout. */
async function press(
  setup: TestRendererSetup,
  input: (keys: TestRendererSetup["mockInput"]) => void | Promise<void>,
) {
  await act(async () => {
    await input(setup.mockInput);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await setup.flush();
  });
}

function metrics(): EngineMetrics {
  return {
    provisional: true,
    totalSelected: 15,
    settledCount: 12,
    coverage: 0.8,
    correctCount: 9,
    totalSelectedAccuracy: 0.6,
    scoredResponseCount: 11,
    scoredResponseAccuracy: 9 / 11,
    stateCounts: [],
    outcomeCounts: [],
    failureCounts: [],
    categoryMetrics: [
      { category: "math", selected: 4, settled: 4, correct: 3, coverage: 1, accuracy: 0.75 },
    ],
    tokens: {
      promptTokens: 1_500,
      completionTokens: 75,
      totalTokens: 1_575,
      reasoningTokens: 300,
      usageUnknownCount: 2,
    },
    costs: { reportedUsd: 0.012, estimatedUsd: 0.003, knownUsd: 0.015, unknownCount: 2 },
    requestLatency: {
      count: 11,
      minMs: 400,
      maxMs: 5_000,
      meanMs: 1_800,
      p50Ms: 1_200,
      p95Ms: 3_400,
    },
    fixtureLatency: { count: 0, minMs: null, maxMs: null, meanMs: null, p50Ms: null, p95Ms: null },
  };
}

describe("RunnerTui rendering", () => {
  test("shows run identity, model rows, cooldown countdown, and activity", async () => {
    const setup = await renderApp(seededStore(), 100, 30);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("2026-09-23T00:00:00.000Z_8a716225");
    expect(frame).toContain("alpha");
    expect(frame).toContain("group-a");
    expect(frame).toContain("p:provider-x");
    expect(frame).toContain("[COOL]");
    expect(frame).toContain("10s");
    expect(frame).toContain("rate_limit");
    expect(frame).toContain("Activity");
    expect(frame).toContain("fixture 3");
  });

  test("seeds every planned row and shows in-flight counts on frame", async () => {
    const store = new RunViewStore();
    store.applyEngineEvent(
      event("run.started", {
        runId: "run-seeded",
        totalEvaluations: 3,
        totalFixtures: 7,
        evaluations: [
          {
            evaluationId: "alpha::high",
            modelAlias: "alpha",
            openRouterId: "vendor/alpha",
            reasoningMode: "high",
            rateLimitGroup: "group-a",
            fixtures: 2,
          },
          {
            evaluationId: "beta::default",
            modelAlias: "beta",
            openRouterId: "vendor/beta",
            reasoningMode: "default",
            rateLimitGroup: "group-b",
            fixtures: 2,
          },
          {
            evaluationId: "gamma::default",
            modelAlias: "gamma",
            openRouterId: "vendor/gamma",
            reasoningMode: "default",
            rateLimitGroup: "group-c",
            fixtures: 3,
          },
        ],
      }),
    );
    store.applyEngineEvent(
      event("attempt.started", {
        evaluationId: "alpha::high",
        fixtureId: "0",
        attemptNumber: 1,
      }),
    );
    store.applyEngineEvent(
      event("attempt.started", {
        evaluationId: "beta::default",
        fixtureId: "1",
        attemptNumber: 1,
      }),
    );

    const setup = await renderApp(store, 110, 32);
    const frame = setup.captureCharFrame();
    const alphaLine = linesWith(frame, "alpha")[0] ?? "";
    const betaLine = linesWith(frame, "beta")[0] ?? "";
    const gammaLine = linesWith(frame, "gamma")[0] ?? "";

    expect(alphaLine).toContain("[RUN]");
    expect(alphaLine).toContain("flight 1");
    expect(betaLine).toContain("[RUN]");
    expect(betaLine).toContain("flight 1");
    // An evaluation with nothing in flight is still visible with its own total.
    expect(gammaLine).toContain("[WAIT]");
    expect(gammaLine).toContain("0/3");
  });

  test("moves the visible focus marker with arrow keys", async () => {
    const setup = await renderApp(seededStore(), 100, 30);
    const before = setup.captureCharFrame();
    const alphaBefore = linesWith(before, "alpha")[0] ?? "";
    const betaBefore = linesWith(before, "beta")[0] ?? "";

    expect(alphaBefore).toContain(">");
    expect(betaBefore).not.toContain(">");

    await press(setup, (keys) => keys.pressArrow("down"));

    const after = setup.captureCharFrame();
    const alphaAfter = linesWith(after, "alpha")[0] ?? "";
    const betaAfter = linesWith(after, "beta")[0] ?? "";
    expect(alphaAfter).not.toContain(">");
    expect(betaAfter).toContain(">");
  });

  test("opens and closes the keyboard help overlay", async () => {
    const setup = await renderApp(seededStore(), 100, 30);

    await press(setup, (keys) => keys.pressKey("?"));
    const help = setup.captureCharFrame();
    expect(help).toContain("Keyboard");
    expect(help).toContain("PgUp/PgDn");
    expect(help).toContain("Tab");

    await press(setup, (keys) => keys.pressEscape());
    expect(setup.captureCharFrame()).toContain("Models / groups");
  });

  test("uses compact rows and still shows the group when narrow", async () => {
    const setup = await renderApp(seededStore(), 60, 20);
    const frame = setup.captureCharFrame();

    expect(frame).not.toContain("p:provider-x");
    expect(frame).toContain("provider-x");
    expect(frame).toContain("group-a");
    expect(frame).toContain("[COOL]");
  });

  test("keeps rendering while one group cools down and another runs", async () => {
    const store = seededStore();
    store.applyEngineEvent(
      event("attempt.started", {
        evaluationId: "beta::default",
        fixtureId: "0",
        attemptNumber: 1,
      }),
    );
    const setup = await renderApp(store, 100, 30);
    const frame = setup.captureCharFrame();

    const alphaLine = linesWith(frame, "alpha")[0] ?? "";
    const betaLine = linesWith(frame, "beta")[0] ?? "";
    expect(alphaLine).toContain("[COOL]");
    expect(betaLine).toContain("[RUN]");
  });

  test("bounds activity rendering under a burst of events", async () => {
    const store = seededStore();
    for (let index = 0; index < 500; index++) {
      store.applyEngineEvent(
        event("outcome.settled", {
          evaluationId: "alpha::high",
          fixtureId: String(index),
          state: "failed",
          kind: null,
          requestLatencyMs: null,
          totalFixtureTimeMs: null,
        }),
      );
    }

    const setup = await renderApp(store, 80, 24);
    const frame = setup.captureCharFrame();

    expect(store.getSnapshot().activity.length).toBeLessThanOrEqual(MAX_ACTIVITY);
    expect(frame).toContain("fixture 499");
    expect(frame).not.toContain("fixture 0 ");
  });

  test("renders provisional metrics with distinct cost kinds", async () => {
    const store = seededStore();
    store.applyMetrics(metrics());
    const setup = await renderApp(store, 120, 34);
    const frame = setup.captureCharFrame();

    expect(frame).toContain("[PROVISIONAL]");
    expect(frame).toContain("accuracy");
    expect(frame).toContain("p50 1.2s");
    expect(frame).toContain("known $0.0150");
    expect(frame).toContain("estimated $0.0030");
    expect(frame).toContain("math 75%");
  });

  test("inspects the selected activity entry and closes the detail pane", async () => {
    const store = seededStore();
    const inspected: string[] = [];
    const setup = await renderApp(store, 110, 32, {
      onInspect: (evaluationId, fixtureId) => {
        inspected.push(`${evaluationId}:${fixtureId}`);
        store.applyDetail({
          evaluationId,
          modelAlias: "alpha",
          reasoningMode: "high",
          fixtureId,
          category: "math",
          question: "Which option best answers the question?",
          state: "failed",
          kind: null,
          parsedAnswer: null,
          expectedAnswer: "A",
          responseText: null,
          indeterminate: false,
          failure: {
            category: "rate_limit",
            message: "too many requests",
            httpStatus: 429,
            retryAfterMs: null,
          },
          lineage: { sourceRunId: null, sourceOutcomeId: null },
          retryAtMs: null,
          attempts: [],
        });
      },
    });

    await press(setup, (keys) => keys.pressTab());
    await press(setup, (keys) => keys.pressEnter());

    expect(inspected).toEqual(["alpha::high:3"]);
    const detailFrame = setup.captureCharFrame();
    expect(detailFrame).toContain("Fixture detail");
    expect(detailFrame).toContain("question:");
    expect(detailFrame).toContain("expected A");
    expect(detailFrame).toContain("failure: rate_limit");

    await press(setup, (keys) => keys.pressEscape());
    const closed = setup.captureCharFrame();
    expect(closed).not.toContain("Fixture detail");
    expect(closed).toContain("Activity");
  });

  test("scrolls a long response in the detail pane", async () => {
    const store = seededStore();
    const responseText = Array.from({ length: 120 }, (_, index) => `word${index}`).join(" ");
    store.applyDetail({
      evaluationId: "alpha::high",
      modelAlias: "alpha",
      reasoningMode: "high",
      fixtureId: "3",
      category: "math",
      question: "Question?",
      state: "settled",
      kind: "incorrect",
      parsedAnswer: "B",
      expectedAnswer: "A",
      responseText,
      indeterminate: false,
      failure: null,
      lineage: { sourceRunId: null, sourceOutcomeId: null },
      retryAtMs: null,
      attempts: [],
    });

    const setup = await renderApp(store, 80, 24);
    expect(setup.captureCharFrame()).toContain("Question?");

    await press(setup, (keys) => keys.pressKey("\u001B[6~"));
    expect(setup.captureCharFrame()).toContain("word0");

    for (let index = 0; index < 12; index++) {
      await press(setup, (keys) => keys.pressKey("\u001B[6~"));
    }
    expect(setup.captureCharFrame()).toContain("word119");

    await press(setup, (keys) => keys.pressKey("\u001B[H"));
    expect(setup.captureCharFrame()).toContain("Question?");
  });

  test("filters activity from the keyboard", async () => {
    const store = seededStore();
    store.applyEngineEvent(
      event("outcome.settled", {
        evaluationId: "alpha::high",
        fixtureId: "4",
        state: "settled",
        kind: "incorrect",
        requestLatencyMs: null,
        totalFixtureTimeMs: null,
      }),
    );
    const setup = await renderApp(store, 110, 32);

    await press(setup, (keys) => keys.pressKey("f"));
    expect(setup.captureCharFrame()).toContain("filter:");
    await press(setup, async (keys) => {
      await keys.typeText("failure");
    });

    const typing = setup.captureCharFrame();
    expect(typing).toContain("filter: failure_");
    expect(typing).toContain("fixture 3");
    expect(typing).not.toContain("fixture 4");

    await press(setup, (keys) => keys.pressEnter());
    expect(setup.captureCharFrame()).toContain("[filter: failure]");
  });

  test("keeps the detail pane usable on a narrow terminal", async () => {
    const store = seededStore();
    store.applyMetrics(metrics());
    store.applyDetail({
      evaluationId: "alpha::high",
      modelAlias: "alpha",
      reasoningMode: "high",
      fixtureId: "3",
      category: "math",
      question: "Compact layout question?",
      state: "settled",
      kind: "incorrect",
      parsedAnswer: "B",
      expectedAnswer: "A",
      responseText: "B",
      indeterminate: false,
      failure: null,
      lineage: { sourceRunId: null, sourceOutcomeId: null },
      retryAtMs: null,
      attempts: [],
    });

    const setup = await renderApp(store, 60, 18);
    expect(setup.captureCharFrame()).toContain("Fixture detail");
    expect(setup.captureCharFrame()).toContain("fixture 3");

    await press(setup, (keys) => keys.pressKey("\u001B[6~"));
    expect(setup.captureCharFrame()).toContain("Compact layout question?");
  });

  test("routes pause, continue, and quit to the entry point", async () => {
    const store = seededStore();
    const calls: string[] = [];
    const setup = await renderApp(store, 100, 30, {
      onQuit: () => calls.push("quit"),
      onPause: () => calls.push("pause"),
      onResume: () => calls.push("resume"),
    });

    await press(setup, (keys) => keys.pressKey("p"));
    await press(setup, (keys) => keys.pressKey("c"));
    await press(setup, (keys) => keys.pressKey("q"));

    expect(calls).toEqual(["pause", "resume", "quit"]);
  });

  test("reflows between full and compact layouts on resize", async () => {
    const store = seededStore();
    store.applyMetrics(metrics());
    const setup = await renderApp(store, 100, 30);

    expect(setup.captureCharFrame()).toContain("p:provider-x");
    expect(setup.captureCharFrame()).toContain("[PROVISIONAL]");

    await act(async () => {
      setup.resize(60, 18);
      // The renderer debounces resize events; let the layout settle.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await setup.flush();
    });
    const compact = setup.captureCharFrame();
    expect(compact).not.toContain("p:provider-x");
    expect(compact).toContain("provider-x");
    expect(compact).toContain("[PROVISIONAL]");

    await act(async () => {
      setup.resize(110, 32);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await setup.flush();
    });
    expect(setup.captureCharFrame()).toContain("p:provider-x");
  });
});
