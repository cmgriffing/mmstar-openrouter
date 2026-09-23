/**
 * Capability preflight: validate every planned evaluation against fresh
 * metadata before any request is submitted.
 *
 * This is the fail-closed boundary. Image support, unknown models, mandatory
 * reasoning, explicit efforts the metadata does not list, and metadata that
 * exposes no effort selection are all rejected here with an actionable issue —
 * the runner never silently downgrades an effort, substitutes a model, or
 * treats unknown support as supported. `default` and `none` stay distinct:
 * `default` always omits the upstream `reasoning` parameter, while `none`
 * requests disabled reasoning and is rejected when reasoning is mandatory.
 */
import type {
  EvaluationPlan,
  ProviderRoutingConfig,
  ReasoningMode,
  ValidationIssue,
} from "@mmstar/config";
import type { ModelCapabilitySnapshot } from "@mmstar/results";
import type { ModelCatalog, ModelReasoningMetadata } from "./provider-metadata";
import { toCapabilitySnapshot } from "./provider-metadata";

/** The upstream `reasoning` payload for one evaluation, or null to omit it. */
export type ReasoningRequest = { effort: string } | null;

/**
 * A plan evaluation enriched with the preflight decision. `reasoning` is null
 * when the parameter must be omitted entirely (`default`, or a non-reasoning
 * model).
 */
export interface PreflightEvaluation {
  evaluationId: string;
  modelAlias: string;
  openRouterId: string;
  reasoningMode: ReasoningMode;
  rateLimitGroup: string;
  provider: ProviderRoutingConfig | null;
  reasoning: ReasoningRequest;
}

export interface CapabilityPreflight {
  evaluations: PreflightEvaluation[];
  /** One snapshot per distinct model, in plan order. */
  capabilities: ModelCapabilitySnapshot[];
}

export type CapabilityPreflightResult =
  | { ok: true; preflight: CapabilityPreflight }
  | { ok: false; issues: readonly ValidationIssue[] };

export type ReasoningDecision =
  | { ok: true; reasoning: ReasoningRequest }
  | { ok: false; code: "mandatory_reasoning" | "unsupported_reasoning_effort"; message: string };

/** Decide whether one configured mode may be requested, and how. */
export function decideReasoningRequest(
  mode: ReasoningMode,
  reasoning: ModelReasoningMetadata,
): ReasoningDecision {
  if (mode === "default") return { ok: true, reasoning: null };

  if (mode === "none") {
    if (reasoning.mandatory === true) {
      return {
        ok: false,
        code: "mandatory_reasoning",
        message:
          'model metadata marks reasoning as mandatory, so mode "none" cannot be requested and is never silently substituted',
      };
    }
    // A model with no reasoning object does not accept a reasoning parameter,
    // so explicit disabling is a documented no-op: omit it. A reasoning model
    // whose metadata exposes no effort selection still receives the explicit
    // disable request, keeping `none` distinct from `default`.
    if (reasoning.supportedEfforts === "non-reasoning") return { ok: true, reasoning: null };
    return { ok: true, reasoning: { effort: "none" } };
  }

  if (
    reasoning.supportedEfforts === "non-reasoning" ||
    reasoning.supportedEfforts === "no-effort-selection"
  ) {
    return {
      ok: false,
      code: "unsupported_reasoning_effort",
      message: `model metadata exposes no effort selection, so mode "${mode}" is unsupported; use "default"${
        reasoning.mandatory === true ? "" : ' or "none"'
      }`,
    };
  }

  if (reasoning.supportedEfforts === null) {
    return { ok: true, reasoning: { effort: mode } };
  }

  if (!reasoning.supportedEfforts.includes(mode)) {
    const supported = reasoning.supportedEfforts.join(", ") || "none";
    return {
      ok: false,
      code: "unsupported_reasoning_effort",
      message: `mode "${mode}" is not in the model's supported efforts (${supported}); request a supported effort or "default"`,
    };
  }

  return { ok: true, reasoning: { effort: mode } };
}

/**
 * Validate a plan against a fresh catalog. Returns every issue found so one
 * preflight run reports all unsupported evaluations.
 */
export function preflightPlan(
  plan: EvaluationPlan,
  catalog: ModelCatalog,
): CapabilityPreflightResult {
  const issues: ValidationIssue[] = [];
  const evaluations: PreflightEvaluation[] = [];
  const capabilities: ModelCapabilitySnapshot[] = [];
  const snapshotsByModel = new Map<string, ModelCapabilitySnapshot>();

  plan.evaluations.forEach((evaluation, index) => {
    const path = `plan.evaluations[${index}]`;
    const metadata = catalog.models.find((model) => model.id === evaluation.openRouterId);
    if (metadata === undefined) {
      issues.push({
        path,
        code: "unknown_model",
        message: `model "${evaluation.openRouterId}" is not in the models metadata; check the OpenRouter ID and reconnect before running`,
      });
      return;
    }

    if (!metadata.inputModalities.includes("image")) {
      issues.push({
        path,
        code: "missing_image_input",
        message: `model "${metadata.id}" does not declare image input (declared modalities: ${describeModalities(
          metadata.inputModalities,
        )}); MMStar requires an image-capable model`,
      });
    }

    const decision = decideReasoningRequest(evaluation.reasoningMode, metadata.reasoning);
    if (!decision.ok) {
      issues.push({
        path: `${path}.reasoningMode`,
        code: decision.code,
        message: decision.message,
      });
    }

    let snapshot = snapshotsByModel.get(metadata.id);
    if (snapshot === undefined) {
      snapshot = toCapabilitySnapshot(metadata, catalog.fetchedAt);
      snapshotsByModel.set(metadata.id, snapshot);
      capabilities.push(snapshot);
    }

    if (decision.ok) {
      evaluations.push({
        evaluationId: evaluation.evaluationId,
        modelAlias: evaluation.modelAlias,
        openRouterId: evaluation.openRouterId,
        reasoningMode: evaluation.reasoningMode,
        rateLimitGroup: evaluation.rateLimitGroup,
        provider: evaluation.provider,
        reasoning: decision.reasoning,
      });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, preflight: { evaluations, capabilities } };
}

export function describeModalities(modalities: readonly string[]): string {
  return modalities.length === 0 ? "none declared" : modalities.join(", ");
}
