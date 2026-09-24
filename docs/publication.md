# Publication artifacts

A **publication** is the immutable, deployable snapshot of a run family: one SQLite
database plus a content-addressed image inventory, bound together by a manifest. The
website queries a publication read-only; publishing new results means running `export`
and redeploying, never writing to a live database.

Generated artifacts stay Git-ignored (`/publication/`, `benchmark-images/`,
`apps/web/public/publication/`). `MMStar.tsv` remains the single committed image
source.

## Layout

```
publication/
  manifest.json                 versions, source hashes, counts, image inventory
  benchmark.sqlite              normalized query snapshot
  benchmark-images/<sha256>.<ext>   original image bytes, deduplicated by content
```

`export --run ID|--latest [--out DIR]` builds the whole **family** of the selected run
(the topmost ancestor plus every descendant), so restarts and recoveries are published
together. It reloads the dataset named by the frozen plan and fails when the dataset
hash no longer matches, when a fixture or image is missing, when a run file is corrupt,
or when two records claim the same identity with different content.

## Schema

Schema version 1. Every table and view is created idempotently, and
`publication_meta` records the schema and exporter versions.

| Table | Key | Contents |
| --- | --- | --- |
| `publication_meta` | `key` | Schema/exporter versions and creation time. |
| `runs` | `run_id` | Family membership (`root_run_id`), lineage, lifecycle, frozen plan summary, source fingerprint. |
| `run_recovered_fixtures` | `(run_id, fixture_id)` | The fixture IDs a recovery run intended to resolve. |
| `evaluations` | `evaluation_id` | Model alias, OpenRouter ID, reasoning mode, rate-limit group, routing. |
| `fixtures` | `fixture_id` | Question, expected answer, category metadata, and the relative image path/hash. |
| `outcomes` | `(run_id, evaluation_id, fixture_id)` | Effective-record source: state, scored kind, bounded response, usage, cost, failure, lineage. |
| `attempts` | `(run_id, attempt_id)` | The billing ledger: every submitted request with provider, tokens, cost, latency, and failure. |

`attempt_id` alone repeats across a family (a recovery reissues the same
evaluation/fixture/number), which is why the run is part of the key.

### Views

- `v_runs_with_root` — deterministic family-root resolution; a missing parent counts as
  a root so partial imports still resolve.
- `v_original_outcomes` — outcomes from each family's first run.
- `v_recovery_outcomes` — outcomes from continuation/recovery runs.
- `v_effective_outcomes` — exactly one winner per `(family, evaluation, fixture)`:
  the newest **scored** outcome, or the newest terminal outcome when nothing scored.
  A recovery never double-counts a fixture, and a later failure never replaces a
  scored answer.
- `v_evaluation_summary` — per family/evaluation selected, settled, kind/state counts,
  coverage inputs, and mean latencies over effective outcomes.
- `v_category_summary` — the same counts grouped by fixture category.
- `v_attempt_totals` — per run/evaluation attempt ledger: token sums, usage-unknown
  count, reported/estimated/known costs, and unknown-cost count. Original and recovery
  attempts both appear here, so full experiment cost is auditable without inflating
  effective outcome counts.
- `v_fixture_drilldown` — effective outcome joined to fixture metadata and image path
  for paginated drilldown.

## Public projection rules

- Responses are bounded at 20,000 characters; `response_truncated` records that
  truncation happened. The local JSON audit keeps the full text.
- `raw_response_ref` and the raw audit directory are never published; only visible
  response text, parsed/expected answers, and normalized attempt metadata are.
- Credentials are never written to run records in the first place; the projection has
  no column for the API key, and the export test asserts the key never appears in the
  database or manifest.
- Unknown usage/cost stays null with an explicit `usage_known`/`cost_kind` flag; it is
  never published as zero.

## Validation and atomic replacement

Export writes into a sibling temp directory, then:

1. validates every image (base64, magic number against declared media type, size
   bound) and writes one file per unique SHA-256;
2. imports all rows in one transaction, with fingerprint-based idempotency and
   conflict detection;
3. checks SQLite `integrity_check`, `foreign_key_check`, schema version, and row
   counts;
4. writes `manifest.json` (database hash/size, per-run source hashes, dataset hash,
   image inventory) and runs the full `verifyPublication` pass — database hash, image
   hash/size, run/root identity, and every fixture's image reference;
5. only then renames the temp directory into place, keeping the old publication as a
   `.old-*` sibling until the swap succeeds.

A failed export leaves the previous publication untouched. If a process dies between
the two renames, the next export restores the `.old-*` directory before building.

## Representative size

Measured on the committed dataset (1,500 fixtures, 1,430 unique images after content
deduplication) with two evaluations × 1,500 outcomes and one attempt per outcome
(2026-09-23, Bun 1.4.2, `node:sqlite`):

| Artifact | Size |
| --- | --- |
| `benchmark.sqlite` (3,000 outcomes, 3,000 attempts) | 2.7 MB |
| `benchmark-images/` (1,430 files) | 40.4 MB |
| `manifest.json` | 0.4 MB |
| **Publication total** | **43.3 MB** |
| One 1,500-outcome model JSON (local source) | 2.6 MB |

Image bytes dominate, and 70 duplicate images collapse to existing hashes. The export
itself runs in under a second on this volume once the dataset is loaded.

## Deploying

The artifact layout is platform-neutral: the website build copies
`benchmark.sqlite`, `benchmark-images/`, and `sql-wasm.wasm` into its static
asset root, and the query endpoints read the snapshot through the read-only
repository. Per-target build/deploy commands, endpoint contracts, image serving,
and the current verification status are documented in `docs/website.md`. Hosted
Netlify/Vercel/Cloudflare behavior remains unverified until a real deployment
smoke test is recorded; SQLite reader compatibility is established by the gate
in `docs/adr/0001-web-sqlite-reader.md`.
