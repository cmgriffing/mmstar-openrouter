/**
 * Coalescing checkpoint writer.
 *
 * Outcome checkpoints do not need the durability of a submission marker: a
 * crash may lose up to one flush interval of settled outcomes, and `resume`
 * reissues those fixtures (paid, deterministic, non-corrupting). What matters
 * is that persistence never blocks the scheduling/render loop, so this writer:
 *
 * - keeps at most one filesystem write in flight,
 * - collapses intermediate states to the latest snapshot,
 * - flushes at most once per constant interval,
 * - exposes an explicit awaited `flush()` for stop/finish/signal paths, and
 * - performs no writes after `dispose()`.
 */
import type { ModelRecordFile, RunManifest } from "./records";

export interface CheckpointSnapshot {
  manifest: RunManifest;
  files: readonly ModelRecordFile[];
  /** Raw response audit files, keyed by the relative path stored on the attempt. */
  rawFiles?: Readonly<Record<string, string>>;
}

/** Durable snapshot sink; the runner binds this to `RunStore.writeCheckpointAsync`. */
export type CheckpointWrite = (snapshot: CheckpointSnapshot) => Promise<void>;

export interface CheckpointWriterOptions {
  /** Latest in-memory state, or null when there is nothing to write yet. */
  snapshot: () => CheckpointSnapshot | null;
  write: CheckpointWrite;
  /** Constant flush interval; callers should not change this per event. */
  intervalMs?: number;
  /** Receives failures from background (timer-driven) writes. */
  onError?: (error: unknown) => void;
}

export class CheckpointWriter {
  private readonly snapshot: () => CheckpointSnapshot | null;
  private readonly write: CheckpointWrite;
  private readonly onError: (error: unknown) => void;

  private dirty = false;
  private disposed = false;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private writes = 0;
  private failures = 0;

  constructor(options: CheckpointWriterOptions) {
    this.snapshot = options.snapshot;
    this.write = options.write;
    this.onError = options.onError ?? (() => {});
    this.timer = setInterval(() => this.trigger(), options.intervalMs ?? 1000);
    unrefTimer(this.timer);
  }

  /** Number of durable snapshot writes performed; used by tests and telemetry. */
  get writeCount(): number {
    return this.writes;
  }

  /** Number of failed writes (each leaves state dirty for a later flush). */
  get failureCount(): number {
    return this.failures;
  }

  /** State changed; the next periodic tick or `flush()` writes it. */
  markDirty(): void {
    if (this.disposed) return;
    this.dirty = true;
  }

  /**
   * Write every pending change and await the result, including a write that is
   * already in flight. Safe to call concurrently; each flush drains to the
   * latest snapshot present when it finishes.
   */
  async flush(): Promise<void> {
    while (true) {
      if (this.inFlight !== null) {
        await this.inFlight;
        continue;
      }
      if (this.dirty && !this.disposed) {
        await this.startDrain();
        continue;
      }
      break;
    }
  }

  /**
   * Stop the timer and refuse further writes. A write already in flight is
   * awaited so callers can close locks safely; its failure is reported through
   * `onError` instead of rejecting disposal, because disposal runs on cleanup
   * paths that must still release the run lock. Callers should `flush()` first
   * when pending state must be durable.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) {
      try {
        await this.inFlight;
      } catch (error) {
        this.onError(error);
      }
    }
  }

  private trigger(): void {
    if (this.disposed || !this.dirty) return;
    void this.startDrain().catch((error) => this.onError(error));
  }

  private startDrain(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const promise = this.drain().finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  private async drain(): Promise<void> {
    while (this.dirty && !this.disposed) {
      const current = this.snapshot();
      this.dirty = false;
      if (current === null) return;
      try {
        await this.write(current);
        this.writes += 1;
      } catch (error) {
        // Keep the state so a later tick or the final flush can retry instead
        // of silently dropping the newest records.
        this.dirty = true;
        this.failures += 1;
        throw error;
      }
    }
  }
}

/** A pending timer must not keep a process alive after the run settles. */
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
}
