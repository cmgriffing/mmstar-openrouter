import type { APIRoute } from "astro";
import { failure, ok } from "../../server/http";
import { getPublicationRepository } from "../../server/publication";

export const prerender = false;

/** Publication-wide model/effort comparisons. Any `rootRunId` is ignored. */
export const GET: APIRoute = async (context) => {
  try {
    const repository = await getPublicationRepository(context);
    return ok({ comparisons: repository.listComparisons() });
  } catch (error) {
    return failure(error);
  }
};
