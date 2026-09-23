/**
 * Headless benchmark engine.
 *
 * The engine schedules every (evaluation, fixture) pair as an independent work
 * item, but serializes items within a configured rate-limit group and lets only
 * a bounded number of groups run at once. Every dependency that makes behavior
 * observable — clock, provider, jitter, event sink, scorer — is injected, so
 * scheduling, retry, pause/stop, and metric behavior is testable without a
 * network or a terminal.
 *
 * Correctness rules implemented here:
 * - At most one in-flight request per group across models and effort variants.
 * - Groups are served round-robin under `maxConcurrentGroups` and an optional
 *   account-wide requests-per-minute cap.
 * - Only classified transient failures are retried; permanent auth and
 *   configuration failures halt new scheduling.
 * - A scored response (correct or not) is terminal and never retried.
 * - A timeout or network failure leaves upstream completion unknown: exhausted
 *   work is `indeterminate`, never silently "failed".
 *
 * The engine is in-memory only. Durable JSON persistence, run identity, and
 * recovery commands are chunk 5; the TUI consumes the typed events in chunks 6-7.
 */
import type { ExecutionConfig } from "@mmstar/config";
import type {
  AttemptRecord,
  AttemptState,
  CostRecord,
  EvaluationRecord,
  FailureRecord,
  OutcomeKind,
  OutcomeRecord,
  OutcomeState,
  RunState,
} from "@mmstar/results";
import type { PromptFixtureInput } from "./dataset";
import {
  ENGINE_EVENT_VERSION,
  type EngineEvent,
  type EngineEventSink,
  type StopReason,
} from "./events";
import { computeEngineMetrics, type EngineMetrics } from "./metrics";
import { buildPrompt, type PromptPayload } from "./prompt";
import { boundMessage, type ProviderResult } from "./provider-failure";
import type { PreflightEvaluation } from "./provider-preflight";
import { buildChatCompletionRequest, type ChatCompletionRequestPayload } from "./provider-request";
import type { NormalizedCompletion } from "./provider-response";
import { RequestRateLimiter } from "./rate-limiter";
import { computeRetryDelayMs, shouldRetryAttempt } from "./retry-policy";
import { createOptionScorer, type Scorer } from "./scorer";

/** One planned fixture: prompt input plus the local scoring metadata. */
export interface EngineFixture {
  fixtureId: string;
  category: string;
  expectedAnswer: string;
  prompt: PromptFixtureInput;
}

/** One provider submission. `apps/runner` binds `OpenRouterClient.chatCompletion`. */
export type CompletionProvider = (
  payload: ChatCompletionRequestPayload,
  options: { timeoutMs: number; signal: AbortSignal },
) => Promise<ProviderResult<NormalizedCompletion>>;

/** Injected time source. `sleep` must resolve early when `signal` aborts. */
export interface EngineClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: EngineClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export interface BenchmarkEngineOptions {
  runId: string;
  evaluations: readonly PreflightEvaluation[];
  fixtures: readonly EngineFixture[];
  execution: ExecutionConfig;
  provider: CompletionProvider;
  clock?: EngineClock;
  /** Jitter source for retry backoff; defaults to `Math.random`. */
  random?: () => number;
  sink?: EngineEventSink;
  scorer?: Scorer;
}

export interface EngineRunResult {
  runId: string;
  state: RunState;
  /** Terminal permanent failure that halted scheduling, or null. */
  halt: FailureRecord | null;
  evaluations: EvaluationRecord[];
  metrics: EngineMetrics;
}

interface WorkItem {
  evaluation: PreflightEvaluation;
  fixture: EngineFixture;
  prompt: PromptPayload;
  outcome: OutcomeRecord;
  attempts: AttemptRecord[];
  nextAttemptNumber: number;
  firstAttemptAtMs: number | null;
  /** Earliest epoch ms at which the next attempt may start (retry backoff). */
  retryAtMs: number;
  terminal: boolean;
}

