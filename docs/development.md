# Development

## Toolchain

Pinned versions live in the repository, not in a developer's shell history:

| Tool | Pin | Where |
| --- | --- | --- |
| Node.js | `24.16.0` | `.node-version`, `engines.node` in `package.json` |
| pnpm | `10.24.0` | `packageManager` in `package.json` |
| Bun | `1.4.2` | `.bun-version` |
| TypeScript, Turbo, Biome, Vitest, React | see catalog | `pnpm-workspace.yaml` `catalog:` |

Shared dependency versions are declared once in the pnpm catalog and referenced from
workspace packages with `"catalog:"`. Change a version in `pnpm-workspace.yaml`, not in
individual package manifests.

Bun is required for the runner (`apps/runner`) but not for the website. Install it with
`npm install -g bun` or the official installer, then confirm `bun --version` matches
`.bun-version`.

## Setup

```bash
pnpm install           # installs the whole workspace from pnpm-lock.yaml
pnpm build             # Astro site build + runner CLI bundle
pnpm typecheck         # tsc/astro check across all packages
pnpm lint              # Biome
pnpm test              # Vitest
pnpm check             # typecheck + lint + test in one Turbo run
pnpm schema            # regenerate mmstar.config.schema.json from config rules
```

Use `pnpm install --frozen-lockfile` in CI or when verifying a clean install.

## Commands

Benchmark lifecycle commands are implemented. The four run commands open the TUI when
stdout is a terminal and fall back to NDJSON when piped or given `--plain`:

```bash
pnpm validate --set <name>           # validate config and expand a frozen plan
pnpm benchmark --set <name>          # start a primary run (TUI on a TTY)
pnpm resume --latest                 # continue pending/interrupted work
pnpm retry-failed --latest           # linked recovery run for request failures
pnpm restart --latest                # new primary run with the original selection
pnpm export                          # publish every run as a validated SQLite artifact
```

`validate` is a Turbo task with `"cache": false`. `export` is a root orchestrator
script that runs the runner CLI with `apps/runner` as its working directory (so frozen
dataset and results-root paths resolve) and writes `<repo>/publication` for the website
sync; the package-level `export` script remains for targeted runs. The four run commands
intentionally bypass Turbo: their root scripts invoke
`pnpm --filter @mmstar/runner <command>` with the user's arguments forwarded verbatim
(for example `pnpm benchmark --set testing`), because Turbo would otherwise pipe or
multiplex the child's stdout and silently flip the TUI to the plain path.

The interactive TUI runs from source:

```bash
pnpm --filter @mmstar/runner dev          # interactive monitor for a runner command
pnpm --filter @mmstar/runner dev -- benchmark --set testing
pnpm --filter @mmstar/runner demo         # deterministic mock run, no credentials
pnpm --filter @mmstar/runner smoke        # render briefly, then exit (PTY check)
```

TUI behavior is covered by Vitest (pure view-state, formatting, and line builders,
fixture inspection assembly, and headless non-TTY entry-point checks) plus Bun-native
frame tests that drive OpenTUI's test renderer, including resize, filtering, fixture
detail scrolling, and control callbacks;
`pnpm --filter @mmstar/runner test` runs both suites. The demo command never makes a
network request, so PTY checks work without `OPENROUTER_API_KEY`.

`OPENROUTER_API_KEY` is read from the environment by the runner only. It is declared as
a Turbo pass-through variable and must never be written to configuration or artifacts.

## Verification and release checklist

Every automated check uses deterministic mock providers; no step below requires a paid
request or a credential.

1. `pnpm install --frozen-lockfile` — the lockfile is the install of record.
2. `pnpm check` — typecheck, lint, and tests across every package (includes the
   Bun-native OpenTUI frame tests via `pnpm --filter @mmstar/runner test`).
