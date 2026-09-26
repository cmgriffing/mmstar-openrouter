/**
 * `mmstar export`: turn durable run JSON into a validated, immutable
 * publication directory.
 *
 * With no selector the command exports every run in the results root; `--run
 * <id>` (or a positional ID) and `--latest` stay targeted and resolve the whole
 * family (ancestors plus descendants, so restarts and recoveries travel with the
 * experiment). Either way it reloads the committed dataset to verify the frozen
 * hashes, and hands the projections to `@mmstar/results/node`. The publication
 * itself lives in `packages/results`; this module owns selection, dataset
 * access, and CLI flags.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "@mmstar/config";
import type { RunManifest } from "@mmstar/results";
import { canonicalJson, PublicationConflictError } from "@mmstar/results";
import {
  publishPublication,
  RunNotFoundError,
  RunStore,
  reconcileRun,
  resolveLineage,
} from "@mmstar/results/node";
import {
  type CommandResult,
  loadDataset,
  type RunContext,
  reportError,
  resolvePath,
} from "./execute";
import { flagsForCommand, parseFlags } from "./flags";

export interface ExportOptions {
  runId?: string | undefined;
  latest: boolean;
  /**
   * Informational: true when no selector was given. Selectors stay
   * authoritative in `resolveExportSelection`, so a contradictory flag cannot
   * pick a different run set than the CLI parsed.
   */
  all: boolean;
  /** Publication output directory, relative to the working directory. */
  outDir: string;
}

export function exportOptionsFromArgs(
  args: readonly string[],
): { ok: true; options: ExportOptions } | { ok: false; message: string } {
  const parsed = parseFlags(args, flagsForCommand("export"));
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const { values, booleans, positionals } = parsed.flags;
  if (positionals.length > 1) return { ok: false, message: "only one run may be selected" };
  const runId = values.get("run") ?? positionals[0];
  const latest = booleans.has("latest");
  if (runId !== undefined && latest) {
    return { ok: false, message: "provide either --run <id> or --latest, not both" };
  }
  return {
    ok: true,
    options: {
      runId,
      latest,
      all: runId === undefined && !latest,
      outDir: values.get("out") ?? "publication",
    },
  };
}

interface ExportSelection {
  mode: "all" | "run" | "latest";
  /** Runs to project, in projection order. */
  runs: RunManifest[];
  /** The run named by a targeted selector; null for an all-runs export. */
  selectedRunId: string | null;
  /** Dataset to load; every selected run's frozen hash must match it. */
  dataset: { path: string; sha256: string };
}

/**
 * Resolve what a bare or targeted export publishes. A bare export enumerates
 * every run in the results root (including every family), while selectors keep
 * the existing single-family behavior.
 */
export function resolveExportSelection(store: RunStore, options: ExportOptions): ExportSelection {
  const targeted = options.runId !== undefined || options.latest;
  if (!targeted) {
    const runIds = store.listRunIds();
    if (runIds.length === 0) throw new RunNotFoundError("any run", store.root);
    const runs = runIds.map((runId) => store.readManifest(runId));
    const first = runs[0];
    if (first === undefined) throw new RunNotFoundError("any run", store.root);
    return {
      mode: "all",
      runs,
      selectedRunId: null,
      dataset: { path: first.plan.dataset.path, sha256: first.plan.dataset.sha256 },
    };
  }
  const selected = store.resolveSelector({ runId: options.runId, latest: options.latest });
  return {
    mode: options.latest ? "latest" : "run",
    runs: collectFamily(store, selected),
    selectedRunId: selected.runId,
    dataset: { path: selected.plan.dataset.path, sha256: selected.plan.dataset.sha256 },
  };
}

