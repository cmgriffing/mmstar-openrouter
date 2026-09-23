/**
 * Durable run storage: directories, manifests, per-model files, locking, and
 * crash reconciliation.
 *
 * Ownership split with `@mmstar/benchmark`: the engine owns in-memory outcomes
 * and emits typed events; this module owns everything that touches disk. A run
 * directory holds:
 *
 *   results/<runId>/manifest.json           frozen plan + lifecycle state
 *   results/<runId>/models/<alias>.json     one file per model, all its outcomes
 *   results/<runId>/raw/...                 optional bounded raw response audit
 *   results/<runId>/run.lock                single-writer lock
 *
 * Every write uses temp-file + rename, so a crash always leaves either the old
 * or the new complete file. A crash between a model-file replacement and the
 * manifest update is invisible: `reconcileRun` rebuilds progress from the
 * validated model files and only trusts the manifest for identity/plan.
 */
import { readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  atomicWriteFileSync,
  createExclusiveFileSync,
  isErrno,
  readFileIfExistsSync,
} from "./atomic";
import {
  RunConflictError,
  RunCorruptError,
  RunLockedError,
  RunNotFoundError,
  RunVersionError,
} from "./errors";
import { formatRunId, isValidRunId, parseRunId } from "./paths";
import {
  type EvaluationRecord,
  MODEL_RECORD_VERSION,
  type ModelRecordFile,
  type OutcomeState,
  RUN_MANIFEST_VERSION,
  type RunManifest,
  type RunState,
} from "./records";

export const MANIFEST_FILE = "manifest.json";
export const MODELS_DIR = "models";
export const RAW_DIR = "raw";
export const LOCK_FILE = "run.lock";
export const MODEL_FILE_SUFFIX = ".json";
export const LOCK_VERSION = 1;

/** Stable identity for one outcome across files and lineage: `<evaluationId>::<fixtureId>`. */
export function outcomeIdentity(evaluationId: string, fixtureId: string): string {
  return `${evaluationId}::${fixtureId}`;
}

/**
 * Encode a model alias into a single safe filename segment. Aliases are already
 * identifier-validated, so this is a defense-in-depth guard against traversal
 * rather than a general escaper.
 */
export function modelFileName(modelAlias: string): string {
  const safe = modelAlias.replace(
    /[^A-Za-z0-9._-]/g,
    (char) => `_${char.charCodeAt(0).toString(16)}`,
  );
  return `${safe}${MODEL_FILE_SUFFIX}`;
}

export interface RunPaths {
  runId: string;
  /** Absolute run directory. */
  dir: string;
  manifestFile: string;
  modelsDir: string;
  rawDir: string;
  lockFile: string;
}

export interface CreateRunInput {
  runId: string;
  manifest: RunManifest;
}

export interface RunLock {
  release: () => void;
}

export interface WriteModelRecordsInput {
  manifest: RunManifest;
  /** Model files to replace; every model that has records must be present. */
  files: readonly ModelRecordFile[];
  /** Raw response audit files, keyed by the relative path stored on the attempt. */
  rawFiles?: Readonly<Record<string, string>>;
}

export interface LockPayload {
  version: typeof LOCK_VERSION;
  runId: string;
  pid: number;
  acquiredAt: string;
  host: string;
}

export interface RunStoreOptions {
  /** Results root, absolute or relative to the process working directory. */
  root: string;
  /** Injected for tests; defaults to `process.pid`. */
  pid?: number;
  /** Injected for tests; defaults to `os.hostname()`. */
  host?: string;
}

export class RunStore {
  readonly root: string;
  private readonly pid: number;
  private readonly host: string;

  constructor(options: RunStoreOptions) {
    this.root = options.root;
    this.pid = options.pid ?? process.pid;
    this.host = options.host ?? hostname();
  }

  /**
   * Generate an unused run ID. `suffix` is supplied by the caller (the runner
   * uses crypto randomness) so tests can produce deterministic IDs.
   */
  nextRunId(nowMs: number, suffix: string): string {
    return formatRunId(nowMs, suffix);
  }

  paths(runId: string): RunPaths {
    assertSafeRunId(runId);
    const dir = join(this.root, runId);
    return {
      runId,
      dir,
      manifestFile: join(dir, MANIFEST_FILE),
      modelsDir: join(dir, MODELS_DIR),
      rawDir: join(dir, RAW_DIR),
      lockFile: join(dir, LOCK_FILE),
    };
  }

