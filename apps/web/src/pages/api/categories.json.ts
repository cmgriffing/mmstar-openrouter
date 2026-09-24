import type { APIRoute } from "astro";
import { failure, ok, textParam } from "../../server/http";
import { getPublicationRepository, resolveRootRunId } from "../../server/publication";

export const prerender = false;

/** Category accuracy per evaluation, optionally narrowed to one evaluation. */
export const GET: APIRoute = async (context) => {
  try {
    const url = new URL(context.request.url);
    const repository = await getPublicationRepository(context);
    const rootRunId = resolveRootRunId(repository, textParam(url, "rootRunId"));
    const evaluationId = textParam(url, "evaluationId");
    return ok({
      rootRunId,
      categories: repository.listCategories(
        evaluationId === undefined ? { rootRunId } : { rootRunId, evaluationId },
      ),
    });
  } catch (error) {
    return failure(error);
  }
};
