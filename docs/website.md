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
apps/web/src/lib/view.ts              outcome labels, filters, selection/axes/sorting, metrics
apps/web/src/components/FixtureExplorer.tsx  drilldown island (filters, pages, states)
apps/web/src/components/ComparisonExplorer.tsx  comparison island (picker host, chart, sortable table)
apps/web/src/components/ModelPicker.tsx  searchable model/effort picker (trigger, panel, bulk actions)
apps/web/src/components/QuadrantChart.tsx  hand-rolled SVG quadrant chart (points, medians, tooltip)
apps/web/src/pages/index.astro        comparison island host + publication stat strip
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
| `GET /api/health.json` | — | Reader/schema versions, run count, evaluation count, winning family roots. |
| `GET /api/runs.json` | — | Every run, newest first, with family roles and per-run attempt/token/cost totals (shadowed families included). |
| `GET /api/comparisons.json` | — | Publication-wide per-evaluation accuracy/coverage/latency/cost with winning-family provenance. |
| `GET /api/categories.json` | `evaluationId?` | Publication-wide category counts and accuracy per evaluation. |
| `GET /api/fixtures.json` | `evaluationId?`, `category?`, `state?`, `kind?`, `limit?`, `offset?` | Paginated publication-wide drilldown; `limit` 1–200 (default 50), deterministic ordering. Response text is excluded. |
| `GET /api/fixture.json` | `evaluationId`, `fixtureId` | Effective outcome, winning-family outcome lines, and the attempt ledger. |

All queries are publication-wide and require no scope. A `rootRunId` parameter in a
URL is ignored: the response is identical to the same request without it. Unknown
`state`/`kind` values and out-of-range pages are rejected before any SQL runs.

Images are static assets: the `imagePath` returned by the API is a relative URL
(`benchmark-images/<sha256>.<ext>`) served by the deployment host, never a Git
raw URL and never fetched at request time.

## Frontend

Every page is server-rendered from the same read-only repository; interactive
filtering hydrates on top of the rendered first page, so the site works without
JavaScript and never opens a writable database.

| Route | Behavior |
| --- | --- |
| `/` | One comparison of every model in the publication (scored/selected accuracy, coverage, outcome counts, request and fixture latency, tokens, reported/estimated/unknown cost) with winning-family provenance, a hand-rolled quadrant chart, a category accuracy matrix, and the full run lineage table. A searchable model/effort picker backs the `models` selection and filters the table, chart, and matrix together; the trigger shows the selection count, and the panel searches alias/OpenRouter ID/effort and offers `Select all`, `Clear all`, and a filter-scoped matching action. `sort`/`dir` anchors order the table and `x`/`y`/`scale` choose the chart axes and cost scale. The stat strip and run lineage stay publication-wide. A family switcher is deliberately absent. |
| `/fixtures?evaluationId&category&state&kind&offset` | Paginated fixture drilldown (25 per page) over publication-wide effective outcomes, with recovered/indeterminate badges; filtering re-queries `/api/fixtures.json` and keeps the URL shareable. |
| `/fixture?evaluationId&fixtureId&back` | One fixture: original image, question, effective outcome, parsed/expected answer, response text, usage/cost, failure details, outcome lineage (effective vs superseded), and the attempt ledger. |

Presentation rules:

- Unknown usage/cost render as "not reported" (family cost also shows how many
  attempts are unknown); a real zero stays `$0.00`/`0`.
- Scored accuracy (correct/settled), selected accuracy (correct/selected),
  coverage (settled/selected), and attempt counts are labelled separately.
- The comparison selector is URL-backed and mirrored by the server-rendered
  island: `models` holds the selected evaluation IDs (absent means every
  evaluation, empty means none), `x`/`y` hold the chart metrics (default
  `cost`/`pass`; assigning the other axis metric swaps the pair), `scale`
  holds `log`/`linear` for a cost axis (default `log`), and `sort`/`dir` hold
  the table order (default scored accuracy descending). Unknown evaluation IDs
  and unknown parameter values are dropped and reported with the same
  ignored-filter notice as the drilldown; the canonical URL omits defaults and
  the all-selected case.
