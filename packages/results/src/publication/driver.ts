/**
 * Runtime-neutral SQLite driver seam.
 *
 * The exporter and the website repository only depend on this interface, never
 * on a concrete library. Local execution uses `node:sqlite` (available in Node
 * and Bun); the deployment gate in chunk 9 supplies WASM readers per platform.
 *
 * Statements are prepared with positional `?` parameters and executed with the
 * parameter list spread positionally, which every SQLite binding supports.
 */

export type SqlValue = string | number | bigint | Uint8Array | null;

export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  all(...params: SqlValue[]): SqlRow[];
  get(...params: SqlValue[]): SqlRow | undefined;
  run(...params: SqlValue[]): SqlRunResult;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteOpenOptions {
  /** Open without write access; the website repository always uses this. */
  readOnly?: boolean;
}
