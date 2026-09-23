/**
 * Bounded, renderer-independent view state for the runner TUI.
 *
 * The store consumes the engine's typed events and durable lifecycle payloads
 * and produces plain data. No scheduling, persistence, or React code lives
 * here: `apps/runner/src/index.tsx` subscribes with `useSyncExternalStore`, and
 * the demo harness feeds the same events the real engine emits. History is
 * capped so a long run cannot grow the UI's memory or redraw cost without
 * bound.
 */
import type { CooldownReason, EngineEvent, EngineMetrics } from "@mmstar/benchmark";
import type { ReasoningMode } from "@mmstar/config";
import type {
  AttemptState,
  CostRecord,
  FailureCategory,
  FailureRecord,
  OutcomeKind,
  RecoveryLineage,
  UsageRecord,
} from "@mmstar/results";
import { OUTCOME_STATES, type OutcomeState, RUN_STATES, type RunState } from "@mmstar/results";

export type RowStatus = "queued" | "running" | "cooldown" | "done" | "failed";

/** Newest activity entries kept; older entries are dropped, not accumulated. */
export const MAX_ACTIVITY = 100;
/** Newest notices kept for the overview footer. */
export const MAX_NOTICES = 8;
/** Newest pending retry countdowns kept; a long run cannot grow an unbounded list. */
export const MAX_PENDING_RETRIES = 200;
const MAX_NOTICE_LENGTH = 240;

export interface CooldownView {
  group: string;
  untilMs: number;
  reason: CooldownReason;
}

export interface EvaluationRow {
  evaluationId: string;
  modelAlias: string;
  openRouterId: string;
  reasoningMode: ReasoningMode;
  /** Rate-limit group; variants in one group serialize. */
  group: string;
  /** Last upstream provider observed in a response, or null when unknown. */
  actualProvider: string | null;
  /** Fixtures this evaluation will run (frozen plan selection for this run). */
  total: number;
  counts: Record<OutcomeState, number>;
  attempts: number;
  inFlight: number;
}

export interface ActivityEntry {
  seq: number;
  at: string;
  summary: string;
  /** Coarse classification for filtering without parsing summary text. */
  kind: ActivityKind;
  /** Fixture/evaluation this entry is about, when it is fixture-scoped. */
  evaluationId: string | null;
  fixtureId: string | null;
}

/** Activity classification used by the filter prompt. */
export type ActivityKind = "failure" | "outcome" | "run" | "control";

/** One scheduled retry for a fixture, kept until it starts or settles. */
export interface PendingRetry {
  evaluationId: string;
  fixtureId: string;
  retryAtMs: number;
}

/** Attempt summary shown in the fixture detail pane. */
export interface DetailAttemptView {
  attemptNumber: number;
  state: AttemptState;
  failureCategory: FailureCategory | null;
  requestLatencyMs: number | null;
  usage: UsageRecord | null;
  cost: CostRecord;
  modelUsed: string | null;
  upstreamProvider: string | null;
}

/**
 * One fixture's inspection payload. Plain data assembled by the entry point
 * from engine records plus fixture metadata; the renderer never reads the
 * engine itself.
 */
export interface FixtureDetailView {
  evaluationId: string;
  modelAlias: string;
  reasoningMode: ReasoningMode;
  fixtureId: string;
  category: string;
  question: string;
  state: OutcomeState;
  kind: OutcomeKind | null;
  parsedAnswer: string | null;
  expectedAnswer: string;
  responseText: string | null;
  indeterminate: boolean;
  failure: FailureRecord | null;
  lineage: RecoveryLineage;
  retryAtMs: number | null;
  attempts: DetailAttemptView[];
}

export interface RunnerViewState {
  runId: string | null;
  mode: string | null;
  setName: string | null;
  /** `waiting` until a run is created; then mirrors the engine/run state. */
  status: "waiting" | RunState;
  startedAtMs: number | null;
  updatedAtMs: number | null;
  totalEvaluations: number;
  totalFixtures: number;
  counts: Record<OutcomeState, number>;
  rows: readonly EvaluationRow[];
  cooldowns: readonly CooldownView[];
  /** Oldest first; the renderer scrolls to the newest. */
  activity: readonly ActivityEntry[];
  notices: readonly string[];
  paused: boolean;
  stopping: string | null;
  haltMessage: string | null;
  finished: boolean;
  finalState: RunState | null;
  /**
   * Provisional metrics snapshot computed from engine records. Null until an
   * engine is observed (there is nothing honest to show before that).
   */
  metrics: EngineMetrics | null;
  /** Currently inspected fixture, or null when the inspection pane is closed. */
  detail: FixtureDetailView | null;
  /** Fixtures waiting on a scheduled retry, pruned as attempts resume. */
  pendingRetries: readonly PendingRetry[];
}

