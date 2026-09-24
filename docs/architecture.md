# Architecture

## Purpose

MMStar OpenRouter is a reproducible benchmark and publication pipeline for comparing
image-capable models through the OpenRouter API: accuracy, coverage, latency, and cost,
with recoverable runs and an immutable results website.

The dataset (`MMStar.tsv`) and the upstream benchmark implementation are separate
projects. This repository implements its own runner, scoring protocol, and publication
format. See the MMStar citation in `README.md`.

## Components

| Piece | Location | Runtime | Responsibility |
| --- | --- | --- | --- |
| Runner | `apps/runner` | Bun + OpenTUI React | CLI commands (`validate`, `benchmark`, `resume`, `retry-failed`, `restart`, `export`), interactive TUI, headless/plain output |
| Website | `apps/web` | Astro + React islands | Read-only comparisons and fixture drilldown over one immutable publication |
| Config contracts | `packages/config` | Runtime-neutral TypeScript | Versioned JSON configuration and validation, generated editor schema, deterministic evaluation-plan expansion |
| Benchmark contracts | `packages/benchmark` | Runtime-neutral TypeScript | MMStar TSV ingestion, prompt/scorer contracts, typed engine events, OpenRouter adapter (metadata preflight, requests, responses), scheduling, metrics |
| Results contracts | `packages/results` | Runtime-neutral TypeScript | Versioned run/evaluation/outcome/attempt records, recovery lineage, publication queries |

Planned flow:

```
config JSON ──> packages/config ──> frozen plan ──────────────┐
                                                             ├──> packages/benchmark engine
MMStar.tsv ──> packages/benchmark (bounded dataset parse) ───┘              │
                                                                            ▼
                                                      results/<timestamp>_<run-id>/*.json
                                                          (packages/results records)
                                                                            │
                                                                            ▼
                                              packages/results export ──> SQLite + image assets
                                                                            │
                                                                            ▼
                                                                    apps/web publication
```

Dependency direction is linear: `@mmstar/config` → `@mmstar/results` → `@mmstar/benchmark`.
Run records embed the frozen plan, and engine events embed record classifications, without
import cycles. Nothing imports in the reverse direction.

## Runtime boundaries

`packages/*` hold pure contracts and pure logic. They must not import Bun, Node,
OpenTUI, Astro, or native modules, so the same source can run in the Bun runner and
be bundled into the website. Each package's `tsconfig.json` sets `"types": []` to keep
ambient runtime globals out of shared code.

Runtime-specific work lives in the apps:

- `apps/runner` owns the OpenRouter transport (`fetchTransport`), filesystem persistence,
  process locking, the terminal renderer, and the CLI process surface.
- `apps/web` owns Astro adapters, deployment-platform loading code, and the browser UI.

If a later chunk needs SQLite or filesystem access in a shared package, it must be an
explicit subpath module (for example `@mmstar/results/node`) with its own runtime types,
so the website bundle never pulls native or Bun-only code in through the package entry
point.

## Internal packages

Shared packages are private and export their TypeScript source directly
(`"exports": { ".": "./src/index.ts" }`). Bun, Vite/Astro, and Vitest all consume the
source, so there is no library build step and no stale `dist/` to manage. Type safety
comes from `pnpm typecheck` across the workspace, not from emitted declarations.

Concrete contracts, schema versions, dataset bounds, and record shapes are documented in
[`docs/contracts.md`](./contracts.md); config fields and reasoning semantics are documented
in [`docs/configuration.md`](./configuration.md).

`apps/runner` is the only build with an artifact: `bun build` bundles the CLI entry
point. The TUI runs directly from source through Bun.

## Reproducibility and caching

Turbo runs `build`, `typecheck`, `lint`, and `test`, which are cacheable. All commands
that can contact a provider or write benchmark artifacts — `validate`, `benchmark`,
`resume`, `retry-failed`, `restart`, `export` — are declared with `"cache": false` in
`turbo.json` so a repeated command always executes. `OPENROUTER_API_KEY` is declared as
a pass-through environment variable; credentials never appear in configuration files or
run artifacts.

## Execution model

`packages/benchmark` owns a headless engine (`engine.ts`) that turns a frozen plan and
fixture list into scheduled provider requests. It is deliberately independent of the
terminal: injected clock, provider, jitter source, scorer, and event sink mean the same
engine can drive the TUI, plain output, or tests. Rate-limit groups serialize variants,
a global group cap plus an optional account-wide requests-per-minute cap bound traffic,
classified transient failures retry with jittered backoff, and every attempt is recorded
before submission and after completion. Durable persistence and recovery commands are
wired in chunk 5; the interactive TUI consumes the same typed events through
`RunContext.engineEvents` and a bounded, renderer-independent view store
(`apps/runner/src/tui/state.ts`). `RunContext.observeEngine` hands the entry point a
read-only control surface (pause/resume/graceful stop) plus snapshots for metrics,
fixture inspection, and retry countdowns, so the React tree only reads view state and
requests actions. Non-TTY and `--plain` invocations bypass the renderer entirely and
reuse the plain CLI path with the same engine and exit codes.

## Results and publication model

Benchmark runs write immutable JSON under `results/`: a timestamped run directory, a
frozen `manifest.json` (plan, capability snapshots, lifecycle), and one model file per
alias containing every effort variant and attempt. A single locked writer checkpoints
atomically (temp file + rename) after attempt starts and after terminal outcomes, so a
crash always leaves a complete previous file. `resume` reconstructs progress from the
validated model files, `retry-failed` creates a linked recovery run, and `restart`
creates a new primary run from the original frozen settings.

`export --run ID|--latest` publishes the whole run family into `publication/`: a
normalized SQLite snapshot (`benchmark.sqlite`), content-addressed original images under
`benchmark-images/`, and a `manifest.json` binding database hash, source hashes, and the
image inventory. The build is verified before an atomic directory swap, so a failed
export leaves the previous publication intact. Generated results, publication assets,
and images are Git-ignored; `MMStar.tsv` stays the single committed image source.
Command and recovery semantics are documented in `docs/runner.md`; the schema, views,
projection rules, and measured artifact sizes are documented in `docs/publication.md`.

`packages/results/src/query/repository.ts` defines the read-only website contract over
that snapshot: fixed parameterized statements (comparisons, categories, paginated
fixture drilldown, fixture detail), page bounds, and no arbitrary SQL. `apps/web` builds
the same Astro codebase for Node, Netlify, Vercel, and Cloudflare Workers; platform code
is confined to where the database and WASM assets come from (`apps/web/src/server/publication.ts`,
with sql.js as the WASM reader on every target). Endpoint contracts, per-target
build/deploy commands, and the measured runtime evidence are documented in
`docs/website.md` and `docs/adr/0001-web-sqlite-reader.md`. Hosted Netlify/Vercel/
Cloudflare behavior stays explicitly unverified until a real deployment smoke check is
recorded; the full comparison and drilldown UI lands in chunk 10.

## Planning and sessions

OpenSpec planning files under `/openspec/` are Git-ignored and local to a working copy.
Implementation is split into bounded chunks in
`openspec/changes/initial-runner-architecture/tasks.md`; each session implements one
chunk and writes `handoffs/NN.md` next to it. Durable product documentation lives in
`docs/` and `README.md` and must never depend on ignored planning files. See
`docs/development.md` for the session workflow.
