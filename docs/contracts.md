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
| `CAPABILITY_SNAPSHOT_VERSION` | 1 | Frozen provider capability snapshot | `packages/results` |
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

## Provider adapter

`packages/benchmark/src/provider-*.ts` owns the OpenRouter-facing contracts. The network
transport is injected, so the same code runs under Bun, in tests, and in any future
runtime; `apps/runner/src/transport.ts` is the only `fetch` implementation.

- `OpenRouterClient` (`provider-client.ts`) sends `GET /models` and
  `POST /chat/completions` through the injected `ProviderTransport`. It never reads
  configuration: the caller passes the key from the environment via
  `readOpenRouterApiKey`, and the key stays in outgoing headers — never in failures, raw
  response retention, events, or records. A request timeout aborts the transport and is
  classified as `timeout`; caller cancellation is classified as `cancelled`.
- Metadata parsing (`provider-metadata.ts`) preserves the upstream distinctions:
  `supported_efforts` array, `null` (all gateway efforts accepted),
  `"no-effort-selection"` (reasoning object without the field), and `"non-reasoning"`
  (no reasoning object). Catalog shapes the parser cannot interpret throw
  `ProviderProtocolError` instead of being guessed at.
- Preflight (`provider-preflight.ts`) fails closed: unknown models, models without
  `image` input, and explicit efforts that metadata does not list are rejected as
  actionable issues. `mandatory` reasoning rejects `none`. `default` always omits the
  upstream `reasoning` parameter; `none` on a non-reasoning model also omits it, while a
  reasoning model without effort selection still receives the explicit
  `{ effort: "none" }` so `none` never silently becomes `default`. One snapshot per
  distinct model is returned for freezing in the manifest.
- Requests (`provider-request.ts`) carry one user message with the versioned instruction
  plus the question verbatim and the image as a `data:` URL. The expected answer is never
  part of the payload. Dynamic routers (`openrouter/auto`, `openrouter/free`) and
  `:variant` suffixes are rejected again at this boundary. Provider routing maps to
  `only`, `order`, `ignore`, `allow_fallbacks`, and `sort`, with
  `require_parameters: true` always set.
- Responses (`provider-response.ts`) normalize the reported model, the serving provider
  (from `openrouter_metadata.endpoints.selected` or the legacy `provider` field),
  `finish_reason`, visible text, nullable token usage (including
  `completion_tokens_details.reasoning_tokens`), and reported cost. Missing or malformed
  fields become `null`/`unknown`, never zero. The parsed body is returned so chunk 5 can
  retain it for local audit.
- Failures (`provider-failure.ts`) map HTTP statuses to the durable categories: 401/403
  `auth`, 402/404 `configuration`, 408 `timeout`, 429 `rate_limit`, 400/other 4xx
  `invalid_request`, 499 `cancelled`, 5xx `server_error`, and malformed success bodies
  `unknown`. `isRetryableFailure` allows only timeouts, network failures, 429, and
  selected 5xx (500, 502–504, 507, 508, 520–525, 527, 530); 501/505 are recorded but not
  retried. `Retry-After` (delta-seconds or HTTP-date) is preserved as `retryAfterMs`.

## Run records

`packages/results/src/records.ts` defines the durable JSON shapes. Key rules:

- `RunManifest` = frozen configuration + plan + lifecycle; `lineage.kind` is `primary`,
  `recovery`, or `restart`, with `parentRunId` and (for recovery) `recoveredFixtureIds`.
- `ModelRecordFile` holds one alias's `EvaluationRecord[]`, each with `outcomes` and
  `attempts`. Outcomes and attempts have stable unique IDs.
- `RunManifest.capabilities` holds one versioned `ModelCapabilitySnapshot` per distinct
  model in `plan.evaluations`, in first-seen order: input modalities, image support, and
  the raw reasoning metadata. It is the frozen evidence preflight used, so a later
  capability change cannot silently reinterpret a run.
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
provider output. `evaluation.started` also carries `openRouterId` and `rateLimitGroup`,
and `attempt.finished` carries `modelUsed`/`upstreamProvider` (null when no response
arrived) plus an optional `retryAt` (the scheduled retry time, or null when the attempt
is terminal), so a renderer can show the active model/group, observed provider, and a
live retry countdown without reading engine internals. Rendering consumes events;
scheduling and persistence never depend on a renderer. `BenchmarkEngine.getMetrics()`
and `getRecords()` expose read-only snapshots, and `getFixtureDetail(fixtureId)` exposes
category/question/expected-answer metadata (never image bytes) for inspection UIs.

