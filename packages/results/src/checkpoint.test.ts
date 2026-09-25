import { afterEach, describe, expect, it, vi } from "vitest";
import { type CheckpointSnapshot, CheckpointWriter } from "./checkpoint";
import type { ModelRecordFile, RunManifest } from "./records";

afterEach(() => {
  vi.useRealTimers();
});

function manifest(updatedAt: string): RunManifest {
  return { runId: "run-1", updatedAt } as RunManifest;
}

function snapshot(updatedAt: string): CheckpointSnapshot {
  return { manifest: manifest(updatedAt), files: [] as ModelRecordFile[] };
}

describe("CheckpointWriter", () => {
  it("coalesces a burst of dirty marks into one periodic write of the latest snapshot", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let latest = "0";
    const writer = new CheckpointWriter({
      snapshot: () => snapshot(latest),
      write: async (value) => {
        writes.push(value.manifest.updatedAt);
      },
      intervalMs: 1000,
    });

    for (let i = 1; i <= 50; i += 1) {
      latest = String(i);
      writer.markDirty();
    }
    await vi.advanceTimersByTimeAsync(1000);

    expect(writes).toEqual(["50"]);
    await writer.dispose();
  });

  it("keeps at most one write in flight and then writes the newest state", async () => {
    vi.useFakeTimers();
    const pending: (() => void)[] = [];
    const writes: string[] = [];
    let latest = "first";
    const writer = new CheckpointWriter({
      snapshot: () => snapshot(latest),
      write: async (value) => {
        writes.push(value.manifest.updatedAt);
        await new Promise<void>((resolve) => pending.push(resolve));
      },
      intervalMs: 1000,
    });

    writer.markDirty();
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual(["first"]);

    latest = "second";
    writer.markDirty();
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual(["first"]); // still one in flight

    pending.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual(["first", "second"]);
    pending.shift()?.();
    await writer.dispose();
  });

  it("flush writes pending state and awaits it", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    let latest = "0";
    const writer = new CheckpointWriter({
      snapshot: () => snapshot(latest),
      write: async (value) => {
        writes.push(value.manifest.updatedAt);
      },
      intervalMs: 1000,
    });

    latest = "1";
    writer.markDirty();
    latest = "2";
    writer.markDirty();
    await writer.flush();
    expect(writes).toEqual(["2"]);

    // A second flush with nothing pending does not write again.
    await writer.flush();
    expect(writes).toEqual(["2"]);
    await writer.dispose();
  });

  it("writes nothing after dispose", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const writer = new CheckpointWriter({
      snapshot: () => snapshot("1"),
      write,
      intervalMs: 1000,
    });

    await writer.dispose();
    writer.markDirty();
    await vi.advanceTimersByTimeAsync(5000);
    expect(write).not.toHaveBeenCalled();
  });

  it("reports a failed write without losing later state", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    let calls = 0;
    const writer = new CheckpointWriter({
      snapshot: () => snapshot("1"),
      write: async () => {
        calls += 1;
        if (calls === 1) throw new Error("disk full");
      },
      intervalMs: 1000,
      onError: (error) => errors.push(error),
    });

    writer.markDirty();
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toHaveLength(1);

    writer.markDirty();
    await writer.flush();
    expect(calls).toBe(2);
    await writer.dispose();
  });
});
