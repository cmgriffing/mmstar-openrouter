/**
 * Chunk 8 verification: the `export` command end to end.
 *
 * A deterministic mock provider runs the real benchmark command, then export
 * publishes the resulting JSON family. No network, no paid request. The corrupt
 * model file scenario edits durable files directly, which is what a damaged
 * results root looks like to export.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionProvider, NormalizedCompletion, ProviderResult } from "@mmstar/benchmark";
import { openSqliteDatabase, RunStore, verifyPublication } from "@mmstar/results/node";
import { describe, expect, it } from "vitest";
import { execute, type RunContext } from "./execute";
import { executeExport, exportOptionsFromArgs } from "./export";

const T0 = Date.parse("2026-09-23T03:33:37.000Z");

/** 1x1 baseline JPEG; both fixtures share the bytes so image dedupe is exercised. */
const JPEG = [
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL",
  "/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
].join("");

const TSV_HEADER = "index\tquestion\tanswer\tcategory\tl2_category\tbench\timage";
const ROWS = [
  '0\t"Which color is the sky?"\tB\tcolor\tcolor-l2\tMMStar',
  '1\t"How many legs does a cat have?"\tA\tanimals\tanimals-l2\tMMStar',
];

function buildTsv(): string {
  return `${[TSV_HEADER, ...ROWS.map((row) => `${row}\t${JPEG}`)].join("\n")}\n`;
}

function buildConfig(): string {
  return `${JSON.stringify(
    {
      version: 1,
      dataset: { path: "fixtures.tsv" },
      execution: {
        maxConcurrentGroups: 2,
        maxRetries: 0,
        requestTimeoutMs: 5000,
        maxRequestsPerMinute: null,
        resultsRoot: "results",
      },
      models: {
        alpha: { openRouterId: "vendor/alpha", reasoningModes: ["default"], rateLimitGroup: "g1" },
        beta: { openRouterId: "vendor/beta", reasoningModes: ["default"], rateLimitGroup: "g2" },
      },
      sets: { demo: { models: ["alpha", "beta"] } },
    },
    null,
    2,
  )}\n`;
}

function success(text: string): ProviderResult<NormalizedCompletion> {
  return {
    ok: true,
    value: {
      responseId: "test-response",
      modelUsed: "vendor/alpha",
      upstreamProvider: "test-provider",
      finishReason: "stop",
      responseText: text,
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, reasoningTokens: null },
      cost: { kind: "reported", usd: 0.001 },
      rawResponse: { id: "test-response" },
    },
  };
}

const answerWith =
  (letter: string): CompletionProvider =>
  async () =>
    success(letter);

interface Harness {
  dir: string;
  context: RunContext;
  events: Record<string, unknown>[];
  stderr: string[];
  store: RunStore;
  cleanup: () => void;
}

