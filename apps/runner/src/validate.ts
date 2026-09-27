/**
 * `mmstar validate`: read-only preflight of configuration, dataset, and set
 * expansion. It performs the same loading and plan building a run does, so a
 * successful validate is real evidence the run would start, then stops before
 * creating any run directory or making an inference request.
 *
 * `reasoningModes: "all"` cannot be expanded offline, so any selected set using
 * it forces the capability path even without `--preflight`: the catalog is
 * fetched, efforts are resolved, and the summary lists the concrete
 * `<alias>::<effort>` evaluations a run would execute. A missing credential is
 * an error there, never a silently unresolved plan. Sets without `all` keep the
 * offline behavior unless preflight was requested.
 */
import {
  type ModelCatalog,
  OPENROUTER_API_KEY_ENV,
  OpenRouterClient,
  PROMPT_VERSION,
  preflightPlan,
  readOpenRouterApiKey,
} from "@mmstar/benchmark";
import { expandPlan, REASONING_ALL, ValidationError, type ValidationIssue } from "@mmstar/config";
import type { CommandResult, RunContext } from "./execute";
import {
  aliasesForSets,
  loadConfig,
  loadDataset,
  resolveAllEffortsForAliases,
  resolvePath,
} from "./execute";
import { fetchTransport } from "./transport";

const SCORER_VERSION = 1;

export interface ValidateOptions {
  set?: string | undefined;
  /** When true, also fetch model metadata and run the capability check. */
  preflight: boolean;
}

export async function executeValidate(
  context: RunContext,
  options: ValidateOptions,
): Promise<CommandResult> {
  try {
    const config = loadConfig(context);
    const dataset = await loadDataset(resolvePath(context.cwd, config.dataset.path));

    const sets = options.set === undefined ? Object.keys(config.sets) : [options.set];
    const usesAll = sets.some((setName) =>
      (config.sets[setName]?.models ?? []).some(
        (aliasName) => config.models[aliasName]?.reasoningModes === REASONING_ALL,
      ),
    );

    // A set using `all` needs the catalog regardless of the flag; a missing key
    // is reported instead of returning an unresolved plan.
    const catalog = await loadValidationCatalog(context, options.preflight, usesAll);
    const resolvedEfforts = resolveAllEffortsForAliases(
      config,
      aliasesForSets(config, sets),
      catalog,
    );

    const plans = sets.map((setName) => {
      const result = expandPlan({
        config,
        setName,
        fixtureIds: dataset.fixtureIds,
        datasetSha256: dataset.sha256,
        configSha256: null,
        promptVersion: PROMPT_VERSION,
        scorerVersion: SCORER_VERSION,
        ...(resolvedEfforts.size === 0 ? {} : { resolvedEfforts }),
      });
      if (!result.ok) throw new ValidationError(`set ${setName}`, result.issues);
      return result.plan;
    });

    const summary: Record<string, unknown> = {
      event: "validate.ok",
      config: context.configPath,
      dataset: {
        path: config.dataset.path,
        sha256: dataset.sha256,
        fixtures: dataset.records.length,
      },
      sets: plans.map((plan) => ({
        name: plan.setName,
        evaluations: plan.evaluations.length,
        fixtures: plan.dataset.fixtureIds.length,
        models: plan.evaluations.map((evaluation) => evaluation.evaluationId),
      })),
    };

    if (catalog !== null) {
      const preflights = plans.map((plan) => {
        const result = preflightPlan(plan, catalog);
        if (!result.ok) throw new ValidationError("capability preflight", result.issues);
        return result.preflight;
      });
      summary.preflight = {
        status: "ok",
        models: preflights[0]?.evaluations.length ?? 0,
        ...(usesAll
          ? {
              resolved: plans.map((plan) => ({
                name: plan.setName,
                evaluations: plan.evaluations.map((evaluation) => evaluation.evaluationId),
              })),
            }
          : {}),
      };
    } else if (options.preflight) {
      summary.preflight = {
        status: "skipped",
        reason: "OPENROUTER_API_KEY is not set; capability preflight needs live metadata",
      };
      context.stderr.write(
        "mmstar: warning: OPENROUTER_API_KEY is not set; capability preflight was skipped\n",
      );
    }

    context.emit(summary);
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof ValidationError) {
      context.emit({ event: "error", kind: error.name, message: error.message });
      context.stderr.write(`mmstar: ${error.message}\n`);
      return { exitCode: 2 };
    }
    const message = error instanceof Error ? error.message : String(error);
    context.emit({ event: "error", kind: "internal", message });
    context.stderr.write(`mmstar: ${message}\n`);
    return { exitCode: 1 };
  }
}

/**
 * Fetch the capability catalog when validation needs it. Returns null when the
 * request was optional (`--preflight` without credentials) and preflight can be
 * skipped under the existing behavior.
 */
async function loadValidationCatalog(
  context: RunContext,
  preflightRequested: boolean,
  usesAll: boolean,
): Promise<ModelCatalog | null> {
  if (!preflightRequested && !usesAll) return null;
  if (context.apiKey === null) {
    if (usesAll) {
      throw new ValidationError("capability preflight", [
        {
          path: "",
          code: "configuration",
          message: `${OPENROUTER_API_KEY_ENV} is not set; export it in the runner environment before making requests (a set using reasoningModes "all" needs live capability metadata, so validate cannot run offline)`,
        },
      ]);
    }
    return null;
  }

  const client = new OpenRouterClient({ transport: fetchTransport, apiKey: context.apiKey });
  const catalog = await client.fetchModelCatalog();
  if (!catalog.ok) {
    throw new ValidationError("capability preflight", [
      {
        path: "",
        code: catalog.failure.category,
        message: catalog.failure.message,
      },
    ]);
  }
  return catalog.value;
}

/** Read the provider credential from the environment; never from config. */
export function environmentApiKey(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  return readOpenRouterApiKey(env);
}

/** Validation issues from a failed expand are already actionable; keep the type local. */
export type { ValidationIssue };
