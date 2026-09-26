/**
 * Runner command surface, kept free of process/terminal side effects so it can
 * be unit tested. The accepted command names are stable; each command owns its
 * flag set here so usage text and parsing cannot drift.
 */
import { describeFlags, flagsForCommand } from "./flags";

export const RUNNER_COMMANDS = [
  "validate",
  "benchmark",
  "resume",
  "retry-failed",
  "restart",
  "export",
] as const;

export type RunnerCommand = (typeof RUNNER_COMMANDS)[number];

export interface ParsedCommand {
  readonly command: RunnerCommand;
  readonly args: readonly string[];
}

export type ParseResult =
  | { readonly kind: "command"; readonly parsed: ParsedCommand }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

export function parseCommand(argv: readonly string[]): ParseResult {
  const [first, ...rest] = argv;

  if (first === undefined || first === "--help" || first === "-h") {
    return { kind: "help" };
  }

  const command = RUNNER_COMMANDS.find((candidate) => candidate === first);
  if (command === undefined) {
    return { kind: "error", message: `unknown command "${first}"` };
  }

  return { kind: "command", parsed: { command, args: rest } };
}

export function formatUsage(): string {
  return [
    "Usage: mmstar <command> [options]",
    "",
    "Commands:",
    ...RUNNER_COMMANDS.map((command) => `  ${command}`),
    "",
    "Exit codes:",
    "  0  success",
    "  1  runtime failure (invalid run, provider halt, incomplete work)",
    "  2  usage or validation error",
    "  130 interrupted (SIGINT)",
    "",
    'Run "mmstar <command> --help" for command-specific options.',
  ].join("\n");
}

export function formatCommandUsage(command: RunnerCommand): string {
  const summary: Record<RunnerCommand, string> = {
    validate: "Validate configuration, dataset, and set expansion without making requests.",
    benchmark: "Execute a named model set and produce a durable run under the results root.",
    resume: "Continue a run's pending/cancelled/interrupted work with frozen settings.",
    "retry-failed": "Create a recovery run for unresolved request failures.",
    restart: "Create a new primary run with the original fixtures and settings.",
    export:
      "Export every run, or a selected run family, into a validated SQLite publication with content-addressed images.",
  };
  return [
    `Usage: mmstar ${command} [options]`,
    "",
    summary[command],
    "",
    "Options:",
    ...describeFlags(flagsForCommand(command)),
    "",
    "Run IDs are the directory names under the results root; use --latest to select",
    "the newest primary run. Export writes publication/, which stays Git-ignored.",
  ].join("\n");
}
