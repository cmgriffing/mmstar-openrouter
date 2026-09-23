/**
 * `mmstar validate`: read-only preflight of configuration, dataset, and set
 * expansion. It performs the same loading and plan building a run does, so a
 * successful validate is real evidence the run would start, then stops before
 * creating any run directory or making an inference request.
 */
import { PROMPT_VERSION, preflightPlan, readOpenRouterApiKey } from "@mmstar/benchmark";
import { expandPlan, ValidationError, type ValidationIssue } from "@mmstar/config";
import type { CommandResult, RunContext } from "./execute";
import { loadConfig, loadDataset, resolvePath } from "./execute";
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
    const plans = sets.map((setName) => {
      const result = expandPlan({
        config,
        setName,
        fixtureIds: dataset.fixtureIds,
        datasetSha256: dataset.sha256,
        configSha256: null,
        promptVersion: PROMPT_VERSION,
        scorerVersion: SCORER_VERSION,
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

    if (options.preflight) {
      const apiKey = context.apiKey;
      if (apiKey === null) {
        summary.preflight = {
          status: "skipped",
          reason: "OPENROUTER_API_KEY is not set; capability preflight needs live metadata",
        };
        context.stderr.write(
          "mmstar: warning: OPENROUTER_API_KEY is not set; capability preflight was skipped\n",
        );
      } else {
        const { OpenRouterClient } = await import("@mmstar/benchmark");
        const client = new OpenRouterClient({ transport: fetchTransport, apiKey });
        for (const plan of plans) {
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
          const preflight = preflightPlan(plan, catalog.value);
          if (!preflight.ok) throw new ValidationError("capability preflight", preflight.issues);
        }
        summary.preflight = { status: "ok", models: plans[0]?.evaluations.length ?? 0 };
      }
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

/** Read the provider credential from the environment; never from config. */
export function environmentApiKey(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  return readOpenRouterApiKey(env);
}

/** Validation issues from a failed expand are already actionable; keep the type local. */
export type { ValidationIssue };
