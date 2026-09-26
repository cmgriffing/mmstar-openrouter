#!/usr/bin/env bun
/**
 * Chunk 11.1 — deterministic end-to-end workflow verification.
 *
 * Drives the real command layer (`executeValidate`, `execute`, `executeExport`)
 * against a temporary workspace built from six real MMStar fixtures (one per
 * category) and a scripted in-memory provider. No network, no credentials, and
 * no paid request are involved.
 *
 * Workflow under test:
 *   validate -> interrupted benchmark -> resume -> retry-failed -> restart
 *   --latest -> export --latest -> publication verification and repository
 *   queries over the resulting family.
 *
 * The harness prints a phase log, writes `e2e-summary.json` into the working
 * directory, and exits non-zero when any assertion fails. Run it with:
 *
 *   bun apps/runner/scripts/e2e-workflow.ts [--workdir /tmp/mmstar-e2e]
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ChatCompletionRequestPayload,
  type CompletionProvider,
  type FixtureRecord,
  type NormalizedCompletion,
  type ProviderResult,
  parseDatasetTsv,
} from "@mmstar/benchmark";
import { createPublicationRepository, type FailureCategory } from "@mmstar/results";
import { openSqliteDatabase, RunStore, verifyPublication } from "@mmstar/results/node";
import { type EngineObserver, execute, type RunContext } from "../src/execute";
import { executeExport } from "../src/export";
import { executeValidate } from "../src/validate";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const DATASET_PATH = join(REPO_ROOT, "apps", "runner", "MMStar.tsv");
const T0 = Date.parse("2026-09-25T00:00:00.000Z");

const MODELS = {
  alpha: { openRouterId: "e2e/alpha", rateLimitGroup: "shared" },
  beta: { openRouterId: "e2e/beta", rateLimitGroup: "shared" },
  gamma: { openRouterId: "e2e/gamma", rateLimitGroup: "solo" },
} as const;
const MODEL_TO_GROUP = new Map<string, string>(
  Object.values(MODELS).map((model) => [model.openRouterId, model.rateLimitGroup]),
);

const args = process.argv.slice(2);
const workdirFlag = args.indexOf("--workdir");
const workdirValue = workdirFlag >= 0 ? args[workdirFlag + 1] : undefined;
const explicitWorkdir = workdirValue === undefined ? null : resolve(workdirValue);
const workDir = explicitWorkdir ?? mkdtempSync(join(tmpdir(), "mmstar-e2e-"));
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const resultsRoot = join(workDir, "results");
const publicationDir = join(workDir, "publication");

function log(phase: string, message: string): void {
  process.stdout.write(`[e2e] ${phase} ${message}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`e2e assertion failed: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// ---------------------------------------------------------------------------
// Deterministic provider
// ---------------------------------------------------------------------------

type Behavior =
  | { kind: "answer"; text: string; unknownUsage?: boolean }
  | { kind: "failure"; category: FailureCategory; retryAfterMs?: number }
  | { kind: "hang" };

type BehaviorResolver = (input: { model: string; fixtureId: string; attempt: number }) => Behavior;

interface ProviderStats {
  calls: number;
  inFlight: number;
  maxGlobal: number;
  perGroup: Map<string, number>;
  maxPerGroup: Map<string, number>;
}

function newStats(): ProviderStats {
  return { calls: 0, inFlight: 0, maxGlobal: 0, perGroup: new Map(), maxPerGroup: new Map() };
}

function scriptedProvider(options: {
  resolve: BehaviorResolver;
  stats: ProviderStats;
  latencyMs?: number;
  onCall?: () => void;
}): CompletionProvider {
  const attempts = new Map<string, number>();
  return async (
    payload: ChatCompletionRequestPayload,
    { signal }: { timeoutMs: number; signal: AbortSignal },
  ): Promise<ProviderResult<NormalizedCompletion>> => {
    const fixtureId = fixtureIdFor(payload);
    const key = `${payload.model}|${fixtureId}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);

    const group = MODEL_TO_GROUP.get(payload.model) ?? "unknown";
    options.stats.calls += 1;
    options.stats.inFlight += 1;
    options.stats.maxGlobal = Math.max(options.stats.maxGlobal, options.stats.inFlight);
    const inGroup = (options.stats.perGroup.get(group) ?? 0) + 1;
    options.stats.perGroup.set(group, inGroup);
    options.stats.maxPerGroup.set(
      group,
      Math.max(options.stats.maxPerGroup.get(group) ?? 0, inGroup),
    );
    options.onCall?.();

    const behavior = options.resolve({ model: payload.model, fixtureId, attempt });
    try {
      if (behavior.kind === "hang") {
        await new Promise<void>((done) => {
          if (signal.aborted) {
            done();
            return;
          }
          signal.addEventListener("abort", () => done(), { once: true });
        });
        return failure("cancelled");
      }
      if (options.latencyMs !== undefined) await sleep(options.latencyMs);
      if (behavior.kind === "failure") {
        return failure(behavior.category, behavior.retryAfterMs ?? null);
      }
      return success(payload.model, behavior.text, behavior.unknownUsage === true);
    } finally {
      options.stats.inFlight -= 1;
      options.stats.perGroup.set(group, (options.stats.perGroup.get(group) ?? 1) - 1);
    }
  };
}

function failure(category: FailureCategory, retryAfterMs: number | null = null) {
  return {
    ok: false as const,
    failure: {
      category,
      message: `deterministic ${category} failure`,
      httpStatus: null,
      retryAfterMs,
    },
    rawResponse: null,
  };
}

function success(
  model: string,
  text: string,
  unknownUsage: boolean,
): { ok: true; value: NormalizedCompletion } {
  return {
    ok: true,
    value: {
      responseId: `e2e-${model}`,
      modelUsed: model,
      upstreamProvider: "e2e-provider",
      finishReason: "stop",
      responseText: text,
      usage: unknownUsage
        ? null
        : { promptTokens: 12, completionTokens: 1, totalTokens: 13, reasoningTokens: null },
      cost: unknownUsage ? { kind: "unknown", usd: null } : { kind: "reported", usd: 0.002 },
      rawResponse: { model },
    },
  };
}

// ---------------------------------------------------------------------------
// Dataset and workspace
// ---------------------------------------------------------------------------

const parsed = parseDatasetTsv(readFileSync(DATASET_PATH, "utf8"));
const firstPerCategory = new Map<string, FixtureRecord>();
for (const fixture of parsed.fixtures) {
  if (!firstPerCategory.has(fixture.category)) firstPerCategory.set(fixture.category, fixture);
}
const fixtures = [...firstPerCategory.values()];
assert(fixtures.length === 6, `expected six categories, saw ${fixtures.length}`);

const fixtureById = new Map(fixtures.map((fixture) => [fixture.fixtureId, fixture]));
const fixtureIdByQuestion = new Map(
  fixtures.map((fixture) => [fixture.question, fixture.fixtureId]),
);

function answerOf(fixtureId: string): string {
  const fixture = fixtureById.get(fixtureId);
  if (fixture === undefined) throw new Error(`unknown fixture ${fixtureId}`);
  return fixture.answer;
}

function fixtureIdFor(payload: ChatCompletionRequestPayload): string {
  const text = payload.messages[0]?.content.find((part) => part.type === "text")?.text ?? "";
  for (const [question, fixtureId] of fixtureIdByQuestion) {
    if (text.includes(question)) return fixtureId;
  }
  throw new Error(`could not identify fixture from request to ${payload.model}`);
}

function tsvField(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const tsvRows = fixtures.map((fixture) =>
  [
    fixture.fixtureId,
    tsvField(fixture.question),
    fixture.answer,
    tsvField(fixture.category),
    tsvField(fixture.l2Category),
    tsvField(fixture.bench),
    fixture.image.base64,
  ].join("\t"),
);
writeFileSync(
  join(workDir, "fixtures.tsv"),
  `${["index", "question", "answer", "category", "l2_category", "bench", "image"].join("\t")}\n${tsvRows.join("\n")}\n`,
);

const config = {
  version: 1,
  dataset: { path: "fixtures.tsv" },
  execution: {
    maxConcurrentGroups: 2,
    maxRetries: 1,
    requestTimeoutMs: 5_000,
    maxRequestsPerMinute: null,
    resultsRoot: "results",
  },
  models: {
    alpha: { ...MODELS.alpha, reasoningModes: ["default"] },
    beta: { ...MODELS.beta, reasoningModes: ["default"] },
    gamma: { ...MODELS.gamma, reasoningModes: ["default"] },
  },
  sets: { e2e: { models: ["alpha", "beta", "gamma"] } },
};
writeFileSync(join(workDir, "mmstar.config.json"), `${JSON.stringify(config, null, 2)}\n`);

const events: Record<string, unknown>[] = [];
const stderrLines: string[] = [];
let suffixCounter = 0;
const context: RunContext = {
  resultsRoot,
  cwd: workDir,
  configPath: join(workDir, "mmstar.config.json"),
  apiKey: null,
  skipPreflight: true,
  force: false,
  now: () => T0 + suffixCounter * 1_000,
  suffix: () => {
    suffixCounter += 1;
    return suffixCounter.toString(16).padStart(8, "0");
  },
  stderr: { write: (text) => stderrLines.push(text) },
  emit: (payload) => events.push(payload),
  revision: async () => ({ revision: "e2e-harness", dirty: false }),
};

const store = new RunStore({ root: resolve(resultsRoot) });

function runIds(): string[] {
  return store.listRunIds();
}

function lastRunId(): string {
  const id = runIds().at(-1);
  if (id === undefined) throw new Error("no run was created");
  return id;
}

function eventsByName(name: string, from = 0): Record<string, unknown>[] {
  return events.slice(from).filter((event) => event.event === name);
}

function statesOf(runId: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of store.readModelRecords(runId)) {
    for (const evaluation of file.evaluations) {
      for (const outcome of evaluation.outcomes) {
        counts.set(outcome.state, (counts.get(outcome.state) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function attemptsOf(
  runId: string,
): { attemptId: string; state: string; retryAfterMs: number | null }[] {
  return store.readModelRecords(runId).flatMap((file) =>
    file.evaluations.flatMap((evaluation) =>
      evaluation.attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        state: attempt.state,
        retryAfterMs: attempt.failure?.retryAfterMs ?? null,
      })),
    ),
  );
}

const summary: Record<string, unknown> = {
  workDir,
  publicationDir,
  fixtures: fixtures.map((fixture) => fixture.fixtureId),
};

async function main(): Promise<void> {
  // ---------------------------------------------------------------- validate
  log("validate", "checking config, dataset, and plan expansion");
  const validateResult = await executeValidate(context, { set: "e2e", preflight: false });
  assert(validateResult.exitCode === 0, `validate exited ${validateResult.exitCode}`);
  const validateOk = eventsByName("validate.ok")[0];
  assert(validateOk !== undefined, "validate.ok event missing");
  assert(
    (validateOk.dataset as { fixtures: number }).fixtures === 6,
    "validate did not see six fixtures",
  );
  assert(runIds().length === 0, "validate must not create a run");
  log("validate", "ok — six fixtures, three evaluations, no run created");

  // ------------------------------------------------- interrupted benchmark
  const stats = newStats();
  let hanging = false;
  let control: EngineObserver | null = null;
  const phase1Provider = scriptedProvider({
    stats,
    latencyMs: 15,
    onCall: () => {
      if (stats.calls === 4) hanging = true;
    },
    resolve: ({ fixtureId }) =>
      stats.calls >= 4 ? { kind: "hang" } : { kind: "answer", text: answerOf(fixtureId) },
  });

  const primaryPromise = execute(
    { mode: "run", set: "e2e" },
    {
      ...context,
      provider: phase1Provider,
      observeEngine: (_engine, observer) => {
        control = observer;
      },
    },
  );
  for (let i = 0; i < 10_000 && !hanging; i += 1) {
    await sleep(2);
  }
  assert(hanging, "the fourth provider call never started");
  const observer = control as EngineObserver | null;
  assert(observer !== null, "engine observer was never exposed");
  observer.stop("user");
  const primaryResult = await primaryPromise;

  const primaryId = lastRunId();
  const primaryManifest = store.readManifest(primaryId);
  const primaryStates = statesOf(primaryId);
  assert(
    primaryResult.exitCode === 130,
    `interrupted run exited ${primaryResult.exitCode}, want 130`,
  );
  assert(primaryManifest.lifecycle.state === "stopped", "primary manifest is not stopped");
  assert(
    eventsByName("run.finished").some((event) => event.state === "stopped"),
    "run.finished did not report a stopped run",
  );
  assert(eventsByName("engine.stop-requested").length > 0, "engine stop-requested event missing");
  assert(
    primaryStates.get("settled") === 3,
    `expected three settled outcomes before the stop, saw ${primaryStates.get("settled") ?? 0}`,
  );
  assert((primaryStates.get("pending") ?? 0) >= 1, "stopped run has no pending work to resume");
  assert(
    attemptsOf(primaryId).some((attempt) => attempt.state === "cancelled"),
    "aborted in-flight attempt was not recorded as cancelled",
  );
  assert(stats.maxGlobal === 2, `global concurrency reached ${stats.maxGlobal}, want 2`);
  assert(
    (stats.maxPerGroup.get("shared") ?? 0) === 1,
    `shared rate-limit group reached ${stats.maxPerGroup.get("shared") ?? 0} in-flight, want 1`,
  );
  log(
    "run",
    `stopped after 4 calls (exit 130) — ${primaryStates.get("settled") ?? 0} settled, ${primaryStates.get("pending") ?? 0} pending, shared group max 1`,
  );

  // ---------------------------------------------------------------- resume
  const phase2Provider = scriptedProvider({
    stats,
    resolve: ({ model, fixtureId, attempt }) => {
      const fixture = fixtures[2];
      if (fixture === undefined) throw new Error("fixture 2 missing");
      const key = `${model}|${fixtureId}`;
      if (key === `${MODELS.alpha.openRouterId}|${fixture.fixtureId}`) {
        return { kind: "failure", category: "timeout" };
      }
      if (key === `${MODELS.beta.openRouterId}|${fixture.fixtureId}`) {
        return { kind: "failure", category: "server_error" };
      }
      if (key === `${MODELS.beta.openRouterId}|${fixtures[1]?.fixtureId}`) {
        return attempt === 1
          ? { kind: "failure", category: "rate_limit", retryAfterMs: 30 }
          : { kind: "answer", text: answerOf(fixtureId) };
      }
      if (key === `${MODELS.alpha.openRouterId}|${fixtures[4]?.fixtureId}`) {
        return { kind: "answer", text: "I cannot answer this question." };
      }
      if (key === `${MODELS.gamma.openRouterId}|${fixtures[1]?.fixtureId}`) {
        return { kind: "answer", text: "The answer could be A or B." };
      }
      if (key === `${MODELS.gamma.openRouterId}|${fixtures[3]?.fixtureId}`) {
        return { kind: "answer", text: "The image is unclear." };
      }
      return {
        kind: "answer",
        text: answerOf(fixtureId),
        unknownUsage: model === MODELS.gamma.openRouterId,
      };
    },
  });

  const resumeFrom = events.length;
  const resumeResult = await execute(
    { mode: "resume", selector: { runId: primaryId } },
    { ...context, provider: phase2Provider },
  );
  assert(resumeResult.exitCode === 0, `resume exited ${resumeResult.exitCode}`);
  const resumeId = lastRunId();
  assert(resumeId !== primaryId, "resume did not create a child run");
  const resumeStates = statesOf(resumeId);
  assert(
    (resumeStates.get("indeterminate") ?? 0) >= 1,
    "timeout/network work did not become indeterminate",
  );
  assert((resumeStates.get("failed") ?? 0) >= 1, "exhausted 503 did not become a failed outcome");
  assert((resumeStates.get("settled") ?? 0) >= 10, "resume did not settle the reissued work");
  const resumeEvents = events.slice(resumeFrom);
  assert(
    resumeEvents.some((event) => event.event === "run.created" && event.mode === "resume"),
    "resume run.created event missing",
  );
  const rateLimitAttempt = attemptsOf(resumeId).find(
    (attempt) => attempt.retryAfterMs !== null && attempt.retryAfterMs !== undefined,
  );
  assert(rateLimitAttempt?.retryAfterMs === 30, "Retry-After was not persisted on the attempt");
  assert(
    !stderrLines.some((line) => line.includes("unknown upstream completion")),
    "resume disclosed indeterminate work that did not exist yet",
  );
  log(
    "resume",
    `ok — ${resumeStates.get("settled") ?? 0} settled, ${resumeStates.get("indeterminate") ?? 0} indeterminate, ${resumeStates.get("failed") ?? 0} failed`,
  );

  // ----------------------------------------------------------- retry-failed
  const phase3Provider = scriptedProvider({
    stats,
    resolve: ({ fixtureId }) => ({ kind: "answer", text: answerOf(fixtureId) }),
  });
  const recoveryFrom = events.length;
  const recoveryResult = await execute(
    { mode: "retry-failed", selector: { latest: true } },
    { ...context, provider: phase3Provider },
  );
  assert(recoveryResult.exitCode === 0, `retry-failed exited ${recoveryResult.exitCode}`);
  const recoveryId = lastRunId();
  const recoveryManifest = store.readManifest(recoveryId);
  const recoveryStates = statesOf(recoveryId);
  assert(
    recoveryManifest.lineage.kind === "recovery" &&
      recoveryManifest.lineage.parentRunId === resumeId,
    "recovery lineage is wrong",
  );
  assert(
    recoveryManifest.lineage.recoveredFixtureIds?.length === 1,
    `recovery selected ${recoveryManifest.lineage.recoveredFixtureIds?.length ?? 0} unique fixtures, want 1`,
  );
  assert(
    recoveryStates.get("settled") === 18,
    `recovery run carries ${recoveryStates.get("settled") ?? 0} settled outcomes, want all 18`,
  );
  const recoveryAttempts = attemptsOf(recoveryId);
  assert(
    recoveryAttempts.length === 2 &&
      recoveryAttempts.every((attempt) => attempt.state === "completed"),
    "recovery run must persist its own two successful attempts",
  );
  const recoveryCreated = events
    .slice(recoveryFrom)
    .find((event) => event.event === "run.created" && event.mode === "retry-failed");
  assert(recoveryCreated !== undefined, "recovery run.created event missing");
  // A second recovery over the whole lineage is a no-op: nothing is unresolved.
  const repeat = await execute(
    { mode: "retry-failed", selector: { latest: true } },
    { ...context, provider: phase3Provider },
  );
  assert(repeat.exitCode === 0, "repeated retry-failed must exit 0");
  assert(
    eventsByName("run.nothing-to-do").length === 1,
    "repeated retry-failed must report nothing-to-do exactly once",
  );
  assert(runIds().length === 3, "repeated retry-failed created another run");
  log("recovery", "ok — unresolved lineage resolved once; repeated recovery is a no-op");

  // --------------------------------------------------------------- restart
  const phase4Provider = scriptedProvider({
    stats,
    resolve: ({ fixtureId }) => ({ kind: "answer", text: answerOf(fixtureId) }),
  });
  const restartResult = await execute(
    { mode: "restart", selector: { latest: true } },
    { ...context, provider: phase4Provider },
  );
  assert(restartResult.exitCode === 0, `restart exited ${restartResult.exitCode}`);
  const restartId = lastRunId();
  const restartManifest = store.readManifest(restartId);
  const restartStates = statesOf(restartId);
  assert(restartManifest.lineage.kind === "restart", "restart manifest kind is wrong");
  assert(
    restartManifest.plan.dataset.fixtureIds.length === 6,
    "restart did not preserve the original fixture selection",
  );
  assert(restartStates.get("settled") === 18, "restart did not settle every planned outcome");
  assert(
    store.resolveSelector({ latest: true }).runId === restartId,
    "--latest does not select the restart",
  );
  assert(runIds().length === 4, `expected four runs, saw ${runIds().length}`);
  log("restart", "ok — new primary covers all 18 planned outcomes and is --latest");

  // ----------------------------------------------------------------- export
  const exportFrom = events.length;
  const exportResult = await executeExport(context, {
    latest: true,
    all: false,
    outDir: "publication",
  });
  assert(exportResult.exitCode === 0, `export exited ${exportResult.exitCode}`);
  const exportOk = eventsByName("export.ok", exportFrom)[0];
  assert(exportOk !== undefined, "export.ok event missing");
  const counts = exportOk.counts as { outcomes: number; attempts: number };
  assert(counts.outcomes === 72, `publication has ${counts.outcomes} outcomes, want 72`);
  assert(
    counts.attempts === stats.calls,
    `publication attempt ledger has ${counts.attempts} rows for ${stats.calls} physical provider calls`,
  );
  assert(
    (exportOk.runIds as string[]).length === 4,
    "publication family does not contain four runs",
  );

  const verified = verifyPublication(publicationDir);
  assert(
    verified.manifest.images.fileCount >= 1 && verified.manifest.images.fileCount <= 6,
    "image inventory is outside the expected range",
  );
  log(
    "export",
    `ok — 4 runs, ${counts.outcomes} outcomes, ${counts.attempts} attempts, ${verified.manifest.images.fileCount} images`,
  );
  const familyCalls = stats.calls;

  // ------------------------------------- duplicate primary (second family)
  const phase5Provider = scriptedProvider({
    stats,
    resolve: ({ fixtureId }) => ({ kind: "answer", text: answerOf(fixtureId) }),
  });
  const duplicateFrom = events.length;
  const duplicateResult = await execute(
    { mode: "run", set: "e2e" },
    { ...context, provider: phase5Provider },
  );
  assert(duplicateResult.exitCode === 0, `duplicate primary exited ${duplicateResult.exitCode}`);
  const duplicateId = lastRunId();
  assert(duplicateId !== restartId, "duplicate primary reused the restart run");
  assert(
    store.readManifest(duplicateId).lineage.kind === "primary",
    "duplicate run is not a primary family root",
  );
  const duplicateStates = statesOf(duplicateId);
  assert(duplicateStates.get("settled") === 18, "duplicate primary did not settle every outcome");
  assert(runIds().length === 5, `expected five runs, saw ${runIds().length}`);
  assert(
    events.slice(duplicateFrom).some((event) => event.event === "run.finished"),
    "duplicate primary did not finish",
  );
  log("duplicate", "ok — second primary family settled all 18 outcomes");

  // ------------------------------------------- selector-free export (all runs)
  const allExportFrom = events.length;
  const allExportDir = join(workDir, "publication-all");
  const allExportResult = await executeExport(context, {
    latest: false,
    all: true,
    outDir: "publication-all",
  });
  assert(allExportResult.exitCode === 0, `all-runs export exited ${allExportResult.exitCode}`);
  const allExportOk = eventsByName("export.ok", allExportFrom)[0];
  assert(allExportOk !== undefined, "all-runs export.ok event missing");
  assert(allExportOk.mode === "all", `all-runs export reported mode ${String(allExportOk.mode)}`);
  const allCounts = allExportOk.counts as { runs: number; outcomes: number; attempts: number };
  assert(allCounts.runs === 5, `all-runs publication has ${allCounts.runs} runs, want 5`);
  assert(
    (allExportOk.runIds as string[]).length === runIds().length,
    "all-runs event does not list every run",
  );
  assert(
    (allExportOk.runIds as string[]).sort().join(",") === runIds().sort().join(","),
    "all-runs event run IDs do not match the results root",
  );
  assert(
    (allExportOk.rootRunIds as string[]).length === 2,
    "all-runs publication must resolve both family roots",
  );
  assert(allCounts.outcomes === 90, `all-runs publication has ${allCounts.outcomes} outcomes`);
  assert(
    allCounts.attempts === stats.calls,
    `all-runs attempt ledger has ${allCounts.attempts} rows for ${stats.calls} physical provider calls`,
  );
  const allVerified = verifyPublication(allExportDir);
  assert(allVerified.manifest.runs.runIds.length === 5, "all-runs manifest is missing runs");
  assert(allVerified.manifest.schemaVersion === 2, "all-runs manifest is not schema v2");
  assert(allVerified.manifest.exporterVersion === 2, "all-runs manifest is not exporter v2");
  log(
    "export-all",
    `ok — ${allCounts.runs} runs, ${allCounts.outcomes} outcomes, ${allCounts.attempts} attempts`,
  );

  // -------------------------------------------------- repository queries
  const db = openSqliteDatabase(join(publicationDir, "benchmark.sqlite"), { readOnly: true });
  try {
    const repository = createPublicationRepository(db);
    const meta = repository.meta();
    assert(meta.schemaVersion === 2 && meta.exporterVersion === 2, "publication meta is wrong");
    const rootId = (exportOk.rootRunIds as string[])[0];
    assert(rootId !== undefined, "publication has no root run");
    const runs = repository.listRuns(rootId);
    assert(runs.length === 4, `repository lists ${runs.length} runs, want 4`);
    assert(
      runs.some((run) => run.runKind === "recovery") &&
        runs.some((run) => run.runKind === "restart"),
      "repository run kinds are incomplete",
    );
    const comparisons = repository.listComparisons();
    assert(comparisons.length === 3, `expected three evaluations, saw ${comparisons.length}`);
    for (const comparison of comparisons) {
      assert(
        comparison.rootRunId === rootId,
        `${comparison.evaluationId} provenance is ${comparison.rootRunId}, want ${rootId}`,
      );
      assert(
        comparison.selected === 6,
        `${comparison.evaluationId} selected ${comparison.selected}`,
      );
      assert(comparison.settled === 6, `${comparison.evaluationId} settled ${comparison.settled}`);
      assert(comparison.correct === 6, `${comparison.evaluationId} correct ${comparison.correct}`);
      assert(comparison.coverage === 1 && comparison.scoredAccuracy === 1, "accuracy ratios wrong");
    }
    const ledgerRow = db.prepare("SELECT COUNT(*) AS attempts FROM attempts").get();
    const ledgerCount = Number(ledgerRow?.attempts ?? -1);
    assert(
      ledgerCount === familyCalls,
      `billing ledger has ${ledgerCount} rows for ${familyCalls} physical provider calls`,
    );
    const categories = repository.listCategories();
    assert(categories.length === 18, `expected 18 category rows, saw ${categories.length}`);
    const page = repository.listFixtures({ limit: 200 });
    assert(page.total === 18, `fixture page totals ${page.total}, want 18`);
    assert(
      page.rows.every((row) => row.imagePath.startsWith("benchmark-images/")),
      "fixture rows must reference hosted image assets",
    );

    const timeoutFixture = fixtures[2];
    assert(timeoutFixture !== undefined, "fixture 2 missing");
    const detail = repository.getFixtureDetail({
      evaluationId: "alpha::default",
      fixtureId: timeoutFixture.fixtureId,
    });
    assert(detail !== null, "fixture detail missing");
    assert(
      detail.state === "settled" && detail.kind === "correct",
      `effective detail is ${detail.state}/${detail.kind}, want settled/correct`,
    );
    const outcomeStates = new Set(detail.outcomes.map((outcome) => outcome.state));
    assert(outcomeStates.has("pending"), "primary pending outcome missing from lineage");
    assert(outcomeStates.has("indeterminate"), "interrupted outcome missing from lineage");
    assert(outcomeStates.has("settled"), "settled outcome missing from lineage");
    assert(detail.attempts.length === 4, `detail has ${detail.attempts.length} attempts, want 4`);
    log(
      "repository",
      `ok — 3 evaluations x 6 fixtures, ${ledgerCount} ledger attempts for ${familyCalls} family calls, lineage intact`,
    );
    summary.repository = {
      runs: runs.length,
      evaluations: comparisons.length,
      categories: categories.length,
      ledgerAttempts: ledgerCount,
      detailOutcomes: detail.outcomes.length,
      detailAttempts: detail.attempts.length,
    };
  } finally {
    db.close();
  }

  // ---------------------------------------- global winner over every family
  const globalDb = openSqliteDatabase(join(allExportDir, "benchmark.sqlite"), { readOnly: true });
  try {
    const globalRepository = createPublicationRepository(globalDb);
    const globalComparisons = globalRepository.listComparisons();
    assert(globalComparisons.length === 3, `global summary has ${globalComparisons.length} rows`);
    for (const comparison of globalComparisons) {
      assert(
        comparison.rootRunId === duplicateId,
        `${comparison.evaluationId} global winner is ${comparison.rootRunId}, want ${duplicateId}`,
      );
      assert(
        comparison.selected === 6 && comparison.settled === 6 && comparison.correct === 6,
        `${comparison.evaluationId} global counts are wrong`,
      );
    }
    const globalPage = globalRepository.listFixtures({ limit: 200 });
    assert(globalPage.total === 18, `global fixture page totals ${globalPage.total}, want 18`);
    assert(
      globalPage.rows.every(
        (row) => row.rootRunId === duplicateId && row.effectiveRunId === duplicateId,
      ),
      "global fixture rows must come from the newest family",
    );
    const globalCategories = globalRepository.listCategories();
    assert(
      globalCategories.length === 18,
      `global category rows are ${globalCategories.length}, want 18`,
    );
    const globalLedger = globalDb.prepare("SELECT COUNT(*) AS attempts FROM attempts").get();
    const globalLedgerCount = Number(globalLedger?.attempts ?? -1);
    assert(
      globalLedgerCount === stats.calls,
      `all-runs ledger has ${globalLedgerCount} rows for ${stats.calls} physical provider calls`,
    );
    log(
      "global-winner",
      `ok — newest family (${duplicateId}) supplies all 3 evaluations and 18 fixtures`,
    );
    summary.globalRepository = {
      evaluations: globalComparisons.length,
      categories: globalCategories.length,
      fixtures: globalPage.total,
      winner: duplicateId,
      ledgerAttempts: globalLedgerCount,
    };
  } finally {
    globalDb.close();
  }

  summary.runs = { primaryId, resumeId, recoveryId, restartId, duplicateId };
  summary.physicalCalls = stats.calls;
  summary.exportedAttempts = counts.attempts;
  summary.exportedOutcomes = counts.outcomes;
  summary.allRunsExport = {
    directory: allExportDir,
    runs: allCounts.runs,
    outcomes: allCounts.outcomes,
    attempts: allCounts.attempts,
  };
  summary.imageFiles = verified.manifest.images.fileCount;
  writeFileSync(join(workDir, "e2e-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  log("done", `all phases passed; summary written to ${join(workDir, "e2e-summary.json")}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
