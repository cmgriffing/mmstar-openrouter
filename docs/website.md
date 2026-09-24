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
apps/web/src/layouts/Base.astro       site shell, fonts, navigation
apps/web/src/styles/global.css        field-report design system
apps/web/src/lib/format.ts            pure value formatting (unknown vs zero)
apps/web/src/lib/view.ts              outcome labels, filters, query strings
apps/web/src/components/FixtureExplorer.tsx  drilldown island (filters, pages, states)
apps/web/src/pages/index.astro        server-rendered comparisons
apps/web/src/pages/fixtures.astro     drilldown shell + island
apps/web/src/pages/fixture.astro      fixture detail (image, lineage, attempts)
apps/web/public/                      generated static assets (Git-ignored)
  publication/benchmark.sqlite        the published snapshot, served as an asset
  benchmark-images/<sha256>.<ext>     content-addressed originals
  sql-wasm.wasm                       WASM binary for Node-target readers
scripts/sync-publication.mjs          copies the publication + WASM into public/ before dev/build
scripts/postprocess-cloudflare.mjs    CompiledWasm module + rule for the Workers build
scripts/seed-verification-publication.ts  deterministic UI fixture publication
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

## Frontend

Every page is server-rendered from the same read-only repository; interactive
filtering hydrates on top of the rendered first page, so the site works without
JavaScript and never opens a writable database.

| Route | Behavior |
| --- | --- |
| `/` | Comparisons by model × effort (scored/selected accuracy, coverage, outcome counts, request and fixture latency, tokens, reported/estimated/unknown cost), a category accuracy matrix, and the family's lineage table. |
| `/fixtures?rootRunId&evaluationId&category&state&kind&offset` | Paginated fixture drilldown (25 per page) over effective outcomes, with recovered/indeterminate badges; filtering re-queries `/api/fixtures.json` and keeps the URL shareable. |
| `/fixture?rootRunId&evaluationId&fixtureId&back` | One fixture: original image, question, effective outcome, parsed/expected answer, response text, usage/cost, failure details, outcome lineage (effective vs superseded), and the attempt ledger. |

Presentation rules:

- Unknown usage/cost render as "not reported" (family cost also shows how many
  attempts are unknown); a real zero stays `$0.00`/`0`.
- Scored accuracy (correct/settled), selected accuracy (correct/selected),
  coverage (settled/selected), and attempt counts are labelled separately.
- Recovery never double-counts: lists and comparisons show one effective
  outcome per evaluation/fixture; the detail page keeps the superseded original
  visible and marks the effective record.
- Incomplete evaluations carry an "incomplete" badge; runs that mix frozen
  settings or never completed are called out above the comparisons.
- Statuses always combine a symbol and a label, focus is always visible, and
  tables become labelled cards on narrow screens.

The React island is the only stateful frontend code. It owns filter/pagination
state, calls the bounded endpoint, and exposes explicit loading, empty, and
error states with retry; engine and persistence code never enters the browser
bundle (types are imported with `import type` only).

### Reproducing the UI states

`apps/web/scripts/seed-verification-publication.ts` builds a small deterministic
publication that exercises recovery lineage, request failures, indeterminate
attempts, pending work, mixed frozen settings, and known/estimated/unknown
costs. It is a UI fixture, not a validated export:

```bash
bun apps/web/scripts/seed-verification-publication.ts /tmp/mmstar-verification
MMSTAR_PUBLICATION_DIR=/tmp/mmstar-verification pnpm --filter @mmstar/web build:node
HOST=127.0.0.1 PORT=4602 node apps/web/dist/server/entry.mjs
```

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

Frontend behavior was checked in a real browser (agent-browser/Chromium) against
the deterministic verification publication, 2026-09-24:

- comparisons render both families, including the incomplete and mixed-settings
  notices, with effective-outcome counts (a recovered failure counts once);
- fixture filters (evaluation/category/state/kind) re-query the API, pagination
  moves through pages with URL sync, empty results and aborted requests show the
  empty/error panels, and Retry recovers;
- a recovered fixture shows the failed original as superseded beside the
  effective recovery outcome, and unknown attempt cost reads "not reported";
- keyboard tab order covers every control with a visible focus outline, Enter
  activates pagination, and the skip link targets `#main`;
- at 420×900 the pages have no horizontal overflow, tables become labelled
  cards, and the detail image stays inside the viewport;
- images load from `benchmark-images/<sha>.png` (HTTP 200); no page errors,
  console errors, or failing resources were recorded.
