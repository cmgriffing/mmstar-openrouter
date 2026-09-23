/**
 * Run directory naming.
 *
 * A run ID is both the directory name under the results root and the durable
 * identity recorded in every file, so it must be parseable, timestamp-ordered,
 * unique, and safe as a single path segment. The format is
 * `<UTC yyyy-mm-ddThh-mm-ss-mmmZ>_<suffix>` where the suffix is 8 hex
 * characters supplied by the caller (the runner uses `crypto.randomUUID`).
 */

export const RUN_ID_REGEX =
  /^(?<stamp>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(?<suffix>[0-9a-f]{8})$/;

export interface ParsedRunId {
  runId: string;
  /** Original creation timestamp encoded in the ID. */
  createdAt: Date;
  createdAtIso: string;
  suffix: string;
}

/** Format an ID from an epoch-millisecond timestamp and an 8-hex-character suffix. */
export function formatRunId(epochMs: number, suffix: string): string {
  if (!/^[0-9a-f]{8}$/.test(suffix)) {
    throw new Error(`run ID suffix must be 8 lowercase hex characters, received "${suffix}"`);
  }
  const iso = new Date(epochMs).toISOString();
  // 2026-09-23T03:33:37.000Z -> 2026-09-23T03-33-37-000Z
  const stamp = `${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, "-")}-${iso.slice(20, 23)}Z`;
  return `${stamp}_${suffix}`;
}

/** Parse a run ID, or return null when the value is not a valid run identity. */
export function parseRunId(value: string): ParsedRunId | null {
  const match = RUN_ID_REGEX.exec(value);
  const stamp = match?.groups?.stamp;
  const suffix = match?.groups?.suffix;
  if (stamp === undefined || suffix === undefined) return null;
  // Rebuild the ISO timestamp: 2026-09-23T03-33-37-000Z -> 2026-09-23T03:33:37.000Z
  const iso = `${stamp.slice(0, 10)}T${stamp.slice(11, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}.${stamp.slice(20, 23)}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (date.toISOString() !== iso) return null;
  return { runId: value, createdAt: date, createdAtIso: iso, suffix };
}

export function isValidRunId(value: string): boolean {
  return parseRunId(value) !== null;
}
