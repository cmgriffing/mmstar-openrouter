/**
 * Run execution: config/dataset loading, plan freezing, preflight, engine
 * wiring, durable checkpointing, and the resume/recover/restart modes.
 *
 * This module is the only place that decides which fixtures a command reissues.
 * It returns a plain `CommandResult` instead of calling `process.exit`, so the
 * CLI entry point stays a thin adapter and tests can drive every path with an
 * in-memory provider and a temporary results root.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  BenchmarkEngine,
  type CompletionProvider,
  type EngineEventSink,
  type EngineFixture,
  type EngineRunResult,
  type FixtureRecord,
  OpenRouterClient,
  PROMPT_VERSION,
  type PreflightEvaluation,
  parseDatasetTsv,
  preflightPlan,
  toPromptFixture,
} from "@mmstar/benchmark";
import {
  expandPlan,
  type MmstarConfig,
  type PlanEvaluation,
  parseMmstarConfigJson,
  sha256Hex,
  ValidationError,
  type ValidationIssue,
} from "@mmstar/config";
import {
  CAPABILITY_SNAPSHOT_VERSION,
  type EvaluationRecord,
  type FailureRecord,
  type LineageView,
  type ModelCapabilitySnapshot,
  type ModelRecordFile,
  type OutcomeRecord,
  type RunManifest,
  type RunState,
} from "@mmstar/results";
import {
  buildModelFiles,
  countProgress,
  isResumeCandidate,
  isRetryableFailureOutcome,
  outcomeIdentity,
  PublicationError,
  type ReconciledRun,
  RunConflictError,
  RunCorruptError,
  RunLockedError,
  RunNotFoundError,
  RunStore,
  RunVersionError,
  reconcileRun,
  resolveLineage,
} from "@mmstar/results/node";
import { mergePlanEvaluations } from "./checkpoint";
import type { RunnerCommand } from "./commands";
import { flagsForCommand, parseFlags } from "./flags";
import { fetchTransport } from "./transport";

const SCORER_VERSION = 1;

export interface RunContext {
  resultsRoot: string;
  cwd: string;
  configPath: string;
  /** Provider API key; environment only, never config or artifacts. */
  apiKey: string | null;
  skipPreflight: boolean;
  force: boolean;
  now?: () => number;
  suffix?: () => string;
  stderr: { write: (text: string) => void };
  emit: (payload: Record<string, unknown>) => void;
  /** Optional typed engine-event subscriber for an interactive renderer. */
  engineEvents?: EngineEventSink;
  /**
   * Called once per run when the engine exists, for read-only observation and
   * graceful controls. The TUI uses this for metrics, fixture inspection, and
   * pause/stop; it never moves scheduling into the renderer.
   */
  observeEngine?: (engine: BenchmarkEngine, control: EngineObserver) => void;
  revision?: () => Promise<{ revision: string | null; dirty: boolean }>;
  /** Injected provider for tests; defaults to the OpenRouter client. */
  provider?: CompletionProvider;
}

export interface CommandResult {
  exitCode: number;
}

/**
 * Read-only control surface exposed to an observing renderer. `stop` is a
 * graceful interruption: in-flight attempts are cancelled and recorded, and
 * the command exits with the interrupted status.
 */
export interface EngineObserver {
  pause(): void;
  resume(): void;
  stop(reason: "user" | "signal"): void;
}

export type RunRequest =
  | { mode: "run"; set: string }
  | { mode: "resume"; selector: RunSelector }
  | { mode: "retry-failed"; selector: RunSelector }
  | { mode: "restart"; selector: RunSelector };

export interface RunSelector {
  runId?: string | undefined;
  latest?: boolean | undefined;
}

/** Execute the full runner workflow for one command invocation. */
export async function execute(request: RunRequest, context: RunContext): Promise<CommandResult> {
  const store = new RunStore({ root: resolve(context.resultsRoot) });
  try {
    switch (request.mode) {
      case "run":
        return await runFresh(request.set, context, store);
      case "restart":
        return await runRestart(request.selector, context, store);
      case "resume":
      case "retry-failed":
        return await runContinuation(request.mode, request.selector, context, store);
    }
  } catch (error) {
    return reportError(error, context);
  }
}