  /** Create the run directory, write the manifest, and return its paths. */
  createRun(input: CreateRunInput): RunPaths {
    const paths = this.paths(input.runId);
    if (input.manifest.runId !== input.runId) {
      throw new RunConflictError(
        input.runId,
        `manifest runId ${input.manifest.runId} does not match the requested run directory`,
      );
    }
    if (readFileIfExistsSync(paths.manifestFile) !== null) {
      throw new RunConflictError(input.runId, "a run with this ID already exists");
    }
    atomicWriteFileSync(paths.manifestFile, serializeJson(input.manifest));
    return paths;
  }

  /** Write the manifest atomically. Run directories are created if absent. */
  writeManifest(runId: string, manifest: RunManifest): void {
    const paths = this.paths(runId);
    if (manifest.runId !== runId) {
      throw new RunConflictError(
        runId,
        `manifest runId ${manifest.runId} does not match run directory ${runId}`,
      );
    }
    atomicWriteFileSync(paths.manifestFile, serializeJson(manifest));
  }

  /** Write one model record file atomically, validating identity first. */
  writeModelRecord(runId: string, file: ModelRecordFile): void {
    const paths = this.paths(runId);
    if (file.runId !== runId) {
      throw new RunConflictError(
        runId,
        `model record runId ${file.runId} does not match run directory ${runId}`,
      );
    }
    if (file.recordVersion !== MODEL_RECORD_VERSION) {
      throw new RunVersionError(runId, file.recordVersion);
    }
    atomicWriteFileSync(join(paths.modelsDir, modelFileName(file.modelAlias)), serializeJson(file));
  }

  /** Write or replace every model file and any raw response audit files. */
  writeCheckpoint(input: WriteModelRecordsInput): void {
    const paths = this.paths(input.manifest.runId);
    for (const [relativePath, body] of Object.entries(input.rawFiles ?? {})) {
      atomicWriteFileSync(join(paths.dir, assertSafeRelativePath(relativePath)), body);
    }
    for (const file of input.files) {
      this.writeModelRecord(input.manifest.runId, file);
    }
    this.writeManifest(input.manifest.runId, input.manifest);
  }

  /** Read and validate a manifest. Throws `RunCorruptError`/`RunVersionError`. */
  readManifest(runId: string): RunManifest {
    const paths = this.paths(runId);
    const text = readFileIfExistsSync(paths.manifestFile);
    if (text === null) {
      throw new RunCorruptError(runId, paths.manifestFile, "manifest file is missing");
    }
    return parseManifest(runId, text);
  }

  /** Read and validate every model file in the run, in filename order. */
  readModelRecords(runId: string): ModelRecordFile[] {
    const paths = this.paths(runId);
    const entries = listJsonFiles(paths.modelsDir);
    return entries.map((name) => {
      const filePath = join(paths.modelsDir, name);
      const text = readFileIfExistsSync(filePath);
      if (text === null) {
        throw new RunCorruptError(runId, filePath, "model record file disappeared while reading");
      }
      return parseModelRecord(runId, filePath, text);
    });
  }

