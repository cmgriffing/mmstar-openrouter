#!/usr/bin/env bun
/**
 * Interactive runner entry point.
 *
 * This is the OpenTUI counterpart to `cli.ts`: it parses the same runner
 * commands, executes them through the same headless engine and recovery code,
 * and renders typed engine events instead of NDJSON. `--demo` runs a
 * deterministic mock benchmark for PTY/rendering checks, so no network or
 * credentials are involved.
 *
 * Controls are intentionally minimal in this chunk: `q`/Ctrl-C are accepted,
 * but a quit request while work is in flight is deferred until the run settles,
 * because pause/quit wiring lands in chunk 7.
 */
import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { formatCommandUsage, formatUsage, parseCommand } from "./commands";
import { buildRunContext } from "./context";
import { execute, type RunContext, requestFromArgs } from "./execute";
import { flagsForCommand, parseFlags } from "./flags";
import { RunnerTui } from "./tui/App";
import { DEMO_RUN_ID, demoEvaluations, runDemo } from "./tui/demo";
import { type RunnerViewState, RunViewStore } from "./tui/state";
import { executeValidate } from "./validate";

interface TuiOptions {
  demo: boolean;
  smoke: boolean;
  hold: boolean;
  exitOnFinish: boolean;
  runArgs: string[];
}

function parseTuiArgs(argv: readonly string[]): TuiOptions {
  const runArgs: string[] = [];
  let demo = false;
  let smoke = false;
  let hold = false;
  let exitOnFinish = false;
  for (const arg of argv) {
    switch (arg) {
      case "--demo":
        demo = true;
        break;
      case "--smoke":
        smoke = true;
        demo = true;
        exitOnFinish = true;
        break;
      case "--hold":
        hold = true;
        break;
      case "--exit-on-finish":
        exitOnFinish = true;
        break;
      default:
        runArgs.push(arg);
    }
  }
  return { demo, smoke, hold, exitOnFinish, runArgs };
}

function formatTuiUsage(): string {
  return [
    "Usage: mmstar-tui <command> [options]",
    "       mmstar-tui --demo [--hold]",
    "",
    "Interactive monitor for runner commands; events come from the same headless",
    "engine as the plain CLI. Commands:",
    "",
    ...formatUsage().split("\n").slice(2),
    "",
    "TUI options:",
    "  --demo             deterministic mock run (no network, no credentials)",
    "  --hold             stay on the final frame after a demo run until q",
    "  --exit-on-finish   exit automatically when the run settles",
    "",
    "Keyboard: ? help · ↑/↓ rows · Tab pane · PgUp/PgDn scroll · q quit",
  ].join("\n");
}

const stdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const ndjson = (payload: Record<string, unknown>): void => {
  stdout(JSON.stringify(payload));
};

function stateLabel(state: RunnerViewState): string {
  return state.finalState ?? (state.finished ? "completed" : state.status);
}

async function main(): Promise<number> {
  const options = parseTuiArgs(process.argv.slice(2));

  if (options.demo) return runDemoTui(options);

  const parsed = parseCommand(options.runArgs);
  if (parsed.kind === "help") {
    console.log(formatTuiUsage());
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`mmstar: ${parsed.message}`);
    console.error(formatTuiUsage());
    return 2;
  }

  const { command, args } = parsed.parsed;
  const helpCheck = parseFlags(args, flagsForCommand(command));
  if (helpCheck.ok && helpCheck.flags.booleans.has("help")) {
    console.log(formatCommandUsage(command));
    return 0;
  }

  if (command === "validate") {
    if (!helpCheck.ok) {
      console.error(`mmstar: ${helpCheck.message}`);
      return 2;
    }
    const set = helpCheck.flags.values.get("set") ?? helpCheck.flags.positionals[0];
    const configPath = helpCheck.flags.values.get("config");
    const context = buildRunContext({ emit: ndjson, stderr: process.stderr });
    const result = await executeValidate(
      configPath === undefined ? context : { ...context, configPath },
      { set, preflight: true },
    );
    return result.exitCode;
  }

  if (command === "export") {
    console.error("mmstar: export is implemented in a later chunk");
    return 2;
  }

  const request = requestFromArgs(command, args);
  if (!request.ok) {
    console.error(`mmstar: ${request.message}`);
    console.error(formatCommandUsage(command));
    return 2;
  }

  return runCommandTui(request.request, request.context, options);
}

/** Create the renderer, run the command, and keep watching until quit/exit. */
async function runCommandTui(
  request: Parameters<typeof execute>[0],
  overrides: Partial<RunContext>,
  options: TuiOptions,
): Promise<number> {
  const store = new RunViewStore();
  const quit = createQuitSignal();
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  let exitCode: number | null = null;
  const requestQuit = (): void => {
    if (exitCode === null) {
      store.addNotice(
        "finishing the current run before quit; pause/quit controls arrive in chunk 7",
      );
      return;
    }
    quit.resolve();
  };

  root.render(<RunnerTui store={store} onQuit={requestQuit} />);

  try {
    const context: RunContext = {
      ...buildRunContext({
        emit: (payload) => store.applyLifecycleEvent(payload),
        stderr: { write: (text) => store.addNotice(text) },
        engineEvents: (event) => store.applyEngineEvent(event),
      }),
      ...overrides,
    };
    const result = await execute(request, context);
    exitCode = result.exitCode;
    if (!store.getSnapshot().finished) {
      store.applyLifecycleEvent({
        event: "run.finished",
        runId: store.getSnapshot().runId,
        state: result.exitCode === 0 ? "completed" : "failed",
      });
    }
  } catch (error) {
    store.addNotice(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  }

  if (options.exitOnFinish) {
    await sleep(400);
  } else {
    await quit.promise;
  }
  return restore(renderer, root, store, exitCode);
}

async function runDemoTui(options: TuiOptions): Promise<number> {
  const store = new RunViewStore();
  const quit = createQuitSignal();
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  const fixtureCount = options.smoke ? 2 : 8;
  store.applyLifecycleEvent({
    event: "run.created",
    runId: DEMO_RUN_ID,
    mode: "demo",
    setName: "demo",
    evaluations: demoEvaluations().length,
    fixtures: fixtureCount,
  });

  let settled = false;
  root.render(
    <RunnerTui
      store={store}
      onQuit={() => {
        if (settled) quit.resolve();
        else store.addNotice("demo run still executing");
      }}
    />,
  );

  let exitCode = 0;
  try {
    const result = await runDemo({
      fixtureCount,
      latencyMs: options.smoke ? 5 : 25,
      rateLimitRetryAfterMs: options.smoke ? 20 : 600,
      sink: (event) => store.applyEngineEvent(event),
    });
    if (result.state !== "completed") exitCode = 1;
  } catch (error) {
    store.addNotice(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  }
  settled = true;

  if (options.hold) {
    await quit.promise;
  } else {
    await sleep(options.smoke ? 250 : 500);
  }
  return restore(renderer, root, store, exitCode);
}

function createQuitSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restore(
  renderer: CliRenderer,
  root: ReturnType<typeof createRoot>,
  store: RunViewStore,
  exitCode: number,
): number {
  if (!renderer.isDestroyed) {
    root.unmount();
    renderer.destroy();
  }
  const state = store.getSnapshot();
  if (state.runId !== null) {
    stdout(`mmstar: run ${state.runId} ${stateLabel(state)}`);
  }
  return exitCode;
}

const exitCode = await main();
process.exit(exitCode);
