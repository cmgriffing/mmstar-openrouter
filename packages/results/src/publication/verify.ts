/**
 * Publication-wide integrity verification.
 *
 * `verifyPublication` is the gate the exporter runs before the atomic swap and
 * the tool a deployment/CI check can run afterwards. It trusts nothing the
 * manifest says until it has recomputed it: database hash/size, SQLite
 * integrity, table counts, run/root identity, and every declared image file.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PublicationValidationError } from "../errors";
import type { SqlRow, SqlValue } from "./driver";
import { type PublicationManifest, parsePublicationManifest } from "./manifest";
import {
  PUBLICATION_DATABASE_FILE,
  PUBLICATION_IMAGES_DIR,
  PUBLICATION_MANIFEST_FILE,
  PUBLICATION_META_SCHEMA_VERSION,
  PUBLICATION_SCHEMA_VERSION,
} from "./schema";
import { openSqliteDatabase } from "./sqlite-node";

export interface VerifiedPublication {
  manifest: PublicationManifest;
  outputDir: string;
  databasePath: string;
  imagesDir: string;
}

export function verifyPublication(outputDir: string): VerifiedPublication {
  const manifestPath = join(outputDir, PUBLICATION_MANIFEST_FILE);
  const databasePath = join(outputDir, PUBLICATION_DATABASE_FILE);
  const imagesDir = join(outputDir, PUBLICATION_IMAGES_DIR);

  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, "utf8");
  } catch {
    throw new PublicationValidationError(`publication manifest ${manifestPath} is missing`);
  }
  const manifest = parsePublicationManifest(manifestText, manifestPath);

  const databaseBytes = readFileSync(databasePath);
  const databaseSha256 = sha256Hex(databaseBytes);
  if (databaseBytes.byteLength !== manifest.database.byteLength) {
    throw new PublicationValidationError(
      `database size ${databaseBytes.byteLength} does not match manifest ${manifest.database.byteLength}`,
    );
  }
  if (databaseSha256 !== manifest.database.sha256) {
    throw new PublicationValidationError("database hash does not match the publication manifest");
  }

  verifyImages(imagesDir, manifest);

  const database = openSqliteDatabase(databasePath, { readOnly: true });
  try {
    assertIntegrity(database);
    const meta = database
      .prepare("SELECT value FROM publication_meta WHERE key = ?")
      .get(PUBLICATION_META_SCHEMA_VERSION);
    if (meta === undefined || Number(readValue(meta, "value")) !== PUBLICATION_SCHEMA_VERSION) {
      throw new PublicationValidationError("database schema version does not match this build");
    }
    const counts = {
      runs: countRows(database, "runs"),
      evaluations: countRows(database, "evaluations"),
      fixtures: countRows(database, "fixtures"),
      outcomes: countRows(database, "outcomes"),
      attempts: countRows(database, "attempts"),
    };
    for (const [table, expected] of Object.entries(manifest.database.counts)) {
      const actual = counts[table as keyof typeof counts];
      if (actual !== expected) {
        throw new PublicationValidationError(
          `database ${table} count ${actual} does not match manifest ${expected}`,
        );
      }
    }

    const runIds = database
      .prepare("SELECT run_id FROM runs ORDER BY run_id")
      .all()
      .map((row) => readValue(row, "run_id"));
    if (!sameStrings(runIds, manifest.runs.runIds)) {
      throw new PublicationValidationError(
        "database run IDs do not match the publication manifest",
      );
    }
    const rootRunIds = database
      .prepare("SELECT run_id FROM runs WHERE run_id = root_run_id ORDER BY run_id")
      .all()
      .map((row) => readValue(row, "run_id"));
    if (!sameStrings(rootRunIds, manifest.runs.rootRunIds)) {
      throw new PublicationValidationError(
        "database root runs do not match the publication manifest",
      );
    }

    // Every fixture reference must resolve to a published asset, not just an
    // entry that exists somewhere in the inventory.
    const declaredPaths = new Set(manifest.images.entries.map((entry) => entry.path));
    const referencedPaths = database
      .prepare("SELECT DISTINCT image_path AS path FROM fixtures")
      .all()
      .map((row) => readValue(row, "path"));
    for (const path of referencedPaths) {
      if (!declaredPaths.has(path)) {
        throw new PublicationValidationError(`fixture references undeclared image ${path}`);
      }
    }
  } finally {
    database.close();
  }

  return { manifest, outputDir, databasePath, imagesDir };
}

function verifyImages(imagesDir: string, manifest: PublicationManifest): void {
  let files: string[];
  try {
    files = readdirSync(imagesDir).sort();
  } catch {
    throw new PublicationValidationError(`image directory ${imagesDir} is missing`);
  }
  const declared = new Map(manifest.images.entries.map((entry) => [basename(entry.path), entry]));
  if (files.length !== manifest.images.fileCount) {
    throw new PublicationValidationError(
      `image directory holds ${files.length} files; manifest declares ${manifest.images.fileCount}`,
    );
  }
  let totalBytes = 0;
  for (const file of files) {
    const entry = declared.get(file);
    if (entry === undefined) {
      throw new PublicationValidationError(`image file ${file} is not declared in the manifest`);
    }
    const bytes = readFileSync(join(imagesDir, file));
    if (bytes.byteLength !== entry.byteLength) {
      throw new PublicationValidationError(
        `image ${file} size ${bytes.byteLength} does not match manifest ${entry.byteLength}`,
      );
    }
    if (sha256Hex(bytes) !== entry.sha256) {
      throw new PublicationValidationError(`image ${file} hash does not match the manifest`);
    }
    totalBytes += bytes.byteLength;
  }
  if (totalBytes !== manifest.images.totalBytes) {
    throw new PublicationValidationError(
      `image inventory totals ${totalBytes} bytes; manifest declares ${manifest.images.totalBytes}`,
    );
  }
}

export function assertIntegrity(database: {
  prepare: (sql: string) => { all: () => SqlRow[] };
}): void {
  const integrity = database.prepare("PRAGMA integrity_check").all();
  const verdict = integrity[0] === undefined ? "" : String(integrity[0].integrity_check ?? "");
  if (verdict !== "ok") {
    throw new PublicationValidationError(
      `SQLite integrity_check failed: ${verdict || "no result"}`,
    );
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0) {
    throw new PublicationValidationError(
      `SQLite foreign_key_check found ${foreignKeys.length} violation(s)`,
    );
  }
}

export function countRows(
  database: { prepare: (sql: string) => { get: () => SqlRow | undefined } },
  table: string,
): number {
  const row = database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  if (row === undefined) throw new PublicationValidationError(`cannot count ${table}`);
  return Number(row.n);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readValue(row: SqlRow, column: string): string {
  const value: SqlValue | undefined = row[column];
  if (typeof value !== "string") {
    throw new PublicationValidationError(`expected string column "${column}"`);
  }
  return value;
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/** Byte size on disk, exported for artifact-size reporting. */
export function pathByteLength(path: string): number {
  return statSync(path).size;
}
