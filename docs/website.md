# Results website

The website is a read-only query layer over one immutable publication. It never
writes to a database and never accepts arbitrary SQL: every request goes through
the bounded repository contract in `packages/results/src/query/repository.ts`.

The same Astro codebase builds for four targets. Only the way the two immutable
reader assets are obtained differs; the query layer is identical.

## Layout

```
apps/web/src/server/sqljs-driver.ts   sql.js (WASM SQLite) adapter over the SqliteDatabase seam
apps/web/src/server/publication.ts    platform asset loading + cached repository
apps/web/src/server/http.ts           JSON/error response helpers
apps/web/src/pages/api/*.json.ts      read-only endpoints
apps/web/public/                      generated static assets (Git-ignored)
  publication/benchmark.sqlite        the published snapshot, served as an asset
  benchmark-images/<sha256>.<ext>     content-addressed originals
  sql-wasm.wasm                       WASM binary for Node-target readers
scripts/sync-publication.mjs          copies the publication + WASM into public/ before dev/build
scripts/postprocess-cloudflare.mjs    CompiledWasm module + rule for the Workers build
```

`pnpm dev` and `pnpm build` run the sync first. Without a publication the sync
warns (set `MMSTAR_REQUIRE_PUBLICATION=1` to fail instead) and the endpoints
answer `503 publication_unavailable`.

## Endpoints

All responses are JSON. Validation failures return `400` with a stable
`error.code` (`query_invalid`), a missing fixture returns `404`, and an
unavailable publication returns `503`.

| Endpoint | Parameters | Notes |
| --- | --- | --- |
| `GET /api/health.json` | — | Reader/schema versions, family root, run count. |
| `GET /api/runs.json` | — | Every run, newest first, with family roles. |
| `GET /api/comparisons.json` | `rootRunId?` | Per-evaluation accuracy/coverage/latency/cost; defaults to the newest root run. |
| `GET /api/categories.json` | `rootRunId?`, `evaluationId?` | Category counts and accuracy per evaluation. |
| `GET /api/fixtures.json` | `rootRunId?`, `evaluationId?`, `category?`, `state?`, `kind?`, `limit?`, `offset?` | Paginated drilldown list; `limit` 1–200 (default 50), deterministic ordering. Response text is excluded. |
| `GET /api/fixture.json` | `rootRunId?`, `evaluationId`, `fixtureId` | Effective outcome, family outcome lines, and the attempt ledger. |

`rootRunId` defaults to the newest family root, so a single-run publication needs
no parameters. Unknown `state`/`kind` values and out-of-range pages are rejected
before any SQL runs.

Images are static assets: the `imagePath` returned by the API is a relative URL
(`benchmark-images/<sha256>.<ext>`) served by the deployment host, never a Git
raw URL and never fetched at request time.

## Platform loading

- **Node targets** (local preview, Netlify, Vercel): the reader loads
  `publication/benchmark.sqlite` and `sql-wasm.wasm` from the asset directory
  when it is present. Serverless functions do not bundle static assets, so when
  no local copy exists the loader falls back to fetching both files from the
  deployment origin (the site CDN) once per instance.
- **Cloudflare Workers**: assets are fetched through the `ASSETS` binding.
  Workerd forbids compiling WASM from bytes during a request, so the WASM binary
  is loaded as a `CompiledWasm` module (see below); `scripts/postprocess-cloudflare.mjs`
  copies `sql-wasm.wasm` next to the server chunks and adds the module rule to
  `dist/server/wrangler.json`.

The reader is cached for the life of the process/isolate. Each instance holds one
in-memory database copy; measured footprint is ~27 MiB of ArrayBuffers for the
full 2.7 MB snapshot. See `docs/adr/0001-web-sqlite-reader.md`.

## Build commands

Run from the repository root (`pnpm --filter @mmstar/web <script>` or from
`apps/web`):

| Target | Build | Deploy |
| --- | --- | --- |
| Node (local) | `pnpm build:node` → `node dist/server/entry.mjs` | `pnpm preview` or run the entry directly (honours `HOST`/`PORT`). |
| Netlify | `pnpm build:netlify` | Build command `pnpm --filter @mmstar/web build:netlify`, publish directory `apps/web/dist`. `netlify deploy --prod` or Git integration. |
| Vercel | `pnpm build:vercel` | Build command `pnpm --filter @mmstar/web build:vercel`; output is `.vercel/output` (Build Output API v3). `vercel deploy --prebuilt --prod` or Git integration. |
| Cloudflare | `pnpm build:cloudflare` | `pnpm exec wrangler deploy` from `apps/web` (uses `dist/server/wrangler.json`; the `SESSION` KV namespace is auto-provisioned by the adapter). |

Environment:

- `MMSTAR_ADAPTER` selects the adapter for the generic `pnpm build`
  (`node` default, or `netlify`, `vercel`, `cloudflare`).
- `MMSTAR_PUBLICATION_DIR` points the sync step at a publication outside the repo.
- `MMSTAR_WEB_ASSETS_DIR` overrides the Node asset directory at runtime.
- `MMSTAR_REQUIRE_PUBLICATION=1` makes the sync fail instead of warning.

## Publishing and rollback

Publishing is a redeploy: produce a new validation-passing publication with
`mmstar export`, re-run the target build, and deploy. The deployed site remains
on its current snapshot until then. Roll back by redeploying the previous
immutable publication; there is no in-place database mutation to undo.

## Verification status

Measured 2026-09-23 (macOS arm64, Node 24.16.0, Bun 1.4.2, workerd 1.20260923.1):

- **Cloudflare Workers** — built and run locally with `wrangler dev` (workerd,
  the production runtime): health, comparisons, categories, paginated fixtures,
  a category/kind-filtered page, fixture detail, `limit=999` → 400, missing
  fixture → 404, and image retrieval all succeeded. Worker script 1.45 MB
  (356 KB gzip) plus a 644 KB `CompiledWasm` module; static assets 47 MB.
- **Node** — built with both `@astrojs/node` and the HTTP asset fallback;
  endpoint responses are byte-identical to the workerd responses for all six
  comparison/detail requests (parity checked with `cmp`).
- **Netlify / Vercel** — real adapters build (function bundle 1.1 MB / 1.3 MB)
  and their generated SSR entry points serve the endpoints when invoked with a
  platform-shaped context in Node and assets fetched from the deployment origin.
  These are **emulated runtime checks, not hosted deployments**.
- **Hosted checks are unverified**: no deployment credentials were available in
  this environment. Netlify, Vercel, and Cloudflare hosted query/image behavior
  still requires a real deploy and must not be described as verified until then.
  The release checklist in `docs/development.md` tracks this open item.
