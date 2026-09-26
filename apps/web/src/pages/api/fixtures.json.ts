import type { APIRoute } from "astro";
import { failure, numberParam, ok, textParam } from "../../server/http";
import { getPublicationRepository } from "../../server/publication";

export const prerender = false;

/** Paginated publication-wide fixture drilldown (response text is detail-only). */
export const GET: APIRoute = async (context) => {
  try {
    const url = new URL(context.request.url);
    const repository = await getPublicationRepository(context);
    const query = {
      evaluationId: textParam(url, "evaluationId"),
      category: textParam(url, "category"),
      state: textParam(url, "state"),
      kind: textParam(url, "kind"),
      limit: numberParam(url, "limit"),
      offset: numberParam(url, "offset"),
    };
    return ok(repository.listFixtures(query as Parameters<typeof repository.listFixtures>[0]));
  } catch (error) {
    return failure(error);
  }
};
