# Runner commands and run recovery

`apps/runner` is the operator interface: it loads configuration and the committed
dataset, freezes an evaluation plan, and executes it through the headless engine in
`packages/benchmark`. Every command writes one JSON object per line to stdout (plain,
machine-readable, ANSI-free) and human-readable diagnostics to stderr, so the same
commands work headlessly and under the TUI added in chunks 6–7.

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
| `export ID\|--latest` | Publish the selected run family as a validated SQLite snapshot with content-addressed images. |

Exit codes: `0` success, `1` runtime failure (invalid run, provider halt, incomplete
work), `2` usage or validation error, `130` interrupted before completion (SIGINT or a
TUI graceful quit).

## Terminal UI

`bun run src/index.tsx <command>` (or `pnpm --filter @mmstar/runner dev -- <command>`)
runs the same commands as the plain CLI but renders typed engine events in an
OpenTUI React screen instead of NDJSON. The header shows run identity, progress and an
elapsed/remaining estimate, terminal outcome counts, cooldowns and retry countdowns,
and a live metrics block: provisional/final markers, scored and total-selected
accuracy with explicit denominators, coverage, category breakdown, latency
percentiles, token usage, and known/reported/estimated/unknown costs kept distinct.
Missing values render as `—`, never as zero. Below that, one row per model/effort
shows its rate-limit group, observed provider, attempts, and status token, and the
activity pane lists failures, wrong answers, and control events.

```bash
pnpm --filter @mmstar/runner dev -- benchmark --set smoke
pnpm --filter @mmstar/runner demo         # deterministic mock run, no credentials
pnpm --filter @mmstar/runner smoke        # render briefly, then exit (PTY check)
```

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

`--demo` drives the real engine with a deterministic mock provider (scripted
cooldown, retry, and permanent failure) and exits when the run finishes; `--hold`
keeps the final frame until `q`. Quitting (`q`, Ctrl-C, or SIGINT) is a graceful stop:
no new requests start, in-flight attempts are aborted and recorded as `cancelled`,
checkpoints are written, the terminal is restored, and the run ID plus final state are
printed. When stdout is not a TTY, or `--plain` is passed, the entry point never
starts a renderer: it runs the same engine through the plain CLI (or emits demo
engine events as NDJSON) with the same exit codes and no terminal control sequences.

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

`export --run ID` or `export --latest` turns durable run JSON into the immutable
artifact the website deploys. `--out <dir>` changes the output directory (default
`publication/`); the directory is Git-ignored. Exactly one selector is required, and
export resolves the whole **family**: the topmost ancestor of the selected run plus all
of its descendants, so restarts and recoveries travel together and the effective view
can resolve each fixture exactly once.

```bash
mmstar export --latest                       # newest primary run's family
mmstar export --run 20260923T053337000Z_deadbeef --out publication
```

Export never makes a provider request and never needs an API key. It reloads the
dataset named by the frozen plan and refuses to publish when the dataset SHA-256 no
longer matches, when a selected fixture (or its image) is missing, when a run file is
corrupt or uses an unsupported version, or when an identity conflict would mix two
different experiments. The artifact is built in a temp directory and verified before
the previous publication is replaced, so a failed export always leaves the last valid
publication in place. See `docs/publication.md` for the layout, schema, and views.

## Single writer, atomic checkpoints

- **Locking.** A run directory is written by exactly one process. `run.lock` is created
  exclusively (`O_EXCL`) and records PID, host, and acquisition time. A lock is reclaimed
  automatically only when this host can prove the holder is gone (dead PID recorded on
  this host). A lock from another host, or one carrying this process's own PID (a
  re-entrant acquisition), requires an explicit `--force`; the runner never guesses.
- **Atomic writes.** Every file is written to a uniquely named temp file in the same
  directory, fsynced, then renamed over the target. A crash always leaves either the old
  or the new complete file — never a partial manifest.
- **Checkpoints.** Model files are written before the manifest, after attempt starts,
  after terminal outcomes, and at run end. If a crash lands between the two writes, the
  model files are newer than the manifest.
- **Reconciliation.** `resume`/`retry-failed`/`restart` reconstruct progress from the
  validated model files and treat the manifest as identity/plan only. A fixture that is
  present in the plan but absent from the durable records counts as pending work, and a
  fixture that appears in two model files is a hard conflict, not a silent deduplication.

## Continuation semantics

- **`resume`** reissues work that was never attempted (`pending`), was cancelled, or was
  interrupted (`indeterminate`). It prints a warning that an interrupted request has
  unknown upstream completion and can be charged again. Exhausted request failures are
  *not* resumed — that is `retry-failed`'s job.
- **`retry-failed`** creates a `recovery` child run linked by `lineage.parentRunId`. It
  selects only unresolved request failures (timeouts, network, rate limits, selected
  5xx, invalid requests, unknown transport failures), never scored responses, and never
  authentication/configuration failures that require an operator fix. If nothing is
  unresolved it does nothing and reports `run.nothing-to-do`.
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
