import type { APIRoute } from "astro";
import { failure, numberParam, ok, textParam } from "../../server/http";
import { getPublicationRepository, resolveRootRunId } from "../../server/publication";

export const prerender = false;

/** Paginated fixture drilldown list (response text is reserved for detail). */
export const GET: APIRoute = async (context) => {
  try {
    const url = new URL(context.request.url);
    const repository = await getPublicationRepository(context);
    const rootRunId = resolveRootRunId(repository, textParam(url, "rootRunId"));
    const query = {
      rootRunId,
      evaluationId: textParam(url, "evaluationId"),
      category: textParam(url, "category"),
      state: textParam(url, "state"),
      kind: textParam(url, "kind"),
      limit: numberParam(url, "limit"),
      offset: numberParam(url, "offset"),
    };
    const page = repository.listFixtures(query as Parameters<typeof repository.listFixtures>[0]);
    return ok(page, { rootRunId });
  } catch (error) {
    return failure(error);
  }
};
