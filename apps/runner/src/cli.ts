#!/usr/bin/env bun
/**
 * CLI entry point. Everything testable lives in `commands`, `flags`, `execute`,
 * and `validate`; this file only wires process streams, signals, and exit codes.
 *
 * `runCli` is exported so the interactive entry point can hand non-TTY or
 * `--plain` invocations to the exact same implementation: same engine, same
 * NDJSON events, same exit codes, no terminal renderer.
 */
import { formatCommandUsage, formatUsage, parseCommand } from "./commands";
import { buildRunContext } from "./context";
import { execute, type RunContext, requestFromArgs } from "./execute";
import { executeExport, exportOptionsFromArgs } from "./export";
import { flagsForCommand, parseFlags } from "./flags";
import { executeValidate } from "./validate";

export interface CliStreams {
  stdout: { write: (text: string) => void };
  stderr: { write: (text: string) => void };
}

/** Run one plain (NDJSON) command and return its exit code. */
export async function runCli(
  argv: readonly string[],
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const out = (line: string): void => {
    streams.stdout.write(`${line}\n`);
  };
  const err = (line: string): void => {
    streams.stderr.write(`${line}\n`);
  };

  const parsed = parseCommand(argv);

  if (parsed.kind === "help") {
    out(formatUsage());
    return 0;
  }

  if (parsed.kind === "error") {
    err(`mmstar: ${parsed.message}`);
    err(formatUsage());
    return 2;
  }

  const { command, args } = parsed.parsed;

  // `--help` is handled before any file is read so command help never depends
  // on a valid config or run directory.
  const helpCheck = parseFlags(args, flagsForCommand(command));
  if (helpCheck.ok && helpCheck.flags.booleans.has("help")) {
    out(formatCommandUsage(command));
    return 0;
  }

  const emit = (payload: Record<string, unknown>): void => {
    streams.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const baseContext = (): RunContext => buildRunContext({ emit, stderr: streams.stderr });

  if (command === "validate") {
    if (!helpCheck.ok) {
      err(`mmstar: ${helpCheck.message}`);
      return 2;
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
    return result.exitCode;
  }

  if (command === "export") {
    if (!helpCheck.ok) {
      err(`mmstar: ${helpCheck.message}`);
      return 2;
    }
    const parsedExport = exportOptionsFromArgs(args);
    if (!parsedExport.ok) {
      err(`mmstar: ${parsedExport.message}`);
      err(formatCommandUsage(command));
      return 2;
    }
    return (await executeExport(baseContext(), parsedExport.options)).exitCode;
  }

  const request = requestFromArgs(command, args);
  if (!request.ok) {
    err(`mmstar: ${request.message}`);
    err(formatCommandUsage(command));
    return 2;
  }

  const context: RunContext = { ...baseContext(), ...request.context };
  const result = await execute(request.request, context);
  return result.exitCode;
}

if (import.meta.main) {
  process.exit(await runCli(process.argv.slice(2)));
}
