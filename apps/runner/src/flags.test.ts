/**
 * Flag parsing is the runner's narrowest external contract: a silently ignored
 * option (or a rejected valid one) makes every command unreliable, so the parser
 * gets its own tests rather than only being exercised through command tests.
 */
import { describe, expect, it } from "vitest";
import { describeFlags, flagsForCommand, parseFlags, RUN_FLAGS, SELECTOR_FLAGS } from "./flags";

describe("parseFlags", () => {
  it("accepts long, short, and inline value forms", () => {
    const long = parseFlags(["--set", "smoke"], RUN_FLAGS);
    const inline = parseFlags(["--set=smoke"], RUN_FLAGS);
    const short = parseFlags(["-s", "smoke"], RUN_FLAGS);

    expect(long.ok && long.flags.values.get("set")).toBe("smoke");
    expect(inline.ok && inline.flags.values.get("set")).toBe("smoke");
    expect(short.ok && short.flags.values.get("set")).toBe("smoke");
  });

  it("collects booleans without consuming the next argument", () => {
    const result = parseFlags(["--latest", "--force"], SELECTOR_FLAGS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.flags.booleans].sort()).toEqual(["force", "latest"]);
    expect(result.flags.positionals).toEqual([]);
  });

  it("keeps positionals separate from flags", () => {
    const result = parseFlags(["2026-09-23T00-00-00-000Z_abcdef01", "--force"], SELECTOR_FLAGS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.positionals).toEqual(["2026-09-23T00-00-00-000Z_abcdef01"]);
  });

  it("stops flag parsing at --", () => {
    const result = parseFlags(["--", "--set"], RUN_FLAGS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.positionals).toEqual(["--set"]);
  });

  it("rejects unknown options, values on booleans, and missing values", () => {
    expect(parseFlags(["--frob"], RUN_FLAGS)).toEqual({
      ok: false,
      message: 'unknown option "frob"',
    });
    expect(parseFlags(["--latest=yes"], SELECTOR_FLAGS)).toEqual({
      ok: false,
      message: 'option "latest" does not take a value',
    });
    expect(parseFlags(["--set"], RUN_FLAGS)).toEqual({
      ok: false,
      message: 'option "set" requires a value',
    });
  });
});

describe("command flag surfaces", () => {
  it("gives validate a set selector and the config path", () => {
    const names = flagsForCommand("validate").map((flag) => flag.name);
    expect(names).toContain("set");
    expect(names).toContain("config");
  });

  it("gives selector commands both selectors and force, and restart no set flag", () => {
    for (const command of ["resume", "retry-failed", "restart"] as const) {
      const names = flagsForCommand(command).map((flag) => flag.name);
      expect(names).toContain("latest");
      expect(names).toContain("force");
    }
    expect(flagsForCommand("restart").map((flag) => flag.name)).not.toContain("set");
  });

  it("documents every flag it accepts with correct short aliases", () => {
    const described = describeFlags(flagsForCommand("benchmark"));
    expect(described.join("\n")).toContain("--set <value>");
    expect(described.join("\n")).toContain("--skip-preflight");
    expect(described.join("\n")).toContain("-s <value>");
    expect(described.join("\n")).not.toContain("---");

    const exported = describeFlags(flagsForCommand("export"));
    expect(exported.join("\n")).toContain("--run <value>, -r <value>");
    expect(exported.join("\n")).toContain("--out <value>, -o <value>");
  });
});
