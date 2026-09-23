import { describe, expect, it } from "vitest";
import committedSchema from "../../../mmstar.config.schema.json";
import { buildConfigJsonSchema, generateConfigSchemaJson } from "./schema";

describe("generated config schema", () => {
  it("stays in sync with the committed editor schema", () => {
    // Compare serialized text (not objects) so key order changes also fail.
    expect(generateConfigSchemaJson()).toBe(`${JSON.stringify(committedSchema, null, 2)}\n`);
  });

  it("describes the version, defaults, and closed objects", () => {
    const schema = buildConfigJsonSchema() as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { const?: number }>;
      $defs: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["version", "models", "sets"]);
    expect(schema.properties.version?.const).toBe(1);
    expect(schema.$defs.modelAlias).toBeDefined();
    expect(schema.$defs.execution).toBeDefined();
    expect(schema.$defs.set).toBeDefined();
  });
});
