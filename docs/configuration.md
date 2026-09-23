# Configuration

A run is configured by a versioned JSON document, `mmstar.config.json`, resolved from the
working directory. [`mmstar.config.example.json`](../mmstar.config.example.json) is a
validated placeholder: copy it and replace `example-vendor/example-image-model` with a real
OpenRouter model only after checking that model's current image and reasoning capabilities
(chunk 3 preflight fails closed rather than guessing support).

Editor autocomplete comes from [`mmstar.config.schema.json`](../mmstar.config.schema.json),
which is generated from the runtime validator. After changing configuration rules:

```bash
pnpm schema                  # regenerate the committed schema
pnpm --filter @mmstar/config test   # fails when the committed file drifts
```

The runtime validator in `packages/config` is authoritative. It reports every problem with a
path such as `models.gpt.reasoningModes[1]` and a stable code such as
`unknown_reasoning_mode`, and never repairs or infers input.

## Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Configuration schema version; currently `1`. Other values are rejected. |
| `$schema` | no | Editor schema reference, normally `"./mmstar.config.schema.json"`. |
| `dataset` | no | `{ "path": "MMStar.tsv" }`; relative to the working directory. Defaults to `MMStar.tsv`. |
| `execution` | no | Execution limits; see below. All fields default. |
| `models` | yes | Named aliases; each expands into one evaluation per reasoning mode. |
| `sets` | yes | Named ordered lists of aliases; `validate`/`benchmark --set <name>` selects one. |

Unknown fields are rejected at every level, including inside `execution`, aliases, provider
routing, and sets.

### `models.<alias>`

| Field | Meaning |
| --- | --- |
| `openRouterId` | Fixed `vendor/model` ID. Dynamic routers (`openrouter/auto`, `openrouter/free`) and variant suffixes (`:nitro`, `:floor`, `:online`, `:thinking`) are rejected: a fixed-model comparison must not substitute models at request time. |
| `reasoningModes` | Ordered, unique modes; order determines evaluation order inside a set. |
| `rateLimitGroup` | Required identifier shared by every alias limited by the same provider rate limit. One request is in flight per group at a time. |
| `provider` | Optional routing restrictions (below). |

### `execution`

| Field | Default | Bounds |
| --- | --- | --- |
| `maxConcurrentGroups` | `4` | 1–64 |
| `maxRetries` | `3` | 0–10; retries **after** the initial attempt, so `3` allows at most four attempts per fixture per execution |
| `requestTimeoutMs` | `120000` | 1000–600000 |
| `maxRequestsPerMinute` | `null` (no configured cap) | 1–60000 when set; account-wide across groups |
| `resultsRoot` | `"results"` | relative path without `..` segments |

These are local policies, not provider guarantees. `dataset.path` and `execution.resultsRoot`
must be relative and traversal-free so a config cannot read or write outside the workspace.

### Provider routing

`provider` is passed through with `require_parameters: true` always set by the adapter:

| Field | Meaning |
| --- | --- |
| `only` | Providers allowed to serve the model. Mutually exclusive with `ignore`. |
| `ignore` | Providers excluded from serving the model. |
| `order` | Preferred provider order. |
| `allowFallbacks` | Whether fallback providers may serve when preferred ones are unavailable. |
| `sort` | `price`, `throughput`, or `latency`. |

Declare shared provider limits in the same `rateLimitGroup`. Pin routing (`only`/`order`)
when a stable provider comparison is required; when routing may vary, the runner records the
observed serving provider per attempt.

## Reasoning modes

Modes map to OpenRouter's `reasoning.effort` (current gateway values: `max`, `xhigh`, `high`,
`medium`, `low`, `minimal`, `none`):

| Mode | Upstream behavior |
| --- | --- |
| `default` | Omit the `reasoning` parameter entirely; the model/provider default applies. Not the same experiment as `none`. |
| `none` | Explicitly request disabled reasoning. Invalid for models whose metadata marks reasoning as mandatory. |
| `minimal` … `max` | Explicit effort level. |

Preflight (chunk 3) validates each configured mode against fresh model metadata and fails
closed for unknown explicit support instead of silently remapping effort. Metadata semantics
observed during chunk 2:

- `supported_efforts: null` means all gateway effort values are accepted;
- an omitted `reasoning` object means the model does not expose effort selection;
- `default_enabled`, `default_effort` (`"none"` means off by default), and `mandatory` decide
  whether `default`/`none` are valid and what they mean.

## Credentials

`OPENROUTER_API_KEY` is read from the environment by the runner only. Credentials never
belong in configuration, schema files, or run artifacts, and the website is credential-free.
