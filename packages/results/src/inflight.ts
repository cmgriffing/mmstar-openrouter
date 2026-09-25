/**
 * In-flight submission markers.
 *
 * A marker records every attempt the runner has submitted (or is about to
 * submit) before the provider call, so a crash can never make an interrupted
 * request look like work that was never attempted. `reconcileRun` treats a
 * marked attempt without a durable terminal outcome as an indeterminate
 * candidate, which `resume` reissues only with the double-charge disclosure.
 *
 * The file is small and O(in-flight): one entry per request awaiting a
 * response, replaced atomically on every submission. Writes are serialized:
 * two overlapping submissions must never let an older snapshot's atomic rename
 * land after a newer one, because that would silently drop a submitted request
 * from the durable marker. Finished attempts leave the in-memory set
 * immediately but stay in the durable file until the next write, so a crash
 * after an attempt finishes but before its outcome is checkpointed still
 * surfaces as an unknown completion instead of being reissued silently.
 */
import { rm } from "node:fs/promises";
import { atomicWriteFile, readFileIfExistsSync } from "./atomic";
import { RunCorruptError, RunVersionError } from "./errors";
import { serializeJson } from "./serialize";

export const INFLIGHT_VERSION = 1;

export interface InflightAttempt {
  evaluationId: string;
  fixtureId: string;
  attemptNumber: number;
  submittedAt: string;
}

export interface InflightMarkerFile {
  version: typeof INFLIGHT_VERSION;
  runId: string;
  updatedAt: string;
  attempts: InflightAttempt[];
}

export interface InflightMarkerWriterOptions {
  /** Marker file path, normally `RunStore.paths(runId).inflightFile`. */
  file: string;
  runId: string;
  /** Injected clock for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Read and validate a marker file. A missing file is empty (legacy runs are
 * unaffected); a corrupt or unsupported file fails closed so recovery never
 * silently reissues a request that may already have been billed.
 */
export function readInflightMarker(runId: string, file: string): InflightMarkerFile | null {
  const text = readFileIfExistsSync(file);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RunCorruptError(
      runId,
      file,
      `inflight marker is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new RunCorruptError(runId, file, "inflight marker root must be an object");
  }
  if (parsed.version !== INFLIGHT_VERSION) {
    throw new RunVersionError(runId, parsed.version ?? null);
  }
  if (parsed.runId !== runId) {
    throw new RunCorruptError(
      runId,
      file,
      "inflight marker runId does not match its run directory",
    );
  }
  if (typeof parsed.updatedAt !== "string") {
    throw new RunCorruptError(runId, file, "inflight marker is missing updatedAt");
  }
  return {
    version: INFLIGHT_VERSION,
    runId,
    updatedAt: parsed.updatedAt,
    attempts: parseAttempts(runId, file, parsed.attempts),
  };
}

/**
 * In-memory view of the marker with durable write helpers. One instance owns
 * one run directory for the duration of an execution.
 */
export class InflightMarkerWriter {
  private readonly file: string;
  private readonly runId: string;
  private readonly now: () => number;
  private readonly pending = new Map<string, InflightAttempt>();
  /** Serializes file mutations so an older snapshot cannot overwrite a newer one. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: InflightMarkerWriterOptions) {
    this.file = options.file;
    this.runId = options.runId;
    this.now = options.now ?? Date.now;
  }

  /** Attempts currently awaiting a response (or finish accounting). */
  snapshot(): InflightAttempt[] {
    return [...this.pending.values()];
  }

  get size(): number {
    return this.pending.size;
  }

  /**
   * Record a submission before the provider call and await the durable write.
   * Re-recording the same evaluation/fixture replaces the previous attempt
   * (retries keep only the latest submission).
   */
  async record(attempt: InflightAttempt): Promise<void> {
    this.pending.set(identity(attempt), attempt);
    await this.enqueue(() => this.writeFile());
  }

  /**
   * Remove a finished attempt from memory. The durable file keeps the entry
   * until the next write, so a crash before the outcome is checkpointed still
   * surfaces as an unknown completion instead of a silent reissue.
   */
  markFinished(evaluationId: string, fixtureId: string): void {
    this.pending.delete(identity({ evaluationId, fixtureId }));
  }

  /** Rewrite the file from memory, or delete it when nothing is in flight. */
  async persist(): Promise<void> {
    await this.enqueue(() => (this.pending.size === 0 ? this.removeFile() : this.writeFile()));
  }

  /** Delete the marker after a clean finish. */
  async clear(): Promise<void> {
    this.pending.clear();
    await this.enqueue(() => this.removeFile());
  }

  /**
   * Run one file mutation after every previously queued one, so snapshots are
   * applied in call order. A failed mutation does not poison the queue.
   */
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation);
    this.chain = next.catch(() => {
      // The caller sees the rejection; the queue keeps draining.
    });
    return next;
  }

  private async writeFile(): Promise<void> {
    const body: InflightMarkerFile = {
      version: INFLIGHT_VERSION,
      runId: this.runId,
      updatedAt: new Date(this.now()).toISOString(),
      attempts: this.snapshot(),
    };
    await atomicWriteFile(this.file, serializeJson(body));
  }

  private async removeFile(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

function identity(attempt: { evaluationId: string; fixtureId: string }): string {
  return `${attempt.evaluationId}::${attempt.fixtureId}`;
}

function parseAttempts(runId: string, file: string, value: unknown): InflightAttempt[] {
  if (!Array.isArray(value)) {
    throw new RunCorruptError(runId, file, "inflight marker attempts must be an array");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new RunCorruptError(runId, file, `inflight attempt ${index} must be an object`);
    }
    const { evaluationId, fixtureId, attemptNumber, submittedAt } = entry;
    if (typeof evaluationId !== "string" || evaluationId === "") {
      throw new RunCorruptError(runId, file, `inflight attempt ${index} has no evaluationId`);
    }
    if (typeof fixtureId !== "string" || fixtureId === "") {
      throw new RunCorruptError(runId, file, `inflight attempt ${index} has no fixtureId`);
    }
    if (typeof attemptNumber !== "number" || !Number.isFinite(attemptNumber)) {
      throw new RunCorruptError(runId, file, `inflight attempt ${index} has no attemptNumber`);
    }
    if (typeof submittedAt !== "string") {
      throw new RunCorruptError(runId, file, `inflight attempt ${index} has no submittedAt`);
    }
    return { evaluationId, fixtureId, attemptNumber, submittedAt };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
