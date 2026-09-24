import { describe, expect, it } from "vitest";
import {
  formatCount,
  formatDateTime,
  formatFraction,
  formatLatency,
  formatPercent,
  formatRange,
  formatTokens,
  formatUsd,
  shortHash,
} from "./format";

describe("format helpers", () => {
  it("keeps unknown values distinct from zero", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatPercent(null)).toBe("—");
    expect(formatLatency(null)).toBe("—");
    expect(formatTokens(null)).toBe("—");
    expect(formatUsd(null)).toBe("not reported");

    expect(formatCount(0)).toBe("0");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatLatency(0)).toBe("0 ms");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formats measured values", () => {
    expect(formatCount(1500)).toBe("1,500");
    expect(formatPercent(2 / 3)).toBe("66.7%");
    expect(formatFraction(1000, 1500)).toBe("1,000 / 1,500");
    expect(formatUsd(1.26)).toBe("$1.26");
    expect(formatUsd(0.00042)).toBe("$0.0004");
    expect(formatUsd(0.00042, 4)).toBe("$0.0004");
    expect(formatLatency(840.4)).toBe("840 ms");
    expect(formatLatency(1229.5)).toBe("1.23 s");
    expect(formatLatency(125_000)).toBe("2m 05s");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(1_049_000)).toBe("1.05M");
  });

  it("formats UTC timestamps and short hashes", () => {
    expect(formatDateTime("2026-09-23T05:58:36.453Z")).toBe("23 Sept 2026, 05:58 UTC");
    expect(formatDateTime(null)).toBe("—");
    expect(shortHash("abcdef0123456789", 12)).toBe("abcdef012345");
    expect(shortHash("short", 12)).toBe("short");
  });

  it("formats page ranges", () => {
    expect(formatRange(0, 25, 1500)).toBe("1–25 of 1,500");
    expect(formatRange(75, 25, 1500)).toBe("76–100 of 1,500");
    expect(formatRange(0, 0, 0)).toBe("0 fixtures");
  });
});
