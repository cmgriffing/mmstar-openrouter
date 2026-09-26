import type { APIRoute } from "astro";
import { failure, ok } from "../../server/http";
import { getPublicationRepository } from "../../server/publication";

export const prerender = false;

/** Deployment smoke endpoint: reader versions, run/evaluation counts, winners. */
export const GET: APIRoute = async (context) => {
  try {
    const repository = await getPublicationRepository(context);
    const runs = repository.listRuns();
    // Winners come from the ranking view (one row per evaluation); this stays a
    // cheap smoke check instead of materializing the full comparison summary.
    const winners = repository.listEvaluationWinners();
    return ok({
      ready: true,
      meta: repository.meta(),
      runCount: runs.length,
      evaluationCount: winners.length,
      winningRootRunIds: [...new Set(winners.map((row) => row.rootRunId))].sort(),
    });
  } catch (error) {
    return failure(error);
  }
};
