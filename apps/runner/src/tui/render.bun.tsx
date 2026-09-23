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
import type { EngineEvent } from "@mmstar/benchmark";
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

async function renderApp(store: RunViewStore, width: number, height: number) {
  const setup = await testRender(
    <RunnerTui store={store} now={() => Date.parse(AT)} tickMs={0} />,
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
  input: (keys: TestRendererSetup["mockInput"]) => void,
) {
  await act(async () => {
    input(setup.mockInput);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await setup.flush();
  });
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
});
