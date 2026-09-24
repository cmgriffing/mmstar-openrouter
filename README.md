# MMStar: OpenRouter

This repo is meant to be an implementation of the MMStar benchmarks that is set up in a way to evaluate the capabilities of models via the OpenRouter API.

The end goal is to have a verifiable set of data that can be used to make informed decisions about which models to use for various image understanding using cases and allow for the selection of cheaper or faster models with a good enough level of understanding.

## Requirements

| Tool | Pin | Check |
| --- | --- | --- |
| Node.js | `24.16.0` | `.node-version`, `engines.node` |
| pnpm | `10.24.0` | `packageManager` |
| Bun | `1.4.2` | `.bun-version` (runner and export harnesses; the website does not need Bun) |

Shared dependency versions live in the pnpm catalog (`pnpm-workspace.yaml`); see
[`docs/development.md`](./docs/development.md) for the full toolchain, conventions, and
troubleshooting.

## Quick start

```bash
pnpm install                 # installs the whole workspace from pnpm-lock.yaml
pnpm check                   # typecheck + lint + tests across packages
pnpm build                   # runner CLI bundle + Astro site build
```

Run a benchmark:

```bash
cp mmstar.config.example.json mmstar.config.json   # then set real model IDs
export OPENROUTER_API_KEY=...                      # runner only, never config or artifacts
pnpm validate -- --set example                     # read-only config/dataset/plan check
pnpm benchmark -- --set example                    # paid: starts a primary run
pnpm --filter @mmstar/runner dev -- benchmark --set example   # same run with the TUI
```

Every command emits one JSON object per line on stdout and human diagnostics on stderr;
the same engine backs the interactive TUI and headless use. Exit codes: `0` success, `1`
runtime failure, `2` usage/validation error, `130` interrupted.

## Configuration

`mmstar.config.json` is versioned JSON validated by `packages/config`; unknown fields,
unknown aliases, unsupported reasoning modes, and duplicate evaluations are rejected with
actionable paths before any request. The example file contains one placeholder alias.

- `models.<alias>` fixes an `openRouterId`, ordered `reasoningModes` (`default`, `none`, or
  an explicit effort), a required `rateLimitGroup`, and optional provider routing.
- `sets.<name>` is an ordered list of aliases; `validate`/`benchmark --set` select one.
- `execution` bounds concurrency, retries, request timeout, and an optional account-wide
  requests-per-minute cap.

**Grouping caveat.** `rateLimitGroup` is declared by the operator and must group every
alias that shares one upstream rate limit — model vendor, family, and serving provider are
different concepts. One request is in flight per group at a time, so a shared group
serializes its variants while independent groups run concurrently. Pin routing
(`provider.only`/`order`) when comparing providers; when routing may vary, the observed
serving provider is recorded per attempt.

Reasoning semantics, editor schema generation, and provider-routing fields are documented
in [`docs/configuration.md`](./docs/configuration.md).

## Interpreting results

The runner scores deterministic single-letter answers locally; the expected answer is
never sent to a model, and a wrong or unparseable answer is a terminal outcome — it is
never retried to improve a score. Metrics keep denominators explicit:

- **selected accuracy** = correct / selected fixtures; **scored accuracy** = correct /
  settled responses; **coverage** = settled / selected, with category breakdowns.
- Attempts, token usage, and costs are a billing ledger over every submitted request.
  Cost kinds stay distinct: `reported` (gateway-supplied), `estimated`, and `unknown`;
  unknown usage/cost is `null` and renders as "not reported", never `0`.

Live metrics are provisional until the run completes. Request latency excludes scheduler
wait and is reported separately from total fixture time including retries. See
[`docs/contracts.md`](./docs/contracts.md) for the scoring and record contracts.

## Monitoring

`pnpm --filter @mmstar/runner dev -- <command>` renders the same engine through an
OpenTUI React screen: run identity and progress, per-model/group status with provider and
cooldowns, provisional accuracy/categories, latency, token and cost accounting, and
bounded failure/activity inspection with fixture detail. Keyboard help, visible focus,
scrolling, resize handling, and non-color status tokens are built in; `p`/`c` pause and
continue, `q` quits gracefully. `pnpm --filter @mmstar/runner demo` runs a deterministic
mock benchmark with no credentials. Redirected stdout or `--plain` never starts a
renderer: the same engine emits machine-readable events. See [`docs/runner.md`](./docs/runner.md).

## Recovery

Runs are durable, single-writer JSON directories under `results/` with a frozen manifest,
per-model records, atomic checkpoints, and a process lock.

