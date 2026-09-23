import { describe, expect, it } from "vitest";
import { CONFIG_PACKAGE } from "./index";

describe("@mmstar/config scaffold", () => {
  it("exposes its package identity", () => {
    expect(CONFIG_PACKAGE).toBe("@mmstar/config");
  });
});
