import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./global.css", import.meta.url), "utf8");

/**
 * Regression guard for the comparison island. The mobile card layout sets an
 * author `display` value on table rows, which beats the user-agent `[hidden]`
 * rule; the category matrix filters its rows with `hidden`, so this override
 * must stay in place.
 */
describe("hidden data-table rows", () => {
  it("re-asserts display:none for hidden rows", () => {
    expect(css).toMatch(/\.data-table tbody tr\[hidden\]\s*\{[^}]*display:\s*none/);
  });
});
