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
 * When stdout is not a TTY, or `--plain` is passed, the entry point delegates
 * to the plain CLI (or emits NDJSON demo events): same engine, same exit codes,
 * no terminal control sequences. Ctrl-C and `q` are graceful stops: in-flight
 * attempts are cancelled and recorded, checkpoints are written, and only then
 * is the terminal restored.
 */
import type { BenchmarkEngine } from "@mmstar/benchmark";
import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { runCli } from "./cli";
import { formatCommandUsage, formatUsage, parseCommand } from "./commands";
import { buildRunContext } from "./context";
import { type EngineObserver, execute, type RunContext, requestFromArgs } from "./execute";
import { flagsForCommand, parseFlags } from "./flags";
import { RunnerTui } from "./tui/App";
import { createDemoEngine, DEMO_RUN_ID, demoEvaluations } from "./tui/demo";
import { buildFixtureDetail } from "./tui/inspection";
import { RunViewStore } from "./tui/state";
import { executeValidate } from "./validate";

interface TuiOptions {
  demo: boolean;
  smoke: boolean;
  hold: boolean;
  exitOnFinish: boolean;
  plain: boolean;
  runArgs: string[];
}

function parseTuiArgs(argv: readonly string[]): TuiOptions {
  const runArgs: string[] = [];
  let demo = false;
  let smoke = false;
  let hold = false;
  let exitOnFinish = false;
  let plain = false;
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
      case "--plain":
        plain = true;
        break;
      default:
        runArgs.push(arg);
    }
  }
  return { demo, smoke, hold, exitOnFinish, plain, runArgs };
}

function formatTuiUsage(): string {
  return [
    "Usage: mmstar-tui <command> [options]",
    "       mmstar-tui --demo [--hold] [--plain]",
    "",
    "Interactive monitor for runner commands; events come from the same headless",
    "engine as the plain CLI. When stdout is not a TTY, or --plain is given, the",
    "command runs headlessly and writes NDJSON events instead of rendering.",
    "Commands:",
    "",
    ...formatUsage().split("\n").slice(2),
    "",
    "TUI options:",
    "  --demo             deterministic mock run (no network, no credentials)",
    "  --hold             stay on the final frame after a demo run until q",
    "  --exit-on-finish   exit automatically when the run settles",
    "  --plain            never render; use the machine-readable output path",
    "",
    "Keyboard: ? help · ↑/↓ select · Enter inspect · f filter · p/c pause/continue · q quit",
  ].join("\n");
}

const stdout = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const ndjson = (payload: Record<string, unknown>): void => {
  stdout(JSON.stringify(payload));
};

function stateLabel(state: ReturnType<RunViewStore["getSnapshot"]>): string {
  return state.finalState ?? (state.finished ? "completed" : state.status);
}

