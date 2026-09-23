# Contracts and schemas

Runtime-neutral contracts live in `packages/*` and are shared by the Bun runner and the Astro
website. TypeScript source is the contract; there is no generated library build. Every
persisted or wire-facing structure carries an explicit version constant.

## Version table

| Constant | Value | Owns | Where |
| --- | --- | --- | --- |
| `CONFIG_VERSION` | 1 | `mmstar.config.json` | `packages/config` |
| `PLAN_VERSION` | 1 | Frozen evaluation plan | `packages/config` |
| `PROMPT_VERSION` | 1 | Prompt instruction/shape | `packages/benchmark` |
| `SCORER_VERSION` | 1 | Scoring contract | `packages/benchmark` |
| `RUN_MANIFEST_VERSION` | 1 | `manifest.json` | `packages/results` |
| `MODEL_RECORD_VERSION` | 1 | Per-model JSON records | `packages/results` |
| `ENGINE_EVENT_VERSION` | 1 | Typed engine events | `packages/benchmark` |

Package dependency direction is linear and enforced by imports: `@mmstar/config` →
`@mmstar/results` → `@mmstar/benchmark`. Nothing imports in the reverse direction, so run
records can embed the plan and events can embed record classifications without cycles.

## Dataset

`MMStar.tsv` is committed Tab-separated with RFC 4180 quoting: `question` fields are
double-quoted when they contain newlines or tabs, with `""` for a literal quote. The base64
`image` column is unquoted. `packages/benchmark/src/dataset.ts` parses this file
incrementally (`push`/`finish`) under bounds:

| Bound | Default |
| --- | --- |
| records | 20 000 |
| field characters | 8 000 000 |
| question characters | 65 536 |
| decoded image bytes | 8 000 000 |
| total input characters | 256 000 000 |
| collected failures | 50 |

Validated per row: seven canonical columns, unique `index` (non-negative, no leading zeros)
used as the fixture ID, non-empty `question`, single-letter `answer` (normalized uppercase),
non-empty `category`/`l2_category`/`bench`, and base64 with a supported image signature
(JPEG, PNG, or WebP; data URIs are rejected). Carriage returns are dropped, so CRLF input and
CRLF inside quoted fields normalize to LF.

The committed dataset verifies as 1,500 fixtures, six categories × 250, 18 `l2_category`
values, and 1,500 JPEG images; the frozen SHA-256 is asserted in
`packages/benchmark/src/dataset.test.ts`.

`toPromptFixture` is the only projection handed to a prompt or provider: fixture ID, question,
image media type, and raw base64. The expected answer stays in the fixture record for
scoring/audit and is never part of model input.

## Evaluation plan

`expandPlan` is deterministic and pure. Evaluations follow set order, then each alias's
declared reasoning-mode order; fixtures keep dataset order. It freezes:

- `planVersion`, `setName`, `promptVersion`, `scorerVersion`;
- dataset `path`, `sha256`, `fixtureCount`, and selected `fixtureIds`;
- `configSha256` when known;
- one entry per evaluation: stable `evaluationId` (`<alias>::<mode>`), alias, OpenRouter ID,
  reasoning mode, `rateLimitGroup`, and provider routing (or `null`).

Duplicate evaluations — two aliases expanding to the same model, mode, and routing — are
rejected, as are unknown sets, duplicate fixture IDs, and empty selections.

## Run records

`packages/results/src/records.ts` defines the durable JSON shapes. Key rules:

- `RunManifest` = frozen configuration + plan + lifecycle; `lineage.kind` is `primary`,
  `recovery`, or `restart`, with `parentRunId` and (for recovery) `recoveredFixtureIds`.
- `ModelRecordFile` holds one alias's `EvaluationRecord[]`, each with `outcomes` and
  `attempts`. Outcomes and attempts have stable unique IDs.
- `OutcomeRecord.state` is `pending`, `settled`, `failed`, `indeterminate`, or `cancelled`;
  `kind` (`correct`, `incorrect`, `ambiguous`, `invalid`, `refused`, `truncated`) is only set
  for settled outcomes. Request failures are never scored kinds.
- `indeterminate` marks a submitted request with no durable terminal result; recovery must
  disclose duplicate-call/billing uncertainty.
- `UsageRecord` is `null` when no usage exists at all; individual token fields are `null` when
  unknown. `CostRecord.kind` is `reported`, `estimated`, or `unknown`, and `usd` is `null` for
  unknown. Unknown is never encoded as zero.
- `lineage` on an outcome points at the source run/outcome it resolves; original records are
  never overwritten.
- Every record carries timestamps and enough request/provider detail to audit an attempt
  without storing credentials.

## Engine events

`EngineEvent` is a discriminated union (`run.started`, `evaluation.started`,
`attempt.started`, `attempt.finished`, `outcome.settled`, `group.cooldown.started`,
`group.cooldown.ended`, `engine.paused`, `engine.resumed`, `engine.stopping`,
`run.finished`). Payloads carry IDs, classifications, timings, and usage/cost records only —
never raw response text — so event batching and bounded UI history cannot be inflated by
provider output. Rendering consumes events; scheduling and persistence never depend on a
renderer.

## Verification

```bash
pnpm check                 # typecheck + lint + test across the workspace
pnpm --filter @mmstar/config test
pnpm --filter @mmstar/benchmark test
pnpm --filter @mmstar/results test
pnpm schema                # regenerate the editor schema after config rule changes
```

The benchmark suite parses the committed 59 MB dataset in-test to assert counts, image
formats, unique IDs, and the frozen source hash. Test-only Node builtin declarations live in
`packages/benchmark/src/test-node.d.ts` so shared source keeps `"types": []`.

## Current upstream references

Captured while implementing chunk 2 (recheck before changing provider behavior in chunk 3+):

- Reasoning controls and effort values:
  <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
- Provider routing:
  <https://openrouter.ai/docs/guides/routing/provider-selection>
- Model metadata (`GET /api/v1/models`) exposes `reasoning.supported_efforts` (descending,
  `null` = all accepted, omitted = no effort selection), `default_effort` (`"none"` = off by
  default), `default_enabled`, `supports_max_tokens`, and `mandatory`.