  /**
   * Acquire the single-writer lock. A lock held by a process that no longer
   * exists is reclaimed; a live holder is reported instead of guessed away.
   * `force` reclaims regardless, which is how an operator recovers from a lock
   * left by an unreadable/remote PID.
   */
  acquireLock(runId: string, options: { force?: boolean } = {}): RunLock {
    const paths = this.paths(runId);
    const payload: LockPayload = {
      version: LOCK_VERSION,
      runId,
      pid: this.pid,
      acquiredAt: new Date().toISOString(),
      host: this.host,
    };

    const attempt = (): boolean => createExclusiveFileSync(paths.lockFile, serializeJson(payload));

    if (!attempt()) {
      const existing = this.readLock(runId);
      // A lock is only reclaimed when this host can prove its holder is gone:
      // a dead PID recorded on this host. A lock from another host might belong
      // to a live remote process, and a lock carrying this same PID is a
      // re-entrant acquisition (a caller bug), so both require an explicit
      // --force. Without this guard a second in-process writer would silently
      // steal the lock, because `process.kill(self, 0)` always succeeds.
      const holderIsDead =
        existing !== null &&
        existing.host === this.host &&
        existing.pid !== this.pid &&
        !isProcessAlive(existing.pid);
      if (!holderIsDead && options.force !== true) {
        throw new RunLockedError(runId, {
          pid: existing?.pid ?? null,
          acquiredAt: existing?.acquiredAt ?? null,
        });
      }
      // Stale (dead PID, different host, or the same PID re-running after a
      // crash), or forced: replace atomically via rename so two contenders
      // cannot both end up believing they own the lock.
      rmSync(paths.lockFile, { force: true });
      if (!attempt()) {
        const raced = this.readLock(runId);
        throw new RunLockedError(runId, {
          pid: raced?.pid ?? null,
          acquiredAt: raced?.acquiredAt ?? null,
        });
      }
    }

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const current = this.readLock(runId);
        if (current?.pid === this.pid && current.host === this.host) {
          rmSync(paths.lockFile, { force: true });
        }
      },
    };
  }

  /** Read the current lock payload, or null when unlocked/illegible. */
  readLock(runId: string): LockPayload | null {
    const paths = this.paths(runId);
    const text = readFileIfExistsSync(paths.lockFile);
    if (text === null) return null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) return null;
      const { version, runId: lockedRunId, pid, acquiredAt, host } = parsed;
      if (version !== LOCK_VERSION) return null;
      if (typeof lockedRunId !== "string" || typeof pid !== "number") return null;
      if (typeof acquiredAt !== "string" || typeof host !== "string") return null;
      return { version: LOCK_VERSION, runId: lockedRunId, pid, acquiredAt, host };
    } catch {
      return null;
    }
  }

  /** Every valid run directory in the results root, sorted by ID (timestamp order). */
  listRunIds(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.root);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    return entries.filter(isValidRunId).sort();
  }

  /**
   * Resolve an explicit run ID or `--latest`. Latest means the newest primary
   * (including restarted) manifest by creation time, with the run ID as the
   * deterministic tie-breaker; recovery children never win.
   */
  resolveSelector(selector: {
    runId?: string | undefined;
    latest?: boolean | undefined;
  }): RunManifest {
    if (selector.runId !== undefined && selector.latest === true) {
      throw new RunConflictError(
        selector.runId,
        "an explicit run ID and --latest are mutually exclusive",
      );
    }
    if (selector.runId !== undefined) {
      return this.readManifest(selector.runId);
    }
    if (selector.latest === true) {
      const primaries: RunManifest[] = [];
      for (const runId of this.listRunIds()) {
        let manifest: RunManifest;
        try {
          manifest = this.readManifest(runId);
        } catch (error) {
          // A corrupt directory must not silently become "latest"; surface it so
          // the operator can inspect or remove it instead of running the wrong
          // experiment. Unsupported schemas are equally load-bearing.
          if (error instanceof RunVersionError) throw error;
          continue;
        }
        if (manifest.lineage.kind !== "recovery") primaries.push(manifest);
      }
      if (primaries.length === 0) {
        throw new RunNotFoundError("--latest", this.root);
      }
      primaries.sort((a, b) => compareCreation(a, b));
      const newest = primaries[primaries.length - 1];
      if (newest === undefined) throw new RunNotFoundError("--latest", this.root);
      return newest;
    }
    throw new RunConflictError("<none>", "select a run by ID or --latest");
  }
}

/** Deterministic creation ordering: createdAt, then runId as the tie-breaker. */
export function compareCreation(a: RunManifest, b: RunManifest): number {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (at !== bt) return at < bt ? -1 : 1;
  return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
}

export interface ReconciledRun {
  manifest: RunManifest;
  /** Model files in filename order, replaced by the authoritative reconstruction. */
  files: ModelRecordFile[];
  /** `files` flattened into evaluation records, deduplicated and validated. */
  evaluations: EvaluationRecord[];
  /** Model files that were missing or incomplete relative to the plan. */
  missingModelFiles: string[];
  /**
   * `evaluationId::fixtureId` pairs the frozen plan requires but no durable
   * record covers. A crash can drop one outcome without dropping the whole
   * model file, so file presence alone is not proof of progress.
   */
  missingOutcomes: string[];
}

/**
 * Reconstruct durable progress from validated model files.
 *
 * The manifest supplies identity, plan, and capabilities; outcomes and attempts
 * come from the model files. Duplicate attempt/outcome identities across files
 * are conflicts, not silently deduplicated, because they mean two writers or a
 * corrupted copy.
 */
export function reconcileRun(store: RunStore, runId: string): ReconciledRun {
  const manifest = store.readManifest(runId);
  const files = store.readModelRecords(runId);
  const evaluations = mergeModelFiles(files);
  const present = new Set(files.map((file) => file.modelAlias));
  const missingModelFiles = uniqueAliases(manifest).filter((alias) => !present.has(alias));
  const missingOutcomes = findMissingOutcomes(manifest, evaluations);
  return { manifest, files, evaluations, missingModelFiles, missingOutcomes };
}

