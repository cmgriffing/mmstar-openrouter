/**
 * Deterministic evaluation-plan expansion.
 *
 * A plan is the frozen, ordered list of evaluations (model alias + reasoning
 * mode) and fixture IDs that a run executes, together with the source hashes and
 * prompt/scorer versions needed to reproduce it. Expansion is pure: identical
 * inputs produce byte-identical plans.
 */
import type { MmstarConfig, ProviderRoutingConfig } from "./config";
import type { ValidationIssue } from "./errors";
import type { ReasoningMode } from "./reasoning";

export const PLAN_VERSION = 1;

export interface PlanEvaluation {
  /** Stable ID: `<alias>::<mode>`; unique within a plan. */
  evaluationId: string;
  modelAlias: string;
  openRouterId: string;
  reasoningMode: ReasoningMode;
  rateLimitGroup: string;
  /** Routing preferences frozen with the plan, or null when provider defaults apply. */
  provider: ProviderRoutingConfig | null;
}

export interface FrozenDatasetPlan {
  path: string;
  /** SHA-256 of the dataset bytes used to build the plan. */
  sha256: string;
  fixtureCount: number;
  /** Selected fixture IDs in deterministic (dataset) order. */
  fixtureIds: string[];
}

export interface EvaluationPlan {
  planVersion: typeof PLAN_VERSION;
  setName: string;
  promptVersion: number;
  scorerVersion: number;
  dataset: FrozenDatasetPlan;
  /** SHA-256 of the config document when known, or null. */
  configSha256: string | null;
  evaluations: PlanEvaluation[];
}

export interface PlanSource {
  config: MmstarConfig;
  setName: string;
  /** Selected fixture IDs in deterministic order. */
  fixtureIds: readonly string[];
  datasetSha256: string;
  configSha256?: string | null;
  promptVersion: number;
  scorerVersion: number;
}

export type PlanResult =
  | { ok: true; plan: EvaluationPlan }
  | { ok: false; issues: readonly ValidationIssue[] };

export function evaluationIdFor(modelAlias: string, reasoningMode: ReasoningMode): string {
  return `${modelAlias}::${reasoningMode}`;
}

/**
 * Stable identity for provider routing preferences. Two aliases that resolve to
 * the same model and mode with identical routing are duplicate evaluations.
 */
export function providerRoutingKey(provider: ProviderRoutingConfig | null): string {
  if (provider === null) return "default";
  const entries = Object.entries(provider).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Expand `setName` into an ordered plan. Evaluations follow set order and then
 * each alias's declared reasoning-mode order; fixture IDs keep their input
 * order. Duplicate evaluations are rejected rather than deduplicated.
 */
export function expandPlan(source: PlanSource): PlanResult {
  const issues: ValidationIssue[] = [];

  const set = source.config.sets[source.setName];
  if (set === undefined) {
    const available = Object.keys(source.config.sets).join(", ") || "none";
    issues.push({
      path: `sets.${source.setName}`,
      code: "unknown_set",
      message: `set "${source.setName}" is not defined; available sets: ${available}`,
    });
    return { ok: false, issues };
  }

  if (source.fixtureIds.length === 0) {
    issues.push({
      path: "dataset.fixtureIds",
      code: "empty_fixture_selection",
      message: "fixture selection contains no fixtures",
    });
  }
  const seenFixtures = new Set<string>();
  source.fixtureIds.forEach((fixtureId, index) => {
    if (seenFixtures.has(fixtureId)) {
      issues.push({
        path: `dataset.fixtureIds[${index}]`,
        code: "duplicate_fixture",
        message: `fixture "${fixtureId}" is selected more than once`,
      });
    }
    seenFixtures.add(fixtureId);
  });

  const evaluations: PlanEvaluation[] = [];
  const evaluationIdentity = new Map<string, string>();

  set.models.forEach((aliasName, aliasIndex) => {
    const alias = source.config.models[aliasName];
    if (alias === undefined) {
      issues.push({
        path: `sets.${source.setName}.models[${aliasIndex}]`,
        code: "unknown_alias",
        message: `alias "${aliasName}" is not defined in models`,
      });
      return;
    }
    const provider = alias.provider ?? null;
    const routingKey = `${alias.openRouterId}::${providerRoutingKey(provider)}`;
    for (const reasoningMode of alias.reasoningModes) {
      const identity = `${routingKey}::${reasoningMode}`;
      const existingAlias = evaluationIdentity.get(identity);
      if (existingAlias !== undefined) {
        issues.push({
          path: `sets.${source.setName}.models[${aliasIndex}]`,
          code: "duplicate_evaluation",
          message: `aliases "${existingAlias}" and "${aliasName}" both expand to ${alias.openRouterId} with reasoning mode "${reasoningMode}" and identical provider routing`,
        });
        continue;
      }
      evaluationIdentity.set(identity, aliasName);
      evaluations.push({
        evaluationId: evaluationIdFor(aliasName, reasoningMode),
        modelAlias: aliasName,
        openRouterId: alias.openRouterId,
        reasoningMode,
        rateLimitGroup: alias.rateLimitGroup,
        provider,
      });
    }
  });

  if (evaluations.length === 0 && issues.length === 0) {
    issues.push({
      path: `sets.${source.setName}.models`,
      code: "empty_plan",
      message: `set "${source.setName}" expands to no evaluations`,
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    plan: {
      planVersion: PLAN_VERSION,
      setName: source.setName,
      promptVersion: source.promptVersion,
      scorerVersion: source.scorerVersion,
      dataset: {
        path: source.config.dataset.path,
        sha256: source.datasetSha256,
        fixtureCount: source.fixtureIds.length,
        fixtureIds: [...source.fixtureIds],
      },
      configSha256: source.configSha256 ?? null,
      evaluations,
    },
  };
}
