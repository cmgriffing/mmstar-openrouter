/**
 * Headless (non-TTY) entry-point checks.
 *
 * These spawn the real `src/index.tsx` with piped stdout, which is exactly the
 * redirected-execution path: the entry point must not start a terminal
 * renderer, must emit machine-readable events, and must not leak ANSI control
 * sequences into redirected output.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RUNNER_DIR = fileURLToPath(new URL("../", import.meta.url));
const ANSI_ESCAPE = `${String.fromCharCode(27)}[`;

function hasAnsi(text: string): boolean {
  return text.includes(ANSI_ESCAPE);
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", ["run", "src/index.tsx", ...args], {
    cwd: RUNNER_DIR,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ndjson(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("non-TTY entry point", () => {
  it("runs the demo headlessly with NDJSON events and no terminal sequences", () => {
    const result = run(["--demo", "--plain"]);

    expect(result.status).toBe(0);
    expect(hasAnsi(result.stdout)).toBe(false);
    expect(result.stderr).toContain("mmstar: run demo-run-0001 completed");

    const events = ndjson(result.stdout);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ event: "engine", runId: "demo-run-0001" });
    expect(
      events.some((event) => event.type === "run.finished" && event.state === "completed"),
    ).toBe(true);
  });

  it("reports a validation failure as machine-readable output with the documented exit code", () => {
    const result = run(["validate", "--config", "/tmp/definitely-missing-mmstar.json", "--plain"]);

    expect(result.status).toBe(2);
    expect(hasAnsi(result.stdout)).toBe(false);
    const events = ndjson(result.stdout);
    expect(events.some((event) => event.event === "error")).toBe(true);
    expect(result.stderr).toContain("mmstar:");
  });

  it("routes redirected real commands through the plain CLI without a renderer", () => {
    const result = run(["benchmark", "--set", "smoke", "--config", "/tmp/does-not-exist.json"]);

    expect(result.status).toBe(2);
    expect(hasAnsi(result.stdout)).toBe(false);
    expect(result.stdout).not.toContain("MMStar runner");
    expect(ndjson(result.stdout).some((event) => event.event === "error")).toBe(true);
  });
});
