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
| Benchmark contracts | `packages/benchmark` | Runtime-neutral TypeScript | MMStar TSV ingestion, prompt/scorer contracts, typed engine events, provider contracts, scheduling, metrics |
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

- `apps/runner` owns the OpenRouter transport, filesystem persistence, process locking,
  the terminal renderer, and the CLI process surface.
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

## Results and publication model

Benchmark runs write immutable JSON under `results/` (timestamped run directory, frozen
manifest, per-model files with all attempts). Export validates that JSON and produces a
SQLite publication plus content-addressed images under generated asset directories.
Generated results, publication assets, and images are Git-ignored; `MMStar.tsv` stays
the single committed image source. Publication and website details land in chunks 8–10.

## Planning and sessions

OpenSpec planning files under `/openspec/` are Git-ignored and local to a working copy.
Implementation is split into bounded chunks in
`openspec/changes/initial-runner-architecture/tasks.md`; each session implements one
chunk and writes `handoffs/NN.md` next to it. Durable product documentation lives in
`docs/` and `README.md` and must never depend on ignored planning files. See
`docs/development.md` for the session workflow.
