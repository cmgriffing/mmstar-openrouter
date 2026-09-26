/**
 * sql.js driver tests: the adapter used in deployments must read the same
 * publication repository contract as `node:sqlite` and must refuse writes.
 *
 * The seed database is created with `node:sqlite` (test-only import; the web
 * runtime never imports `@mmstar/results/node`) and then reopened from bytes
 * through the WASM adapter, mirroring how the site loads its asset.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicationRepository,
  createPublicationSchema,
  EXPORTER_VERSION,
  PUBLICATION_SCHEMA_VERSION,
} from "@mmstar/results";
import { openSqliteDatabase } from "@mmstar/results/node";
import { afterAll, describe, expect, it } from "vitest";
import { loadSqlJs, openSqlJsDatabase } from "./sqljs-driver";

const tempDir = mkdtempSync(join(tmpdir(), "mmstar-sqljs-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

let seedCounter = 0;

function seedDatabaseBytes(): Uint8Array {
  const path = join(tempDir, `benchmark-${seedCounter++}.sqlite`);
  const seed = openSqliteDatabase(path);
  createPublicationSchema(seed);
  seed
    .prepare(
      `INSERT INTO runs
         (run_id, root_run_id, run_kind, parent_run_id, created_at, updated_at,
          lifecycle_state, set_name, dataset_path, dataset_sha256, fixture_count,
          prompt_version, scorer_version, config_sha256, code_revision, code_dirty,
          recovered_fixture_count, content_sha256)
       VALUES ('run-1', 'run-1', 'primary', NULL, '2026-01-01T00:00:00.000Z',
               '2026-01-01T01:00:00.000Z', 'completed', 'smoke', 'MMStar.tsv',
               'dataset-sha', 1, 1, 1, NULL, 'abc', 0, 0, 'content')`,
    )
    .run();
  seed.close();
  return new Uint8Array(readFileSync(path));
}

describe("openSqlJsDatabase", () => {
  it("serves the publication repository from loaded bytes", async () => {
    const SQL = await loadSqlJs();
    const database = openSqlJsDatabase(SQL, seedDatabaseBytes(), { readOnly: true });
    try {
      const repository = createPublicationRepository(database);
      expect(repository.meta()).toMatchObject({
        schemaVersion: PUBLICATION_SCHEMA_VERSION,
        exporterVersion: EXPORTER_VERSION,
      });
      expect(repository.listRuns()).toEqual([
        expect.objectContaining({ runId: "run-1", isRoot: true, lifecycleState: "completed" }),
      ]);
    } finally {
      database.close();
    }
  });

  it("refuses writes when opened read-only", async () => {
    const SQL = await loadSqlJs();
    const database = openSqlJsDatabase(SQL, seedDatabaseBytes(), { readOnly: true });
    try {
      expect(() => database.exec("DELETE FROM runs")).toThrow(/readonly/i);
    } finally {
      database.close();
    }
  });
});