## Execution engine

`packages/benchmark/src/engine.ts` is the headless scheduler. Clock, provider, jitter
source, scorer, and event sink are injected, so scheduling is tested without a network or
a terminal.

- **Groups.** Every evaluation belongs to one `rateLimitGroup`. Work items
  (evaluation × fixture) queue per group in plan/fixture order; at most one request is in
  flight per group across models and effort variants. Groups run round-robin under
  `maxConcurrentGroups`, and `maxRequestsPerMinute` applies a sliding one-minute
  account-wide request cap with its own cooldown event (`reason: "request_cap"`).
  Pause stops new launches while in-flight work settles; resume continues; stop aborts
  in-flight requests (recorded `cancelled`) and leaves never-started work `pending`.
- **Retries.** Only `isRetryableFailure` failures retry, up to `maxRetries` after the
  initial attempt (`maxRetries: 3` allows at most four attempts). Delays are jittered
  exponential backoff in `[250 ms, min(30 s, 1 s · 2^(attempt-1))]`; a `Retry-After`
  value is honored exactly, including zero. A 429 also starts a shared group cooldown.
  Scored responses — including `incorrect`, `ambiguous`, `invalid`, `refused`, and
  `truncated` — are terminal and never retried.
- **Permanent failures.** `auth` and `configuration` failures record a failed outcome and
  halt new scheduling for the whole run (`EngineRunResult.halt` carries the failure);
  in-flight requests settle normally. Other permanent failures (`invalid_request`,
  `content_filter`, `unknown`) fail that fixture and scheduling continues.
- **Unknown completion.** Exhausted `timeout`/`network` attempts settle as
  `indeterminate` with `indeterminate: true`, never silently `failed`.
- **Scoring.** `createOptionScorer()` accepts exactly one distinct uppercase option
  letter among A–D, tolerating markdown emphasis, punctuation, and answer prose. Lowercase
  answers, prose without an option, refusals, `finish_reason: "length"`, and
  `finish_reason: "content_filter"` become `invalid`, `refused`, or `truncated`. The
  expected answer is compared locally and never enters a request.
- **Metrics.** `computeEngineMetrics()` reports coverage, total-selected accuracy
  (`correct / selected`), scored-response accuracy (`correct / (correct + incorrect)`),
  per-category denominators, attempt-level token totals and known/estimated/unknown
  costs, and nearest-rank latency distributions for request latency and total fixture
  time. Missing values stay `null`, and snapshots are `provisional` until the run ends.

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

Rechecked while implementing chunk 3 (2026-09-23). Recheck again before changing provider
behavior:

- Reasoning controls and effort values (`max`, `xhigh`, `high`, `medium`, `low`,
  `minimal`, `none`; `reasoning.enabled`, `reasoning.exclude`; legacy `include_reasoning`):
  <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
- Metadata semantics: `supported_efforts` is descending order; `null` means all gateway
  effort values are accepted; omitted means the model exposes no effort selection;
  `default_effort: "none"` means reasoning is off by default; `default_enabled`,
  `supports_max_tokens`, and `mandatory` (which rejects `effort: "none"`). Model metadata
  comes from `GET /api/v1/models` and `architecture.input_modalities` includes `image`
  for image-capable models:
  <https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties>
- Gateway effort mapping: OpenRouter documents that some providers map an unsupported
  effort to the nearest supported level (for example Gemini 3 `thinkingLevel`). This
  project still fails closed — an explicit mode must appear in `supported_efforts`, or
  the field must be `null`, before it is sent, so a benchmark never depends on an
  undocumented remap.
- Provider routing (`order`, `only`, `ignore`, `allow_fallbacks`, `sort`, and
  `require_parameters`) and routing metadata opt-in (`X-OpenRouter-Metadata: enabled`,
  surfaced under `openrouter_metadata`):
  <https://openrouter.ai/docs/guides/routing/provider-selection>
- Chat completions response shape (`choices[].message.content`, `finish_reason`,
  `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`,
  `usage.completion_tokens_details.reasoning_tokens`, `usage.cost`):
  <https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion>
