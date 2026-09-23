/**
 * Typed engine events.
 *
 * The headless engine emits these events; the OpenTUI renderer and plain-output
 * mode consume them. Payloads are intentionally small (IDs, classifications,
 * timings, usage/cost records) so event batching and bounded UI history cannot
 * be inflated by raw responses, and so scheduling correctness never depends on a
 * terminal renderer.
 */
import type { ReasoningMode } from "@mmstar/config";
import type {
  AttemptState,
  CostRecord,
  FailureRecord,
  OutcomeKind,
  OutcomeState,
  RunState,
  UsageRecord,
} from "@mmstar/results";

export const ENGINE_EVENT_VERSION = 1;

interface EngineEventBase {
  version: typeof ENGINE_EVENT_VERSION;
  /** ISO-8601 UTC timestamp from the injected clock. */
  at: string;
}

export type CooldownReason = "rate_limit" | "request_cap";
export type StopReason = "user" | "signal" | "error";

export type EngineEvent =
  | (EngineEventBase & {
      type: "run.started";
      runId: string;
      totalEvaluations: number;
      totalFixtures: number;
    })
  | (EngineEventBase & {
      type: "evaluation.started";
      evaluationId: string;
      modelAlias: string;
      openRouterId: string;
      reasoningMode: ReasoningMode;
      rateLimitGroup: string;
    })
  | (EngineEventBase & {
      type: "attempt.started";
      evaluationId: string;
      fixtureId: string;
      attemptNumber: number;
    })
  | (EngineEventBase & {
      type: "attempt.finished";
      evaluationId: string;
      fixtureId: string;
      attemptNumber: number;
      state: AttemptState;
      failure: FailureRecord | null;
      usage: UsageRecord | null;
      cost: CostRecord;
      /** Model reported by the provider response; null when no response arrived. */
      modelUsed: string | null;
      /** Upstream provider that served the response; null when unknown. */
      upstreamProvider: string | null;
    })
  | (EngineEventBase & {
      type: "outcome.settled";
      evaluationId: string;
      fixtureId: string;
      state: OutcomeState;
      kind: OutcomeKind | null;
      requestLatencyMs: number | null;
      totalFixtureTimeMs: number | null;
    })
  | (EngineEventBase & {
      type: "group.cooldown.started";
      group: string;
      until: string;
      reason: CooldownReason;
    })
  | (EngineEventBase & { type: "group.cooldown.ended"; group: string })
  | (EngineEventBase & { type: "engine.paused" })
  | (EngineEventBase & { type: "engine.resumed" })
  | (EngineEventBase & { type: "engine.stopping"; reason: StopReason })
  | (EngineEventBase & { type: "run.finished"; runId: string; state: RunState });

export type EngineEventType = EngineEvent["type"];

export type EngineEventSink = (event: EngineEvent) => void;