- The picker trigger reads `N of M evaluations` and opens a non-modal panel on
  demand. Search matches model alias, `openRouterId`, and effort name
  case-insensitively; an alias/ID match shows all of a group's efforts, an
  effort match shows only the matching rows, and the group checkbox and its
  `selected/visible` count apply to exactly the rows visible under the current
  filter. Efforts are ordered by intensity — `default` first, then `none`,
  `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — not alphabetically.
  `Select all`/`Clear all` keep the all-selected (`models` absent) and empty
  (`models=`) URL states, and the filter-scoped footer action reads
  `Select N matching` or `Deselect N matching`. Panel open state, search text,
  and per-group expansion are ephemeral component state and never enter the
  URL; selection changes are announced through a live region.
- Table headers are anchors carrying `sort`/`dir`, so sorting works without
  JavaScript; hydration re-sorts in place and keeps the URL shareable. Null
  cost, token, and latency values always sort last in either direction, and
  ties break on model alias, then reasoning mode, then evaluation ID.
- Chart metric definitions: cost = `knownUsd`, speed =
  `meanRequestLatencyMs` (mean last-attempt request latency; unresolved
  timeouts count as latencies), token usage = `totalTokens`, pass rate =
  `scoredAccuracy`. Evaluations whose known cost is `$0` or never reported are
  excluded from a cost axis and named below the chart with that distinction;
  an unknown on either axis is never plotted as zero. Crosshairs mark the
  median of the visible points and are omitted below two points. Points carry
  deterministic per-model colors and full accessible names; the comparison
  table is the tabular fallback.
- Attempts counts effective outcomes; cost and token totals come from the
  winning family's full attempt ledger, which includes superseded retries and
  recovery attempts.
- Recovery never double-counts: lists and comparisons show one effective
  outcome per evaluation/fixture from the winning family; the detail page keeps
  the superseded original visible and marks the effective record. A newer family
  that has settled only some fixtures wins that evaluation wholesale, so reduced
  coverage is visible rather than silently stitched. A newer family that has only
  failed still wins; `mmstar retry-failed` repairs an errored fixture inside that
  winning family.
- Incomplete evaluations carry an "incomplete" badge; runs that mix frozen
  settings in the winning families or never completed are called out above the
  comparisons.
- Statuses always combine a symbol and a label, focus is always visible, and
  tables become labelled cards on narrow screens.

The React island is the only stateful frontend code. It owns filter/pagination
state, calls the bounded endpoint, and exposes explicit loading, empty, and
error states with retry; engine and persistence code never enters the browser
bundle (types are imported with `import type` only).

### Reproducing the UI states

`apps/web/scripts/seed-verification-publication.ts` builds a small deterministic
schema-v2 publication that exercises recovery lineage, request failures,
indeterminate attempts, pending work, mixed frozen settings,
known/estimated/unknown costs, and the winning-family rule (a newer restart family
settles only `demo::low`, so that evaluation resolves to the newer family with
reduced coverage while the older family's complete `demo::low` results are shadowed
and `demo::high`/`demo::none` stay on the older family). It is a
UI fixture, not a validated export:

```bash
bun apps/web/scripts/seed-verification-publication.ts /tmp/mmstar-verification
MMSTAR_PUBLICATION_DIR=/tmp/mmstar-verification pnpm --filter @mmstar/web build:node
HOST=127.0.0.1 PORT=4602 node apps/web/dist/server/entry.mjs
```

With that server running, the comparison island states can be reached directly:
`/` (default cost × pass chart, three evaluations), `/?models=demo::low`
(single selection, no median crosshairs), `/?models=` (empty states for chart,
table, and matrix), `/?sort=cost&dir=asc`, `/?x=pass&y=cost&scale=linear`, and
`/?models=ghost&x=nope` (ignored-filter notice). The picker itself has no URL
state: open the trigger and search an alias, an OpenRouter ID, or an effort
name to exercise filtering, filter-scoped group toggling, and the matching bulk
action.

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
`pnpm export` (or a targeted `mmstar export --run ID|--latest`), re-run the target
build, and deploy. The deployed site remains
on its current snapshot until then. Roll back by redeploying the previous
immutable publication; there is no in-place database mutation to undo. Because the v2
reader refuses an exporter-v1 database (schema/exporter version check) with a re-export
message, roll forward by re-exporting rather than redeploying a v1 publication against
a v2 site build.

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

Frontend behavior was last checked in a real browser (agent-browser/Chromium) against
the deterministic verification publication, 2026-09-24, while the site still had a
family switcher. The family-scoped checks below (filters, pagination, recovered
detail, keyboard/overflow behavior) exercise code paths that survive the one-table
change, but the switch itself has not been re-run in a browser. The v2 one-table view
has been checked with server-rendered smoke against the seed results (all
evaluations in one table, winning-family provenance, mixed-settings notice, no
`?rootRunId=` effect).

The comparison island (model selector, quadrant chart, sortable table) was checked in
a real browser on 2026-09-25 against both the seed results and an export of the
two-run results in `apps/runner/results`: group and effort toggles kept table, chart,
and category matrix in sync and updated the URL; sort anchors re-sorted in place with
`aria-sort` and also worked by plain navigation with JavaScript disabled; selecting
the metric already on the other axis swapped the pair; the cost log/linear toggle and
selection/sort/axis URLs survived a reload; the warning-only chart state appeared for
the all-`$0` real publication (`reported as $0` plus the empty state); the empty
selection showed explicit empty states on all three surfaces; and point focus revealed
the full tooltip. Null ordering and the `cost never reported` distinction are covered
by `view.test.ts` because neither available publication has a null winning-family
metric or an unpriced winning family to show in the browser. The matrix filtering was
re-checked at a 400 px viewport on the same date after the mobile card rules were found
to override the `hidden` attribute; `/?models=demo::low` now hides the other matrix
rows there, and `styles/global.test.ts` guards the override rule. The remaining
drilldown/keyboard checks from the 2026-09-24 pass still apply to unchanged code but
have not been repeated.

The searchable model picker replaced the inline grid and was checked in a real browser
on 2026-09-25 against the seed results: the trigger counted `N of M evaluations`;
opening focused the search field; alias, OpenRouter-ID, and effort queries filtered
case-insensitively (`high` narrowed each matching group to its single visible row);
the group checkbox and `selected/visible` count affected only the visible rows;
`Select all`/`Clear all` produced the `/` and `?models=` URL states, and the
filter-scoped `Select/Deselect N matching` action selected or deselected exactly the
visible rows; the panel stayed open across toggles; Escape closed it and returned
focus to the trigger, and outside activation closed it without moving focus; the live
region carried the count; efforts rendered in intensity order (`none`, `low`, `high`);
and no picker state entered the URL. Existing `?models=` URLs still restored the
selection and `?models=ghost` kept the ignored-filter notice. The panel also dismisses
when focus moves outside it; that behavior was added after the 2026-09-25 pass and
awaits a browser re-check. Narrow-screen layout was checked at 400 px: the trigger
spans the selector bar, the panel stays anchored, and the page has no horizontal
overflow.

- comparisons render every family present in the publication, including the incomplete
  and mixed-settings notices, with effective-outcome counts (a recovered failure counts
  once);
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
