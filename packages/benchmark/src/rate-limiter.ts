/**
 * Account-wide request-rate cap.
 *
 * A sliding one-minute window over request start times. The engine asks
 * `nextAvailableAt()` before launching; a non-null answer means the whole
 * account must wait that long, regardless of group cooldowns.
 */
export const RATE_LIMIT_WINDOW_MS = 60_000;

export class RequestRateLimiter {
  private readonly limitPerMinute: number;
  private readonly now: () => number;
  private starts: number[] = [];

  constructor(limitPerMinute: number, now: () => number = Date.now) {
    this.limitPerMinute = limitPerMinute;
    this.now = now;
  }

  /** Epoch ms at which a request may start, or null when one may start now. */
  nextAvailableAt(): number | null {
    this.prune();
    if (this.starts.length < this.limitPerMinute) return null;
    const oldest = this.starts[0];
    return oldest === undefined ? null : oldest + RATE_LIMIT_WINDOW_MS;
  }

  /** Record a request starting now. */
  recordRequest(): void {
    this.prune();
    this.starts.push(this.now());
  }

  countInWindow(): number {
    this.prune();
    return this.starts.length;
  }

  private prune(): void {
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS;
    while (this.starts.length > 0 && (this.starts[0] ?? 0) <= cutoff) {
      this.starts.shift();
    }
  }
}
