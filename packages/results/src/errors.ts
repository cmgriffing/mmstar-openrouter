/**
 * Run persistence failures.
 *
 * Each error carries the run and file it concerns so the CLI can print one
 * actionable line without guessing, and so tests can assert exact behavior.
 */

export class RunStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStoreError";
  }
}

/** A run directory, manifest, or model file failed validation. */
export class RunCorruptError extends RunStoreError {
  readonly runId: string;
  readonly path: string;

  constructor(runId: string, path: string, message: string) {
    super(`run ${runId} is corrupt: ${message} (${path})`);
    this.name = "RunCorruptError";
    this.runId = runId;
    this.path = path;
  }
}

/** The manifest exists but declares a schema version this build cannot read. */
export class RunVersionError extends RunStoreError {
  readonly runId: string;
  readonly version: unknown;

  constructor(runId: string, version: unknown) {
    super(
      `run ${runId} uses unsupported schema version ${JSON.stringify(version)}; this build reads manifest version 1`,
    );
    this.name = "RunVersionError";
    this.runId = runId;
    this.version = version;
  }
}

/** Another live process holds the single-writer lock for a run. */
export class RunLockedError extends RunStoreError {
  readonly runId: string;
  readonly pid: number | null;
  readonly acquiredAt: string | null;

  constructor(runId: string, holder: { pid: number | null; acquiredAt: string | null }) {
    const holderText = holder.pid === null ? "an unknown process" : `process ${holder.pid}`;
    super(
      `run ${runId} is locked by ${holderText}${
        holder.acquiredAt === null ? "" : ` since ${holder.acquiredAt}`
      }; stop that process or remove the stale lock file manually`,
    );
    this.name = "RunLockedError";
    this.runId = runId;
    this.pid = holder.pid;
    this.acquiredAt = holder.acquiredAt;
  }
}

/** The requested run does not exist in the results root. */
export class RunNotFoundError extends RunStoreError {
  constructor(selector: string, resultsRoot: string) {
    super(`no run matching "${selector}" in ${resultsRoot}`);
    this.name = "RunNotFoundError";
  }
}

/** Two records claim the same durable ID. */
export class RunConflictError extends RunStoreError {
  readonly id: string;

  constructor(id: string, message: string) {
    super(`conflicting record for ${id}: ${message}`);
    this.name = "RunConflictError";
    this.id = id;
  }
}