interface GroupState {
  name: string;
  queue: WorkItem[];
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EngineEventPayload = DistributiveOmit<EngineEvent, "version" | "at">;

export class BenchmarkEngine {
  private readonly runId: string;
  private readonly evaluations: readonly PreflightEvaluation[];
  private readonly fixtures: readonly EngineFixture[];
  private readonly execution: ExecutionConfig;
  private readonly provider: CompletionProvider;
  private readonly clock: EngineClock;
  private readonly random: () => number;
  private readonly sink: EngineEventSink;
  private readonly scorer: Scorer;
  private readonly rateLimiter: RequestRateLimiter;

  private readonly groups: GroupState[] = [];
  private readonly groupByName = new Map<string, GroupState>();
  private readonly allItems: WorkItem[] = [];
  private readonly activeGroups = new Set<string>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly cooldownAnnounced = new Set<string>();
  private readonly controllers = new Map<WorkItem, AbortController>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly startedEvaluations = new Set<string>();

  private cursor = 0;
  private completedItems = 0;
  private runState: RunState = "initialized";
  private started = false;
  private finished = false;
  private paused = false;
  private stopping = false;
  private haltReason: FailureRecord | null = null;
  private controlWaiter: (() => void) | null = null;
  private wakeController: AbortController | null = null;
  private rateCap: { group: string; until: number } | null = null;

  constructor(options: BenchmarkEngineOptions) {
    this.runId = options.runId;
    this.evaluations = [...options.evaluations];
    this.fixtures = [...options.fixtures];
    this.execution = options.execution;
    this.provider = options.provider;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.sink = options.sink ?? (() => {});
    this.scorer = options.scorer ?? createOptionScorer();
    this.rateLimiter = new RequestRateLimiter(
      this.execution.maxRequestsPerMinute ?? Number.POSITIVE_INFINITY,
      () => this.clock.now(),
    );

    for (const evaluation of this.evaluations) {
      let group = this.groupByName.get(evaluation.rateLimitGroup);
      if (group === undefined) {
        group = { name: evaluation.rateLimitGroup, queue: [] };
        this.groupByName.set(group.name, group);
        this.groups.push(group);
      }
      for (const fixture of this.fixtures) {
        const item: WorkItem = {
          evaluation,
          fixture,
          prompt: buildPrompt(fixture.prompt),
          outcome: pendingOutcome(evaluation.evaluationId, fixture, this.iso(this.clock.now())),
          attempts: [],
          nextAttemptNumber: 1,
          firstAttemptAtMs: null,
          retryAtMs: 0,
          terminal: false,
        };
        group.queue.push(item);
        this.allItems.push(item);
      }
    }
  }

  get state(): RunState {
    return this.runState;
  }

  /** Stop launching new requests; in-flight work settles normally. */
  pause(): void {
    if (this.paused || this.stopping || this.haltReason !== null || this.finished) return;
    this.paused = true;
    this.emit({ type: "engine.paused" });
    this.interruptWaiters();
  }

  resume(): void {
    if (!this.paused || this.finished) return;
    this.paused = false;
    this.emit({ type: "engine.resumed" });
    this.interruptWaiters();
  }

  /**
   * Stop scheduling and abort in-flight requests. Aborted attempts record a
   * `cancelled` terminal outcome so `resume` can safely reissue them later;
   * never-attempted work stays `pending`.
   */
  stop(reason: StopReason = "user"): void {
    if (this.stopping || this.finished) return;
    this.stopping = true;
    this.emit({ type: "engine.stopping", reason });
    for (const controller of this.controllers.values()) controller.abort();
    this.interruptWaiters();
  }

  /** Snapshot of every evaluation record; safe to call while running. */
  getRecords(): EvaluationRecord[] {
    return this.buildEvaluationRecords();
  }

  getMetrics(): EngineMetrics {
    return computeEngineMetrics({
      evaluations: this.buildEvaluationRecords(),
      fixtures: this.fixtures,
      provisional: !this.finished,
    });
  }

