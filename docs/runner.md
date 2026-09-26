# Runner commands and run recovery

`apps/runner` is the operator interface: it loads configuration and the committed
dataset, freezes an evaluation plan, and executes it through the headless engine in
`packages/benchmark`. `benchmark`, `resume`, `retry-failed`, and `restart` open the
interactive TUI when stdout is a terminal; when stdout is piped or `--plain` is given
they write one JSON object per line (plain, machine-readable, ANSI-free) instead.
`validate` and `export` are always plain. Human-readable diagnostics go to stderr in
every mode.

```
mmstar <command> [options]
```

| Command | Purpose |
| --- | --- |
| `validate` | Read-only check of config, dataset, set expansion, and (with a key) capability metadata. Creates nothing. |
| `benchmark --set NAME` | Create a new primary run and execute the set. |
| `resume ID\|--latest` | Continue pending/cancelled/interrupted work in an existing run. |
| `retry-failed ID\|--latest` | Create a linked recovery run for unresolved request failures. |
| `restart ID\|--latest` | Create a new primary run with the original fixtures and frozen settings. |
| `export [ID\|--latest]` | Publish every run in the results root (bare) or the selected run family as a validated SQLite snapshot with content-addressed images. |

Exit codes: `0` success, `1` runtime failure (invalid run, provider halt, incomplete
work), `2` usage or validation error, `130` interrupted before completion (SIGINT or a
TUI graceful quit).

## Terminal UI

`pnpm benchmark --set <set>`, `pnpm resume --latest`, `pnpm retry-failed --latest`, and
`pnpm restart --latest` open the interactive monitor by default: the root scripts bypass
Turbo and forward their arguments straight to `src/index.tsx`, so Turbo can never pipe or
multiplex the child's stdout (which would silently select the plain path) or compete with
the full-screen renderer. `bun run src/index.tsx <command>` and
`pnpm --filter @mmstar/runner dev -- <command>` remain equivalent direct entries.
The header shows run identity, progress and an
elapsed/remaining estimate, terminal outcome counts, cooldowns and retry countdowns,
and a live metrics block: provisional/final markers, scored and total-selected
accuracy with explicit denominators, coverage, category breakdown, latency
percentiles, token usage, and known/reported/estimated/unknown costs kept distinct.
Missing values render as `—`, never as zero. Below that, one row per model/effort
shows its rate-limit group, observed provider, attempts, and status token, and the
activity pane lists failures, wrong answers, and control events.

```bash
pnpm --filter @mmstar/runner dev -- benchmark --set testing
pnpm --filter @mmstar/runner demo         # deterministic mock run, no credentials
pnpm --filter @mmstar/runner smoke        # render briefly, then exit (PTY check)
```

## Operator smoke run (paid)

The automated suites never submit a real provider request. To exercise the live path
deliberately, run the paid smoke from `apps/runner`, whose `mmstar.config.json` defines
the `testing` set for `stealth/space-bunny-alpha` against the full committed dataset:

```bash
cd apps/runner
export OPENROUTER_API_KEY=...     # environment only; never write it to config or artifacts
pnpm benchmark --set testing
```

Expected: the TUI opens and every planned row appears immediately as `[WAIT] 0/1500`, rows
show in-flight request counts while requests are outstanding, and the process exits by
itself when the run settles (`--hold` keeps the final frame until `q`). An interrupted run
is continued with `pnpm resume --latest`, which reissues pending/cancelled work and prints
the indeterminate double-charge warning when a submitted request lacks a durable outcome.
Executing this run is an operator action — it submits paid requests and is intentionally
outside `pnpm check`.

Keyboard:

| Key | Action |
| --- | --- |
| `↑/↓` | move model/group row focus, or the activity selection when that pane is focused |
| `Tab` | switch pane focus between models and activity |
| `Enter` | inspect the selected activity entry (fixture detail) |
| `Esc` | close fixture detail, or clear an active filter |
| `f` | filter activity by kind, fixture ID, model alias, or failure text (`failure` shows only failures) |
| `p` / `c` | pause / continue scheduling (in-flight work settles; no new requests start) |
| `PgUp/PgDn`, `Home/End` | scroll activity or a long fixture response |
| `?` | help overlay |
| `q` / Ctrl-C | graceful quit |

Fixture detail shows the question, parsed and expected answer, the retained
response, every attempt (state, provider, latency, tokens, cost), failure category
and message, and recovery lineage. A pathological response is truncated at 20,000
characters with an explicit marker; ordinary long responses are wrapped and fully
reachable with the scroll keys (no image rendering in the terminal).

