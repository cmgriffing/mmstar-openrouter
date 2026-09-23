import type { EngineEvent } from "@mmstar/benchmark";
import { describe, expect, it } from "vitest";
import { createDemoEngine, DEMO_RUN_ID, demoEvaluations, demoFixtures } from "./demo";

async function runDemo(overrides: Parameters<typeof createDemoEngine>[0] = {}) {
  const events: EngineEvent[] = [];
  const engine = createDemoEngine({
    fixtureCount: 8,
    latencyMs: 0,
    rateLimitRetryAfterMs: 50,
    maxRetries: 1,
    sink: (event) => events.push(event),
    ...overrides,
  });
  const result = await engine.run();
  return { result, events };
}

describe("demo run definition", () => {
  it("exposes three ordered evaluations across two rate-limit groups", () => {
    const evaluations = demoEvaluations();

    expect(evaluations.map((evaluation) => evaluation.evaluationId)).toEqual([
      "alpha::high",
      "alpha::low",
      "beta::default",
    ]);
    expect(new Set(evaluations.map((evaluation) => evaluation.rateLimitGroup))).toEqual(
      new Set(["g-alpha", "g-beta"]),
    );
    expect(evaluations[0]?.openRouterId).toBe(evaluations[1]?.openRouterId);
  });

  it("builds the requested number of unique fixtures", () => {
    const fixtures = demoFixtures(5);

    expect(fixtures).toHaveLength(5);
    expect(new Set(fixtures.map((fixture) => fixture.fixtureId)).size).toBe(5);
    expect(fixtures.every((fixture) => fixture.expectedAnswer === "A")).toBe(true);
  });
});

describe("demo engine run", () => {
  it("completes deterministically with retries, a cooldown, and a permanent failure", async () => {
    const { result, events } = await runDemo();

    expect(result.runId).toBe(DEMO_RUN_ID);
    expect(result.state).toBe("completed");

    const started = events.find((event) => event.type === "run.started");
    expect(started).toMatchObject({ totalEvaluations: 3, totalFixtures: 8 });

    const cooldown = events.find((event) => event.type === "group.cooldown.started");
    expect(cooldown).toMatchObject({ group: "g-alpha", reason: "rate_limit" });

    const failures = events.filter(
      (event): event is Extract<EngineEvent, { type: "attempt.finished" }> =>
        event.type === "attempt.finished" && event.failure !== null,
    );
    expect(failures.some((event) => event.failure?.category === "rate_limit")).toBe(true);
    expect(failures.some((event) => event.failure?.category === "timeout")).toBe(true);
    expect(failures.some((event) => event.failure?.category === "content_filter")).toBe(true);

    const outcomes = result.evaluations.flatMap((evaluation) => evaluation.outcomes);
    expect(outcomes).toHaveLength(24);
    expect(outcomes.filter((outcome) => outcome.state === "settled")).toHaveLength(22);
    expect(outcomes.filter((outcome) => outcome.state === "failed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.state === "indeterminate")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === "incorrect").length).toBeGreaterThan(0);
  });

  it("keeps variant evaluations of one group serialized", async () => {
    const { events } = await runDemo();

    const inflight = new Map<string, number>();
    let maxAlphaInFlight = 0;
    for (const event of events) {
      if (event.type !== "attempt.started" && event.type !== "attempt.finished") continue;
      const evaluation = demoEvaluations().find(
        (candidate) => candidate.evaluationId === event.evaluationId,
      );
      if (evaluation === undefined) continue;
      const group = evaluation.rateLimitGroup;
      const delta = event.type === "attempt.started" ? 1 : -1;
      const next = (inflight.get(group) ?? 0) + delta;
      inflight.set(group, next);
      if (group === "g-alpha") maxAlphaInFlight = Math.max(maxAlphaInFlight, next);
    }

    expect(maxAlphaInFlight).toBe(1);
  });
});