/**
 * Parse the flag surface for one command into a request. Returns a usage error
 * message instead of throwing so the CLI can print usage next to it.
 */
export function requestFromArgs(
  command: RunnerCommand,
  args: readonly string[],
):
  | { ok: true; request: RunRequest; context: Partial<RunContext> }
  | { ok: false; message: string } {
  const parsed = parseFlags(args, flagsForCommand(command));
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const { values, booleans, positionals } = parsed.flags;

  const common: Partial<RunContext> = {};
  const config = values.get("config");
  if (config !== undefined) common.configPath = config;

  switch (command) {
    case "benchmark": {
      const set = values.get("set") ?? positionals[0];
      if (set === undefined) {
        return { ok: false, message: "benchmark requires --set <name>" };
      }
      common.skipPreflight = booleans.has("skip-preflight");
      return { ok: true, request: { mode: "run", set }, context: common };
    }
    case "resume":
    case "retry-failed": {
      const selector = selectorFrom(positionals, booleans);
      if (!selector.ok) return { ok: false, message: selector.message };
      common.force = booleans.has("force");
      return {
        ok: true,
        request: { mode: command, selector: selector.selector },
        context: common,
      };
    }
    case "restart": {
      const selector = selectorFrom(positionals, booleans);
      if (!selector.ok) return { ok: false, message: selector.message };
      common.force = booleans.has("force");
      return {
        ok: true,
        request: { mode: "restart", selector: selector.selector },
        context: common,
      };
    }
    case "validate":
      return { ok: false, message: "validate does not start a run" };
    case "export":
      return { ok: false, message: "export is parsed by its own command options" };
  }
}

