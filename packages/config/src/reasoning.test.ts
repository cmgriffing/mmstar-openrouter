import { describe, expect, it } from "vitest";
import { isReasoningModesConfig, REASONING_ALL } from "./reasoning";

describe("isReasoningModesConfig", () => {
  it("accepts all and non-empty unique explicit-mode arrays", () => {
    expect(isReasoningModesConfig(REASONING_ALL)).toBe(true);
    expect(isReasoningModesConfig(["default", "high"])).toBe(true);
    expect(isReasoningModesConfig(["none"])).toBe(true);
  });

  it("rejects mixed, empty, duplicate, and non-mode forms", () => {
    expect(isReasoningModesConfig(["all", "high"])).toBe(false);
    expect(isReasoningModesConfig([])).toBe(false);
    expect(isReasoningModesConfig(["high", "high"])).toBe(false);
    expect(isReasoningModesConfig(["ultra"])).toBe(false);
    expect(isReasoningModesConfig([1])).toBe(false);
    expect(isReasoningModesConfig("ALL")).toBe(false);
    expect(isReasoningModesConfig(undefined)).toBe(false);
    expect(isReasoningModesConfig({})).toBe(false);
  });
});