Statuses use text tokens (`[RUN]`, `[COOL]`, `[WAIT]`, `[DONE]`, `[FAIL]`) so they
never depend on color; narrow terminals drop the provider prefix, shorten columns and
the metrics block, and hide panes rather than overflowing.

Exit and quit semantics:

- The TUI exits when the run settles: pending checkpoints are flushed, a brief final
  frame is shown, the terminal is restored, and `mmstar: run <id> <state>` is printed.
  `--hold` keeps the final frame until `q`; `--exit-on-finish` is accepted and behaves
  identically to the default.
- `q`, Ctrl-C, and SIGINT are graceful stops in every phase. Before `run.created` they
  abort the dataset read and capability preflight, create no run, and exit `130`. While
  requests are in flight they stop scheduling and cancel in-flight attempts (recorded
  `cancelled` and checkpointed); after the run settles they exit through the normal
  final-flush path. A second interrupt force-exits immediately after restoring the
  terminal.
- The process signal handler stays registered through the post-finish wait, so a signal
  after the run completed still restores the terminal before exit.

`--demo` drives the real engine with a deterministic mock provider (scripted
cooldown, retry, and permanent failure) and exits when the run finishes; `--hold`
keeps the final frame until `q`. `--latency <ms>` overrides the demo request latency
for slow-request/quit PTY checks. When stdout is not a TTY, or `--plain` is passed, the
entry point never starts a renderer: it runs the same engine through the plain CLI (or
emits demo engine events as NDJSON) with the same exit codes and no terminal control
sequences.

## Run directory layout

```
results/<UTC-timestamp>_<8-hex>/manifest.json   frozen plan, capabilities, lifecycle
results/<UTC-timestamp>_<8-hex>/models/<alias>.json
results/<UTC-timestamp>_<8-hex>/raw/            optional bounded raw response audit
results/<UTC-timestamp>_<8-hex>/run.lock        single-writer lock
```

A run ID is `<UTC yyyy-mm-ddThh-mm-ss-mmmZ>_<8 hex>`; its timestamp makes directory
listing chronological and the suffix makes it unique. The manifest is the frozen plan
plus lifecycle state; outcomes and attempts live in per-model files.

## Publication export

`export` with no selector exports **every** run in the results root into one
publication. `export --run ID` (or a positional ID) and `export --latest` stay targeted:
they export the selected run's whole **family** — the topmost ancestor plus all of its
descendants — so restarts and recoveries travel together. `--out <dir>` changes the
output directory (default `publication/`); the directory is Git-ignored. Combining an
explicit run ID with `--latest` is a usage error.

`pnpm export` from the repository root is the canonical, argument-free command: it runs
the CLI with `apps/runner` as its working directory (so the frozen dataset and results
root resolve correctly) and writes the artifact to `<repo>/publication`, where
`apps/web/scripts/sync-publication.mjs` expects it.

```bash
pnpm export                                  # every run -> <repo>/publication
mmstar export --latest                       # newest primary run's family
mmstar export --run 20260923T053337000Z_deadbeef --out publication
```

Export never makes a provider request and never needs an API key. It reloads the
dataset named by the frozen plan and refuses to publish when the dataset SHA-256 no
longer matches, when a selected fixture (or its image) is missing, when a run file is
corrupt or uses an unsupported version, or when an identity conflict would mix two
different experiments (the error names the offending run). A bare export validates
every run in the results root all-or-nothing: one corrupt run fails the whole command.
The artifact is built in a temp directory and verified before
the previous publication is replaced, so a failed export always leaves the last valid
publication in place.

The publication is schema v2: each family's effective outcomes stay the inner layer, and
publication-wide views pick, per evaluation, the newest family with terminal outcomes, so
the website shows one comparison of every model without a family selector. Publications
built by exporter v1 are rejected; re-export them. See `docs/publication.md` for the
layout, schema, and views.

## Single writer, atomic checkpoints

- **Locking.** A run directory is written by exactly one process. `run.lock` is created
  exclusively (`O_EXCL`) and records PID, host, and acquisition time. A lock is reclaimed
  automatically only when this host can prove the holder is gone (dead PID recorded on
  this host). A lock from another host, or one carrying this process's own PID (a
  re-entrant acquisition), requires an explicit `--force`; the runner never guesses.
- **Atomic writes.** Every file is written to a uniquely named temp file in the same
  directory, fsynced, then renamed over the target. A crash always leaves either the old
  or the new complete file — never a partial manifest.
