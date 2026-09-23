#!/usr/bin/env bun
/**
 * CLI entry point. Everything testable lives in `commands`, `flags`, `execute`,
 * and `validate`; this file only wires process streams, signals, and exit codes.
 */
import { readOpenRouterApiKey } from "@mmstar/benchmark";
import { formatCommandUsage, formatUsage, parseCommand } from "./commands";
import { execute, type RunContext, requestFromArgs } from "./execute";
import { flagsForCommand, parseFlags } from "./flags";
import { executeValidate } from "./validate";

const argv = process.argv.slice(2);
const parsed = parseCommand(argv);

if (parsed.kind === "help") {
  console.log(formatUsage());
  process.exit(0);
}

if (parsed.kind === "error") {
  console.error(`mmstar: ${parsed.message}`);
  console.error(formatUsage());
  process.exit(2);
}

const { command, args } = parsed.parsed;

// `--help` is handled before any file is read so command help never depends on
// a valid config or run directory.
const helpCheck = parseFlags(args, flagsForCommand(command));
if (helpCheck.ok && helpCheck.flags.booleans.has("help")) {
  console.log(formatCommandUsage(command));
  process.exit(0);
}

const emit = (payload: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const resultsRoot = process.env.MMSTAR_RESULTS_ROOT ?? "results";

const baseContext = (): RunContext => ({
  resultsRoot,
  cwd: process.cwd(),
  configPath: process.env.MMSTAR_CONFIG ?? "mmstar.config.json",
  apiKey: readOpenRouterApiKey(process.env),
  skipPreflight: false,
  force: false,
  stderr: process.stderr,
  emit,
});

if (command === "validate") {
  if (!helpCheck.ok) {
    console.error(`mmstar: ${helpCheck.message}`);
    process.exit(2);
  }
  // The validate command owns its own context (it has no RunRequest), so its
  // flags are applied here rather than through `requestFromArgs`.
  const set = helpCheck.flags.values.get("set") ?? helpCheck.flags.positionals[0];
  const configPath = helpCheck.flags.values.get("config");
  const context = baseContext();
  const result = await executeValidate(
    configPath === undefined ? context : { ...context, configPath },
    { set, preflight: true },
  );
  process.exit(result.exitCode);
}

if (command === "export") {
  console.error("mmstar: export is implemented in a later chunk");
  process.exit(2);
}

const request = requestFromArgs(command, args);
if (!request.ok) {
  console.error(`mmstar: ${request.message}`);
  console.error(formatCommandUsage(command));
  process.exit(2);
}

const context: RunContext = { ...baseContext(), ...request.context };
const result = await execute(request.request, context);
process.exit(result.exitCode);
