import type { APIRoute } from "astro";
import { failure, ok } from "../../server/http";
import { getPublicationRepository, resolveRootRunId } from "../../server/publication";

export const prerender = false;

/** Deployment smoke endpoint: reader versions, family root, and run count. */
export const GET: APIRoute = async (context) => {
  try {
    const repository = await getPublicationRepository(context);
    const runs = repository.listRuns();
    return ok({
      ready: true,
      meta: repository.meta(),
      runCount: runs.length,
      rootRunId: resolveRootRunId(repository),
    });
  } catch (error) {
    return failure(error);
  }
};