- **Checkpoints.** Persistence is two-tier. Before every provider submission the engine
  invokes `beforeSubmitAttempt`, and the runner awaits a small `inflight.json` marker
  listing the attempts awaiting a response, written through the async atomic writer with
  writes serialized, so a concurrent submission can never be overwritten by an older
  snapshot. Everything else — attempts, retries, terminal outcomes, and the manifest — is
  coalesced by a `CheckpointWriter`: at most one write in flight, intermediate states
  collapsed to the latest snapshot, a constant 1 s flush interval, and an awaited flush
  on stop, finish, and signal before the final state is reported or the lock is released.
  Model files are written before the manifest, and flushes use `fs/promises` write +
  fsync + rename + directory fsync, so file I/O does not block the render/scheduling
  loop. A hard `SIGKILL` can lose up to ~1 s of settled outcomes (resume reissues them,
  paid and deterministic); a submitted request is never lost silently, because its marker
  is durable before the provider call.
- **Reconciliation.** `resume`/`retry-failed`/`restart` reconstruct progress from the
  validated model files and treat the manifest as identity/plan only. A fixture that is
  present in the plan but absent from the durable records counts as pending work, and a
  fixture that appears in two model files is a hard conflict, not a silent deduplication.
  A marked attempt with no durable terminal outcome is classified indeterminate — counted
  in the resume double-charge warning — even when the persisted outcome is `pending`. The
  exception is an attempt whose durable record already carries a classified failure
  (rate limit, server error, invalid request, content filter, auth, configuration): that
  round-trip finished, so a stale marker is not an unknown completion. A missing
  `inflight.json` (runs created before this marker existed) is treated as empty, so
  legacy runs reconcile exactly as before.

## Continuation semantics

- **`resume`** reissues work that was never attempted (`pending`), was cancelled, or was
  interrupted (`indeterminate`). It prints a warning that an interrupted request has
  unknown upstream completion and can be charged again. Exhausted request failures are
  *not* resumed — that is `retry-failed`'s job. Operator-cancelled work is reissued
  without that warning: the abort was local and deliberate, and the engine records it as
  `cancelled` rather than `indeterminate`. Cancellation does not prove the upstream
  provider skipped the request, so treat a stopped run's in-flight requests as possibly
  charged once already.
- **`retry-failed`** creates a `recovery` child run linked by `lineage.parentRunId`. It
  selects only unresolved request failures (timeouts, network, rate limits, selected
  5xx, invalid requests, unknown transport failures), never scored responses, and never
  authentication/configuration failures that require an operator fix. Selection is per
  evaluation: a fixture with one unresolved evaluation reissues only that evaluation,
  not every variant of the fixture. If nothing is unresolved it does nothing and reports
  `run.nothing-to-do`.
- **Continuation scope and ownership.** A continuation's model files carry prior
  outcomes (so the child counts full plan progress) but record only the attempts that
  execution made; ancestor attempts stay in the ancestor run's files. The exported
  family billing ledger therefore sums each submitted request exactly once.
- **`restart`** creates a new `restart` primary run covering the original fixture
  selection with the original frozen settings and capability snapshot. It becomes the
  `--latest` primary; recovery children never do.
- **Lineage resolution** walks the whole recovery tree in creation order and takes the
  newest terminal record, while a scored response is never overwritten by a later
  failure. Repeated recovery therefore narrows to what is still unresolved.
- **Frozen settings are revalidated** before any continuation: the dataset SHA-256 must
  match, and every planned alias must still resolve to the same model ID, reasoning mode,
  and rate-limit group in the current config. A changed setting stops the command rather
  than mutating the experiment.

## Selector rules

- `--latest` selects the newest **primary** manifest by creation time in the configured
  results root, with the run ID as the deterministic tie-breaker. Recovery children are
  excluded.
- An explicit ID and `--latest` are mutually exclusive; supplying neither is a usage
  error.
- Missing, corrupt, or unsupported-version manifests fail the command. The runner never
  falls back to another run and never selects by file modification time.

## Environment

| Variable | Meaning |
| --- | --- |
| `OPENROUTER_API_KEY` | Provider credential. Read from the environment only; never written to config or artifacts. |
| `MMSTAR_CONFIG` | Optional config path override (same as `--config`). |
| `MMSTAR_RESULTS_ROOT` | Optional results-root override. |

## Capability preflight

A new `benchmark` run fetches `GET /api/v1/models` and freezes image-input and reasoning
support into the manifest before any inference request. Unsupported efforts, non-image
models, mandatory-reasoning conflicts, and unknown metadata fail closed. `resume`,
`retry-failed`, and `restart` rebuild the engine evaluations from the **frozen** snapshot
instead of re-fetching, so a metadata change cannot silently alter an existing run.

`--skip-preflight` is a development escape hatch for offline work: it freezes assumed
capabilities (image input, all efforts) with a loud warning. Results produced that way
are development evidence, not verified capability evidence, and must not be published as
a comparison.
