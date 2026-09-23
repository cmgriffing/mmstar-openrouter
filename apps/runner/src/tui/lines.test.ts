import type { EngineEvent } from "@mmstar/benchmark";
import { describe, expect, it } from "vitest";
import {
  activityLines,
  compactModelRowLine,
  cooldownLine,
  countsLine,
  helpLines,
  identityLine,
  layoutFor,
  modelRowLine,
  progressLine,
  truncate,
} from "./lines";
import {
  applyEngineEvent,
  applyLifecycleEvent,
  type EvaluationRow,
  initialViewState,
  type RunnerViewState,
} from "./state";

const AT = "2026-09-23T00:00:00.000Z";

function event<T extends EngineEvent["type"]>(
  type: T,
  payload: Omit<Extract<EngineEvent, { type: T }>, "type" | "version" | "at">,
): EngineEvent {
  return { type, version: 1, at: AT, ...payload } as EngineEvent;
}

function stateWithRun(): RunnerViewState {
  let state = applyEngineEvent(
    initialViewState(),
    event("run.started", {
      runId: "2026-09-23T00:00:00.000Z_8a716225",
      totalEvaluations: 1,
      totalFixtures: 4,
    }),
  );
  state = applyEngineEvent(
    state,
    event("evaluation.started", {
      evaluationId: "alpha::high",
      modelAlias: "alpha",
      openRouterId: "vendor/alpha",
      reasoningMode: "high",
      rateLimitGroup: "group-a",
    }),
  );
  return state;
}

function firstRow(state: RunnerViewState): EvaluationRow {
  const row = state.rows[0];
  if (row === undefined) throw new Error("test state has no rows");
  return row;
}

describe("layoutFor", () => {
  it("keeps the full layout at normal size", () => {
    expect(layoutFor(100, 30)).toEqual({ compact: false, showActivity: true });
  });

  it("switches to compact columns on a narrow terminal", () => {
    expect(layoutFor(60, 30)).toEqual({ compact: true, showActivity: true });
  });

  it("drops the activity pane when there is not enough height", () => {
    expect(layoutFor(100, 14)).toEqual({ compact: false, showActivity: false });
  });
});

describe("truncate", () => {
  it("leaves text that fits untouched and clips the rest with an ellipsis", () => {
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(truncate("hello", 0)).toBe("");
  });
});

describe("header lines", () => {
  it("shows identity and state", () => {
    const line = identityLine(stateWithRun(), 120);
    expect(line).toContain("2026-09-23T00:00:00.000Z_8a716225");
    expect(line).toContain("RUNNING");
  });

  it("shows progress counts and an estimate", () => {
    let state = stateWithRun();
    state = applyEngineEvent(
      state,
      event("outcome.settled", {
        evaluationId: "alpha::high",
        fixtureId: "0",
        state: "settled",
        kind: "correct",
        requestLatencyMs: null,
        totalFixtureTimeMs: null,
      }),
    );

    const line = progressLine(state, Date.parse(AT) + 1_000, 120);
    expect(line).toContain("#");
    expect(line).toContain("1/4");
    expect(line).toContain("remaining");
  });

  it("lists terminal outcome counts", () => {
    const line = countsLine(stateWithRun(), 120);
    expect(line).toContain("pending 4");
    expect(line).toContain("failed 0");
    expect(line).toContain("indeterminate 0");
    expect(line).toContain("cancelled 0");
  });

  it("shows an active cooldown with countdown and reason", () => {
    let state = stateWithRun();
    state = applyEngineEvent(
      state,
      event("group.cooldown.started", {
        group: "group-a",
        until: "2026-09-23T00:00:10.000Z",
        reason: "rate_limit",
      }),
    );

    const line = cooldownLine(state, Date.parse(AT), 120);
    expect(line).toContain("group-a");
    expect(line).toContain("10s");
    expect(line).toContain("rate_limit");
  });

  it("reports halt and notice text instead of a cooldown when present", () => {
    let state = applyLifecycleEvent(initialViewState(), {
      event: "run.finished",
      runId: "run-1",
      state: "failed",
      halt: { message: "authentication failed" },
    });
    state = applyLifecycleEvent(state, {
      event: "error",
      kind: "ValidationError",
      message: "config is invalid",
    });

    const line = cooldownLine(state, Date.parse(AT), 120);
    expect(line).toContain("halt");
    expect(line).toContain("authentication failed");
  });
});

describe("model row lines", () => {
  it("marks the selected row with > and shows effort, group, and status", () => {
    const state = stateWithRun();
    const row = firstRow(state);
    const selected = modelRowLine({
      row,
      state,
      nowMs: Date.parse(AT),
      width: 110,
      selected: true,
    });
    const other = modelRowLine({
      row,
      state,
      nowMs: Date.parse(AT),
      width: 110,
      selected: false,
    });

    expect(selected.startsWith(">")).toBe(true);
    expect(selected).toContain("[WAIT]");
    expect(selected).toContain("alpha");
    expect(selected).toContain("high");
    expect(selected).toContain("group-a");
    expect(other.startsWith(">")).toBe(false);
  });

  it("shows the observed provider once a response arrives", () => {
    let state = stateWithRun();
    state = applyEngineEvent(
      state,
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

    const line = modelRowLine({
      row: firstRow(state),
      state,
      nowMs: Date.parse(AT),
      width: 110,
      selected: false,
    });
    expect(line).toContain("provider-x");
  });

  it("never exceeds the requested width", () => {
    const state = stateWithRun();
    for (const width of [40, 60, 80]) {
      const line = modelRowLine({
        row: firstRow(state),
        state,
        nowMs: Date.parse(AT),
        width,
        selected: true,
      });
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it("keeps compact rows inside a narrow width", () => {
    let state = stateWithRun();
    state = applyEngineEvent(
      state,
      event("group.cooldown.started", {
        group: "group-a",
        until: "2026-09-23T00:00:10.000Z",
        reason: "rate_limit",
      }),
    );

    const line = compactModelRowLine(firstRow(state), state, Date.parse(AT), 50);
    expect(line).toContain("[COOL]");
    expect(line).toContain("alpha");
    expect(line.length).toBeLessThanOrEqual(50);
  });
});

describe("activity lines", () => {
  it("returns a chronological window with the newest entry last", () => {
    let state = stateWithRun();
    for (let index = 0; index < 10; index++) {
      state = applyEngineEvent(
        state,
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

    const lines = activityLines(state, { offset: 0, height: 3 }, 120);
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toContain("fixture 9");
    expect(lines[0]).toContain("fixture 7");
  });

  it("scrolls back by offset and reports when scrolled", () => {
    let state = stateWithRun();
    for (let index = 0; index < 5; index++) {
      state = applyEngineEvent(
        state,
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

    const lines = activityLines(state, { offset: 2, height: 2 }, 120);
    expect(lines.at(-1)).toContain("fixture 2");
    expect(lines.at(-1)?.startsWith("▲")).toBe(true);
  });
});

describe("help and compact helpers", () => {
  it("lists the keyboard surface", () => {
    const text = helpLines().join("\n");
    expect(text).toContain("up/down");
    expect(text).toContain("PgUp/PgDn");
    expect(text).toContain("Tab");
    expect(text).toContain("?");
  });
});