  async run(): Promise<EngineRunResult> {
    if (this.started) throw new Error("BenchmarkEngine.run can only be called once");
    this.started = true;
    this.runState = "running";
    this.emit({
      type: "run.started",
      runId: this.runId,
      totalEvaluations: this.evaluations.length,
      totalFixtures: this.fixtures.length,
    });

    while (true) {
      this.expireCooldowns();
      if (this.paused === false && this.stopping === false && this.haltReason === null) {
        this.launchEligible();
      }

      if (this.inFlight.size > 0) {
        await Promise.race([...this.inFlight]);
        continue;
      }

      if (this.completedItems === this.allItems.length) break;
      if (this.stopping || this.haltReason !== null) break;
      if (this.paused) {
        await this.waitForControl();
        continue;
      }

      const waitMs = this.msUntilLaunchable();
      if (waitMs === null) break;
      await this.sleepInterruptible(waitMs);
    }

    const state: RunState = this.stopping
      ? "stopped"
      : this.haltReason !== null
        ? "failed"
        : this.completedItems === this.allItems.length
          ? "completed"
          : "failed";
    this.runState = state;
    this.finished = true;
    this.emit({ type: "run.finished", runId: this.runId, state });
    return {
      runId: this.runId,
      state,
      halt: this.haltReason,
      evaluations: this.buildEvaluationRecords(),
      metrics: this.getMetrics(),
    };
  }

  private launchEligible(): void {
    while (this.activeGroups.size < this.execution.maxConcurrentGroups) {
      const rateAt = this.rateLimiter.nextAvailableAt();
      if (rateAt !== null) {
        this.announceRateCap(rateAt);
        return;
      }
      this.clearRateCap();
      const group = this.nextEligibleGroup();
      if (group === null) return;
      this.launch(group);
    }
  }

