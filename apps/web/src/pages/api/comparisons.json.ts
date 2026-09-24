import type { APIRoute } from "astro";
import { failure, ok, textParam } from "../../server/http";
import { getPublicationRepository, resolveRootRunId } from "../../server/publication";

export const prerender = false;

/** Model/effort comparisons for one family (defaults to the newest root run). */
export const GET: APIRoute = async (context) => {
  try {
    const url = new URL(context.request.url);
    const repository = await getPublicationRepository(context);
    const rootRunId = resolveRootRunId(repository, textParam(url, "rootRunId"));
    return ok({ rootRunId, comparisons: repository.listComparisons(rootRunId) });
  } catch (error) {
    return failure(error);
  }
};
