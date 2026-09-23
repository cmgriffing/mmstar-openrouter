/**
 * Runner flag parsing.
 *
 * Pure and side-effect free so every command's option handling is unit-testable
 * without a terminal or a filesystem. Unknown flags are rejected rather than
 * ignored: a silently ignored `--set` on `resume` would run the wrong
 * experiment, so the parser is deliberately strict.
 */
import type { RunnerCommand } from "./commands";

export interface FlagSpec {
  name: string;
  /** Aliases accepted for the same flag (for example `-s` for `--set`). */
  aliases?: readonly string[];
  /** `value` consumes the next argument; `boolean` takes none. */
  kind: "value" | "boolean";
  description: string;
}

export interface ParsedFlags {
  values: ReadonlyMap<string, string>;
  booleans: ReadonlySet<string>;
  positionals: readonly string[];
}

export type FlagParseResult = { ok: true; flags: ParsedFlags } | { ok: false; message: string };

export const COMMON_FLAGS: readonly FlagSpec[] = [
  { name: "config", aliases: ["-c"], kind: "value", description: "config file path" },
  { name: "help", aliases: ["-h"], kind: "boolean", description: "show command help" },
];

export const VALIDATE_FLAGS: readonly FlagSpec[] = [
  ...COMMON_FLAGS,
  {
    name: "set",
    aliases: ["-s"],
    kind: "value",
    description: "validate one named set instead of every set",
  },
];

export const RUN_FLAGS: readonly FlagSpec[] = [
  ...COMMON_FLAGS,
  { name: "set", aliases: ["-s"], kind: "value", description: "named model set to execute" },
  {
    name: "skip-preflight",
    kind: "boolean",
    description: "skip the live capability check (development only; frozen support is assumed)",
  },
];

export const SELECTOR_FLAGS: readonly FlagSpec[] = [
  ...COMMON_FLAGS,
  {
    name: "latest",
    kind: "boolean",
    description: "use the newest primary run in the results root",
  },
  {
    name: "force",
    kind: "boolean",
    description: "reclaim a lock whose holder cannot be proven dead",
  },
];

export function flagsForCommand(command: RunnerCommand): readonly FlagSpec[] {
  switch (command) {
    case "validate":
      return VALIDATE_FLAGS;
    case "benchmark":
      return RUN_FLAGS;
    case "restart":
      return [...COMMON_FLAGS, ...SELECTOR_FLAGS.filter((flag) => flag.name !== "config")];
    case "resume":
    case "retry-failed":
      return SELECTOR_FLAGS;
    case "export":
      return COMMON_FLAGS;
  }
}

export function parseFlags(argv: readonly string[], specs: readonly FlagSpec[]): FlagParseResult {
  const byName = new Map<string, FlagSpec>();
  for (const spec of specs) {
    byName.set(bareName(spec.name), spec);
    for (const alias of spec.aliases ?? []) byName.set(bareName(alias), spec);
  }

  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("-") && token !== "-") {
      const [rawName, inlineValue] = splitFlag(token);
      const spec = byName.get(rawName);
      if (spec === undefined) {
        return { ok: false, message: `unknown option "${rawName}"` };
      }
      if (spec.kind === "boolean") {
        if (inlineValue !== undefined) {
          return { ok: false, message: `option "${rawName}" does not take a value` };
        }
        booleans.add(spec.name);
        continue;
      }
      if (inlineValue !== undefined) {
        values.set(spec.name, inlineValue);
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined) {
        return { ok: false, message: `option "${rawName}" requires a value` };
      }
      values.set(spec.name, next);
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { ok: true, flags: { values, booleans, positionals } };
}

function splitFlag(token: string): [string, string | undefined] {
  const equals = token.indexOf("=");
  const nameAndDashes = equals === -1 ? token : token.slice(0, equals);
  if (equals === -1) return [bareName(nameAndDashes), undefined];
  return [bareName(nameAndDashes), token.slice(equals + 1)];
}

/**
 * Specs are keyed by bare name, so `--set`, `-s`, and `--set=x` all resolve to
 * the same spec. Both registration and lookup strip leading dashes; without
 * that every option reads as unknown, which is exactly the kind of silent CLI
 * breakage this parser exists to prevent.
 */
function bareName(value: string): string {
  return value.replace(/^-+/, "");
}

export function describeFlags(specs: readonly FlagSpec[]): string[] {
  return specs
    .filter((spec) => spec.name !== "help")
    .map((spec) => {
      const names = [spec.name, ...(spec.aliases ?? [])].filter((name) => name.length > 1);
      const rendered = names
        .map((name) => (spec.kind === "value" ? `--${name} <value>` : `--${name}`))
        .join(", ");
      return `  ${rendered.padEnd(30)}${spec.description}`;
    });
}