  private launch(group: GroupState): void {
    const item = group.queue[0];
    if (item === undefined) return;
    this.activeGroups.add(group.name);
    this.rateLimiter.recordRequest();
    let tracked: Promise<void>;
    tracked = this.executeItem(item).finally(() => {
      this.activeGroups.delete(group.name);
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
  }

  private nextEligibleGroup(): GroupState | null {
    const now = this.clock.now();
    for (let offset = 0; offset < this.groups.length; offset += 1) {
      const index = (this.cursor + offset) % this.groups.length;
      const group = this.groups[index];
      if (group === undefined || group.queue.length === 0) continue;
      if (this.activeGroups.has(group.name)) continue;
      const cooldown = this.cooldownUntil.get(group.name);
      if (cooldown !== undefined && cooldown > now) continue;
      const head = group.queue[0];
      if (head === undefined || head.retryAtMs > now) continue;
      this.cursor = (index + 1) % this.groups.length;
      return group;
    }
    return null;
  }

  private async executeItem(item: WorkItem): Promise<void> {
    const { evaluation, fixture } = item;
    const attemptNumber = item.nextAttemptNumber;
    const startedAtMs = this.clock.now();
    if (item.firstAttemptAtMs === null) item.firstAttemptAtMs = startedAtMs;

    const attempt: AttemptRecord = {
      attemptId: `${evaluation.evaluationId}:${fixture.fixtureId}:${attemptNumber}`,
      evaluationId: evaluation.evaluationId,
      fixtureId: fixture.fixtureId,
      attemptNumber,
      state: "started",
      startedAt: this.iso(startedAtMs),
      submittedAt: null,
      finishedAt: null,
      requestedModel: evaluation.openRouterId,
      modelUsed: null,
      upstreamProvider: null,
      finishReason: null,
      requestLatencyMs: null,
      usage: null,
      cost: { kind: "unknown", usd: null },
      failure: null,
      rawResponseRef: null,
    };
    item.attempts.push(attempt);
    this.emit({
      type: "attempt.started",
      evaluationId: evaluation.evaluationId,
      fixtureId: fixture.fixtureId,
      attemptNumber,
    });
    if (!this.startedEvaluations.has(evaluation.evaluationId)) {
      this.startedEvaluations.add(evaluation.evaluationId);
      this.emit({
        type: "evaluation.started",
        evaluationId: evaluation.evaluationId,
        modelAlias: evaluation.modelAlias,
        reasoningMode: evaluation.reasoningMode,
      });
    }

    const controller = new AbortController();
    this.controllers.set(item, controller);
    attempt.state = "submitted";
    attempt.submittedAt = this.iso(startedAtMs);

    let result: ProviderResult<NormalizedCompletion>;
    try {
      result = await this.provider(
        buildChatCompletionRequest({ evaluation, prompt: item.prompt }),
        { timeoutMs: this.execution.requestTimeoutMs, signal: controller.signal },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        ok: false,
        failure: {
          category: controller.signal.aborted ? "cancelled" : "unknown",
          message: boundMessage(`provider call threw: ${message}`),
          httpStatus: null,
          retryAfterMs: null,
        },
        rawResponse: null,
      };
    } finally {
      this.controllers.delete(item);
    }

    const finishedAtMs = this.clock.now();
    attempt.finishedAt = this.iso(finishedAtMs);
    attempt.requestLatencyMs = Math.max(0, finishedAtMs - startedAtMs);

    if (result.ok) {
      attempt.state = "completed";
      attempt.modelUsed = result.value.modelUsed;
      attempt.upstreamProvider = result.value.upstreamProvider;
      attempt.finishReason = result.value.finishReason;
      attempt.usage = result.value.usage;
      attempt.cost = result.value.cost;
      this.emit({
        type: "attempt.finished",
        evaluationId: evaluation.evaluationId,
        fixtureId: fixture.fixtureId,
        attemptNumber,
        state: attempt.state,
        failure: null,
        usage: result.value.usage,
        cost: result.value.cost,
      });
      const score = this.scorer.score({
        responseText: result.value.responseText,
        finishReason: result.value.finishReason,
        expectedAnswer: fixture.expectedAnswer,
      });
      this.settle(item, {
        state: "settled",
        kind: score.outcome,
        parsedAnswer: score.parsedAnswer,
        responseText: result.value.responseText,
        failure: null,
        indeterminate: false,
      });
      return;
    }

    const failure = result.failure;
    attempt.failure = failure;
    attempt.state = attemptStateForFailure(failure);
    this.emit({
      type: "attempt.finished",
      evaluationId: evaluation.evaluationId,
      fixtureId: fixture.fixtureId,
      attemptNumber,
      state: attempt.state,
      failure,
      usage: null,
      cost: { kind: "unknown", usd: null },
    });

    if (this.stopping || failure.category === "cancelled") {
      this.settle(item, {
        state: "cancelled",
        kind: null,
        parsedAnswer: null,
        responseText: null,
        failure,
        indeterminate: false,
      });
      return;
    }
    if (failure.category === "auth" || failure.category === "configuration") {
      this.settle(item, {
        state: "failed",
        kind: null,
        parsedAnswer: null,
        responseText: null,
        failure,
        indeterminate: false,
      });
      this.halt(failure);
      return;
    }
    if (shouldRetryAttempt(failure, attemptNumber, this.execution.maxRetries)) {
      const delay = computeRetryDelayMs({ attemptNumber, failure, random: this.random });
      if (failure.category === "rate_limit") {
        const until = finishedAtMs + delay;
        const existing = this.cooldownUntil.get(evaluation.rateLimitGroup) ?? 0;
        this.cooldownUntil.set(evaluation.rateLimitGroup, Math.max(existing, until));
        this.cooldownAnnounced.add(evaluation.rateLimitGroup);
        this.emit({
          type: "group.cooldown.started",
          group: evaluation.rateLimitGroup,
          until: this.iso(Math.max(existing, until)),
          reason: "rate_limit",
        });
      }
      item.nextAttemptNumber = attemptNumber + 1;
      item.retryAtMs = finishedAtMs + delay;
      return;
    }

    this.settle(item, {
      state: attemptStateForFailure(failure) === "indeterminate" ? "indeterminate" : "failed",
      kind: null,
      parsedAnswer: null,
      responseText: null,
      failure,
      indeterminate: failure.category === "timeout" || failure.category === "network",
    });
  }

  private settle(
    item: WorkItem,
    outcome: {
      state: OutcomeState;
      kind: OutcomeKind | null;
      parsedAnswer: string | null;
      responseText: string | null;
      failure: FailureRecord | null;
      indeterminate: boolean;
    },
  ): void {
    const nowMs = this.clock.now();
    const lastAttempt = item.attempts.at(-1) ?? null;
    const record: OutcomeRecord = {
      fixtureId: item.fixture.fixtureId,
      evaluationId: item.evaluation.evaluationId,
      state: outcome.state,
      kind: outcome.kind,
      responseText: outcome.responseText,
      parsedAnswer: outcome.parsedAnswer,
      expectedAnswer: item.fixture.expectedAnswer,
      usage: lastAttempt?.usage ?? null,
      cost: aggregateAttemptCost(item.attempts),
      requestLatencyMs: lastAttempt?.requestLatencyMs ?? null,
      totalFixtureTimeMs:
        item.firstAttemptAtMs === null ? null : Math.max(0, nowMs - item.firstAttemptAtMs),
      attemptCount: item.attempts.length,
      indeterminate: outcome.indeterminate,
      failure: outcome.failure,
      lineage: { sourceRunId: null, sourceOutcomeId: null },
      updatedAt: this.iso(nowMs),
    };
    item.outcome = record;
    item.terminal = true;
    this.completedItems += 1;
    this.removeFromQueue(item);
    this.emit({
      type: "outcome.settled",
      evaluationId: item.evaluation.evaluationId,
      fixtureId: item.fixture.fixtureId,
      state: outcome.state,
      kind: outcome.kind,
      requestLatencyMs: record.requestLatencyMs,
      totalFixtureTimeMs: record.totalFixtureTimeMs,
    });
  }

  private removeFromQueue(item: WorkItem): void {
    const group = this.groupByName.get(item.evaluation.rateLimitGroup);
    if (group === undefined) return;
    const index = group.queue.indexOf(item);
    if (index >= 0) group.queue.splice(index, 1);
  }

  private halt(failure: FailureRecord): void {
    if (this.haltReason === null) {
      this.haltReason = failure;
      this.emit({ type: "engine.stopping", reason: "error" });
    }
    this.interruptWaiters();
  }

  private expireCooldowns(): void {
    const now = this.clock.now();
    for (const [group, until] of [...this.cooldownUntil.entries()]) {
      if (until > now) continue;
      this.cooldownUntil.delete(group);
      if (this.cooldownAnnounced.delete(group)) {
        this.emit({ type: "group.cooldown.ended", group });
      }
    }
  }

  private announceRateCap(until: number): void {
    if (this.rateCap === null) {
      const group = this.peekRunnableGroup();
      if (group === undefined) return;
      this.rateCap = { group: group.name, until };
      this.emit({
        type: "group.cooldown.started",
        group: group.name,
        until: this.iso(until),
        reason: "request_cap",
      });
      return;
    }
    if (until > this.rateCap.until) this.rateCap.until = until;
  }

  private clearRateCap(): void {
    if (this.rateCap === null) return;
    const { group } = this.rateCap;
    this.rateCap = null;
    this.emit({ type: "group.cooldown.ended", group });
  }

  private peekRunnableGroup(): GroupState | undefined {
    for (let offset = 0; offset < this.groups.length; offset += 1) {
      const group = this.groups[(this.cursor + offset) % this.groups.length];
      if (group !== undefined && group.queue.length > 0 && !this.activeGroups.has(group.name)) {
        return group;
      }
    }
    return undefined;
  }

  private msUntilLaunchable(): number | null {
    const now = this.clock.now();
    let earliest: number | null = null;
    const consider = (at: number): void => {
      if (at > now && (earliest === null || at < earliest)) earliest = at;
    };

    const rateAt = this.rateLimiter.nextAvailableAt();
    if (rateAt !== null) consider(rateAt);
    for (const group of this.groups) {
      if (group.queue.length === 0 || this.activeGroups.has(group.name)) continue;
      const cooldown = this.cooldownUntil.get(group.name);
      if (cooldown !== undefined) consider(cooldown);
      const head = group.queue[0];
      if (head !== undefined) consider(head.retryAtMs);
    }
    return earliest === null ? null : Math.max(0, earliest - now);
  }

  private async sleepInterruptible(ms: number): Promise<void> {
    if (ms <= 0) return;
    const controller = new AbortController();
    this.wakeController = controller;
    try {
      await this.clock.sleep(ms, controller.signal);
    } finally {
      if (this.wakeController === controller) this.wakeController = null;
    }
  }

  private waitForControl(): Promise<void> {
    return new Promise((resolve) => {
      this.controlWaiter = resolve;
    });
  }

  private interruptWaiters(): void {
    this.wakeController?.abort();
    const waiter = this.controlWaiter;
    this.controlWaiter = null;
    waiter?.();
  }

  private buildEvaluationRecords(): EvaluationRecord[] {
    return this.evaluations.map((evaluation) => {
      const items = this.allItems.filter(
        (item) => item.evaluation.evaluationId === evaluation.evaluationId,
      );
      return {
        evaluationId: evaluation.evaluationId,
        reasoningMode: evaluation.reasoningMode,
        provider: evaluation.provider,
        rateLimitGroup: evaluation.rateLimitGroup,
        outcomes: items.map((item) => item.outcome),
        attempts: items.flatMap((item) => item.attempts),
      };
    });
  }

  private emit(payload: EngineEventPayload): void {
    const event = Object.assign(
      { version: ENGINE_EVENT_VERSION, at: this.iso(this.clock.now()) },
      payload,
    ) as EngineEvent;
    this.sink(event);
  }

  private iso(epochMs: number): string {
    return new Date(epochMs).toISOString();
  }
}

function pendingOutcome(
  evaluationId: string,
  fixture: EngineFixture,
  updatedAt: string,
): OutcomeRecord {
  return {
    fixtureId: fixture.fixtureId,
    evaluationId,
    state: "pending",
    kind: null,
    responseText: null,
    parsedAnswer: null,
    expectedAnswer: fixture.expectedAnswer,
    usage: null,
    cost: { kind: "unknown", usd: null },
    requestLatencyMs: null,
    totalFixtureTimeMs: null,
    attemptCount: 0,
    indeterminate: false,
    failure: null,
    lineage: { sourceRunId: null, sourceOutcomeId: null },
    updatedAt,
  };
}

function attemptStateForFailure(failure: FailureRecord): AttemptState {
  if (failure.category === "cancelled") return "cancelled";
  if (failure.category === "timeout" || failure.category === "network") return "indeterminate";
  return "failed";
}

/**
 * Total cost across attempts. Unknown anywhere means the total is unknown; a
 * mixture of reported and estimated values is reported as `estimated`, because
 * part of the sum is a local estimate rather than provider-reported.
 */
function aggregateAttemptCost(attempts: readonly AttemptRecord[]): CostRecord {
  let reported = 0;
  let estimated = 0;
  let anyReported = false;
  let anyEstimated = false;
  let unknown = false;
  for (const attempt of attempts) {
    if (attempt.cost.kind === "reported" && attempt.cost.usd !== null) {
      reported += attempt.cost.usd;
      anyReported = true;
    } else if (attempt.cost.kind === "estimated" && attempt.cost.usd !== null) {
      estimated += attempt.cost.usd;
      anyEstimated = true;
    } else {
      unknown = true;
    }
  }
  if (unknown) return { kind: "unknown", usd: null };
  if (anyEstimated) return { kind: "estimated", usd: reported + estimated };
  if (anyReported) return { kind: "reported", usd: reported };
  return { kind: "unknown", usd: null };
}
