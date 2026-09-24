/**
 * Publication loading for the query endpoints.
 *
 * Platform differences are confined to where the two immutable assets
 * (`publication/benchmark.sqlite`, `sql-wasm.wasm`) come from:
 *
 * - Node-based targets (local preview, Netlify, Vercel): read them from the
 *   website asset directory on disk.
 * - Cloudflare Workers: fetch them through the `ASSETS` binding, never `node:fs`.
 *
 * The Workers branch imports `cloudflare:workers` through a dynamic, unanalyzable
 * specifier so non-Workers bundles never try to resolve a workerd builtin; on
 * Node the import fails and the filesystem loader is used.
 *
 * Everything downstream is runtime-neutral: the same `@mmstar/results`
 * repository runs on the sql.js adapter, opened read-only and cached for the
 * life of the process/isolate.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicationRepository, type PublicationRepository } from "@mmstar/results";
import { loadSqlJs, openSqlJsDatabase } from "./sqljs-driver";

const DATABASE_ASSET = "publication/benchmark.sqlite";
const WASM_ASSET = "sql-wasm.wasm";

interface AssetsBinding {
  fetch(input: Request): Promise<Response>;
}

export interface PublicationRequestContext {
  request?: Request;
}

/** Worker runtime bindings, when running under workerd. */
interface WorkersModule {
  env?: { ASSETS?: AssetsBinding };
}

const WORKERS_MODULE = "cloudflare:workers";

async function loadWorkersEnv(): Promise<WorkersModule["env"]> {
  try {
    // The variable specifier and vite-ignore keep bundlers from resolving the
    // workerd builtin in Node deployments, where the import simply fails.
    const workers = (await import(/* @vite-ignore */ WORKERS_MODULE)) as WorkersModule;
    return workers.env;
  } catch {
    return undefined;
  }
}

/** The publication or its reader runtime is not available in this deployment. */
export class PublicationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationUnavailableError";
  }
}

interface PublicationAssets {
  database: Uint8Array;
  /** Node targets compile from bytes. */
  wasmBinary?: Uint8Array;
  /** Workers targets use a `CompiledWasm` module instead. */
  wasmModule?: WebAssembly.Module;
}

function candidateAssetDirs(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const fromEnv = process.env.MMSTAR_WEB_ASSETS_DIR;
  const candidates = [
    fromEnv,
    join(process.cwd(), "public"),
    join(process.cwd(), "dist", "client"),
    join(moduleDir, "..", "client"),
  ];
  return candidates.filter((candidate): candidate is string => typeof candidate === "string");
}

function readNodeAssets(): PublicationAssets {
  const tried: string[] = [];
  for (const dir of candidateAssetDirs()) {
    const databasePath = join(dir, DATABASE_ASSET);
    if (!existsSync(databasePath)) {
      tried.push(databasePath);
      continue;
    }
    const wasmPath = join(dir, WASM_ASSET);
    if (!existsSync(wasmPath)) {
      throw new PublicationUnavailableError(
        `found ${databasePath} but not ${wasmPath}; run \`node scripts/sync-publication.mjs\``,
      );
    }
    return { database: readFileSync(databasePath), wasmBinary: readFileSync(wasmPath) };
  }
  throw new PublicationUnavailableError(
    `no publication database found; tried ${tried.join(", ")}. Run \`mmstar export\` and \`node scripts/sync-publication.mjs\`.`,
  );
}

async function readAsset(
  fetcher: AssetsBinding,
  requestUrl: string,
  path: string,
): Promise<Uint8Array> {
  // Root-relative so an `/api/...` request URL cannot push assets under /api.
  const response = await fetcher.fetch(new Request(new URL(`/${path}`, requestUrl)));
  if (!response.ok) {
    throw new PublicationUnavailableError(`asset ${path} returned ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Serverless Node functions do not bundle static assets, so fall back to
 * fetching the same immutable files from the deployment's asset origin. On
 * Netlify/Vercel that is the site CDN; locally it can be any serving origin.
 */
async function readHttpAssets(origin: string): Promise<PublicationAssets> {
  const [database, wasmBinary] = await Promise.all([
    fetchAssetBytes(new URL(`/${DATABASE_ASSET}`, origin).href),
    fetchAssetBytes(new URL(`/${WASM_ASSET}`, origin).href),
  ]);
  return { database, wasmBinary };
}

async function fetchAssetBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new PublicationUnavailableError(`asset ${url} returned ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function readWorkersAssets(
  fetcher: AssetsBinding,
  requestUrl: string,
): Promise<PublicationAssets> {
  return {
    database: await readAsset(fetcher, requestUrl, DATABASE_ASSET),
    wasmModule: await loadWorkerdWasmModule(),
  };
}

/**
 * Workerd forbids compiling WASM from bytes during a request. The documented
 * path is a `CompiledWasm` module rule, loaded through a runtime specifier the
 * bundler leaves alone; the Cloudflare build copies `sql-wasm.wasm` next to the
 * server chunks and adds the rule (scripts/postprocess-cloudflare.mjs).
 */
const WORKERD_WASM_SPECIFIER = "./sql-wasm.wasm";

async function loadWorkerdWasmModule(): Promise<WebAssembly.Module> {
  try {
    const module = (await import(/* @vite-ignore */ WORKERD_WASM_SPECIFIER)) as {
      default?: WebAssembly.Module;
    };
    if (module.default === undefined) {
      throw new Error("no default export");
    }
    return module.default;
  } catch (error) {
    throw new PublicationUnavailableError(
      `could not load the compiled sql-wasm.wasm module (${String(error)}); the Cloudflare build must run scripts/postprocess-cloudflare.mjs`,
    );
  }
}

let cachedRepository: PublicationRepository | undefined;
let pendingOpen: Promise<PublicationRepository> | undefined;

export async function getPublicationRepository(
  context: PublicationRequestContext = {},
): Promise<PublicationRepository> {
  if (cachedRepository !== undefined) return cachedRepository;
  if (pendingOpen === undefined) {
    pendingOpen = openRepository(context).then(
      (repository) => {
        cachedRepository = repository;
        return repository;
      },
      (error: unknown) => {
        pendingOpen = undefined;
        throw error;
      },
    );
  }
  return pendingOpen;
}

async function openRepository(context: PublicationRequestContext): Promise<PublicationRepository> {
  const workersEnv = await loadWorkersEnv();
  const assets = workersEnv?.ASSETS;
  const requestUrl = context.request?.url;
  let source: PublicationAssets;
  if (assets !== undefined && requestUrl !== undefined) {
    source = await readWorkersAssets(assets, requestUrl);
  } else {
    try {
      source = readNodeAssets();
    } catch (error) {
      if (!(error instanceof PublicationUnavailableError) || requestUrl === undefined) throw error;
      source = await readHttpAssets(new URL(requestUrl).origin);
    }
  }
  const SQL =
    source.wasmModule !== undefined
      ? await loadSqlJs({ wasmModule: source.wasmModule })
      : await loadSqlJs({ wasmBinary: source.wasmBinary as Uint8Array });
  const database = openSqlJsDatabase(SQL, source.database, { readOnly: true });
  return createPublicationRepository(database);
}

/** The newest family root, used when a query omits `rootRunId`. */
export function resolveRootRunId(repository: PublicationRepository, explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const root = repository.listRuns().find((run) => run.isRoot);
  if (root === undefined) {
    throw new PublicationUnavailableError("publication contains no runs");
  }
  return root.runId;
}