function findMissingOutcomes(
  manifest: RunManifest,
  evaluations: readonly EvaluationRecord[],
): string[] {
  const byId = new Map(evaluations.map((evaluation) => [evaluation.evaluationId, evaluation]));
  const missing: string[] = [];
  for (const planEvaluation of manifest.plan.evaluations) {
    const record = byId.get(planEvaluation.evaluationId);
    for (const fixtureId of manifest.plan.dataset.fixtureIds) {
      const present = record?.outcomes.some((outcome) => outcome.fixtureId === fixtureId) ?? false;
      if (!present) missing.push(outcomeIdentity(planEvaluation.evaluationId, fixtureId));
    }
  }
  return missing;
}

function mergeModelFiles(files: readonly ModelRecordFile[]): EvaluationRecord[] {
  const byEvaluation = new Map<string, EvaluationRecord>();
  const attemptIds = new Map<string, string>();
  const outcomeIds = new Map<string, string>();

  for (const file of files) {
    for (const evaluation of file.evaluations) {
      if (byEvaluation.has(evaluation.evaluationId)) {
        throw new RunConflictError(
          outcomeIdentity(evaluation.evaluationId, file.modelAlias),
          `evaluation ${evaluation.evaluationId} appears in more than one model file`,
        );
      }
      const evaluationId = evaluation.evaluationId;
      for (const attempt of evaluation.attempts) {
        const id = `${evaluationId}::${attempt.attemptId}`;
        const owner = attemptIds.get(id);
        if (owner !== undefined) {
          throw new RunConflictError(
            id,
            `attempt ${attempt.attemptId} is recorded in both ${owner} and ${file.modelAlias}`,
          );
        }
        attemptIds.set(id, file.modelAlias);
      }
      for (const outcome of evaluation.outcomes) {
        const id = outcomeIdentity(evaluationId, outcome.fixtureId);
        const owner = outcomeIds.get(id);
        if (owner !== undefined) {
          throw new RunConflictError(
            id,
            `outcome ${outcome.fixtureId} is recorded in both ${owner} and ${file.modelAlias}`,
          );
        }
        outcomeIds.set(id, file.modelAlias);
      }
      byEvaluation.set(evaluationId, evaluation);
    }
  }

  return [...byEvaluation.values()].sort((a, b) =>
    a.evaluationId < b.evaluationId ? -1 : a.evaluationId > b.evaluationId ? 1 : 0,
  );
}

/** Distinct model aliases referenced by the frozen plan, in first-seen order. */
export function uniqueAliases(manifest: RunManifest): string[] {
  const seen: string[] = [];
  for (const evaluation of manifest.plan.evaluations) {
    if (!seen.includes(evaluation.modelAlias)) seen.push(evaluation.modelAlias);
  }
  return seen;
}

/** Build model files from engine output, one per alias, preserving plan order. */
export function buildModelFiles(
  manifest: RunManifest,
  evaluations: readonly EvaluationRecord[],
  updatedAt: string,
): ModelRecordFile[] {
  const byAlias = new Map<string, EvaluationRecord[]>();
  for (const evaluation of evaluations) {
    const planEvaluation = manifest.plan.evaluations.find(
      (candidate) => candidate.evaluationId === evaluation.evaluationId,
    );
    const alias = planEvaluation?.modelAlias ?? evaluation.evaluationId.split("::")[0] ?? "unknown";
    const list = byAlias.get(alias) ?? [];
    list.push(evaluation);
    byAlias.set(alias, list);
  }

  const files: ModelRecordFile[] = [];
  for (const alias of uniqueAliases(manifest)) {
    const aliasEvaluations = byAlias.get(alias) ?? [];
    const planEntry = manifest.plan.evaluations.find(
      (evaluation) => evaluation.modelAlias === alias,
    );
    files.push({
      recordVersion: MODEL_RECORD_VERSION,
      runId: manifest.runId,
      modelAlias: alias,
      openRouterId: planEntry?.openRouterId ?? "unknown",
      evaluations: aliasEvaluations.sort((a, b) =>
        a.evaluationId < b.evaluationId ? -1 : a.evaluationId > b.evaluationId ? 1 : 0,
      ),
      updatedAt,
    });
  }
  return files;
}

