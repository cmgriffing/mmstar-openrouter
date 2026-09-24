/**
 * sql.js (SQLite compiled to WebAssembly) adapter for the runtime-neutral
 * `SqliteDatabase` seam.
 *
 * The publication database is loaded from bytes into memory, so there is no
 * filesystem or native binding here: the same adapter runs under Node, in
 * serverless Node functions, and in Cloudflare Workers. `query_only` makes an
 * accidental write fail loudly instead of mutating the in-memory copy.
 *
 * `sql-wasm.js` 1.14 contains no dynamic execution (`eval`/`new Function`) and
 * bundles SQLite 3.49.1, which is required for the window functions and
 * recursive CTE in the publication views.
 */

import type {
  SqliteDatabase,
  SqliteOpenOptions,
  SqliteStatement,
  SqlRow,
  SqlRunResult,
  SqlValue,
} from "@mmstar/results";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

export interface SqlJsLoadOptions {
  /** Pre-fetched WASM bytes; avoids the glue module's own file/URL lookup. */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /**
   * A `WebAssembly.Module` compiled by the host (for example a Cloudflare
   * `CompiledWasm` module). Workerd forbids compiling WASM from bytes at
   * request time, so Workers deployments must use this instead of
   * `wasmBinary`.
   */
  wasmModule?: WebAssembly.Module;
  /** Fallback locator when no `wasmBinary` is supplied. */
  locateFile?: (file: string) => string;
}

export function loadSqlJs(options: SqlJsLoadOptions = {}): Promise<SqlJsStatic> {
  ensureWorkerdLocation();
  const config: Partial<EmscriptenModule> = {};
  if (options.wasmModule !== undefined) {
    const module = options.wasmModule;
    config.instantiateWasm = (imports, receive): WebAssembly.Exports => {
      const instance = new WebAssembly.Instance(module, imports);
      receive(instance);
      return instance.exports;
    };
  } else if (options.wasmBinary !== undefined) {
    // sql.js types require a plain ArrayBuffer; a Uint8Array view may point into
    // a larger buffer, so copy exactly the view's bytes.
    config.wasmBinary =
      options.wasmBinary instanceof Uint8Array
        ? options.wasmBinary.slice().buffer
        : options.wasmBinary;
  }
  if (options.locateFile !== undefined) config.locateFile = options.locateFile;
  return initSqlJs(config);
}

export function openSqlJsDatabase(
  SQL: SqlJsStatic,
  data?: Uint8Array,
  options: SqliteOpenOptions = {},
): SqliteDatabase {
  const database = new SQL.Database(data);
  database.run("PRAGMA foreign_keys = ON");
  if (options.readOnly === true) database.run("PRAGMA query_only = ON");
  return {
    exec: (sql: string): void => {
      database.exec(sql);
    },
    prepare: (sql: string): SqliteStatement => wrapStatement(database, sql),
    close: (): void => {
      database.close();
    },
  };
}

/**
 * Emscripten's glue computes its script directory from `self.location.href`
 * whenever it detects a Worker global scope, and workerd does not define
 * `location`. Supplying `wasmBinary` skips the actual fetch, but the top-level
 * sniff still runs, so provide the one field it reads. Only a missing global is
 * added; a real `location` is never touched.
 */
function ensureWorkerdLocation(): void {
  const global = globalThis as unknown as {
    WorkerGlobalScope?: unknown;
    location?: { href?: string };
  };
  if (global.WorkerGlobalScope === undefined || global.location?.href !== undefined) return;
  try {
    global.location = { href: "https://mmstar-worker.invalid/" };
  } catch {
    // A read-only global leaves the original initialization error to surface.
  }
}

function wrapStatement(database: Database, sql: string): SqliteStatement {
  return {
    all: (...params: SqlValue[]): SqlRow[] => {
      const statement = database.prepare(sql);
      try {
        if (params.length > 0) statement.bind(params as never);
        const rows: SqlRow[] = [];
        while (statement.step()) rows.push(statement.getAsObject() as SqlRow);
        return rows;
      } finally {
        statement.free();
      }
    },
    get: (...params: SqlValue[]): SqlRow | undefined => {
      const statement = database.prepare(sql);
      try {
        if (params.length > 0) statement.bind(params as never);
        if (!statement.step()) return undefined;
        return statement.getAsObject() as SqlRow;
      } finally {
        statement.free();
      }
    },
    run: (...params: SqlValue[]): SqlRunResult => {
      const statement = database.prepare(sql);
      try {
        if (params.length > 0) statement.bind(params as never);
        while (statement.step()) {
          /* drain statements with RETURNING so sql.js applies the write */
        }
        return { changes: database.getRowsModified(), lastInsertRowid: 0 };
      } finally {
        statement.free();
      }
    },
  };
}