function selectorFrom(
  positionals: readonly string[],
  booleans: ReadonlySet<string>,
): { ok: true; selector: RunSelector } | { ok: false; message: string } {
  const positional = positionals[0];
  const latest = booleans.has("latest");
  if (positionals.length > 1) return { ok: false, message: "only one run may be selected" };
  if (positional !== undefined && latest) {
    return { ok: false, message: "provide either a run ID or --latest, not both" };
  }
  if (positional === undefined && !latest) {
    return { ok: false, message: "provide a run ID or --latest" };
  }
  return { ok: true, selector: latest ? { latest: true } : { runId: positional } };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runFresh(set: string, context: RunContext, store: RunStore): Promise<CommandResult> {
  const config = loadConfig(context);
  const datasetPath = resolvePath(context.cwd, config.dataset.path);
  const dataset = await loadDataset(datasetPath);
  const plan = buildPlan(config, set, dataset.fixtureIds, dataset.sha256);
  const runId = store.nextRunId(nowMs(context), nextSuffix(context));
  const timestamp = nowIso(context);

  const manifest: RunManifest = {
    manifestVersion: 1,
    runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    lineage: { kind: "primary", parentRunId: null, recoveredFixtureIds: null },
    code: await readCodeRevision(context),
    configuration: {
      source: context.configPath,
      sha256: plan.configSha256,
      execution: config.execution,
    },
    plan,
    capabilities: await resolveCapabilities(plan, context),
    lifecycle: { state: "initialized", updatedAt: timestamp },
  };

  const evaluations = preflightEvaluations(manifest);
  store.createRun({ runId, manifest });
  context.emit({
    event: "run.created",
    runId,
    mode: "run",
    setName: plan.setName,
    evaluations: plan.evaluations.length,
    fixtures: plan.dataset.fixtureIds.length,
  });

  return executeManifest({
    context,
    store,
    manifest,
    evaluations,
    fixtures: buildFixtures(manifest, dataset.records, undefined),
    kind: "primary",
  });
}

async function runRestart(
  selector: RunSelector,
  context: RunContext,
  store: RunStore,
): Promise<CommandResult> {
  const source = store.resolveSelector(selector);
  const config = loadConfig(context, source.configuration.source);
  verifyModelsAvailable(source, config);

  // A restart reuses the frozen capability snapshot and plan: it is a new
  // primary run of the same experiment, not a re-plan, so no live metadata
  // fetch is required and no setting can silently change.
  const dataset = await loadDataset(resolvePath(context.cwd, source.plan.dataset.path));
  if (dataset.sha256 !== source.plan.dataset.sha256) {
    throw new DatasetChangedError(source.plan.dataset.path);
  }

  const runId = store.nextRunId(nowMs(context), nextSuffix(context));
  const timestamp = nowIso(context);
  const manifest: RunManifest = {
    ...source,
    runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    lineage: {
      kind: "restart",
      parentRunId: source.runId,
      recoveredFixtureIds: [...source.plan.dataset.fixtureIds],
    },
    code: await readCodeRevision(context),
    configuration: {
      ...source.configuration,
      execution: config.execution,
    },
    lifecycle: { state: "initialized", updatedAt: timestamp },
  };

  const evaluations = preflightEvaluations(manifest);
  store.createRun({ runId, manifest });
  context.emit({
    event: "run.created",
    runId,
    mode: "restart",
    sourceRunId: source.runId,
    evaluations: manifest.plan.evaluations.length,
    fixtures: manifest.plan.dataset.fixtureIds.length,
  });

  return executeManifest({
    context,
    store,
    manifest,
    evaluations,
    fixtures: buildFixtures(manifest, dataset.records, undefined),
    kind: "primary",
  });
}

async function runContinuation(
  mode: "resume" | "retry-failed",
  selector: RunSelector,
  context: RunContext,
  store: RunStore,
): Promise<CommandResult> {
  const source = store.resolveSelector(selector);
  const config = loadConfig(context, source.configuration.source);
  verifyModelsAvailable(source, config);

  const dataset = await loadDataset(resolvePath(context.cwd, source.plan.dataset.path));
  if (dataset.sha256 !== source.plan.dataset.sha256) {
    throw new DatasetChangedError(source.plan.dataset.path);
  }

  const reconciled = reconcileRun(store, source.runId);
  const lineage = resolveLineage(store, source);

  // Hold the source lock across the whole continuation: another resume must not
  // interleave with this one, and a locked run must fail before a child
  // directory is created. Released in `finally`, including on the no-op path.
  const sourceLock = store.acquireLock(source.runId, { force: context.force });
  try {
    return await continueFromSource(
      mode,
      source,
      context,
      store,
      reconciled,
      lineage,
      dataset,
      config,
    );
  } finally {
    sourceLock.release();
  }
}

async function continueFromSource(
  mode: "resume" | "retry-failed",
  source: RunManifest,
  context: RunContext,
  store: RunStore,
  reconciled: ReconciledRun,
  lineage: LineageView,
  dataset: LoadedDataset,
  config: MmstarConfig,
): Promise<CommandResult> {
  const selection = selectWork(mode, source, reconciled, lineage);

  if (selection.evaluationFixtures.size === 0) {
    context.emit({
      event: "run.nothing-to-do",
      runId: source.runId,
      mode,
      reason: selection.reason,
    });
    return { exitCode: 0 };
  }

  const runId = store.nextRunId(nowMs(context), nextSuffix(context));
  const timestamp = nowIso(context);
  const previousFiles = reconciled.files;
  const manifest: RunManifest = {
    ...source,
    runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    lineage: {
      kind: mode === "resume" ? source.lineage.kind : "recovery",
      parentRunId: source.runId,
      recoveredFixtureIds: uniqueFixtures(selection.evaluationFixtures),
    },
    configuration: { ...source.configuration, execution: config.execution },
    lifecycle: { state: "initialized", updatedAt: timestamp },
  };
  const evaluations = preflightEvaluations(manifest);
  store.createRun({ runId, manifest });

  context.emit({
    event: "run.created",
    runId,
    mode,
    sourceRunId: source.runId,
    fixtures: manifest.lineage.recoveredFixtureIds?.length ?? 0,
    evaluations: manifest.plan.evaluations.length,
  });

  if (mode === "resume") {
    const indeterminate = selection.indeterminateCount;
    if (indeterminate > 0) {
      context.stderr.write(
        `mmstar: warning: ${indeterminate} interrupted request(s) have unknown upstream completion; reissuing them can incur another charge\n`,
      );
      context.emit({
        event: "run.indeterminate-disclosure",
        runId,
        indeterminateCount: indeterminate,
      });
    }
  }

  return executeManifest({
    context,
    store,
    manifest,
    evaluations,
    fixtures: buildFixtures(manifest, dataset.records, selection.evaluationFixtures),
    kind: mode === "resume" ? "resume" : "recovery",
    previousFiles,
  });
}

interface SelectionResult {
  /** evaluationId -> fixture IDs to reissue. */
  evaluationFixtures: Map<string, string[]>;
  indeterminateCount: number;
  reason: string;
}

function selectWork(
  mode: "resume" | "retry-failed",
  source: RunManifest,
  reconciled: ReconciledRun,
  lineage: LineageView,
): SelectionResult {
  const byId = new Map(
    reconciled.evaluations.map((evaluation) => [evaluation.evaluationId, evaluation]),
  );
  const missing = new Set(reconciled.missingOutcomes);
  const selection = new Map<string, string[]>();
  let candidates = 0;
  let indeterminateCount = 0;

  for (const planEvaluation of source.plan.evaluations) {
    const record = byId.get(planEvaluation.evaluationId);
    for (const fixtureId of source.plan.dataset.fixtureIds) {
      const identity = outcomeIdentity(planEvaluation.evaluationId, fixtureId);
      const outcome = record?.outcomes.find((candidate) => candidate.fixtureId === fixtureId);

      // A record missing from the durable files is incomplete work by
      // definition: a crash can drop one outcome without losing its model file.
      if (missing.has(identity)) {
        candidates += 1;
        const list = selection.get(planEvaluation.evaluationId) ?? [];
        list.push(fixtureId);
        selection.set(planEvaluation.evaluationId, list);
        continue;
      }
      if (outcome === undefined) continue;

      // A descendant run already recorded a terminal result for this fixture;
      // reissuing it would double-count cost and overwrite recovery history.
      const resolved = lineage.effective.get(identity);
      if (
        resolved !== undefined &&
        resolved.runId !== source.runId &&
        isResolving(resolved.state)
      ) {
        continue;
      }

      const isCandidate =
        mode === "resume" ? isResumeCandidate(outcome) : isRetryableFailureOutcome(outcome);
      if (!isCandidate) continue;

      candidates += 1;
      if (mode === "resume" && outcome.state === "indeterminate") indeterminateCount += 1;
      const list = selection.get(planEvaluation.evaluationId) ?? [];
      list.push(fixtureId);
      selection.set(planEvaluation.evaluationId, list);
    }
  }

  const reason =
    candidates === 0
      ? mode === "resume"
        ? "no pending, cancelled, or interrupted work remains"
        : "no unresolved request failures remain"
      : "";
  return { evaluationFixtures: selection, indeterminateCount, reason };
}

/**
 * States that make a descendant record the final word on a fixture. `failed` and
 * `indeterminate` count because those are what `retry-failed` would reissue, and
 * a later recovery run in the lineage already owns them.
 */
function isResolving(state: OutcomeRecord["state"]): boolean {
  return state === "settled" || state === "failed" || state === "indeterminate";
}

interface ExecuteManifestInput {
  context: RunContext;
  store: RunStore;
  manifest: RunManifest;
  evaluations: readonly PreflightEvaluation[];
  fixtures: readonly EngineFixture[];
  kind: "primary" | "resume" | "recovery";
  previousFiles?: readonly ModelRecordFile[];
  /**
   * Run to lock for exclusive writer access. Defaults to the manifest's own run.
   * A fresh primary/restart locks the run it is about to write; the new child of
   * a continuation needs no competition lock, because its ID is unknowable to
   * any other invocation until it is published.
   */
  lockRunId?: string;
}

async function executeManifest(input: ExecuteManifestInput): Promise<CommandResult> {
  const { context, store, manifest } = input;
  const lock = store.acquireLock(input.lockRunId ?? manifest.runId, { force: context.force });
  const client = new OpenRouterClient({ transport: fetchTransport, apiKey: context.apiKey });

  const engine = new BenchmarkEngine({
    runId: manifest.runId,
    evaluations: input.evaluations,
    fixtures: input.fixtures,
    execution: manifest.configuration.execution,
    provider: context.provider ?? ((payload, control) => client.chatCompletion(payload, control)),
    sink: (event) => {
      context.engineEvents?.(event);
      context.emit({ event: "engine", runId: manifest.runId, ...event });
      if (event.type === "attempt.started" || event.type === "outcome.settled") {
        checkpoint(store, manifest, input, engine.getRecords());
      }
    },
  });

  let interrupted = false;
  const stop = (reason: "user" | "signal" | "error"): void => {
    if (reason !== "error") interrupted = true;
    context.emit({ event: "engine.stop-requested", runId: manifest.runId, reason });
    engine.stop(reason);
  };
  const onSignal = (): void => stop("signal");
  const disposeSignals = registerSignalHandlers(onSignal);
  context.observeEngine?.(engine, {
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    stop: (reason) => stop(reason),
  });

  checkpoint(store, manifest, input, engine.getRecords());

  let result: EngineRunResult;
  try {
    result = await engine.run();
  } finally {
    disposeSignals();
  }

  const finalState = result.state;
  const updatedAt = nowIso(context);
  const finalManifest: RunManifest = {
    ...manifest,
    updatedAt,
    lifecycle: { state: finalState, updatedAt },
  };
  checkpoint(store, finalManifest, input, engine.getRecords(), finalState);
  lock.release();

  const merged =
    input.kind === "primary"
      ? engine.getRecords()
      : mergePlanEvaluations(
          finalManifest,
          input.previousFiles?.flatMap((file) => file.evaluations) ?? [],
          engine.getRecords(),
        );
  const progress = countProgress(finalManifest, merged);

  context.emit({
    event: "run.finished",
    runId: finalManifest.runId,
    state: finalState,
    settled: progress.settled,
    total: progress.total,
    remaining: progress.remaining,
    halt: result.halt,
  });

  if (result.halt !== null) {
    context.stderr.write(`mmstar: run halted: ${result.halt.message}\n`);
    return { exitCode: 1 };
  }
  if (finalState === "completed") return { exitCode: 0 };
  if (interrupted) return { exitCode: 130 };
  return { exitCode: 1 };
}

function checkpoint(
  store: RunStore,
  manifest: RunManifest,
  input: ExecuteManifestInput,
  evaluations: readonly EvaluationRecord[],
  _state?: RunState,
): void {
  const updatedAt = manifest.updatedAt;
  const merged =
    input.kind === "primary"
      ? evaluations
      : mergePlanEvaluations(
          manifest,
          input.previousFiles?.flatMap((file) => file.evaluations) ?? [],
          evaluations,
        );
  const files = buildModelFiles({ ...manifest, updatedAt }, merged, updatedAt);
  store.writeCheckpoint({ manifest: { ...manifest, updatedAt }, files });
}

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

export function loadConfig(context: RunContext, fallbackSource?: string | null): MmstarConfig {
  const source = context.configPath ?? fallbackSource ?? "mmstar.config.json";
  const path = resolvePath(context.cwd, source);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ValidationError(source, [
      { path: "", code: "missing_file", message: `cannot read config file ${path}` },
    ]);
  }
  const result = parseMmstarConfigJson(text);
  if (!result.ok) throw new ValidationError(source, result.issues);
  return result.config;
}

