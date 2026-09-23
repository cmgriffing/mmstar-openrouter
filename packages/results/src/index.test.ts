import { describe, expect, it } from "vitest";
import { RESULTS_PACKAGE } from "./index";

describe("@mmstar/results scaffold", () => {
  it("exposes its package identity", () => {
    expect(RESULTS_PACKAGE).toBe("@mmstar/results");
  });
});
