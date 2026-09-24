/**
 * Full publication build: images → SQLite import → manifest → verification →
 * atomic replacement.
 *
 * The build happens in a sibling temp directory so the previously published
 * artifact is untouched until every check passes. Only after `verifyPublication`
 * succeeds does the export rename the temp directory into place; a crash after
 * the old directory is moved aside leaves the old artifact recoverable as a
 * `.old-*` sibling, and the next run restores it before building again.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteFileSync } from "../atomic";
import { PublicationValidationError } from "../errors";
import { writeImageAssets } from "./images";
import {
  buildPublicationManifest,
  type PublicationImageEntry,
  type PublicationManifest,
} from "./manifest";
import {
  buildFixtureRows,
  buildPublicationRows,
  type PublicationFixtureInput,
  type PublicationImageAsset,
  type PublicationRows,
  type PublicationRunProjection,
} from "./rows";
import {
  createPublicationSchema,
  PUBLICATION_DATABASE_FILE,
  PUBLICATION_IMAGES_DIR,
  PUBLICATION_MANIFEST_FILE,
  PUBLICATION_META_CREATED_AT,
} from "./schema";
import { openSqliteDatabase } from "./sqlite-node";
import { countRows, sha256Hex, verifyPublication } from "./verify";
import { importPublicationRows } from "./write";

export interface PublishPublicationInput {
  outputDir: string;
  resultsRoot: string;
  dataset: { path: string; sha256: string };
  runs: readonly PublicationRunProjection[];
  /** Selected fixtures with original base64 images, one per fixture. */
  fixtures: readonly PublicationFixtureInput[];
  now?: () => Date;
}

export interface PublishPublicationResult {
  outputDir: string;
  manifest: PublicationManifest;
  databaseBytes: number;
  imageFiles: number;
  imageBytes: number;
}

let suffixCounter = 0;