export interface LoadedDataset {
  records: FixtureRecord[];
  fixtureIds: string[];
  sha256: string;
}

export async function loadDataset(path: string): Promise<LoadedDataset> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ValidationError(path, [
      { path: "", code: "missing_file", message: "cannot read dataset file" },
    ]);
  }
  const parsed = parseDatasetTsv(text);
  return {
    records: parsed.fixtures,
    fixtureIds: parsed.fixtures.map((fixture) => fixture.fixtureId),
    sha256: await sha256Hex(text),
  };
}

function buildPlan(
  config: MmstarConfig,
  set: string,
  fixtureIds: readonly string[],
  datasetSha256: string,
): RunManifest["plan"] {
  const result = expandPlan({
    config,
    setName: set,
    fixtureIds,
    datasetSha256,
    configSha256: null,
    promptVersion: PROMPT_VERSION,
    scorerVersion: SCORER_VERSION,
  });
  if (!result.ok) throw new ValidationError(`set ${set}`, result.issues);
  return result.plan;
}

function verifyModelsAvailable(source: RunManifest, config: MmstarConfig): void {
  const issues: ValidationIssue[] = [];
  for (const [index, evaluation] of source.plan.evaluations.entries()) {
    const alias = config.models[evaluation.modelAlias];
    if (alias === undefined) {
      issues.push({
        path: `plan.evaluations[${index}].modelAlias`,
        code: "unknown_alias",
        message: `alias "${evaluation.modelAlias}" is no longer defined in models`,
      });
      continue;
    }
    if (alias.openRouterId !== evaluation.openRouterId) {
      issues.push({
        path: `models.${evaluation.modelAlias}.openRouterId`,
        code: "frozen_setting_changed",
        message: `model ID changed from "${evaluation.openRouterId}" to "${alias.openRouterId}"; a frozen plan cannot be re-targeted`,
      });
    }
    if (!alias.reasoningModes.includes(evaluation.reasoningMode)) {
      issues.push({
        path: `models.${evaluation.modelAlias}.reasoningModes`,
        code: "frozen_setting_changed",
        message: `reasoning mode "${evaluation.reasoningMode}" is no longer declared for this alias`,
      });
    }
    if (alias.rateLimitGroup !== evaluation.rateLimitGroup) {
      issues.push({
        path: `models.${evaluation.modelAlias}.rateLimitGroup`,
        code: "frozen_setting_changed",
        message: `rate-limit group changed from "${evaluation.rateLimitGroup}" to "${alias.rateLimitGroup}"`,
      });
    }
  }
  if (issues.length > 0) throw new ValidationError("frozen plan", issues);
}