3. `pnpm build` — runner CLI bundle and the default Astro build.
4. `bun apps/runner/scripts/e2e-workflow.ts --workdir /tmp/mmstar-e2e` (or
   `pnpm --filter @mmstar/runner e2e`) — validate, interrupted run, resume,
   retry-failed, restart, a duplicate primary family, targeted and selector-free
   export, publication verification, and publication-wide repository queries
   against real dataset fixtures.
5. Build the target website (`pnpm --filter @mmstar/web build:node|build:netlify|
   build:vercel|build:cloudflare`) against the publication from step 4 or a real run,
   and smoke the query endpoints. `docs/website.md` has the per-target commands and
   the endpoint matrix.
6. **Hosted checks remain open.** Netlify, Vercel, and Cloudflare hosted query/image
   behavior is verified only by a real deployment; local `wrangler dev` and emulated
   function entry points are recorded as local evidence in `docs/website.md`. Do not
   mark a target production-ready without a hosted smoke result.
7. **Rollback.** Deployments are immutable publications: redeploy the previous
   versioned artifact to roll back. Keep the prior `publication/` output (or the
   deployed artifact) until the new deployment is verified.

## Repository conventions

- **Shared packages stay runtime-neutral.** `packages/config`, `packages/benchmark`,
  and `packages/results` must not import Bun/Node/OpenTUI/Astro APIs. Runtime adapters
  belong in `apps/runner` or `apps/web`. See `docs/architecture.md`. Test-only Node builtin
  declarations may live in a `*.d.ts` next to tests (for example
  `packages/benchmark/src/test-node.d.ts`) so tests can read the committed dataset without
  adding Node globals to shared source.
- **Package dependencies flow one way:** `@mmstar/config` → `@mmstar/results` →
  `@mmstar/benchmark`. Keep it acyclic; records embed plans and events embed records.
- **Shared packages export TypeScript source** and have no build step; the workspace
  typecheck is the compile gate.
- **Biome** owns formatting and linting for `.ts`/`.tsx`/`.json`. `.astro` files are
  excluded because Biome does not model Astro syntax; `astro check` typechecks them.
- **Tests** live next to source as `*.test.ts` and run under Vitest with no network
  access. Deterministic mock providers are used for provider behavior; a paid smoke run
  is a separate, explicitly invoked operation.

## Bounded implementation sessions

This repository is implemented in numbered chunks (see
`openspec/changes/initial-runner-architecture/tasks.md`). One chunk per session:

1. Read the chunk's spec sections and the preceding `handoffs/NN.md`.
2. Implement only the chunk's scope; keep changes minimal and focused.
3. Run the chunk's verification and the workspace checks.
4. Write `handoffs/NN.md` (inside the OpenSpec change directory) with completed task
   IDs, exact command outcomes, files and contracts changed, unresolved issues, and the
   next entry point.
5. Stop. Do not start the next chunk in the same session.

`/openspec/` is Git-ignored and local to a working copy. A different worktree or session
will not receive it through Git: to continue there, copy the change directory (including
`handoffs/`) explicitly, or start from the tracked `docs/` and the change's
`proposal.md`. Builds and checks must never depend on ignored planning files.

Contract and config reference material lives in tracked docs: `docs/configuration.md` and
`docs/contracts.md`.

## Troubleshooting

- **A dependency's install script was skipped.** pnpm 10 blocks build scripts by
  default. Add the package to `onlyBuiltDependencies` in `pnpm-workspace.yaml`, then
  reinstall.
- **OpenTUI fails to start.** Confirm Bun matches `.bun-version` and that the platform
  native package (`@opentui/core-<platform>`) resolved during install. Run
  `pnpm --filter @mmstar/runner smoke` under a terminal. When stdout is not a TTY, or
  `--plain` is passed, the entry point does not start a renderer at all: it emits the
  same machine-readable events as the plain CLI.
- **Turbo served a benchmark command from cache.** It should not; verify the task is
  listed with `"cache": false` in `turbo.json` and never invoke provider commands
  through `turbo run` with a cacheable task name.
