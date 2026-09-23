import type { EngineEvent, EngineMetrics } from "@mmstar/benchmark";
import { describe, expect, it } from "vitest";
import {
  activityLines,
  compactModelRowLine,
  cooldownLine,
  countsLine,
  detailLines,
  helpLines,
  identityLine,
  layoutFor,
  MAX_DETAIL_RESPONSE_CHARS,
  metricsLines,
  modelRowLine,
  progressLine,
  truncate,
  wrapText,
} from "./lines";
import {
  applyEngineEvent,
  applyLifecycleEvent,
  applyMetrics,
  type EvaluationRow,
  type FixtureDetailView,
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

function metrics(overrides: Partial<EngineMetrics> = {}): EngineMetrics {
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
      {
        category: "physics",
        selected: 3,
        settled: 2,
        correct: 1,
        coverage: 2 / 3,
        accuracy: 1 / 3,
      },
    ],
    tokens: {
      promptTokens: 1_500,
      completionTokens: 75,
      totalTokens: 1_575,
      reasoningTokens: 300,
      usageUnknownCount: 2,
    },
    costs: {
      reportedUsd: 0.012,
      estimatedUsd: 0.003,
      knownUsd: 0.015,
      unknownCount: 2,
    },
    requestLatency: {
      count: 11,
      minMs: 400,
      maxMs: 5_000,
      meanMs: 1_800,
      p50Ms: 1_200,
      p95Ms: 3_400,
    },
    fixtureLatency: { count: 0, minMs: null, maxMs: null, meanMs: null, p50Ms: null, p95Ms: null },
    ...overrides,
  };
}

function detail(overrides: Partial<FixtureDetailView> = {}): FixtureDetailView {
  return {
    evaluationId: "alpha::high",
    modelAlias: "alpha",
    reasoningMode: "high",
    fixtureId: "7",
    category: "physics",
    question: "Which option best answers the question?",
    state: "settled",
    kind: "incorrect",
    parsedAnswer: "B",
    expectedAnswer: "A",
    responseText: "B",
    indeterminate: false,
    failure: null,
    lineage: { sourceRunId: null, sourceOutcomeId: null },
    retryAtMs: null,
    attempts: [
      {
        attemptNumber: 1,
        state: "completed",
        failureCategory: null,
        requestLatencyMs: 1_200,
        usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105, reasoningTokens: null },
        cost: { kind: "reported", usd: 0.0004 },
        modelUsed: "vendor/alpha",
        upstreamProvider: "demo-provider-a",
      },
    ],
    ...overrides,
  };
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
    expect(lines.at(-1)).toContain("▲");
  });

  it("filters entries and marks the selected row", () => {
    let state = stateWithRun();
    for (const [fixtureId, outcomeState] of [
      ["0", "settled"],
      ["1", "failed"],
      ["2", "indeterminate"],
    ] as const) {
      state = applyEngineEvent(
        state,
        event("outcome.settled", {
          evaluationId: "alpha::high",
          fixtureId,
          state: outcomeState,
          kind: outcomeState === "settled" ? "correct" : null,
          requestLatencyMs: null,
          totalFixtureTimeMs: null,
        }),
      );
    }

    const lines = activityLines(state, { offset: 0, height: 5, filter: "failure" }, 120);
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).toContain("fixture 1");
    expect(lines.join("\n")).toContain("fixture 2");
    expect(lines.join("\n")).not.toContain("fixture 0");
    expect(lines.at(-1)?.startsWith(">")).toBe(true);

    const empty = activityLines(state, { offset: 0, height: 5, filter: "nope" }, 120);
    expect(empty).toEqual(["(no matching activity)"]);
  });
});

