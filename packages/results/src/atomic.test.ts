import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "./atomic";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mmstar-atomic-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("atomicWriteFile", () => {
  it("creates parent directories and writes the file", async () => {
    const path = join(dir, "nested", "deeper", "record.json");
    await atomicWriteFile(path, '{"a":1}');
    expect(readFileSync(path, "utf8")).toBe('{"a":1}');
  });

  it("replaces existing content without leaving temp files behind", async () => {
    const path = join(dir, "record.json");
    writeFileSync(path, "old");
    await atomicWriteFile(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readdirSync(dirname(path)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("cleans up its temp file when the final rename fails", async () => {
    const obstacle = join(dir, "obstacle");
    mkdirSync(obstacle);
    await expect(atomicWriteFile(obstacle, "new")).rejects.toBeTruthy();
    expect(readdirSync(dir)).toEqual(["obstacle"]);
  });
});
