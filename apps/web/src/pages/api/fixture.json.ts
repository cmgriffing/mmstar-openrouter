import type { APIRoute } from "astro";
import { failure, json, ok, requiredParam, textParam } from "../../server/http";
import { getPublicationRepository, resolveRootRunId } from "../../server/publication";

export const prerender = false;

/** One fixture's effective outcome, family outcome lines, and attempt ledger. */
export const GET: APIRoute = async (context) => {
  try {
    const url = new URL(context.request.url);
    const repository = await getPublicationRepository(context);
    const rootRunId = resolveRootRunId(repository, textParam(url, "rootRunId"));
    const evaluationId = requiredParam(url, "evaluationId");
    const fixtureId = requiredParam(url, "fixtureId");
    const fixture = repository.getFixtureDetail({ rootRunId, evaluationId, fixtureId });
    if (fixture === null) {
      return json({ error: { code: "not_found", message: `no fixture ${fixtureId}` } }, 404);
    }
    return ok({ rootRunId, fixture });
  } catch (error) {
    return failure(error);
  }
};