export async function publishPublication(
  input: PublishPublicationInput,
): Promise<PublishPublicationResult> {
  const outputDir = input.outputDir;
  const parent = dirname(outputDir);
  const base = basename(outputDir);
  mkdirSync(parent, { recursive: true });
  recoverInterruptedSwap(parent, base, outputDir);

  const suffix = `${process.pid}-${Date.now().toString(36)}-${suffixCounter++}`;
  const tempDir = join(parent, `${base}.tmp-${suffix}`);
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  try {
    const imagesDir = join(tempDir, PUBLICATION_IMAGES_DIR);
    const imageResult = writeImageAssets(input.fixtures, imagesDir);
    const assets = new Map<string, PublicationImageAsset>(
      imageResult.assets.map((asset) => [asset.fixtureId, asset]),
    );
    const fixtureRows = buildFixtureRows(input.fixtures, assets);
    const rows = await buildPublicationRows({ runs: input.runs, fixtures: fixtureRows });
    assertFixtureCoverage(rows);

    const databasePath = join(tempDir, PUBLICATION_DATABASE_FILE);
    const createdAt = (input.now ?? (() => new Date()))().toISOString();
    const database = openSqliteDatabase(databasePath);
    let counts: PublicationManifest["database"]["counts"];
    let rootRunIds: string[];
    try {
      createPublicationSchema(database);
      database
        .prepare("INSERT OR REPLACE INTO publication_meta (key, value) VALUES (?, ?)")
        .run(PUBLICATION_META_CREATED_AT, createdAt);
      importPublicationRows(database, rows);
      assertDatabaseMatchesRows(database, rows);
      counts = {
        runs: countRows(database, "runs"),
        evaluations: countRows(database, "evaluations"),
        fixtures: countRows(database, "fixtures"),
        outcomes: countRows(database, "outcomes"),
        attempts: countRows(database, "attempts"),
      };
      rootRunIds = database
        .prepare("SELECT run_id FROM runs WHERE run_id = root_run_id ORDER BY run_id")
        .all()
        .map((row) => String(row.run_id));
    } finally {
      database.close();
    }

    const databaseBytes = readFileSync(databasePath);
    const manifest = buildPublicationManifest({
      createdAt,
      resultsRoot: input.resultsRoot,
      dataset: input.dataset,
      sources: input.runs.map((run) => ({
        runId: run.manifest.runId,
        sha256: run.sourceSha256,
      })),
      rootRunIds,
      database: {
        file: PUBLICATION_DATABASE_FILE,
        sha256: sha256Hex(databaseBytes),
        byteLength: databaseBytes.byteLength,
        counts,
      },
      images: buildImageInventory(imageResult.assets, imageResult.totalBytes),
    });
    atomicWriteFileSync(
      join(tempDir, PUBLICATION_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    verifyPublication(tempDir);

    swapIntoPlace(parent, base, tempDir, outputDir, suffix);
    return {
      outputDir,
      manifest,
      databaseBytes: databaseBytes.byteLength,
      imageFiles: imageResult.fileCount,
      imageBytes: imageResult.totalBytes,
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function assertFixtureCoverage(rows: PublicationRows): void {
  const fixtureIds = new Set(rows.fixtures.map((fixture) => fixture.fixture_id));
  for (const outcome of rows.outcomes) {
    if (!fixtureIds.has(outcome.fixture_id)) {
      throw new PublicationValidationError(
        `outcome references fixture ${outcome.fixture_id}, which has no published fixture row`,
      );
    }
  }
  for (const attempt of rows.attempts) {
    if (!fixtureIds.has(attempt.fixture_id)) {
      throw new PublicationValidationError(
        `attempt references fixture ${attempt.fixture_id}, which has no published fixture row`,
      );
    }
  }
}

function assertDatabaseMatchesRows(
  database: Parameters<typeof countRows>[0],
  rows: PublicationRows,
): void {
  const expectations = [
    ["runs", rows.runs.length],
    ["fixtures", rows.fixtures.length],
    ["outcomes", rows.outcomes.length],
    ["attempts", rows.attempts.length],
  ] as const;
  for (const [table, expected] of expectations) {
    const actual = countRows(database, table);
    if (actual !== expected) {
      throw new PublicationValidationError(
        `database ${table} count ${actual} does not match ${expected} projected rows`,
      );
    }
  }
}

function buildImageInventory(
  assets: readonly PublicationImageAsset[],
  totalBytes: number,
): { directory: string; fileCount: number; totalBytes: number; entries: PublicationImageEntry[] } {
  const entries = new Map<string, PublicationImageEntry>();
  for (const asset of assets) {
    if (entries.has(asset.sha256)) continue;
    entries.set(asset.sha256, {
      sha256: asset.sha256,
      path: asset.relativePath,
      mediaType: asset.mediaType,
      byteLength: asset.byteLength,
    });
  }
  return {
    directory: PUBLICATION_IMAGES_DIR,
    fileCount: entries.size,
    totalBytes,
    entries: [...entries.values()],
  };
}

function swapIntoPlace(
  parent: string,
  base: string,
  tempDir: string,
  outputDir: string,
  suffix: string,
): void {
  const oldDir = join(parent, `${base}.old-${suffix}`);
  const hadPrevious = existsSync(outputDir);
  if (hadPrevious) renameSync(outputDir, oldDir);
  try {
    renameSync(tempDir, outputDir);
  } catch (error) {
    if (hadPrevious && !existsSync(outputDir) && existsSync(oldDir)) {
      renameSync(oldDir, outputDir);
    }
    throw error;
  }
  rmSync(oldDir, { recursive: true, force: true });
}

/**
 * Clean stale build directories and restore a publication that a crash left
 * moved aside, so the "previous artifact survives a failed export" guarantee
 * also holds across process death.
 */
function recoverInterruptedSwap(parent: string, base: string, outputDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.startsWith(`${base}.tmp-`)) {
      rmSync(join(parent, entry), { recursive: true, force: true });
    }
  }
  if (existsSync(outputDir)) return;
  const olds = entries.filter((entry) => entry.startsWith(`${base}.old-`)).sort();
  const newest = olds[olds.length - 1];
  if (newest !== undefined) renameSync(join(parent, newest), outputDir);
}
