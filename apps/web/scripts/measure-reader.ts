/**
 * WASM SQLite reader gate: measures the sql.js adapter against the real
 * publication and checks query parity with the `node:sqlite` reader.
 *
 * Run from the repository root (Bun executes the workspace TypeScript):
 *   bun apps/web/scripts/measure-reader.ts [publication-dir]
 *
 * Prints a JSON report to stdout and a short human summary to stderr. The ADR
 * in docs/adr/0001-web-sqlite-reader.md records these numbers.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicationRepository } from "@mmstar/results";
import { openSqliteDatabase } from "@mmstar/results/node";
import { loadSqlJs, openSqlJsDatabase } from "../src/server/sqljs-driver";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDir, "..", "..", "..");
const publicationDir =
  process.argv[2] ?? process.env.MMSTAR_PUBLICATION_DIR ?? join(workspaceRoot, "publication");
const sqlJsDist = join(workspaceRoot, "apps", "web", "node_modules", "sql.js", "dist");

const databasePath = join(publicationDir, "benchmark.sqlite");
const wasmPath = join(sqlJsDist, "sql-wasm.wasm");
const gluePath = join(sqlJsDist, "sql-wasm.js");

function now(): number {
  return performance.now();
}

async function timed<T>(fn: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
  const start = now();
  const value = await fn();
  return { value, ms: now() - start };
}

const report: Record<string, unknown> = {};

const databaseBuffer = readFileSync(databasePath);
const wasmBinary = readFileSync(wasmPath);
report.assets = {
  databaseBytes: databaseBuffer.byteLength,
  wasmBytes: wasmBinary.byteLength,
  glueBytes: readFileSync(gluePath).byteLength,
  wasmCompressedBytes: Bun.gzipSync(new Uint8Array(wasmBinary)).byteLength,
  databaseCompressedBytes: Bun.gzipSync(new Uint8Array(databaseBuffer)).byteLength,
};

const baselineMemory = { ...process.memoryUsage() };

const { value: SQL, ms: wasmInitMs } = await timed(() => loadSqlJs({ wasmBinary }));
const { value: wasmDatabase, ms: openMs } = await timed(() =>
  openSqlJsDatabase(SQL, new Uint8Array(databaseBuffer), { readOnly: true }),
);
const wasmRepository = createPublicationRepository(wasmDatabase);

const nodeDatabase = openSqliteDatabase(databasePath, { readOnly: true });
const nodeRepository = createPublicationRepository(nodeDatabase);

// First query is the coldest: it compiles the window-function views.
const { value: meta, ms: firstQueryMs } = await timed(() => wasmRepository.meta());
const { value: runs, ms: listRunsMs } = await timed(() => wasmRepository.listRuns());
const { value: comparisons, ms: comparisonsMs } = await timed(() =>
  wasmRepository.listComparisons(),
);
const { value: categories, ms: categoriesMs } = await timed(() => wasmRepository.listCategories());
const { value: page, ms: fixturesMs } = await timed(() =>
  wasmRepository.listFixtures({ limit: 50 }),
);
const { value: deepPage, ms: deepFixturesMs } = await timed(() =>
  wasmRepository.listFixtures({ limit: 50, offset: 100 }),
);
const firstFixture = page.rows[0];
const { value: detail, ms: detailMs } = await timed(() =>
  firstFixture === undefined
    ? null
    : wasmRepository.getFixtureDetail({
        evaluationId: firstFixture.evaluationId,
        fixtureId: firstFixture.fixtureId,
      }),
);

const afterMemory = { ...process.memoryUsage() };
const mib = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

report.coldStart = {
  wasmInitMs: Math.round(wasmInitMs * 10) / 10,
  openMs: Math.round(openMs * 10) / 10,
  firstQueryMs: Math.round(firstQueryMs * 10) / 10,
  totalMs: Math.round((wasmInitMs + openMs + firstQueryMs) * 10) / 10,
};
report.queryMs = Object.fromEntries(
  Object.entries({
    listRunsMs,
    comparisonsMs,
    categoriesMs,
    fixturesMs,
    deepFixturesMs,
    detailMs,
  }).map(([key, value]) => [key, Math.round(value * 10) / 10]),
);
report.rows = {
  runs: runs.length,
  comparisons: comparisons.length,
  categories: categories.length,
  fixturesPage: page.rows.length,
  detailAttempts: detail?.attempts.length ?? 0,
};
report.memoryMiB = {
  baselineRss: mib(baselineMemory.rss),
  loadedRss: mib(afterMemory.rss),
  rssDelta: mib(afterMemory.rss - baselineMemory.rss),
  loadedArrayBuffers: mib(afterMemory.arrayBuffers),
};

// Warm medians for the view-backed queries (each call prepares a statement).
const warmSamples: Record<string, number[]> = { comparisons: [], categories: [], fixtures: [] };
for (let index = 0; index < 5; index += 1) {
  warmSamples.comparisons.push((await timed(() => wasmRepository.listComparisons())).ms);
  warmSamples.categories.push((await timed(() => wasmRepository.listCategories())).ms);
  warmSamples.fixtures.push((await timed(() => wasmRepository.listFixtures({ limit: 50 }))).ms);
}
report.warmMedianMs = Object.fromEntries(
  Object.entries(warmSamples).map(([key, samples]) => [key, median(samples)]),
);

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  return middle === undefined ? 0 : Math.round(middle * 10) / 10;
}

// Query parity: identical repository calls must return identical JSON.
const parityChecks: Array<[string, () => unknown]> = [
  ["meta", () => meta],
  ["listRuns", () => runs],
  ["listComparisons", () => comparisons],
  ["listCategories", () => categories],
  ["listFixtures", () => page],
  ["listFixtures:offset", () => deepPage],
  ["getFixtureDetail", () => detail],
];
const parity: Record<string, "ok" | string> = {};
for (const [name, read] of parityChecks) {
  const wasmJson = JSON.stringify(read());
  const nodeJson = JSON.stringify(runOnNode(name));
  parity[name] = wasmJson === nodeJson ? "ok" : "mismatch";
}
report.parity = parity;

function runOnNode(name: string): unknown {
  switch (name) {
    case "meta":
      return nodeRepository.meta();
    case "listRuns":
      return nodeRepository.listRuns();
    case "listComparisons":
      return nodeRepository.listComparisons();
    case "listCategories":
      return nodeRepository.listCategories();
    case "listFixtures":
      return nodeRepository.listFixtures({ limit: 50 });
    case "listFixtures:offset":
      return nodeRepository.listFixtures({ limit: 50, offset: 100 });
    case "getFixtureDetail":
      return firstFixture === undefined
        ? null
        : nodeRepository.getFixtureDetail({
            evaluationId: firstFixture.evaluationId,
            fixtureId: firstFixture.fixtureId,
          });
    default:
      throw new Error(`unknown parity check ${name}`);
  }
}

nodeDatabase.close();
wasmDatabase.close();

console.log(JSON.stringify(report, null, 2));
const failedParity = Object.entries(parity).filter(([, result]) => result !== "ok");
const cold = report.coldStart as { totalMs: number };
process.stderr.write(
  `sql.js: cold ${cold.totalMs} ms | warm medians ${JSON.stringify(report.warmMedianMs)} | parity ${failedParity.length === 0 ? "ok" : "MISMATCH"}\n`,
);
if (failedParity.length > 0) process.exitCode = 1;
