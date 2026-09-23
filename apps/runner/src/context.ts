/**
 * Shared CLI/TUI context construction.
 *
 * Both entry points build the same `RunContext` from the environment; only the
 * output sinks differ (NDJSON vs. renderer state), so the runner commands behave
 * identically in plain and interactive modes.
 */
import { type EngineEventSink, readOpenRouterApiKey } from "@mmstar/benchmark";
import type { RunContext } from "./execute";

export interface RunContextOptions {
  emit: (payload: Record<string, unknown>) => void;
  stderr: { write: (text: string) => void };
  engineEvents?: EngineEventSink | undefined;
}

export function buildRunContext(options: RunContextOptions): RunContext {
  return {
    resultsRoot: process.env.MMSTAR_RESULTS_ROOT ?? "results",
    cwd: process.cwd(),
    configPath: process.env.MMSTAR_CONFIG ?? "mmstar.config.json",
    apiKey: readOpenRouterApiKey(process.env),
    skipPreflight: false,
    force: false,
    stderr: options.stderr,
    emit: options.emit,
    ...(options.engineEvents === undefined ? {} : { engineEvents: options.engineEvents }),
  };
}