/**
 * Rebuild engine evaluations from the manifest's frozen capability snapshot.
 * This is the resume/recovery/restart path: it never re-runs a live capability
 * check, because the snapshot is the record of what the experiment was allowed
 * to do, and a changed capability must not silently alter a frozen run.
 */
export function preflightEvaluations(manifest: RunManifest): PreflightEvaluation[] {
  const issues: ValidationIssue[] = [];
  const evaluations: PreflightEvaluation[] = [];
  const snapshots = new Map(manifest.capabilities.map((snapshot) => [snapshot.modelId, snapshot]));

  for (const [index, evaluation] of manifest.plan.evaluations.entries()) {
    const snapshot = snapshots.get(evaluation.openRouterId);
    if (snapshot === undefined) {
      issues.push({
        path: `plan.evaluations[${index}]`,
        code: "missing_capability",
        message: `no frozen capability snapshot for ${evaluation.openRouterId}`,
      });
      continue;
    }
    const issue = reasoningIssue(evaluation.reasoningMode, snapshot);
    if (issue !== null) {
      issues.push({
        path: `plan.evaluations[${index}].reasoningMode`,
        code: "unsupported_reasoning_effort",
        message: issue,
      });
      continue;
    }
    evaluations.push({
      evaluationId: evaluation.evaluationId,
      modelAlias: evaluation.modelAlias,
      openRouterId: evaluation.openRouterId,
      reasoningMode: evaluation.reasoningMode,
      rateLimitGroup: evaluation.rateLimitGroup,
      provider: evaluation.provider,
      reasoning: reasoningRequest(evaluation.reasoningMode, snapshot),
    });
  }

  if (issues.length > 0) throw new ValidationError("frozen capabilities", issues);
  return evaluations;
}

