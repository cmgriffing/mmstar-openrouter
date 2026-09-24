/**
 * Shared JSON response helpers for the read-only query endpoints.
 *
 * Every failure maps to a stable machine-readable code: request validation is
 * `400`, a missing publication is `503`, and anything unexpected is `500`
 * without leaking internals.
 */
import { PublicationError, QueryValidationError } from "@mmstar/results";
import { PublicationUnavailableError } from "./publication";

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function ok(data: unknown, extra: Record<string, unknown> = {}): Response {
  return json({ data, ...extra }, 200);
}

export function failure(error: unknown): Response {
  if (error instanceof QueryValidationError) {
    return json({ error: { code: error.code, field: error.field, message: error.message } }, 400);
  }
  if (error instanceof PublicationUnavailableError) {
    return json({ error: { code: "publication_unavailable", message: error.message } }, 503);
  }
  if (error instanceof PublicationError) {
    return json({ error: { code: error.code, message: error.message } }, 400);
  }
  console.error("[api] unexpected error", error);
  return json({ error: { code: "internal_error", message: "unexpected server error" } }, 500);
}

export function textParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value.length === 0 ? undefined : value;
}

export function numberParam(url: URL, name: string): number | undefined {
  const value = textParam(url, name);
  if (value === undefined) return undefined;
  return Number(value);
}

export function requiredParam(url: URL, name: string): string {
  const value = textParam(url, name);
  if (value === undefined) {
    throw new QueryValidationError(name, "is required");
  }
  return value;
}
