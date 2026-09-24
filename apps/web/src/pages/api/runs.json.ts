import type { APIRoute } from "astro";
import { failure, ok } from "../../server/http";
import { getPublicationRepository } from "../../server/publication";

export const prerender = false;

/** All runs in the publication, newest first, with family roles. */
export const GET: APIRoute = async (context) => {
  try {
    const repository = await getPublicationRepository(context);
    return ok({ runs: repository.listRuns() });
  } catch (error) {
    return failure(error);
  }
};