function reasoningIssue(
  mode: PlanEvaluation["reasoningMode"],
  snapshot: ModelCapabilitySnapshot,
): string | null {
  const reasoning = snapshot.reasoning;
  if (mode === "default") return null;
  if (mode === "none") {
    return reasoning.mandatory === true
      ? 'model metadata marks reasoning as mandatory, so mode "none" cannot be requested'
      : null;
  }
  if (
    reasoning.supportedEfforts === "non-reasoning" ||
    reasoning.supportedEfforts === "no-effort-selection"
  ) {
    return `model metadata exposes no effort selection, so mode "${mode}" is unsupported`;
  }
  if (reasoning.supportedEfforts === null) return null;
  if (!reasoning.supportedEfforts.includes(String(mode))) {
    return `mode "${mode}" is not in the frozen supported efforts (${reasoning.supportedEfforts.join(", ")})`;
  }
  return null;
}

function reasoningRequest(
  mode: PlanEvaluation["reasoningMode"],
  snapshot: ModelCapabilitySnapshot,
): { effort: string } | null {
  if (mode === "default") return null;
  if (mode === "none") {
    return snapshot.reasoning.supportedEfforts === "non-reasoning" ? null : { effort: "none" };
  }
  return { effort: String(mode) };
}

async function resolveCapabilities(
  plan: RunManifest["plan"],
  context: RunContext,
): Promise<ModelCapabilitySnapshot[]> {
  if (context.skipPreflight) {
    context.stderr.write(
      "mmstar: warning: --skip-preflight freezes assumed capabilities with no live check; these results are development evidence, not verified capability evidence\n",
    );
    return assumeCapabilities(plan);
  }

  const client = new OpenRouterClient({ transport: fetchTransport, apiKey: context.apiKey });
  const catalog = await client.fetchModelCatalog();
  if (!catalog.ok) throw new ProviderHaltError(catalog.failure);
  const result = preflightPlan(plan, catalog.value);
  if (!result.ok) throw new ValidationError("capability preflight", result.issues);
  return result.preflight.capabilities;
}

