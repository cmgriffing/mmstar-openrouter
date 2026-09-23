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
 * Upstream `reasoning.effort` for a configured mode, or `null` when the
 * `reasoning` parameter must be omitted (`default`).
 */
export function reasoningEffortFor(mode: ReasoningMode): ReasoningEffort | "none" | null {
  return mode === "default" ? null : mode;
}
