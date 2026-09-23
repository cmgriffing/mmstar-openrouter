#!/usr/bin/env bun
import { formatUsage, parseCommand } from "./commands";

const result = parseCommand(process.argv.slice(2));

if (result.kind === "help") {
  console.log(formatUsage());
  process.exit(0);
}

if (result.kind === "error") {
  console.error(`mmstar: ${result.message}`);
  console.error(formatUsage());
  process.exit(2);
}

const { command, args } = result.parsed;

// Scaffold only: chunk 5 wires validate/run and chunks 5, 8 handle recovery
// and export. Emitting one JSON line now keeps the plain-mode contract honest.
console.log(
  JSON.stringify({
    event: "scaffold",
    command,
    args,
    message: `command "${command}" is scaffolded but not implemented yet`,
  }),
);