describe("metrics lines", () => {
  it("waits for engine records instead of inventing zeros", () => {
    expect(metricsLines(stateWithRun(), 120)).toEqual(["metrics waiting for engine records…"]);
  });

  it("labels provisional metrics and keeps denominators and cost kinds distinct", () => {
    const state = applyMetrics(stateWithRun(), metrics());
    const lines = metricsLines(state, 200);

    expect(lines[0]).toContain("[PROVISIONAL]");
    expect(lines[0]).toContain("82%");
    expect(lines[0]).toContain("9/11");
    expect(lines[0]).toContain("9/15");
    expect(lines[1]).toContain("p50 1.2s");
    expect(lines[1]).toContain("in 1.5k");
    expect(lines[2]).toContain("known $0.0150");
    expect(lines[2]).toContain("reported $0.0120");
    expect(lines[2]).toContain("estimated $0.0030");
    expect(lines[2]).toContain("unknown 2");
    expect(lines[3]).toContain("math 75% (3/4)");

    const final = metricsLines(applyMetrics(stateWithRun(), metrics({ provisional: false })), 200);
    expect(final[0]).toContain("[FINAL]");
  });

  it("keeps unknown costs as a placeholder rather than zero", () => {
    const state = applyMetrics(
      stateWithRun(),
      metrics({
        costs: { reportedUsd: null, estimatedUsd: null, knownUsd: null, unknownCount: 4 },
      }),
    );
    const line = metricsLines(state, 200)[2] ?? "";
    expect(line).toContain("known —");
    expect(line).not.toContain("$0");
  });

  it("drops only the category breakdown in compact mode", () => {
    const state = applyMetrics(stateWithRun(), metrics());
    const compact = metricsLines(state, 60, true);
    expect(compact).toHaveLength(3);
    expect(compact[0]).toContain("accuracy");
    expect(compact[2]).toContain("cost");
    for (const line of compact) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe("detail lines", () => {
  it("shows question, parsed/expected answers, response, attempts and lineage", () => {
    const lines = detailLines(detail(), { scroll: 0, height: 40 }, 120, null).join("\n");

    expect(lines).toContain("fixture 7");
    expect(lines).toContain("category physics");
    expect(lines).toContain("parsed B");
    expect(lines).toContain("expected A");
    expect(lines).toContain("Which option best answers the question?");
    expect(lines).toContain("#1");
    expect(lines).toContain("demo-provider-a");
    expect(lines).toContain("tokens 100/5");
    expect(lines).toContain("cost reported $0.0004");
    expect(lines).toContain("lineage original");
  });

  it("reports recovery lineage and pending retry countdowns", () => {
    const lines = detailLines(
      detail({
        lineage: { sourceRunId: "run-9", sourceOutcomeId: "alpha::high:7" },
      }),
      { scroll: 0, height: 40 },
      120,
      4_000,
    ).join("\n");

    expect(lines).toContain("lineage recovery from run-9");
    expect(lines).toContain("retry pending in 4s");
  });

  it("wraps a long response so later text is reachable by scrolling", () => {
    const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const full = detailLines(detail({ responseText: long }), { scroll: 0, height: 200 }, 40, null);
    const text = full.join("\n");
    expect(text).toContain("word0");
    expect(text).toContain("word39");
    for (const line of full) expect(line.length).toBeLessThanOrEqual(40);

    const window = detailLines(detail({ responseText: long }), { scroll: 4, height: 3 }, 40, null);
    expect(window).toEqual(full.slice(4, 7));
  });

  it("marks a pathological response as truncated and shows failures", () => {
    const huge = "x".repeat(MAX_DETAIL_RESPONSE_CHARS + 5_000);
    const lines = detailLines(
      detail({
        responseText: huge,
        state: "failed",
        kind: null,
        failure: {
          category: "rate_limit",
          message: "too many requests",
          httpStatus: 429,
          retryAfterMs: null,
        },
      }),
      { scroll: 0, height: 5_000 },
      100,
      null,
    ).join("\n");

    expect(lines).toContain("truncated at 20000 characters");
    expect(lines).toContain("failure: rate_limit too many requests");
    expect(lines).toContain("state failed");
  });
});

describe("wrapText", () => {
  it("wraps on word boundaries and preserves explicit newlines", () => {
    expect(wrapText("one two three four", 10)).toEqual(["one two", "three four"]);
    expect(wrapText("first\n\nsecond", 20)).toEqual(["first", "", "second"]);
    expect(wrapText("", 10)).toEqual([""]);
  });
});

describe("help and compact helpers", () => {
  it("lists the keyboard surface", () => {
    const text = helpLines().join("\n");
    expect(text).toContain("up/down");
    expect(text).toContain("PgUp/PgDn");
    expect(text).toContain("Tab");
    expect(text).toContain("?");
    expect(text).toContain("Enter");
    expect(text).toContain("filter");
    expect(text).toContain("pause");
    expect(text).toContain("graceful quit");
  });
});
