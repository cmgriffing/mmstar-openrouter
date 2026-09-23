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
import type { CooldownReason, EngineEvent } from "@mmstar/benchmark";
import type { ReasoningMode } from "@mmstar/config";
import { OUTCOME_STATES, type OutcomeState, RUN_STATES, type RunState } from "@mmstar/results";

export type RowStatus = "queued" | "running" | "cooldown" | "done" | "failed";

/** Newest activity entries kept; older entries are dropped, not accumulated. */
export const MAX_ACTIVITY = 100;
/** Newest notices kept for the overview footer. */
export const MAX_NOTICES = 8;
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

function pushActivity(state: RunnerViewState, at: string, summary: string): RunnerViewState {
  const previous = state.activity.at(-1);
  const entry: ActivityEntry = { seq: (previous?.seq ?? 0) + 1, at, summary };
  const activity = [...state.activity, entry];
  return {
    ...state,
    activity: activity.length > MAX_ACTIVITY ? activity.slice(-MAX_ACTIVITY) : activity,
  };
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
      return updateRow(stamped, event.evaluationId, (row) => ({
        ...row,
        attempts: row.attempts + 1,
        inFlight: row.inFlight + 1,
      }));

    case "attempt.finished": {
      const next = updateRow(stamped, event.evaluationId, (row) => ({
        ...row,
        inFlight: Math.max(0, row.inFlight - 1),
        actualProvider: event.upstreamProvider ?? event.modelUsed ?? row.actualProvider,
      }));
      if (event.failure === null) return next;
      return pushActivity(
        next,
        event.at,
        `attempt failed (${event.failure.category}) fixture ${event.fixtureId} (${rowLabel(next, event.evaluationId)})`,
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
      };
      if (event.state === "settled") {
        if (event.kind === null || event.kind === "correct") return next;
        return pushActivity(
          next,
          event.at,
          `${event.kind} fixture ${event.fixtureId} (${rowLabel(next, event.evaluationId)})`,
        );
      }
      return pushActivity(
        next,
        event.at,
        `${event.state} fixture ${event.fixtureId} (${rowLabel(next, event.evaluationId)})`,
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
      return pushActivity({ ...stamped, paused: true }, event.at, "engine paused");

    case "engine.resumed":
      return pushActivity({ ...stamped, paused: false }, event.at, "engine resumed");

    case "engine.stopping":
      return pushActivity(
        { ...stamped, stopping: event.reason },
        event.at,
        `engine stopping (${event.reason})`,
      );

    case "run.finished": {
      const next: RunnerViewState = {
        ...stamped,
        status: event.state,
        finalState: event.state,
        finished: true,
        cooldowns: [],
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

  addNotice(text: string): void {
    this.set(addNotice(this.state, text));
  }

  private set(next: RunnerViewState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
