/**
 * @mmstar/benchmark — runtime-neutral benchmark contracts.
 *
 * Dataset loading, prompt/scorer versions, provider request/response contracts,
 * scheduling, and metrics land in chunks 2–4. This package owns pure logic and
 * typed contracts; transport and filesystem adapters stay in the runner app.
 */
export const BENCHMARK_PACKAGE = "@mmstar/benchmark" as const;
