/**
 * Configured reasoning modes and their mapping to OpenRouter controls.
 *
 * The mode list is the project's vocabulary; `reasoningEffortFor` maps it to the
 * `reasoning.effort` value sent upstream (current gateway values: `max`, `xhigh`,
 * `high`, `medium`, `low`, `minimal`, `none`).
 *
 * Semantics that later chunks must preserve:
 * - `default` omits the `reasoning` parameter entirely, so the provider/model
 *   default applies. It is not the same experiment as `none`.
 * - `none` explicitly requests disabled reasoning and is invalid for models
 *   whose capability metadata marks reasoning as mandatory (chunk 3 preflight).
 * - Capability validation fails closed: a configured explicit mode that fresh
 *   metadata does not list is rejected rather than silently remapped.
 */
export const REASONING_MODES = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningMode = (typeof REASONING_MODES)[number];

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningMode(value: unknown): value is ReasoningMode {
  return typeof value === "string" && (REASONING_MODES as readonly string[]).includes(value);
}

/**
 * Sentinel accepted in place of an explicit mode list. The runner resolves it
 * from model capability metadata (ascending intensity order) after the catalog
 * fetch and freezes only the concrete evaluations it produced.
 */
export const REASONING_ALL = "all" as const;

/**
 * `reasoningModes` config form: the closed explicit vocabulary, or `"all"` for
 * metadata-driven expansion. An array containing `"all"` is ambiguous and is
 * rejected by the validator.
 */
export type ReasoningModesConfig = ReasoningMode[] | typeof REASONING_ALL;

/**
 * Shape guard for the union. It accepts `"all"` or a non-empty array of unique
 * explicit modes, matching the `reasoningModes` config rule: mixed arrays such
 * as `["all", "high"]`, empty arrays, duplicates, and non-mode entries are not
 * a valid `ReasoningModesConfig`.
 */
export function isReasoningModesConfig(value: unknown): value is ReasoningModesConfig {
  if (value === REASONING_ALL) return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isReasoningMode(entry) || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

/**
 * Upstream `reasoning.effort` for a configured mode, or `null` when the
 * `reasoning` parameter must be omitted (`default`).
 */
export function reasoningEffortFor(mode: ReasoningMode): ReasoningEffort | "none" | null {
  return mode === "default" ? null : mode;
}
