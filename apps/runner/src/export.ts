/**
 * `mmstar export`: turn a run family's durable JSON into a validated,
 * immutable publication directory.
 *
 * The command selects one run (`--run <id>` or `--latest`), resolves the whole
 * family (ancestors plus descendants, so restarts and recoveries travel with the
 * experiment), reloads the committed dataset to verify the frozen hash, and
 * hands the projections to `@mmstar/results/node`. The publication itself lives
 * in `packages/results`; this module owns selection, dataset access, and CLI
 * flags.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError } from "@mmstar/config";
import type { RunManifest } from "@mmstar/results";
import { publishPublication, RunStore, reconcileRun, resolveLineage } from "@mmstar/results/node";
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
  if (runId === undefined && !latest) {
    return { ok: false, message: "provide --run <id> or --latest" };
  }
  return {
    ok: true,
    options: { runId, latest, outDir: values.get("out") ?? "publication" },
  };
}

export async function executeExport(
  context: RunContext,
  options: ExportOptions,
): Promise<CommandResult> {
  const startedAt = context.now?.() ?? Date.now();
  try {
    const store = new RunStore({ root: resolvePath(context.cwd, context.resultsRoot) });
    const selected = store.resolveSelector({
      runId: options.runId,
      latest: options.latest,
    });
    const family = collectFamily(store, selected);

    const dataset = await loadDataset(resolvePath(context.cwd, selected.plan.dataset.path));
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
    for (const run of family) {
      for (const fixtureId of run.plan.dataset.fixtureIds) {
        if (!fixtureIds.includes(fixtureId)) fixtureIds.push(fixtureId);
      }
    }
    const recordsById = new Map(dataset.records.map((record) => [record.fixtureId, record]));
    const fixtures = fixtureIds.map((fixtureId) => {
      const record = recordsById.get(fixtureId);
      if (record === undefined) {
        throw new ValidationError(`dataset ${selected.plan.dataset.path}`, [
          {
            path: `fixture ${fixtureId}`,
            code: "missing_fixture",
            message: "a selected fixture is not present in the current dataset",
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
        path: selected.plan.dataset.path,
        sha256: selected.plan.dataset.sha256,
      },
      runs,
      fixtures,
      now: () => new Date(context.now?.() ?? Date.now()),
    });

    context.emit({
      event: "export.ok",
      output: outputDir,
      selectedRun: selected.runId,
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
