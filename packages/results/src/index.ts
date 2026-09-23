/**
 * @mmstar/results — runtime-neutral run records and publication contracts.
 *
 * Versioned run/evaluation/outcome/attempt schemas land in chunk 2; durable
 * persistence, recovery selection, SQLite export, and the read-only query
 * interface land in chunks 5 and 8–9. Runtime-specific adapters (filesystem,
 * SQLite bindings) are added as explicit subpath modules so they never leak
 * into the website bundle through this entry point.
 */
export const RESULTS_PACKAGE = "@mmstar/results" as const;
