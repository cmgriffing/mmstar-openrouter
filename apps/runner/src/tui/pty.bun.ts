/**
 * Real-PTY behavior tests for the runner entry point.
 *
 * The OpenTUI frame tests (`render.bun.tsx`) drive the component tree with a
 * test renderer. These tests go one level lower: they spawn `src/index.tsx`
 * under a real Bun pseudo-terminal, send real keystrokes, and assert on the
 * process exit code plus the post-restore terminal output. That is the only way
 * to cover "q works before the engine exists", "quit cancels in-flight work and
 * restores the terminal", and "a settled run leaves no lingering process".
 *
 * Everything is deterministic: demo runs use the scripted mock provider (with a
 * `--latency` override for the slow-request case), and the pre-engine test
 * points the dataset at a FIFO so the load stays pending until quit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNNER_DIR = join(import.meta.dir, "..", "..");
/** Terminal restore must leave the alternate screen and re-show the cursor. */
const RESTORE_ALT_SCREEN = "\u001b[?1049l";
const RESTORE_CURSOR = "\u001b[?25h";

interface PtySession {
  write(text: string): void;
  output(): string;
  exited: Promise<number>;
  kill(): void;
  signal(signal?: NodeJS.Signals): void;
  waitFor(needle: string, timeoutMs?: number): Promise<void>;
}

const sessions: PtySession[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) {
    try {
      session.kill();
    } catch {
      // Already exited.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function startRunner(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): PtySession {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 30,
    data(_terminal: unknown, data: Uint8Array) {
      chunks.push(decoder.decode(data, { stream: true }));
    },
  });
  const proc = Bun.spawn(["bun", "run", join(RUNNER_DIR, "src/index.tsx"), ...args], {
    cwd: options.cwd ?? RUNNER_DIR,
    terminal,
    env: { ...process.env, ...options.env },
  });
  const session: PtySession = {
    write: (text) => {
      terminal.write(text);
    },
    output: () => chunks.join(""),
    exited: proc.exited.then((code) => {
      if (!terminal.closed) terminal.close();
      return code;
    }),
    kill: () => {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
      if (!terminal.closed) terminal.close();
    },
    signal: (signal = "SIGINT") => {
      process.kill(proc.pid, signal);
    },
    waitFor: async (needle, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (chunks.join("").includes(needle)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}; output so far:\n${chunks.join("")}`,
      );
    },
  };
  sessions.push(session);
  return session;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("runner entry point under a PTY", () => {
  test("a settled run exits on its own and restores the terminal", async () => {
    const session = startRunner(["--demo", "--smoke"]);
    const code = await session.exited;
    expect(code).toBe(0);

    const output = session.output();
    // The screen rendered, the run line was printed after restore, and the
    // terminal was handed back in a normal state.
    expect(output).toContain("MMStar runner");
    expect(output).toContain("mmstar: run demo-run-0001 completed");
    expect(output).toContain(RESTORE_ALT_SCREEN);
    expect(output).toContain(RESTORE_CURSOR);
  }, 30_000);

  test("q during a slow in-flight request cancels and restores the terminal", async () => {
    const session = startRunner(["--demo", "--hold", "--latency", "3000"]);
    await session.waitFor("MMStar runner");
    // The first frame paints before attempts start; give the in-flight
    // requests time to launch. With 3 s latency the request is still open when
    // the quit arrives.
    await Bun.sleep(500);
    // Frame evidence: both groups report an outstanding request.
    expect(session.output()).toContain("flight 1");

    session.write("q");
    const code = await session.exited;
    expect(code).toBe(130);

    const output = session.output();
    expect(output).toContain("mmstar: run demo-run-0001 stopped");
    expect(output).toContain(RESTORE_ALT_SCREEN);
    expect(output).toContain(RESTORE_CURSOR);
  }, 30_000);

  test("SIGINT during the post-finish hold restores the terminal and exits", async () => {
    const session = startRunner(["--demo", "--hold", "--latency", "1"]);
    // Wait for the header state token, which is emitted in one update when the
    // run settles; a fixed sleep raced the demo's scripted rate-limit cooldown
    // and retry backoff.
    await session.waitFor("COMPLETED");
    session.signal("SIGINT");

    const code = await session.exited;
    expect(code).toBe(0);
    const output = session.output();
    expect(output).toContain("mmstar: run demo-run-0001 completed");
    expect(output).toContain(RESTORE_ALT_SCREEN);
    expect(output).toContain(RESTORE_CURSOR);
  }, 30_000);

  test("q during pre-engine loading exits 130 without creating a run", async () => {
    const dir = tempDir("mmstar-pty-");
    const fifo = join(dir, "dataset.fifo");
    execFileSync("mkfifo", [fifo]);
    writeFileSync(
      join(dir, "mmstar.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          dataset: { path: "dataset.fifo" },
          execution: {
            maxConcurrentGroups: 2,
            maxRetries: 0,
            requestTimeoutMs: 5_000,
            maxRequestsPerMinute: null,
            resultsRoot: "results",
          },
          models: {
            alpha: {
              openRouterId: "vendor/alpha",
              reasoningModes: ["default"],
              rateLimitGroup: "g1",
            },
          },
          sets: { demo: { models: ["alpha"] } },
        },
        null,
        2,
      )}\n`,
    );

    const session = startRunner(["benchmark", "--set", "demo"], {
      cwd: dir,
      env: { MMSTAR_RESULTS_ROOT: "results" },
    });
    // The TUI is up and the dataset read is pending on the FIFO; quit now.
    await session.waitFor("MMStar runner");
    session.write("q");

    const code = await session.exited;
    expect(code).toBe(130);
    // Aborting before `run.created` must not leave a run directory behind.
    expect(existsSync(join(dir, "results"))).toBe(false);
    expect(session.output()).toContain(RESTORE_ALT_SCREEN);
  }, 30_000);
});
