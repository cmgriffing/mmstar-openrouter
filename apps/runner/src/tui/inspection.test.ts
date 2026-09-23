/**
 * Fixture inspection assembly tests.
 *
 * These drive the real demo engine (deterministic, no network) so the
 * conversion from durable records plus prompt metadata to the renderer's
 * fixture detail view is verified against actual engine output.
 */
import { describe, expect, it } from "vitest";
import { createDemoEngine } from "./demo";
import { buildFixtureDetail } from "./inspection";

describe("buildFixtureDetail", () => {
  it("assembles recorded outcome, attempts, and fixture metadata", async () => {
    const engine = createDemoEngine({ fixtureCount: 4, latencyMs: 0, maxRetries: 0 });
    await engine.run();

    const detail = buildFixtureDetail({
      engine,
      modelAlias: "alpha",
      evaluationId: "alpha::high",
      fixtureId: "demo-0",
    });

    expect(detail).toMatchObject({
      evaluationId: "alpha::high",
      modelAlias: "alpha",
      reasoningMode: "high",
      fixtureId: "demo-0",
      category: "biology",
      question: "Demo question 0: choose the best option.",
      state: "settled",
      kind: "correct",
      parsedAnswer: "A",
      expectedAnswer: "A",
      indeterminate: false,
      lineage: { sourceRunId: null, sourceOutcomeId: null },
    });
    expect(detail?.attempts.length).toBeGreaterThan(0);
    expect(detail?.attempts[0]).toMatchObject({
      state: "completed",
      upstreamProvider: "demo-provider-a",
      failureCategory: null,
    });
  });

  it("records a failure category for a permanently failed fixture", async () => {
    const engine = createDemoEngine({ fixtureCount: 8, latencyMs: 0, maxRetries: 0 });
    await engine.run();

    const detail = buildFixtureDetail({
      engine,
      modelAlias: "beta",
      evaluationId: "beta::default",
      fixtureId: "demo-7",
    });

    expect(detail).toMatchObject({ state: "failed", kind: null, responseText: null });
    expect(detail?.failure?.category).toBe("content_filter");
    expect(detail?.attempts.at(-1)?.failureCategory).toBe("content_filter");
  });

  it("returns null for unknown evaluations and fixtures", async () => {
    const engine = createDemoEngine({ fixtureCount: 2, latencyMs: 0 });
    await engine.run();

    expect(
      buildFixtureDetail({
        engine,
        modelAlias: "alpha",
        evaluationId: "nope",
        fixtureId: "0",
      }),
    ).toBeNull();
    expect(
      buildFixtureDetail({
        engine,
        modelAlias: "alpha",
        evaluationId: "alpha::high",
        fixtureId: "999",
      }),
    ).toBeNull();
  });
});
