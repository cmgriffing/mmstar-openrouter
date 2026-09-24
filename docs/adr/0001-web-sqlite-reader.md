# ADR 0001: WASM SQLite reader for the results website

- **Status**: accepted (chunk 9 compatibility gate)
- **Date**: 2026-09-23
- **Context**: `results-website` spec — immutable production querying, deployment
  portability evidence for Netlify, Vercel, and Cloudflare Workers.

## Context

The website queries one immutable `publication/benchmark.sqlite` (schema version 1)
plus content-addressed image assets. The schema depends on window functions
(`ROW_NUMBER() OVER (...)`) and a recursive CTE (`v_runs_with_root`), so the reader
must bundle a modern SQLite. Serverless/edge targets cannot assume a native SQLite
binding: Netlify and Vercel functions run Node (where `node:sqlite` exists on Node
22.5+), but Cloudflare Workers does not expose `node:sqlite` and forbids dynamic
execution (`eval`/`new Function`).

The runner-side exporter and local tooling already use `node:sqlite`
(`packages/results/src/publication/sqlite-node.ts`). The website needs a reader that
implements the same `SqliteDatabase` seam (`publication/driver.ts`) so the query
repository in `packages/results/src/query/repository.ts` is written once.

## Decision

Use **sql.js 1.14.2** (`sql-wasm.js` + `sql-wasm.wasm`) as the deployment reader:

- `apps/web/src/server/sqljs-driver.ts` implements `SqliteDatabase` over a
  `sql.js` database opened from a `Uint8Array`, with `PRAGMA query_only = ON`.
- The database bytes are served as an immutable static asset
  (`/publication/benchmark.sqlite`) and fetched through a platform adapter
  (filesystem or deployment origin on Node, the `ASSETS` binding on Cloudflare).
- On Node targets the WASM binary (`/sql-wasm.wasm`) is instantiated from bytes
  with `wasmBinary`. On Cloudflare Workers, where workerd forbids compiling WASM
  from bytes during a request, the binary is loaded as a `CompiledWasm` module
  through Emscripten's `instantiateWasm` hook (the Cloudflare build copies it
  next to the server chunks and adds the module rule).
- The in-memory database is opened once per isolate/process and reused; the
  underlying asset is never writable, and `query_only` makes an accidental write
  fail loudly.

### Why sql.js

- **Modern SQLite**: bundles SQLite **3.49.1** — window functions and recursive
  CTEs used by the publication views work unchanged.
- **No dynamic execution**: `sql-wasm.js` 1.14 contains no `eval`/`new Function`,
  so it is allowed under Cloudflare Workers' runtime restrictions.
- **Small runtime surface**: 46.5 KB glue + 658 KB WASM (326 KB gzip), far below
  the Workers 3 MB/10 MB script limits; the WASM ships as an asset, not in the
  worker bundle.
- **One API everywhere**: plain `Uint8Array` input and synchronous statement API
  map directly onto the `SqliteDatabase` seam with no async ceremony.
- **Read-only by construction**: a loaded byte array is an in-memory snapshot;
  there is no live database file to write.

### Alternatives considered

| Option | Why not |
| --- | --- |
| `@sqlite.org/sqlite-wasm` | Official build but worker/OPFS-oriented; larger and more complex to instantiate synchronously in a Serverless function; no benefit for a read-only 2.7 MB snapshot. |
| `wa-sqlite` | VFS-focused (OPFS/IDB); unnecessary for a single immutable read-only file. |
| `node:sqlite` on Netlify/Vercel only | Not available on Cloudflare Workers, and would fork the query layer per target. Kept as the local/test binding only. |
| Bundling the database into the worker | Pushes the 2.7 MB snapshot and the WASM into the worker bundle; static assets plus a fetch are cheaper and cacheable. |

## Measured evidence

`bun apps/web/scripts/measure-reader.ts` against the full representative
publication (1 run, 2 evaluations, 1,500 fixtures, 3,000 outcomes, 3,000 attempts),
2026-09-23, Bun 1.4.2, Node 24.16.0, macOS arm64. The harness also runs every
repository query against `node:sqlite` and compares JSON — **parity: all 7 checks
ok**.

| Asset | Size |
| --- | --- |
| `benchmark.sqlite` | 2,686,976 B (2.7 MB; 374 KB gzip) |
| `sql-wasm.wasm` | 658,410 B (644 KB; 326 KB gzip) |
| `sql-wasm.js` glue | 46,535 B |

| Cold start (bytes already read) | ms |
| --- | --- |
| WASM instantiate | 10.8 |
| Open database + PRAGMA | 3.0 |
| First view query | 3.0 |
| **Total** | **16.7** |

| Query (warm median of 5) | ms |
| --- | --- |
| `listComparisons` (2 evaluations) | 18.9 |
| `listCategories` (12 rows) | 17.7 |
| `listFixtures` page of 50 | 32.8 |
| `listRuns` / `getFixtureDetail` | 0.6 / 1.5 |

| Memory after load and queries | MiB |
| --- | --- |
| RSS delta | 103.1 |
| ArrayBuffer total (WASM heap + DB copy) | 26.9 |
| Baseline RSS | 34.2 |

The WASM heap dominates the footprint and stays around 27 MiB of ArrayBuffers,
which fits the Workers isolate limits; each isolate keeps its own copy, so the
adapter must not hold more than one publication per process.

## Consequences

- The web runtime imports `@mmstar/results` (neutral) plus this adapter; it never
  imports `@mmstar/results/node` (`node:sqlite`, `node:fs`, `node:crypto`).
- Workerd forbids dynamic WASM compilation at request time, so Cloudflare must
  use the `CompiledWasm` module path. This is why the Workers build has a
  post-processing step; a plain `wasmBinary` deployment fails with
  `Wasm code generation disallowed by embedder`.
- Serverless Node functions do not bundle static assets; the Node loader falls
  back to fetching the database and WASM from the deployment origin once per
  instance.
- The publication database is public data by design; the site still exposes only
  bounded parameterized endpoints, never arbitrary SQL or writes.
- A database upgrade (schema, size) is a redeploy of the snapshot; there is no
  hot reload path, matching the immutable-publication requirement.
- Target-runtime build and smoke results are recorded in `docs/website.md` and
  handoff 09; hosted checks require deployment access and remain explicitly
  unverified until then.