async function main(): Promise<number> {
  const options = parseTuiArgs(process.argv.slice(2));

  // Non-TTY output cannot be rendered honestly: route to the plain path, which
  // uses the same engine and emits the same machine-readable events.
  const interactive = !options.plain && process.stdout.isTTY === true;
  if (!interactive) return runPlain(options);

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

/** Headless path: identical engine and exit codes, NDJSON on stdout only. */
async function runPlain(options: TuiOptions): Promise<number> {
  if (!options.demo) return runCli(options.runArgs);

  const fixtureCount = options.smoke ? 2 : 8;
  const engine = createDemoEngine({
    fixtureCount,
    latencyMs: options.smoke ? 5 : 25,
    rateLimitRetryAfterMs: options.smoke ? 20 : 600,
    sink: (event) => {
      process.stdout.write(
        `${JSON.stringify({ event: "engine", runId: DEMO_RUN_ID, ...event })}\n`,
      );
    },
  });
  const result = await engine.run();
  process.stderr.write(`mmstar: run ${DEMO_RUN_ID} ${result.state}\n`);
  return result.state === "completed" ? 0 : 1;
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
  let engine: BenchmarkEngine | null = null;
  let control: EngineObserver | null = null;
  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  let quitRequested = false;

  const refreshMetrics = (): void => {
    if (engine !== null) store.applyMetrics(engine.getMetrics());
  };
  const stopMetrics = (): void => {
    if (metricsTimer !== null) {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }
  };
  const inspect = (evaluationId: string, fixtureId: string): void => {
    if (engine === null) {
      store.addNotice("no engine is running; nothing to inspect yet");
      return;
    }
    const row = store.getSnapshot().rows.find((entry) => entry.evaluationId === evaluationId);
    const detail = buildFixtureDetail({
      engine,
      modelAlias: row?.modelAlias ?? evaluationId,
      evaluationId,
      fixtureId,
    });
    if (detail === null) {
      store.addNotice(`fixture ${fixtureId} has no durable record yet`);
      return;
    }
    store.applyDetail(detail);
  };
  const requestQuit = (): void => {
    if (exitCode !== null) {
      quit.resolve();
      return;
    }
    if (quitRequested) return;
    quitRequested = true;
    if (control === null) {
      store.addNotice("stopping before the first request is submitted");
      return;
    }
    store.addNotice("stopping: cancelling in-flight work and checkpointing");
    control.stop("user");
  };
  const onSignal = (): void => {
    quitRequested = true;
    control?.stop("signal");
  };
  const disposeSignals = registerSignals(onSignal);

  root.render(
    <RunnerTui
      store={store}
      onQuit={requestQuit}
      onPause={() => control?.pause()}
      onResume={() => control?.resume()}
      onInspect={inspect}
    />,
  );

  try {
    const context: RunContext = {
      ...buildRunContext({
        emit: (payload) => store.applyLifecycleEvent(payload),
        stderr: { write: (text) => store.addNotice(text) },
        engineEvents: (event) => store.applyEngineEvent(event),
      }),
      ...overrides,
      observeEngine: (created, engineControl) => {
        engine = created;
        control = engineControl;
        refreshMetrics();
        if (metricsTimer === null) metricsTimer = setInterval(refreshMetrics, 500);
        // A quit requested while config/dataset loading was still running must
        // cancel the run as soon as the engine exists.
        if (quitRequested) engineControl.stop("signal");
      },
    };
    const result = await execute(request, context);
    exitCode = result.exitCode;
  } catch (error) {
    store.addNotice(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  } finally {
    disposeSignals();
    stopMetrics();
    refreshMetrics();
  }

  if (!store.getSnapshot().finished) {
    store.applyLifecycleEvent({
      event: "run.finished",
      runId: store.getSnapshot().runId,
      state: exitCode === 0 ? "completed" : "failed",
    });
  }
  if (quitRequested) quit.resolve();
  if (options.exitOnFinish) await sleep(400);
  else await quit.promise;
  return restore(renderer, root, store, exitCode ?? 0);
}

async function runDemoTui(options: TuiOptions): Promise<number> {
  const store = new RunViewStore();
  const quit = createQuitSignal();
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const root = createRoot(renderer);

  const fixtureCount = options.smoke ? 2 : 8;
  const engine = createDemoEngine({
    fixtureCount,
    latencyMs: options.smoke ? 5 : 25,
    rateLimitRetryAfterMs: options.smoke ? 20 : 600,
    sink: (event) => store.applyEngineEvent(event),
  });

  let exitCode: number | null = null;
  let quitRequested = false;
  const refreshMetrics = (): void => store.applyMetrics(engine.getMetrics());
  const metricsTimer = setInterval(refreshMetrics, 100);
  const inspect = (evaluationId: string, fixtureId: string): void => {
    const row = store.getSnapshot().rows.find((entry) => entry.evaluationId === evaluationId);
    const detail = buildFixtureDetail({
      engine,
      modelAlias: row?.modelAlias ?? evaluationId,
      evaluationId,
      fixtureId,
    });
    if (detail === null) {
      store.addNotice(`fixture ${fixtureId} has no durable record yet`);
      return;
    }
    store.applyDetail(detail);
  };
  const requestQuit = (): void => {
    if (exitCode !== null) {
      quit.resolve();
      return;
    }
    if (quitRequested) return;
    quitRequested = true;
    store.addNotice("stopping: cancelling in-flight work and checkpointing");
    engine.stop("user");
  };
  const onSignal = (): void => {
    quitRequested = true;
    engine.stop("signal");
  };
  const disposeSignals = registerSignals(onSignal);

  store.applyLifecycleEvent({
    event: "run.created",
    runId: DEMO_RUN_ID,
    mode: "demo",
    setName: "demo",
    evaluations: demoEvaluations().length,
    fixtures: fixtureCount,
  });

  root.render(
    <RunnerTui
      store={store}
      onQuit={requestQuit}
      onPause={() => engine.pause()}
      onResume={() => engine.resume()}
      onInspect={inspect}
    />,
  );

  try {
    const result = await engine.run();
    exitCode = result.state === "completed" ? 0 : result.state === "stopped" ? 130 : 1;
  } catch (error) {
    store.addNotice(error instanceof Error ? error.message : String(error));
    exitCode = 1;
  } finally {
    disposeSignals();
    clearInterval(metricsTimer);
    refreshMetrics();
  }

  if (quitRequested) quit.resolve();
  if (options.hold) await quit.promise;
  else await sleep(options.smoke ? 250 : 500);
  return restore(renderer, root, store, exitCode ?? 0);
}

function createQuitSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function registerSignals(handler: () => void): () => void {
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
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