export async function executeExport(
  context: RunContext,
  options: ExportOptions,
): Promise<CommandResult> {
  const startedAt = context.now?.() ?? Date.now();
  try {
    const store = new RunStore({ root: resolvePath(context.cwd, context.resultsRoot) });
    const selection = resolveExportSelection(store, options);
    const family = selection.runs;

    const dataset = await loadDataset(resolvePath(context.cwd, selection.dataset.path));
    for (const run of family) {
      if (run.plan.dataset.sha256 !== dataset.sha256) {
        throw new ValidationError("publication", [
          {
            path: `runs.${run.runId}.plan.dataset.sha256`,
            code: "dataset_changed",
            message: `dataset hash ${dataset.sha256} does not match the frozen plan hash ${run.plan.dataset.sha256}; re-run the experiment instead of publishing mismatched sources`,
          },
        ]);
      }
    }

    const fixtureIds: string[] = [];
    const fixtureOwner = new Map<string, string>();
    for (const run of family) {
      for (const fixtureId of run.plan.dataset.fixtureIds) {
        if (fixtureOwner.has(fixtureId)) continue;
        fixtureOwner.set(fixtureId, run.runId);
        fixtureIds.push(fixtureId);
      }
    }
    const recordsById = new Map(dataset.records.map((record) => [record.fixtureId, record]));
    const fixtures = fixtureIds.map((fixtureId) => {
      const record = recordsById.get(fixtureId);
      if (record === undefined) {
        const owner = fixtureOwner.get(fixtureId) ?? "unknown";
        throw new ValidationError(`dataset ${selection.dataset.path}`, [
          {
            path: `runs.${owner}.plan.dataset.fixtureIds`,
            code: "missing_fixture",
            message: `run ${owner} plans fixture ${fixtureId}, which is not present in the current dataset`,
          },
        ]);
      }
      return {
        fixtureId: record.fixtureId,
        question: record.question,
        answer: record.answer,
        category: record.category,
        l2Category: record.l2Category,
        bench: record.bench,
        image: { mediaType: record.image.mediaType, base64: record.image.base64 },
      };
    });

    assertConsistentEvaluationIdentities(family);
    const runs = family.map((run) => ({
      manifest: run,
      evaluations: reconcileRun(store, run.runId).evaluations,
      sourceSha256: hashRunSource(store, run.runId),
    }));

    const outputDir = resolvePath(context.cwd, options.outDir);
    const result = await publishPublication({
      outputDir,
      resultsRoot: resolvePath(context.cwd, context.resultsRoot),
      dataset: {
        path: selection.dataset.path,
        sha256: selection.dataset.sha256,
      },
      runs,
      fixtures,
      now: () => new Date(context.now?.() ?? Date.now()),
    });

    context.emit({
      event: "export.ok",
      output: outputDir,
      mode: selection.mode,
      selectedRun: selection.selectedRunId,
      runIds: result.manifest.runs.runIds,
      rootRunIds: result.manifest.runs.rootRunIds,
      counts: result.manifest.database.counts,
      databaseBytes: result.databaseBytes,
      images: {
        files: result.imageFiles,
        bytes: result.imageBytes,
        directory: result.manifest.images.directory,
      },
      durationMs: (context.now?.() ?? Date.now()) - startedAt,
    });
    return { exitCode: 0 };
  } catch (error) {
    return reportError(error, context);
  }
}

/**
 * Fail before projection when two selected runs share an evaluation ID but
 * disagree on model identity or routing: the evaluations table has one row per
 * ID, so publishing both would either overwrite or silently misattribute rows.
 * The error names the run that introduced the conflict so it can be pruned or
 * renamed.
 */
export function assertConsistentEvaluationIdentities(runs: readonly RunManifest[]): void {
  const seen = new Map<string, { runId: string; identity: string }>();
  for (const run of runs) {
    for (const evaluation of run.plan.evaluations) {
      const identity = canonicalJson({
        modelAlias: evaluation.modelAlias,
        openRouterId: evaluation.openRouterId,
        reasoningMode: evaluation.reasoningMode,
        rateLimitGroup: evaluation.rateLimitGroup,
        provider: evaluation.provider ?? null,
      });
      const existing = seen.get(evaluation.evaluationId);
      if (existing === undefined) {
        seen.set(evaluation.evaluationId, { runId: run.runId, identity });
        continue;
      }
      if (existing.identity !== identity) {
        throw new PublicationConflictError(
          evaluation.evaluationId,
          `run ${run.runId} disagrees with run ${existing.runId} on this evaluation's model identity or routing; rename the alias when model configuration changes`,
        );
      }
    }
  }
}

/**
 * Resolve the run family: climb parent links to the topmost readable ancestor,
 * then take every descendant in creation order. A missing parent is treated as
 * the top so a pruned results root still exports deterministically.
 */
export function collectFamily(store: RunStore, selected: RunManifest): RunManifest[] {
  let root = selected;
  for (let depth = 0; depth < 64; depth += 1) {
    const parentId = root.lineage.parentRunId;
    if (parentId === null) break;
    let parent: RunManifest;
    try {
      parent = store.readManifest(parentId);
    } catch {
      break;
    }
    root = parent;
  }
  return resolveLineage(store, root).runs;
}

/** SHA-256 over the exact manifest and model-record bytes that are imported. */
export function hashRunSource(store: RunStore, runId: string): string {
  const paths = store.paths(runId);
  const hash = createHash("sha256");
  hash.update("manifest\0");
  hash.update(readFileSync(paths.manifestFile));
  let names: string[] = [];
  try {
    names = readdirSync(paths.modelsDir)
      .filter((name) => name.endsWith(".json") && !name.includes(".tmp-"))
      .sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    hash.update(`model:${name}\0`);
    hash.update(readFileSync(join(paths.modelsDir, name)));
  }
  return hash.digest("hex");
}
