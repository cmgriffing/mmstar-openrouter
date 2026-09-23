/**
 * Runner command surface, kept free of process/terminal side effects so it can
 * be unit tested. Chunk 5 replaces the scaffold message with real command
 * wiring; the accepted command names are stable from here on.
 */
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
  ].join("\n");
}
