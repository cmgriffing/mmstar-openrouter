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

Benchmark lifecycle commands are stubs in the workspace-foundation chunk and are wired
to real behavior in later chunks:

```bash
pnpm validate -- --set <name>        # validate config and expand a frozen plan
pnpm benchmark -- --set <name>       # start a primary run
pnpm resume -- --latest              # continue pending/interrupted work
pnpm retry-failed -- --latest        # linked recovery run for request failures
pnpm restart -- --latest             # new primary run with the original selection
pnpm export                          # publish JSON results as a validated SQLite artifact
```

They are Turbo tasks with `"cache": false`: every invocation executes, even if the
inputs are unchanged, because these commands can submit paid requests or write run
artifacts. `pnpm exec turbo run benchmark --dry=json` shows `resolvedTaskDefinition.cache`
as `false`.

The interactive TUI runs from source:

```bash
pnpm --filter @mmstar/runner dev          # interactive monitor for a runner command
pnpm --filter @mmstar/runner dev -- benchmark --set smoke
pnpm --filter @mmstar/runner demo         # deterministic mock run, no credentials
pnpm --filter @mmstar/runner smoke        # render briefly, then exit (PTY check)
```

TUI behavior is covered by Vitest (pure view-state, formatting, and line builders)
plus Bun-native frame tests that drive OpenTUI's test renderer;
`pnpm --filter @mmstar/runner test` runs both suites. The demo command never makes a
network request, so PTY checks work without `OPENROUTER_API_KEY`.

`OPENROUTER_API_KEY` is read from the environment by the runner only. It is declared as
a Turbo pass-through variable and must never be written to configuration or artifacts.

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
  `pnpm --filter @mmstar/runner smoke` under a terminal; a non-TTY still renders but is
  not the supported interactive path.
- **Turbo served a benchmark command from cache.** It should not; verify the task is
  listed with `"cache": false` in `turbo.json` and never invoke provider commands
  through `turbo run` with a cacheable task name.
