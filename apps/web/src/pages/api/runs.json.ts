import type { APIRoute } from "astro";
import { failure, ok } from "../../server/http";
import { getPublicationRepository } from "../../server/publication";

export const prerender = false;

/** Every run, newest first, with family roles and per-run attempt ledger totals. */
export const GET: APIRoute = async (context) => {
  try {
    const repository = await getPublicationRepository(context);
    return ok({
      runs: repository.listRuns(),
      attemptTotals: repository.listRunAttemptTotals(),
    });
  } catch (error) {
    return failure(error);
  }
};