| Command | Behavior |
| --- | --- |
| `resume ID\|--latest` | Reissues pending, cancelled, and interrupted work; warns that an interrupted request has unknown upstream completion and can be billed again. Exhausted failures are not resumed. |
| `retry-failed ID\|--latest` | Creates a linked recovery run for unresolved request failures only (never auth/config failures), scoped to the evaluations that still need them. No-op when nothing remains. |
| `restart ID\|--latest` | Creates a new primary run with the original fixture selection and frozen settings; the restart becomes `--latest`. |

Frozen settings (dataset hash, model IDs, reasoning modes, rate-limit groups) are
revalidated before any continuation; incompatibility stops the command instead of mutating
the experiment. `--latest` selects the newest primary manifest by creation time, excluding
recovery children. Continuation semantics, selector rules, and locking are documented in
[`docs/runner.md`](./docs/runner.md).

## Publication and website

`mmstar export ID|--latest` publishes the selected run family as an immutable, validated
artifact under `publication/`: a normalized SQLite database plus deduplicated
content-addressed images (`benchmark-images/<sha256>.<ext>`) bound by a manifest. Export
never makes a provider request. It fails without replacing the previous artifact when the
dataset hash changed, a fixture or image is missing, a run file is corrupt, or two records
conflict.

The Astro site queries one immutable publication read-only through bounded parameterized
endpoints; original and recovered outcomes are separated by lineage without double-counting,
and missing usage/cost is shown as unknown. Images are served as static assets by the
deployment host — there are no runtime Git-host requests. **Publishing is a redeploy**:
produce a new publication, rebuild the target, deploy. **Rollback** means redeploying the
previous immutable publication; there is nothing to undo in place.

Per-target build and deploy commands (Node, Netlify, Vercel, Cloudflare Workers), endpoint
contracts, image hosting, and release/rollback steps live in [`docs/publication.md`](./docs/publication.md)
and [`docs/website.md`](./docs/website.md). Hosted Netlify/Vercel/Cloudflare behavior
remains unverified without deployment credentials; local workerd and emulated function
evidence is recorded in `docs/website.md`, and the release checklist in
[`docs/development.md`](./docs/development.md) tracks the open item.

## Verification

```bash
pnpm check                 # typecheck + lint + tests across the workspace
pnpm --filter @mmstar/runner test      # includes Bun-native TUI frame tests
bun apps/runner/scripts/e2e-workflow.ts --workdir /tmp/mmstar-e2e
```

The end-to-end harness drives `validate`, an interrupted run, `resume`, `retry-failed`,
`restart --latest`, `export --latest`, publication verification, and repository queries
against six real dataset fixtures with a deterministic in-memory provider — no network and
no paid request. All automated checks use mock providers; a paid smoke run is a separate,
explicitly invoked operation.

Workspace documentation:

- [`docs/architecture.md`](./docs/architecture.md) — components, runtime boundaries, and the results/publication model
- [`docs/configuration.md`](./docs/configuration.md) — `mmstar.config.json` fields, reasoning modes, and routing settings
- [`docs/contracts.md`](./docs/contracts.md) — dataset parsing, schema versions, run records, and engine events
- [`docs/development.md`](./docs/development.md) — pinned toolchain, commands, conventions, and the bounded-session workflow
- [`docs/publication.md`](./docs/publication.md) — SQLite schema, image extraction, validation, and deployment
- [`docs/runner.md`](./docs/runner.md) — CLI commands, TUI controls, recovery semantics, and locking
- [`docs/website.md`](./docs/website.md) — query endpoints, per-target build/deploy commands, and verification status
- [`docs/adr/0001-web-sqlite-reader.md`](./docs/adr/0001-web-sqlite-reader.md) — the WASM SQLite reader decision and measured evidence

## License

This implementation and code in this repo (besides the dataset) is licensed under the [MIT License](./LICENSE).

This repo claims no ownership or copyright over the dataset used for benchmarking.
The dataset is sourced from: https://huggingface.co/datasets/Lin-Chen/MMStar

None of the original benchmarking code is reused.
The original benchmark implementation can be found at: https://github.com/MMStar-Benchmark/MMStar

## ✒️ Citation

If you find our work helpful for your research, please consider giving a star ⭐ and citation 📝

```bibtex
@article{chen2024we,
  title={Are We on the Right Way for Evaluating Large Vision-Language Models?},
  author={Chen, Lin and Li, Jinsong and Dong, Xiaoyi and Zhang, Pan and Zang, Yuhang and Chen, Zehui and Duan, Haodong and Wang, Jiaqi and Qiao, Yu and Lin, Dahua and others},
  journal={arXiv preprint arXiv:2403.20330},
  year={2024}
}
```