let suffixCounter = 0;

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "mmstar-export-"));
  writeFileSync(join(dir, "fixtures.tsv"), buildTsv());
  writeFileSync(join(dir, "mmstar.config.json"), buildConfig());

  const events: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  const context: RunContext = {
    resultsRoot: join(dir, "results"),
    cwd: dir,
    configPath: join(dir, "mmstar.config.json"),
    apiKey: null,
    skipPreflight: true,
    force: false,
    now: () => T0 + suffixCounter * 1000,
    suffix: () => {
      suffixCounter += 1;
      return suffixCounter.toString(16).padStart(8, "0");
    },
    stderr: { write: (text) => stderr.push(text) },
    emit: (payload) => events.push(payload),
    revision: async () => ({ revision: "test-revision", dirty: true }),
    provider: answerWith("B"),
  };

  return {
    dir,
    context,
    events,
    stderr,
    store: new RunStore({ root: context.resultsRoot }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("exportOptionsFromArgs", () => {
  it("defaults to an all-runs export and keeps selectors targeted", () => {
    expect(exportOptionsFromArgs([])).toEqual({
      ok: true,
      options: { runId: undefined, latest: false, all: true, outDir: "publication" },
    });
    expect(exportOptionsFromArgs(["--latest", "--run", "x"])).toEqual({
      ok: false,
      message: "provide either --run <id> or --latest, not both",
    });
    expect(exportOptionsFromArgs(["--latest", "--out", "site"])).toEqual({
      ok: true,
      options: { runId: undefined, latest: true, all: false, outDir: "site" },
    });
    expect(exportOptionsFromArgs(["20260101T000000_aaaaaaaa"])).toEqual({
      ok: true,
      options: {
        runId: "20260101T000000_aaaaaaaa",
        latest: false,
        all: false,
        outDir: "publication",
      },
    });
  });
});

describe("executeExport", () => {
  it("publishes a real run family with deduplicated images and verifies it", async () => {
    const h = harness();
    try {
      const bench = await execute({ mode: "run", set: "demo" }, h.context);
      expect(bench.exitCode).toBe(0);
      const runId = h.store.listRunIds()[0] ?? "";
      expect(runId).not.toBe("");

      const result = await executeExport(h.context, {
        runId,
        latest: false,
        all: false,
        outDir: "publication",
      });
      expect(result.exitCode).toBe(0);

      const published = verifyPublication(join(h.dir, "publication"));
      expect(published.manifest.runs.runIds).toEqual([runId]);
      expect(published.manifest.runs.rootRunIds).toEqual([runId]);
      expect(published.manifest.database.counts).toEqual({
        runs: 1,
        evaluations: 2,
        fixtures: 2,
        outcomes: 4,
        attempts: 4,
      });
      // Two fixtures share identical JPEG bytes: one content-addressed asset.
      expect(published.manifest.images.fileCount).toBe(1);
      expect(published.manifest.images.entries[0]?.path).toMatch(
        /^benchmark-images\/[0-9a-f]{64}\.jpg$/,
      );
      expect(published.manifest.sources[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);

      const okEvent = h.events.find((event) => event.event === "export.ok");
      expect(okEvent).toBeDefined();
      expect(okEvent?.output).toBe(join(h.dir, "publication"));
      expect(okEvent?.mode).toBe("run");
      expect(okEvent?.runIds).toEqual([runId]);
      expect(okEvent?.rootRunIds).toEqual([runId]);
    } finally {
      h.cleanup();
    }
  });

  it("exports every run with a duplicate evaluation, then aborts by name on a corrupt run", async () => {
    const h = harness();
    try {
      expect((await execute({ mode: "run", set: "demo" }, h.context)).exitCode).toBe(0);
      expect((await execute({ mode: "run", set: "demo" }, h.context)).exitCode).toBe(0);
      const runIds = h.store.listRunIds();
      expect(runIds).toHaveLength(2);

      const exportFrom = h.events.length;
      const result = await executeExport(h.context, {
        latest: false,
        all: true,
        outDir: "publication",
      });
      expect(result.exitCode).toBe(0);

      const published = verifyPublication(join(h.dir, "publication"));
      expect(published.manifest.runs.runIds).toEqual([...runIds].sort());
      expect(published.manifest.runs.rootRunIds).toEqual([...runIds].sort());
      expect(published.manifest.database.counts).toEqual({
        runs: 2,
        evaluations: 2,
        fixtures: 2,
        outcomes: 8,
        attempts: 8,
      });

      // Both duplicate families survive in the family-effective view: neither is
      // dropped at export time; the publication-wide views resolve the winner at
      // query time.
      const database = openSqliteDatabase(join(h.dir, "publication", "benchmark.sqlite"), {
        readOnly: true,
      });
      try {
        const families = database
          .prepare("SELECT COUNT(DISTINCT root_run_id) AS n FROM v_evaluation_summary")
          .get();
        expect(Number(families?.n)).toBe(2);
      } finally {
        database.close();
      }

      const okEvent = h.events.slice(exportFrom).find((event) => event.event === "export.ok");
      expect(okEvent?.mode).toBe("all");
      expect(okEvent?.runIds).toEqual([...runIds].sort());
      expect(okEvent?.rootRunIds).toEqual([...runIds].sort());

      // A bare export aborts on the first corrupt run and names it.
      const corruptRunId = runIds[0] ?? "";
      writeFileSync(
        join(h.context.resultsRoot, corruptRunId, "models", "alpha.json"),
        "{ not json",
      );
      const failed = await executeExport(h.context, {
        latest: false,
        all: true,
        outDir: "publication",
      });
      expect(failed.exitCode).toBe(1);
      expect(h.stderr.join("")).toContain(corruptRunId);
      expect(verifyPublication(join(h.dir, "publication")).manifest.createdAt).toBe(
        published.manifest.createdAt,
      );
    } finally {
      h.cleanup();
    }
  });

  it("aborts an all-runs export when duplicate evaluation identities disagree", async () => {
    const h = harness();
    try {
      expect((await execute({ mode: "run", set: "demo" }, h.context)).exitCode).toBe(0);
      const firstRunId = h.store.listRunIds()[0] ?? "";
      expect(
        (
          await executeExport(h.context, {
            runId: firstRunId,
            latest: false,
            all: false,
            outDir: "publication",
          })
        ).exitCode,
      ).toBe(0);
      const published = verifyPublication(join(h.dir, "publication"));

      // The second primary freezes a different OpenRouter model ID under the
      // same evaluation ID; the exporter cannot publish both identity claims.
      writeFileSync(
        join(h.dir, "mmstar.config.json"),
        buildConfig().replace('"vendor/alpha"', '"vendor/alpha-v2"'),
      );
      expect((await execute({ mode: "run", set: "demo" }, h.context)).exitCode).toBe(0);

      const conflictFrom = h.events.length;
      const failed = await executeExport(h.context, {
        latest: false,
        all: true,
        outDir: "publication",
      });
      expect(failed.exitCode).toBe(1);
      const error = h.events.slice(conflictFrom).find((event) => event.event === "error");
      expect(error?.kind).toBe("PublicationConflictError");
      expect(h.stderr.join("")).toContain("disagrees with run");
      expect(verifyPublication(join(h.dir, "publication")).manifest.createdAt).toBe(
        published.manifest.createdAt,
      );
    } finally {
      h.cleanup();
    }
  });

  it("fails on a corrupt run and preserves the previous publication", async () => {
    const h = harness();
    try {
      expect((await execute({ mode: "run", set: "demo" }, h.context)).exitCode).toBe(0);
      const runId = h.store.listRunIds()[0] ?? "";
      expect(
        (
          await executeExport(h.context, {
            runId,
            latest: false,
            all: false,
            outDir: "publication",
          })
        ).exitCode,
      ).toBe(0);
      const firstCreatedAt = verifyPublication(join(h.dir, "publication")).manifest.createdAt;

      const modelFile = join(h.context.resultsRoot, runId, "models", "alpha.json");
      writeFileSync(modelFile, "{ this is not json");
      const failed = await executeExport(h.context, {
        runId,
        latest: false,
        all: false,
        outDir: "publication",
      });
      expect(failed.exitCode).toBe(1);
      expect(h.events.at(-1)?.event).toBe("error");
      expect(verifyPublication(join(h.dir, "publication")).manifest.createdAt).toBe(firstCreatedAt);
    } finally {
      h.cleanup();
    }
  });

  it("rejects a dataset whose bytes changed after the run", async () => {
    const h = harness();
    try {
      expect((await execute({ mode: "run", set: "demo" }, h.context)).exitCode).toBe(0);
      writeFileSync(join(h.dir, "fixtures.tsv"), `${buildTsv()}\n`);
      const result = await executeExport(h.context, {
        runId: h.store.listRunIds()[0] ?? "",
        latest: false,
        all: false,
        outDir: "publication",
      });
      expect(result.exitCode).toBe(2);
      expect(existsSync(join(h.dir, "publication"))).toBe(false);
      expect(h.stderr.join("")).toContain("does not match the frozen plan hash");
    } finally {
      h.cleanup();
    }
  });

  it("never publishes the API key or raw response references", async () => {
    const h = harness();
    try {
      const secret = "sk-or-test-secret-value";
      h.context.apiKey = secret;
      expect((await execute({ mode: "run", set: "demo" }, h.context)).exitCode).toBe(0);
      expect(
        (
          await executeExport(h.context, {
            runId: h.store.listRunIds()[0] ?? "",
            latest: false,
            all: false,
            outDir: "publication",
          })
        ).exitCode,
      ).toBe(0);

      const manifest = readFileSync(join(h.dir, "publication", "manifest.json"), "utf8");
      const database = readFileSync(join(h.dir, "publication", "benchmark.sqlite"));
      expect(manifest).not.toContain(secret);
      expect(database.includes(Buffer.from(secret))).toBe(false);
      expect(manifest).not.toContain("rawResponseRef");
    } finally {
      h.cleanup();
    }
  });
});
