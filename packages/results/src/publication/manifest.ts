/**
 * Publication manifest: the single immutable binding between the SQLite
 * snapshot and its content-addressed image inventory.
 *
 * The manifest is the artifact a deployment and `verify` trust: schema/exporter
 * versions, source run hashes, database hash/size, and every published image
 * hash/size. A publication without a matching manifest is treated as invalid.
 */
import { PublicationValidationError } from "../errors";
import {
  EXPORTER_VERSION,
  PUBLICATION_DATABASE_FILE,
  PUBLICATION_IMAGES_DIR,
  PUBLICATION_MANIFEST_VERSION,
  PUBLICATION_SCHEMA_VERSION,
} from "./schema";

export interface PublicationRunSource {
  runId: string;
  /** SHA-256 over the run's manifest and model-record bytes. */
  sha256: string;
}

export interface PublicationDatabaseRecord {
  file: string;
  sha256: string;
  byteLength: number;
  counts: PublicationCounts;
}

export interface PublicationCounts {
  runs: number;
  evaluations: number;
  fixtures: number;
  outcomes: number;
  attempts: number;
}

export interface PublicationImageEntry {
  sha256: string;
  /** Path relative to the publication root, e.g. `benchmark-images/<hash>.jpg`. */
  path: string;
  mediaType: string;
  byteLength: number;
}

export interface PublicationImageInventory {
  directory: string;
  fileCount: number;
  totalBytes: number;
  entries: PublicationImageEntry[];
}

export interface PublicationManifest {
  manifestVersion: typeof PUBLICATION_MANIFEST_VERSION;
  schemaVersion: typeof PUBLICATION_SCHEMA_VERSION;
  exporterVersion: typeof EXPORTER_VERSION;
  createdAt: string;
  resultsRoot: string;
  dataset: {
    path: string;
    sha256: string;
  };
  runs: {
    runIds: string[];
    rootRunIds: string[];
  };
  sources: PublicationRunSource[];
  database: PublicationDatabaseRecord;
  images: PublicationImageInventory;
}

export function buildPublicationManifest(input: {
  createdAt: string;
  resultsRoot: string;
  dataset: { path: string; sha256: string };
  sources: readonly PublicationRunSource[];
  rootRunIds: readonly string[];
  database: PublicationDatabaseRecord;
  images: PublicationImageInventory;
}): PublicationManifest {
  const sources = [...input.sources].sort((a, b) =>
    a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0,
  );
  return {
    manifestVersion: PUBLICATION_MANIFEST_VERSION,
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    exporterVersion: EXPORTER_VERSION,
    createdAt: input.createdAt,
    resultsRoot: input.resultsRoot,
    dataset: { ...input.dataset },
    runs: {
      runIds: sources.map((source) => source.runId),
      rootRunIds: [...new Set(input.rootRunIds)].sort(),
    },
    sources,
    database: { ...input.database, counts: { ...input.database.counts } },
    images: {
      directory: input.images.directory,
      fileCount: input.images.fileCount,
      totalBytes: input.images.totalBytes,
      entries: [...input.images.entries].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
    },
  };
}

export function parsePublicationManifest(text: string, path: string): PublicationManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PublicationValidationError(
      `publication manifest ${path} is not valid JSON: ${describe(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PublicationValidationError(`publication manifest ${path} must be an object`);
  }
  const manifest = parsed as Partial<PublicationManifest>;
  if (manifest.manifestVersion !== PUBLICATION_MANIFEST_VERSION) {
    throw new PublicationValidationError(
      `publication manifest ${path} declares version ${JSON.stringify(manifest.manifestVersion)}; this build reads ${PUBLICATION_MANIFEST_VERSION}; re-export the runs with this build`,
    );
  }
  if (manifest.schemaVersion !== PUBLICATION_SCHEMA_VERSION) {
    throw new PublicationValidationError(
      `publication schema version ${JSON.stringify(manifest.schemaVersion)} is not supported (expected ${PUBLICATION_SCHEMA_VERSION}); re-export the runs with this build`,
    );
  }
  if (manifest.exporterVersion !== EXPORTER_VERSION) {
    throw new PublicationValidationError(
      `publication exporter version ${JSON.stringify(manifest.exporterVersion)} is not supported (expected ${EXPORTER_VERSION}); re-export the runs with this build`,
    );
  }
  if (manifest.database === undefined || typeof manifest.database.file !== "string") {
    throw new PublicationValidationError(`publication manifest ${path} is missing database info`);
  }
  if (manifest.database.file !== PUBLICATION_DATABASE_FILE) {
    throw new PublicationValidationError(
      `publication manifest ${path} names database ${manifest.database.file}; expected ${PUBLICATION_DATABASE_FILE}`,
    );
  }
  if (manifest.images === undefined || manifest.images.directory !== PUBLICATION_IMAGES_DIR) {
    throw new PublicationValidationError(
      `publication manifest ${path} names an unsupported image directory`,
    );
  }
  if (!Array.isArray(manifest.images.entries) || !Array.isArray(manifest.sources)) {
    throw new PublicationValidationError(
      `publication manifest ${path} is missing sources or image entries`,
    );
  }
  return manifest as PublicationManifest;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
