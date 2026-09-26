import type { APIRoute } from "astro";
import { failure, json, ok, requiredParam } from "../../server/http";
import { getPublicationRepository } from "../../server/publication";

export const prerender = false;

/** One fixture's effective outcome, winning-family lineage, and attempt ledger. */
export const GET: APIRoute = async (context) => {
  try {
    const url = new URL(context.request.url);
    const repository = await getPublicationRepository(context);
    const evaluationId = requiredParam(url, "evaluationId");
    const fixtureId = requiredParam(url, "fixtureId");
    const fixture = repository.getFixtureDetail({ evaluationId, fixtureId });
    if (fixture === null) {
      return json({ error: { code: "not_found", message: `no fixture ${fixtureId}` } }, 404);
    }
    return ok({ fixture });
  } catch (error) {
    return failure(error);
  }
};
