import type { APIRoute } from "astro";
import { failure, ok, textParam } from "../../server/http";
import { getPublicationRepository } from "../../server/publication";

export const prerender = false;

/** Publication-wide category accuracy, optionally narrowed to one evaluation. */
export const GET: APIRoute = async (context) => {
  try {
    const url = new URL(context.request.url);
    const repository = await getPublicationRepository(context);
    const evaluationId = textParam(url, "evaluationId");
    return ok({
      categories: repository.listCategories(evaluationId === undefined ? {} : { evaluationId }),
    });
  } catch (error) {
    return failure(error);
  }
};
