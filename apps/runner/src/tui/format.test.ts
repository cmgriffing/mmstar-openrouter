import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatDuration,
  formatPercent,
  formatProgress,
  formatProgressBar,
  outcomeStateToken,
  statusToken,
} from "./format";

describe("formatDuration", () => {
  it("renders sub-minute durations in seconds with one decimal", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(1_500)).toBe("1.5s");
    expect(formatDuration(59_940)).toBe("59.9s");
  });

  it("renders minutes and hours with zero-padded remainders", () => {
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(3_725_000)).toBe("1h 02m");
  });

  it("returns a placeholder for unknown values", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("formatCountdown", () => {
  it("rounds up to whole seconds so a live countdown never shows 0 early", () => {
    expect(formatCountdown(4_001)).toBe("5s");
    expect(formatCountdown(4_000)).toBe("4s");
  });

  it("renders minutes and seconds and clamps elapsed cooldowns", () => {
    expect(formatCountdown(63_000)).toBe("1m 03s");
    expect(formatCountdown(0)).toBe("0s");
    expect(formatCountdown(-500)).toBe("0s");
    expect(formatCountdown(null)).toBe("0s");
  });
});

describe("formatPercent", () => {
  it("renders a rounded percentage", () => {
    expect(formatPercent(0.615)).toBe("62%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("never invents a value for an unknown ratio", () => {
    expect(formatPercent(null)).toBe("—");
  });
});

describe("progress helpers", () => {
  it("draws a fixed-width bar and clamps out-of-range input", () => {
    expect(formatProgressBar(0, 10, 10)).toBe("----------");
    expect(formatProgressBar(3, 10, 10)).toBe("###-------");
    expect(formatProgressBar(10, 10, 10)).toBe("##########");
    expect(formatProgressBar(11, 10, 10)).toBe("##########");
  });

  it("handles an empty selection without dividing by zero", () => {
    expect(formatProgressBar(0, 0, 5)).toBe("-----");
    expect(formatProgress(0, 0)).toBe("0/0 —");
  });

  it("renders done/total with a percentage", () => {
    expect(formatProgress(3, 10)).toBe("3/10 30%");
  });
});

describe("status tokens", () => {
  it("labels every row status without relying on color", () => {
    expect(statusToken("queued")).toBe("[WAIT]");
    expect(statusToken("running")).toBe("[RUN]");
    expect(statusToken("cooldown")).toBe("[COOL]");
    expect(statusToken("done")).toBe("[DONE]");
    expect(statusToken("failed")).toBe("[FAIL]");
  });

  it("labels every outcome state without relying on color", () => {
    expect(outcomeStateToken("pending")).toBe("PEND");
    expect(outcomeStateToken("settled")).toBe("OK");
    expect(outcomeStateToken("failed")).toBe("FAIL");
    expect(outcomeStateToken("indeterminate")).toBe("INDET");
    expect(outcomeStateToken("cancelled")).toBe("CANCEL");
  });
});
