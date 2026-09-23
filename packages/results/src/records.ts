/**
 * Versioned run-record contracts for durable JSON persistence and recovery.
 *
 * Chunk 2 defines the shapes only; chunk 5 owns filesystem writes, locking,
 * checkpoints, and crash reconciliation, and chunk 8 owns publication import.
 * Every persisted file carries an explicit `*Version`, and every record has a
 * unique ID so lineage resolution never overwrites completed source data.
 */
import type {
  EvaluationPlan,
  ExecutionConfig,
  ProviderRoutingConfig,
  ReasoningMode,
} from "@mmstar/config";

/** `manifest.json` schema version. */
export const RUN_MANIFEST_VERSION = 1;
/** Per-model record file schema version. */
export const MODEL_RECORD_VERSION = 1;
/** Frozen provider capability snapshot schema version. */
export const CAPABILITY_SNAPSHOT_VERSION = 1;

export const RUN_KINDS = ["primary", "recovery", "restart"] as const;
/** A restart is a fresh primary run; lineage still points at the run it restarted from. */
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATES = [
  "initialized",
  "running",
  "paused",
  "completed",
  "stopped",
  "failed",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const OUTCOME_STATES = [
  "pending",
  "settled",
  "failed",
  "indeterminate",
  "cancelled",
] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

/** Terminal scored classifications. Request failures are states, not kinds. */
export const OUTCOME_KINDS = [
  "correct",
  "incorrect",
  "ambiguous",
  "invalid",
  "refused",
  "truncated",
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export const ATTEMPT_STATES = [
  "started",
  "submitted",
  "completed",
  "failed",
  "indeterminate",
  "cancelled",
] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const FAILURE_CATEGORIES = [
  "timeout",
  "network",
  "rate_limit",
  "server_error",
  "auth",
  "configuration",
  "invalid_request",
  "content_filter",
  "cancelled",
  "unknown",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const COST_KINDS = ["reported", "estimated", "unknown"] as const;
export type CostKind = (typeof COST_KINDS)[number];

/**
 * Token usage. The record itself is null when the provider returned no usage at
 * all; individual fields are null when unknown. Unknown must never be encoded
 * as zero.
 */
export interface UsageRecord {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
}

/**
 * Attempt cost. `kind` distinguishes provider-reported cost, a documented local
 * estimate, and unavailable cost (`usd` null).
 */
export interface CostRecord {
  kind: CostKind;
  usd: number | null;
}

export interface FailureRecord {
  category: FailureCategory;
  message: string;
  /** HTTP status when the failure came from a response, else null. */
  httpStatus: number | null;
  /** Server-requested delay in milliseconds when supplied, else null. */
  retryAfterMs: number | null;
}

export interface AttemptRecord {
  attemptId: string;
  evaluationId: string;
  fixtureId: string;
  /** 1-based attempt number within one execution; maxRetries=3 allows 1..4. */
  attemptNumber: number;
  state: AttemptState;
  /** Set before the request is submitted so a crash leaves durable evidence. */
  startedAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
  /** Requested model ID frozen by the plan. */
  requestedModel: string;
  /** Model ID reported by the response when present, else null. */
  modelUsed: string | null;
  /** Upstream serving provider reported by the response when known, else null. */
  upstreamProvider: string | null;
  finishReason: string | null;
  /** End-to-end request latency, excluding scheduler wait; null when incomplete. */
  requestLatencyMs: number | null;
  usage: UsageRecord | null;
  cost: CostRecord;
  failure: FailureRecord | null;
  /** Relative path to safe raw response data, or null when not retained. */
  rawResponseRef: string | null;
}

export interface RecoveryLineage {
  /** Run whose failed work this outcome resolves, or null for original work. */
  sourceRunId: string | null;
  /** Outcome ID in the source run, or null for original work. */
  sourceOutcomeId: string | null;
}

export interface OutcomeRecord {
  fixtureId: string;
  evaluationId: string;
  state: OutcomeState;
  /** Scored classification; null unless state is "settled". */
  kind: OutcomeKind | null;
  /** Model response text retained for inspection, or null when unavailable. */
  responseText: string | null;
  /** Option letter parsed from the response, or null. */
  parsedAnswer: string | null;
  /** Expected answer kept for scoring/audit; never sent to the model. */
  expectedAnswer: string;
  usage: UsageRecord | null;
  /** Total cost across all attempts for this outcome; never a zero stand-in. */
  cost: CostRecord;
  /** Request latency of the final attempt; separate from total fixture time. */
  requestLatencyMs: number | null;
  /** Fixture wall-clock time including retries and scheduler waits. */
  totalFixtureTimeMs: number | null;
  attemptCount: number;
  /** True when a submitted request has no durable terminal result. */
  indeterminate: boolean;
  failure: FailureRecord | null;
  lineage: RecoveryLineage;
  updatedAt: string;
}

export interface EvaluationRecord {
  evaluationId: string;
  reasoningMode: ReasoningMode;
  provider: ProviderRoutingConfig | null;
  rateLimitGroup: string;
  outcomes: OutcomeRecord[];
  attempts: AttemptRecord[];
}

export interface ModelRecordFile {
  recordVersion: typeof MODEL_RECORD_VERSION;
  runId: string;
  modelAlias: string;
  openRouterId: string;
  evaluations: EvaluationRecord[];
  updatedAt: string;
}

export interface RunLineage {
  kind: RunKind;
  /** Run this one resumes/recovers/restarts, or null for an original primary run. */
  parentRunId: string | null;
  /** Fixture IDs a recovery intends to resolve, or null for non-recovery runs. */
  recoveredFixtureIds: string[] | null;
}

/**
 * Provider effort-selection metadata as reported by the models endpoint.
 *
 * `supportedEfforts` preserves the upstream distinction: an array is the
 * declared effort set, `null` means the gateway accepted all effort values,
 * `"no-effort-selection"` means a reasoning model whose metadata carries no
 * `supported_efforts`, and `"non-reasoning"` means the model declares no
 * reasoning object at all. Unknown capabilities must never be silently treated
 * as supported.
 */
export interface ReasoningCapabilitySnapshot {
  supportedEfforts: string[] | null | "no-effort-selection" | "non-reasoning";
  /** Upstream `default_effort`; `"none"` means off by default. */
  defaultEffort: string | null;
  /** Default on/off state when reasoning is not explicitly requested. */
  defaultEnabled: boolean | null;
  supportsMaxTokens: boolean;
  /** When true, the model rejects disabling reasoning. */
  mandatory: boolean | null;
}

/**
 * Fresh capability metadata captured during preflight and frozen with the plan.
 * A run never guesses image or reasoning support from a model name.
 */
export interface ModelCapabilitySnapshot {
  snapshotVersion: typeof CAPABILITY_SNAPSHOT_VERSION;
  modelId: string;
  /** ISO-8601 UTC timestamp of the metadata fetch. */
  fetchedAt: string;
  /** True when `architecture.input_modalities` includes `image`. */
  imageInput: boolean;
  inputModalities: string[];
  reasoning: ReasoningCapabilitySnapshot;
}

export interface CodeRevision {
  /** Git revision recorded at run creation, or null when unavailable. */
  revision: string | null;
  /** Whether the working tree had uncommitted changes at run creation. */
  dirty: boolean;
}

export interface FrozenConfiguration {
  /** Config file path as loaded, or null when constructed programmatically. */
  source: string | null;
  /** SHA-256 of the config document, or null when unknown. */
  sha256: string | null;
  /** Execution limits frozen for recovery revalidation. */
  execution: ExecutionConfig;
}

export interface RunLifecycle {
  state: RunState;
  updatedAt: string;
}

/**
 * Frozen plan plus lifecycle state. Outcomes live in per-model files; if a crash
 * lands between a model-file replacement and a manifest update, resume
 * reconstructs progress from validated model files rather than trusting the
 * manifest alone.
 */
export interface RunManifest {
  manifestVersion: typeof RUN_MANIFEST_VERSION;
  runId: string;
  createdAt: string;
  updatedAt: string;
  lineage: RunLineage;
  code: CodeRevision;
  configuration: FrozenConfiguration;
  plan: EvaluationPlan;
  /** One snapshot per distinct model in `plan.evaluations`, in first-seen order. */
  capabilities: ModelCapabilitySnapshot[];
  lifecycle: RunLifecycle;
}