export function initialViewState(): RunnerViewState {
  return {
    runId: null,
    mode: null,
    setName: null,
    status: "waiting",
    startedAtMs: null,
    updatedAtMs: null,
    totalEvaluations: 0,
    totalFixtures: 0,
    counts: emptyCounts(),
    rows: [],
    cooldowns: [],
    activity: [],
    notices: [],
    paused: false,
    stopping: null,
    haltMessage: null,
    finished: false,
    finalState: null,
    metrics: null,
    detail: null,
    pendingRetries: [],
  };
}

function emptyCounts(): Record<OutcomeState, number> {
  return Object.fromEntries(OUTCOME_STATES.map((state) => [state, 0])) as Record<
    OutcomeState,
    number
  >;
}

function eventMs(at: string): number | null {
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Terminal outcome states counted as completed work. */
function isTerminal(state: OutcomeState): boolean {
  return state !== "pending";
}

export function completedCount(state: RunnerViewState): number {
  let total = 0;
  for (const outcomeState of OUTCOME_STATES) {
    if (isTerminal(outcomeState)) total += state.counts[outcomeState];
  }
  return total;
}

/** Total planned work items (evaluation × fixture). */
export function totalWork(state: RunnerViewState): number {
  return state.totalEvaluations * state.totalFixtures;
}

/** Cooldown still pending at `nowMs`, or null. Expired entries read as null. */
export function activeCooldown(
  state: RunnerViewState,
  group: string,
  nowMs: number,
): CooldownView | null {
  const cooldown = state.cooldowns.find((entry) => entry.group === group);
  if (cooldown === undefined || cooldown.untilMs <= nowMs) return null;
  return cooldown;
}

export function rowStatus(state: RunnerViewState, row: EvaluationRow, nowMs: number): RowStatus {
  const terminal = OUTCOME_STATES.filter(isTerminal).reduce(
    (sum, outcomeState) => sum + row.counts[outcomeState],
    0,
  );
  if (terminal >= row.total) return row.counts.failed > 0 ? "failed" : "done";
  if (activeCooldown(state, row.group, nowMs) !== null) return "cooldown";
  if (row.inFlight > 0) return "running";
  return "queued";
}

/**
 * Naive remaining time: elapsed per completed item × items left. Returns null
 * until at least one item has completed and time has passed — a running clock
 * with no completions cannot honestly estimate anything.
 */
export function estimateRemainingMs(state: RunnerViewState, nowMs: number): number | null {
  if (state.finished) return 0;
  if (state.startedAtMs === null) return null;
  const done = completedCount(state);
  const remaining = totalWork(state) - done;
  if (remaining <= 0) return 0;
  if (done === 0) return null;
  const elapsed = nowMs - state.startedAtMs;
  if (elapsed <= 0) return null;
  return Math.round((elapsed / done) * remaining);
}

function pushActivity(
  state: RunnerViewState,
  at: string,
  summary: string,
  meta: Partial<Pick<ActivityEntry, "kind" | "evaluationId" | "fixtureId">> = {},
): RunnerViewState {
  const previous = state.activity.at(-1);
  const entry: ActivityEntry = {
    seq: (previous?.seq ?? 0) + 1,
    at,
    summary,
    kind: meta.kind ?? "run",
    evaluationId: meta.evaluationId ?? null,
    fixtureId: meta.fixtureId ?? null,
  };
  const activity = [...state.activity, entry];
  return {
    ...state,
    activity: activity.length > MAX_ACTIVITY ? activity.slice(-MAX_ACTIVITY) : activity,
  };
}

/** Retries still pending at `nowMs`, newest deadline first, expired removed. */
export function activeRetries(state: RunnerViewState, nowMs: number): readonly PendingRetry[] {
  return state.pendingRetries
    .filter((retry) => retry.retryAtMs > nowMs)
    .sort((a, b) => a.retryAtMs - b.retryAtMs);
}

/** Pending retry for one fixture at `nowMs`, or null. */
export function activeRetryFor(
  state: RunnerViewState,
  evaluationId: string,
  fixtureId: string,
  nowMs: number,
): PendingRetry | null {
  const retry = state.pendingRetries.find(
    (entry) => entry.evaluationId === evaluationId && entry.fixtureId === fixtureId,
  );
  if (retry === undefined || retry.retryAtMs <= nowMs) return null;
  return retry;
}

/**
 * Activity entries matching a filter. Every whitespace-separated token must
 * appear in the entry's kind, summary, fixture ID, or evaluation ID; an empty
 * or absent filter matches everything.
 */
export function filterActivity(
  entries: readonly ActivityEntry[],
  filter: string | null | undefined,
): readonly ActivityEntry[] {
  const query = (filter ?? "").trim().toLowerCase();
  if (query === "") return entries;
  const tokens = query.split(/\s+/).filter((token) => token !== "");
  return entries.filter((entry) => {
    const haystack =
      `${entry.kind} ${entry.summary} ${entry.fixtureId ?? ""} ${entry.evaluationId ?? ""}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * Entry selected in the activity pane. `selectedFromNewest` is 0 for the newest
 * entry, matching the renderer's marker indexing.
 */
export function selectedActivityEntry(
  state: RunnerViewState,
  filter: string | null | undefined,
  selectedFromNewest: number,
): ActivityEntry | null {
  const entries = filterActivity(state.activity, filter);
  const index = entries.length - 1 - Math.max(0, selectedFromNewest);
  return entries[index] ?? null;
}

function withoutRetry(
  state: RunnerViewState,
  evaluationId: string,
  fixtureId: string,
): readonly PendingRetry[] {
  if (!state.pendingRetries.some((retry) => isRetryFor(retry, evaluationId, fixtureId))) {
    return state.pendingRetries;
  }
  return state.pendingRetries.filter((retry) => !isRetryFor(retry, evaluationId, fixtureId));
}

function withRetry(
  state: RunnerViewState,
  evaluationId: string,
  fixtureId: string,
  retryAtMs: number,
): readonly PendingRetry[] {
  const retries = withoutRetry(state, evaluationId, fixtureId);
  const entry: PendingRetry = { evaluationId, fixtureId, retryAtMs };
  const next = [...retries, entry];
  return next.length > MAX_PENDING_RETRIES ? next.slice(-MAX_PENDING_RETRIES) : next;
}

function isRetryFor(retry: PendingRetry, evaluationId: string, fixtureId: string): boolean {
  return retry.evaluationId === evaluationId && retry.fixtureId === fixtureId;
}

function pushNotice(state: RunnerViewState, text: string): RunnerViewState {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_NOTICE_LENGTH);
  if (clean === "") return state;
  const notices = [...state.notices, clean];
  return {
    ...state,
    notices: notices.length > MAX_NOTICES ? notices.slice(-MAX_NOTICES) : notices,
  };
}

function updateRow(
  state: RunnerViewState,
  evaluationId: string,
  update: (row: EvaluationRow) => EvaluationRow,
): RunnerViewState {
  return {
    ...state,
    rows: state.rows.map((row) => (row.evaluationId === evaluationId ? update(row) : row)),
  };
}

function findRow(state: RunnerViewState, evaluationId: string): EvaluationRow | undefined {
  return state.rows.find((row) => row.evaluationId === evaluationId);
}

function rowLabel(state: RunnerViewState, evaluationId: string): string {
  const row = findRow(state, evaluationId);
  if (row === undefined) return evaluationId;
  return `${row.modelAlias}/${row.reasoningMode}`;
}

export function applyEngineEvent(state: RunnerViewState, event: EngineEvent): RunnerViewState {
  const atMs = eventMs(event.at);
  const stamped: RunnerViewState = atMs === null ? state : { ...state, updatedAtMs: atMs };

  switch (event.type) {
    case "run.started":
      return {
        ...stamped,
        runId: event.runId,
        status: "running",
        startedAtMs: atMs ?? stamped.startedAtMs,
        totalEvaluations: event.totalEvaluations,
        totalFixtures: event.totalFixtures,
      };

    case "evaluation.started": {
      const existing = findRow(stamped, event.evaluationId);
      const row: EvaluationRow = {
        evaluationId: event.evaluationId,
        modelAlias: event.modelAlias,
        openRouterId: event.openRouterId,
        reasoningMode: event.reasoningMode,
        group: event.rateLimitGroup,
        actualProvider: existing?.actualProvider ?? null,
        total: existing?.total ?? stamped.totalFixtures,
        counts: existing?.counts ?? emptyCounts(),
        attempts: existing?.attempts ?? 0,
        inFlight: existing?.inFlight ?? 0,
      };
      return {
        ...stamped,
        rows: [...stamped.rows.filter((entry) => entry.evaluationId !== event.evaluationId), row],
      };
    }

    case "attempt.started":
      return {
        ...updateRow(stamped, event.evaluationId, (row) => ({
          ...row,
          attempts: row.attempts + 1,
          inFlight: row.inFlight + 1,
        })),
        pendingRetries: withoutRetry(stamped, event.evaluationId, event.fixtureId),
      };

    case "attempt.finished": {
      const finished: RunnerViewState = {
        ...updateRow(stamped, event.evaluationId, (row) => ({
          ...row,
          inFlight: Math.max(0, row.inFlight - 1),
          actualProvider: event.upstreamProvider ?? event.modelUsed ?? row.actualProvider,
        })),
        pendingRetries: withoutRetry(stamped, event.evaluationId, event.fixtureId),
      };
      if (event.failure === null) return finished;
      const retryAtMs = event.retryAt == null ? null : eventMs(event.retryAt);
      const withCountdown: RunnerViewState =
        retryAtMs === null
          ? finished
          : {
              ...finished,
              pendingRetries: withRetry(finished, event.evaluationId, event.fixtureId, retryAtMs),
            };
      return pushActivity(
        withCountdown,
        event.at,
        `attempt failed (${event.failure.category}) fixture ${event.fixtureId} (${rowLabel(withCountdown, event.evaluationId)})`,
        {
          kind: "failure",
          evaluationId: event.evaluationId,
          fixtureId: event.fixtureId,
        },
      );
    }

    case "outcome.settled": {
      const next: RunnerViewState = {
        ...stamped,
        counts: { ...stamped.counts, [event.state]: stamped.counts[event.state] + 1 },
        rows: stamped.rows.map((row) =>
          row.evaluationId === event.evaluationId
            ? { ...row, counts: { ...row.counts, [event.state]: row.counts[event.state] + 1 } }
            : row,
        ),
        pendingRetries: withoutRetry(stamped, event.evaluationId, event.fixtureId),
      };
      if (event.state === "settled") {
        if (event.kind === null || event.kind === "correct") return next;
        return pushActivity(
          next,
          event.at,
          `${event.kind} fixture ${event.fixtureId} (${rowLabel(next, event.evaluationId)})`,
          { kind: "outcome", evaluationId: event.evaluationId, fixtureId: event.fixtureId },
        );
      }
      return pushActivity(
        next,
        event.at,
        `${event.state} fixture ${event.fixtureId} (${rowLabel(next, event.evaluationId)})`,
        { kind: "failure", evaluationId: event.evaluationId, fixtureId: event.fixtureId },
      );
    }

    case "group.cooldown.started": {
      const untilMs = eventMs(event.until) ?? 0;
      return {
        ...stamped,
        cooldowns: [
          ...stamped.cooldowns.filter((cooldown) => cooldown.group !== event.group),
          { group: event.group, untilMs, reason: event.reason },
        ],
      };
    }

    case "group.cooldown.ended":
      return {
        ...stamped,
        cooldowns: stamped.cooldowns.filter((cooldown) => cooldown.group !== event.group),
      };

    case "engine.paused":
      return pushActivity({ ...stamped, paused: true }, event.at, "engine paused", {
        kind: "control",
      });

    case "engine.resumed":
      return pushActivity({ ...stamped, paused: false }, event.at, "engine resumed", {
        kind: "control",
      });

    case "engine.stopping":
      return pushActivity(
        { ...stamped, stopping: event.reason },
        event.at,
        `engine stopping (${event.reason})`,
        { kind: "control" },
      );

    case "run.finished": {
      const next: RunnerViewState = {
        ...stamped,
        status: event.state,
        finalState: event.state,
        finished: true,
        cooldowns: [],
        pendingRetries: [],
      };
      return pushActivity(next, event.at, `run ${event.state}`);
    }
  }
}

const RUN_STATE_SET = new Set<string>(RUN_STATES);

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function readNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Apply one runner lifecycle payload (the same JSON object written to stdout in
 * plain mode). Engine event payloads (`event: "engine"`) are ignored here: the
 * typed subscription already handled them.
 */
export function applyLifecycleEvent(
  state: RunnerViewState,
  payload: Record<string, unknown>,
): RunnerViewState {
  const kind = payload.event;
  switch (kind) {
    case "run.created": {
      const runId = readString(payload, "runId") ?? state.runId;
      const next: RunnerViewState = {
        ...state,
        runId,
        mode: readString(payload, "mode") ?? state.mode,
        setName: readString(payload, "setName") ?? state.setName,
        status: state.status === "waiting" ? "initialized" : state.status,
        totalEvaluations: readNumber(payload, "evaluations") ?? state.totalEvaluations,
        totalFixtures: readNumber(payload, "fixtures") ?? state.totalFixtures,
      };
      return pushActivity(next, new Date().toISOString(), `run ${runId ?? "?"} created`);
    }

    case "run.indeterminate-disclosure": {
      const count = readNumber(payload, "indeterminateCount") ?? 0;
      return pushNotice(
        state,
        `${count} interrupted request(s) have unknown upstream completion; reissuing can bill again`,
      );
    }

    case "run.nothing-to-do": {
      const reason = readString(payload, "reason") ?? "nothing to do";
      const next: RunnerViewState = { ...state, status: "completed", finished: true };
      return pushActivity(next, new Date().toISOString(), `nothing to do: ${reason}`);
    }

    case "run.finished": {
      const rawState = readString(payload, "state");
      const finalState =
        rawState !== null && RUN_STATE_SET.has(rawState) ? (rawState as RunState) : null;
      const halt = payload.halt;
      const haltMessage =
        typeof halt === "object" && halt !== null && "message" in halt
          ? readString(halt as Record<string, unknown>, "message")
          : null;
      const next: RunnerViewState = {
        ...state,
        status: finalState ?? state.status,
        finalState,
        haltMessage,
        finished: true,
        cooldowns: [],
        pendingRetries: [],
      };
      return pushActivity(next, new Date().toISOString(), `run ${finalState ?? "finished"}`);
    }

    case "error": {
      const message = readString(payload, "message") ?? "unknown error";
      return pushActivity(
        pushNotice(state, message),
        new Date().toISOString(),
        `error: ${message}`,
      );
    }

    default:
      return state;
  }
}

/**
 * Apply one engine-metrics snapshot. Metrics come from `computeEngineMetrics`
 * over durable records, so the renderer never re-derives accuracy or costs
 * from its own bounded event history.
 */
export function applyMetrics(state: RunnerViewState, metrics: EngineMetrics): RunnerViewState {
  return { ...state, metrics };
}

/** Open or close the fixture inspection pane. */
export function applyDetail(
  state: RunnerViewState,
  detail: FixtureDetailView | null,
): RunnerViewState {
  return { ...state, detail };
}

/**
 * Add or clear a human-readable notice. Used by the entry point for control
 * requests and terminal/signal diagnostics that are not engine events.
 */
export function addNotice(state: RunnerViewState, text: string): RunnerViewState {
  return pushNotice(state, text);
}

/**
 * Observable state container. `getSnapshot`/`subscribe` are stable references
 * so `useSyncExternalStore` can consume the store directly.
 */
export class RunViewStore {
  private state: RunnerViewState = initialViewState();
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): RunnerViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  applyEngineEvent(event: EngineEvent): void {
    this.set(applyEngineEvent(this.state, event));
  }

  applyLifecycleEvent(payload: Record<string, unknown>): void {
    this.set(applyLifecycleEvent(this.state, payload));
  }

  /** Replace the provisional metrics snapshot. */
  applyMetrics(metrics: EngineMetrics): void {
    this.set(applyMetrics(this.state, metrics));
  }

  /** Show or close the fixture inspection pane. */
  applyDetail(detail: FixtureDetailView | null): void {
    this.set(applyDetail(this.state, detail));
  }

  addNotice(text: string): void {
    this.set(addNotice(this.state, text));
  }

  private set(next: RunnerViewState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