function assumeCapabilities(plan: RunManifest["plan"]): ModelCapabilitySnapshot[] {
  const snapshots: ModelCapabilitySnapshot[] = [];
  for (const evaluation of plan.evaluations) {
    if (snapshots.some((snapshot) => snapshot.modelId === evaluation.openRouterId)) continue;
    snapshots.push({
      snapshotVersion: CAPABILITY_SNAPSHOT_VERSION,
      modelId: evaluation.openRouterId,
      fetchedAt: new Date().toISOString(),
      imageInput: true,
      inputModalities: ["text", "image"],
      reasoning: {
        supportedEfforts: null,
        defaultEffort: null,
        defaultEnabled: null,
        supportsMaxTokens: false,
        mandatory: false,
      },
    });
  }
  return snapshots;
}

function buildFixtures(
  manifest: RunManifest,
  records: readonly FixtureRecord[],
  work: Map<string, string[]> | undefined,
): EngineFixture[] {
  const byId = new Map(records.map((record) => [record.fixtureId, record]));
  const fixtures: EngineFixture[] = [];

  for (const fixtureId of manifest.plan.dataset.fixtureIds) {
    const record = byId.get(fixtureId);
    if (record === undefined) {
      throw new ValidationError(`dataset ${manifest.plan.dataset.path}`, [
        {
          path: `fixture ${fixtureId}`,
          code: "missing_fixture",
          message: "selected fixture is not present in the dataset",
        },
      ]);
    }
    fixtures.push({
      fixtureId: record.fixtureId,
      category: record.category,
      expectedAnswer: record.answer,
      prompt: toPromptFixture(record),
    });
  }

  if (work === undefined) return fixtures;

  // Scope each fixture to the evaluations that selected it. The engine
  // otherwise cross-products every evaluation with every fixture, which would
  // re-run already-scored variants of a fixture that only one evaluation still
  // needs to resolve.
  const scoped: EngineFixture[] = [];
  for (const fixture of fixtures) {
    const evaluationIds = [...work.entries()]
      .filter(([, fixtureIds]) => fixtureIds.includes(fixture.fixtureId))
      .map(([evaluationId]) => evaluationId);
    if (evaluationIds.length === 0) continue;
    scoped.push({ ...fixture, evaluationIds });
  }
  return scoped;
}

