import { describe, expect, it } from "vitest";
import { formatUsage, parseCommand, RUNNER_COMMANDS } from "./commands";

describe("parseCommand", () => {
  it("accepts every scaffolded command", () => {
    for (const command of RUNNER_COMMANDS) {
      const result = parseCommand([command]);
      expect(result.kind).toBe("command");
      if (result.kind === "command") {
        expect(result.parsed.command).toBe(command);
        expect(result.parsed.args).toEqual([]);
      }
    }
  });

  it("passes through command arguments", () => {
    const result = parseCommand(["resume", "--latest"]);
    expect(result).toEqual({
      kind: "command",
      parsed: { command: "resume", args: ["--latest"] },
    });
  });

  it("returns help for no arguments or help flags", () => {
    expect(parseCommand([]).kind).toBe("help");
    expect(parseCommand(["--help"]).kind).toBe("help");
    expect(parseCommand(["-h"]).kind).toBe("help");
  });

  it("rejects unknown commands with the offending value", () => {
    const result = parseCommand(["frobnicate"]);
    expect(result).toEqual({ kind: "error", message: 'unknown command "frobnicate"' });
  });
});

describe("formatUsage", () => {
  it("lists every command", () => {
    const usage = formatUsage();
    for (const command of RUNNER_COMMANDS) {
      expect(usage).toContain(command);
    }
  });
});
