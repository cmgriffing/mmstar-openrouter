import { describe, expect, it } from "vitest";
import { BENCHMARK_PACKAGE } from "./index";

describe("@mmstar/benchmark scaffold", () => {
  it("exposes its package identity", () => {
    expect(BENCHMARK_PACKAGE).toBe("@mmstar/benchmark");
  });
});
