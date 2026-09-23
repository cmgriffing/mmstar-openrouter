import { describe, expect, it } from "vitest";
import {
  findModelMetadata,
  ProviderProtocolError,
  parseModelCatalogResponse,
  toCapabilitySnapshot,
} from "./provider-metadata";

const FETCHED_AT = "2026-09-23T00:00:00.000Z";

function parse(data: unknown) {
  return parseModelCatalogResponse({ data }, FETCHED_AT);
}

describe("parseModelCatalogResponse", () => {
  it("distinguishes null, omitted, and declared supported efforts", () => {
    const catalog = parse([
      {
        id: "vendor/all",
        architecture: { input_modalities: ["text", "image"] },
        reasoning: { supported_efforts: null, default_effort: "medium", default_enabled: true },
      },
      {
        id: "vendor/no-selection",
        architecture: { input_modalities: ["image"] },
        reasoning: { default_effort: "none" },
      },
      {
        id: "vendor/plain",
        architecture: { input_modalities: ["text"] },
      },
      {
        id: "vendor/declared",
        architecture: { input_modalities: ["image"] },
        reasoning: {
          supported_efforts: ["high", "low"],
          default_enabled: false,
          supports_max_tokens: true,
          mandatory: true,
        },
      },
    ]);

    expect(catalog.models.map((model) => model.reasoning)).toEqual([
      {
        supportedEfforts: null,
        defaultEffort: "medium",
        defaultEnabled: true,
        supportsMaxTokens: false,
        mandatory: null,
      },
      {
        supportedEfforts: "no-effort-selection",
        defaultEffort: "none",
        defaultEnabled: null,
        supportsMaxTokens: false,
        mandatory: null,
      },
      {
        supportedEfforts: "non-reasoning",
        defaultEffort: null,
        defaultEnabled: null,
        supportsMaxTokens: false,
        mandatory: null,
      },
      {
        supportedEfforts: ["high", "low"],
        defaultEffort: null,
        defaultEnabled: false,
        supportsMaxTokens: true,
        mandatory: true,
      },
    ]);
  });

  it("builds snapshots that mark image input and preserve metadata", () => {
    const catalog = parse([
      {
        id: "vendor/vision",
        name: "Vision",
        context_length: 128000,
        architecture: { input_modalities: ["image", "text"] },
        reasoning: { supported_efforts: null, mandatory: false },
      },
    ]);
    const metadata = findModelMetadata(catalog, "vendor/vision");
    expect(metadata).not.toBeNull();
    if (metadata === null) return;

    expect(toCapabilitySnapshot(metadata, FETCHED_AT)).toEqual({
      snapshotVersion: 1,
      modelId: "vendor/vision",
      fetchedAt: FETCHED_AT,
      imageInput: true,
      inputModalities: ["image", "text"],
      reasoning: {
        supportedEfforts: null,
        defaultEffort: null,
        defaultEnabled: null,
        supportsMaxTokens: false,
        mandatory: false,
      },
    });
    expect(findModelMetadata(catalog, "vendor/other")).toBeNull();
  });

  it("rejects catalog shapes it cannot interpret", () => {
    expect(() => parseModelCatalogResponse({}, FETCHED_AT)).toThrow(ProviderProtocolError);
    expect(() => parseModelCatalogResponse({ data: {} }, FETCHED_AT)).toThrow(
      /missing a "data" array/,
    );
    expect(() => parse([{ name: "no id" }])).toThrow(/id must be a non-empty string/);
    expect(() => parse([{ id: "a" }, { id: "a" }])).toThrow(/duplicate id/);
    expect(() => parse([{ id: "a", reasoning: { supported_efforts: "high" } }])).toThrow(
      /supported_efforts/,
    );
    expect(() => parse([{ id: "a", architecture: { input_modalities: [1] } }])).toThrow(
      /input_modalities/,
    );
    expect(() => parse([{ id: "a", reasoning: { mandatory: "yes" } }])).toThrow(/mandatory/);
    expect(() =>
      parseModelCatalogResponse({ error: { message: "maintenance" } }, FETCHED_AT),
    ).toThrow(/maintenance/);
  });
});