/** Attempts and outcomes per evaluation, in plan order. */
export function countProgress(
  manifest: RunManifest,
  evaluations: readonly EvaluationRecord[],
): { total: number; settled: number; terminal: number; remaining: number } {
  const byId = new Map(evaluations.map((evaluation) => [evaluation.evaluationId, evaluation]));
  const fixtureCount = manifest.plan.dataset.fixtureIds.length;
  let total = 0;
  let settled = 0;
  let terminal = 0;
  for (const evaluation of manifest.plan.evaluations) {
    const record = byId.get(evaluation.evaluationId);
    for (let index = 0; index < fixtureCount; index += 1) {
      total += 1;
      const outcome = record?.outcomes[index];
      if (outcome === undefined) continue;
      if (outcome.state === "settled") settled += 1;
      if (outcome.state !== "pending") terminal += 1;
    }
  }
  return { total, settled, terminal, remaining: total - terminal };
}

export function parseManifest(runId: string, text: string): RunManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RunCorruptError(
      runId,
      MANIFEST_FILE,
      `manifest is not valid JSON: ${describe(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new RunCorruptError(runId, MANIFEST_FILE, "manifest root must be an object");
  }
  if (parsed.manifestVersion !== RUN_MANIFEST_VERSION) {
    throw new RunVersionError(runId, parsed.manifestVersion ?? null);
  }
  if (parsed.runId !== runId) {
    throw new RunCorruptError(
      runId,
      MANIFEST_FILE,
      `manifest runId ${JSON.stringify(parsed.runId)} does not match directory name`,
    );
  }
  if (!isRecord(parsed.plan) || !Array.isArray(parsed.plan.evaluations)) {
    throw new RunCorruptError(runId, MANIFEST_FILE, "manifest plan is missing");
  }
  return parsed as unknown as RunManifest;
}

export function parseModelRecord(runId: string, filePath: string, text: string): ModelRecordFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RunCorruptError(
      runId,
      filePath,
      `model record is not valid JSON: ${describe(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new RunCorruptError(runId, filePath, "model record root must be an object");
  }
  if (parsed.recordVersion !== MODEL_RECORD_VERSION) {
    throw new RunVersionError(runId, parsed.recordVersion ?? null);
  }
  if (parsed.runId !== runId) {
    throw new RunCorruptError(
      runId,
      filePath,
      "model record runId does not match its run directory",
    );
  }
  if (typeof parsed.modelAlias !== "string") {
    throw new RunCorruptError(runId, filePath, "model record is missing modelAlias");
  }
  if (!Array.isArray(parsed.evaluations)) {
    throw new RunCorruptError(runId, filePath, "model record is missing evaluations");
  }
  return parsed as unknown as ModelRecordFile;
}

/** True when an outcome is terminal and needs no further work. */
export function isTerminalOutcome(state: OutcomeState): boolean {
  return state !== "pending";
}

export function isRunState(value: unknown): value is RunState {
  return (
    value === "initialized" ||
    value === "running" ||
    value === "paused" ||
    value === "completed" ||
    value === "stopped" ||
    value === "failed"
  );
}

export function latestUpdatedAt(
  manifest: RunManifest,
  evaluations: readonly EvaluationRecord[],
  fallback: string,
): string {
  let latest = manifest.updatedAt || fallback;
  for (const evaluation of evaluations) {
    for (const outcome of evaluation.outcomes) {
      if (outcome.updatedAt > latest) latest = outcome.updatedAt;
    }
    for (const attempt of evaluation.attempts) {
      if (attempt.finishedAt !== null && attempt.finishedAt > latest) latest = attempt.finishedAt;
    }
  }
  return latest;
}

/** Serialize with a trailing newline and stable 2-space indentation. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(MODEL_FILE_SUFFIX) && !name.includes(".tmp-"))
      .sort();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
}

/** True when a PID currently exists on this host. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return isErrno(error, "EPERM");
  }
}

function assertSafeRunId(runId: string): void {
  if (!isValidRunId(runId) || !parseRunId(runId)) {
    throw new RunCorruptError(runId, runId, "not a valid run ID (expected <timestamp>_<8 hex>)");
  }
}

function assertSafeRelativePath(relativePath: string): string {
  if (
    relativePath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(relativePath) ||
    relativePath.split(/[\\/]/).some((segment) => segment === ".." || segment === "")
  ) {
    throw new RunConflictError(
      relativePath,
      "raw response paths must stay inside the run directory",
    );
  }
  return relativePath;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