function uniqueFixtures(selection: Map<string, string[]>): string[] {
  const seen: string[] = [];
  for (const list of selection.values()) {
    for (const fixtureId of list) {
      if (!seen.includes(fixtureId)) seen.push(fixtureId);
    }
  }
  return seen;
}

async function readCodeRevision(
  context: RunContext,
): Promise<{ revision: string | null; dirty: boolean }> {
  if (context.revision !== undefined) return context.revision();
  try {
    const { spawnSync } = await import("node:child_process");
    const revision = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: context.cwd,
      encoding: "utf8",
    });
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: context.cwd,
      encoding: "utf8",
    });
    const hash = revision.status === 0 ? revision.stdout.trim() : "";
    return {
      revision: hash === "" ? null : hash,
      dirty: status.status === 0 && status.stdout.trim() !== "",
    };
  } catch {
    return { revision: null, dirty: false };
  }
}

export function resolvePath(cwd: string, candidate: string): string {
  return isAbsolute(candidate) ? candidate : join(cwd, candidate);
}

function nowMs(context: RunContext): number {
  return (context.now ?? Date.now)();
}

function nowIso(context: RunContext): string {
  return new Date(nowMs(context)).toISOString();
}

function nextSuffix(context: RunContext): string {
  if (context.suffix !== undefined) return context.suffix();
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

function registerSignalHandlers(onSignal: () => void): () => void {
  const handler = (): void => onSignal();
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

export class DatasetChangedError extends Error {
  constructor(path: string) {
    super(
      `dataset ${path} no longer matches the frozen SHA-256 in the run manifest; restore the original dataset or start a new run`,
    );
    this.name = "DatasetChangedError";
  }
}

export class ProviderHaltError extends Error {
  readonly failure: FailureRecord;

  constructor(failure: FailureRecord) {
    super(`provider request failed: ${failure.message}`);
    this.name = "ProviderHaltError";
    this.failure = failure;
  }
}

export function reportError(error: unknown, context: RunContext): CommandResult {
  if (error instanceof ValidationError) {
    context.emit({ event: "error", kind: error.name, message: error.message });
    context.stderr.write(`mmstar: ${error.message}\n`);
    return { exitCode: 2 };
  }
  if (
    error instanceof RunCorruptError ||
    error instanceof RunVersionError ||
    error instanceof RunConflictError ||
    error instanceof RunNotFoundError ||
    error instanceof RunLockedError ||
    error instanceof DatasetChangedError ||
    error instanceof ProviderHaltError ||
    error instanceof PublicationError
  ) {
    context.emit({ event: "error", kind: error.name, message: error.message });
    context.stderr.write(`mmstar: ${error.message}\n`);
    return { exitCode: 1 };
  }
  const message = error instanceof Error ? error.message : String(error);
  context.emit({ event: "error", kind: "internal", message });
  context.stderr.write(`mmstar: ${message}\n`);
  return { exitCode: 1 };
}
