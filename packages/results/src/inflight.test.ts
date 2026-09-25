import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunCorruptError, RunVersionError } from "./errors";
import { InflightMarkerWriter, readInflightMarker } from "./inflight";

const T0 = Date.parse("2026-09-23T03:33:37.000Z");
const RUN_ID = "2026-09-23T03-33-37-000Z_c17c454e";
const ISO = new Date(T0).toISOString();

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mmstar-inflight-"));
  file = join(dir, "inflight.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function attempt(evaluationId: string, fixtureId: string, attemptNumber = 1) {
  return { evaluationId, fixtureId, attemptNumber, submittedAt: ISO };
}

describe("InflightMarkerWriter", () => {
  it("records a submitted attempt durably before the provider call", async () => {
    const writer = new InflightMarkerWriter({ file, runId: RUN_ID, now: () => T0 });
    await writer.record(attempt("alpha::default", "0"));

    const marker = readInflightMarker(RUN_ID, file);
    expect(marker).toMatchObject({ version: 1, runId: RUN_ID, updatedAt: ISO });
    expect(marker?.attempts).toEqual([attempt("alpha::default", "0")]);
  });

  it("keeps only the latest attempt for a retried fixture", async () => {
    const writer = new InflightMarkerWriter({ file, runId: RUN_ID, now: () => T0 });
    await writer.record(attempt("alpha::default", "0", 1));
    await writer.record(attempt("alpha::default", "0", 2));
    await writer.record(attempt("beta::default", "1", 1));

    const marker = readInflightMarker(RUN_ID, file);
    expect(marker?.attempts).toEqual([
      attempt("alpha::default", "0", 2),
      attempt("beta::default", "1", 1),
    ]);
  });

  it("removes finished attempts in memory and deletes the file when empty", async () => {
    const writer = new InflightMarkerWriter({ file, runId: RUN_ID, now: () => T0 });
    await writer.record(attempt("alpha::default", "0"));
    await writer.record(attempt("beta::default", "1"));

    writer.markFinished("alpha::default", "0");
    await writer.persist();
    expect(readInflightMarker(RUN_ID, file)?.attempts).toEqual([attempt("beta::default", "1")]);

    writer.markFinished("beta::default", "1");
    await writer.persist();
    expect(readInflightMarker(RUN_ID, file)).toBeNull();
  });

  it("keeps every submission when records race", async () => {
    const writer = new InflightMarkerWriter({ file, runId: RUN_ID, now: () => T0 });
    const records = Array.from({ length: 8 }, (_, index) =>
      writer.record(attempt(`e${index}::default`, "0")),
    );
    await Promise.all(records);

    // An older snapshot's rename must never overwrite a newer one: every
    // submission that resolved must still be durable in the marker file.
    const marker = readInflightMarker(RUN_ID, file);
    expect(marker?.attempts).toHaveLength(records.length);
    expect(new Set(marker?.attempts.map((entry) => entry.evaluationId)).size).toBe(records.length);
  });

  it("treats a missing marker file as empty", () => {
    expect(readInflightMarker(RUN_ID, file)).toBeNull();
  });

  it("fails closed on a corrupt marker instead of silently reissuing", () => {
    writeFileSync(file, "{ broken");
    expect(() => readInflightMarker(RUN_ID, file)).toThrow(RunCorruptError);
  });

  it("rejects an unsupported marker version", () => {
    writeFileSync(
      file,
      JSON.stringify({ version: 2, runId: RUN_ID, updatedAt: ISO, attempts: [] }),
    );
    expect(() => readInflightMarker(RUN_ID, file)).toThrow(RunVersionError);
  });

  it("clears the marker after a clean finish", async () => {
    const writer = new InflightMarkerWriter({ file, runId: RUN_ID, now: () => T0 });
    await writer.record(attempt("alpha::default", "0"));
    await writer.clear();
    expect(readInflightMarker(RUN_ID, file)).toBeNull();
  });
});
