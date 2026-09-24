/**
 * `node:sqlite` adapter for the runtime-neutral driver seam.
 *
 * Node 22.5+/24 and Bun both implement `node:sqlite`, so local export,
 * publication verification, and the runner tests share one binding. The
 * deployment gate (chunk 9) supplies WASM adapters per platform.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  SqliteDatabase,
  SqliteOpenOptions,
  SqliteStatement,
  SqlRow,
  SqlRunResult,
  SqlValue,
} from "./driver";

export function openSqliteDatabase(path: string, options: SqliteOpenOptions = {}): SqliteDatabase {
  const database = new DatabaseSync(path, options.readOnly === true ? { readOnly: true } : {});
  database.exec("PRAGMA foreign_keys = ON");
  if (options.readOnly === true) database.exec("PRAGMA query_only = ON");
  return {
    exec: (sql: string): void => database.exec(sql),
    prepare: (sql: string): SqliteStatement => wrapStatement(database.prepare(sql)),
    close: (): void => {
      database.close();
    },
  };
}

function wrapStatement(statement: StatementSync): SqliteStatement {
  return {
    all: (...params: SqlValue[]): SqlRow[] =>
      statement.all(...(params as never[])) as unknown as SqlRow[],
    get: (...params: SqlValue[]): SqlRow | undefined =>
      statement.get(...(params as never[])) as unknown as SqlRow | undefined,
    run: (...params: SqlValue[]): SqlRunResult => {
      const result = statement.run(...(params as never[]));
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid as number | bigint,
      };
    },
  };
}
