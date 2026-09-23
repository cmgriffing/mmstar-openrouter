import { describe, expect, it } from "vitest";
import type { PromptFixtureInput } from "./dataset";
import { buildPrompt, PROMPT_INSTRUCTION, PROMPT_VERSION } from "./prompt";

const fixture: PromptFixtureInput = {
  fixtureId: "42",
  question: "Which option is correct?",
  image: { mediaType: "image/jpeg", base64: "AAAA" },
};

describe("buildPrompt", () => {
  it("carries the versioned instruction and image without answer data", () => {
    const prompt = buildPrompt(fixture);
    expect(prompt.promptVersion).toBe(PROMPT_VERSION);
    expect(prompt.instruction).toBe(PROMPT_INSTRUCTION);
    expect(prompt.instruction).toContain("letter");
    expect(prompt.question).toBe(fixture.question);
    expect(prompt.image).toEqual(fixture.image);
    expect(Object.keys(prompt)).toEqual(["promptVersion", "instruction", "question", "image"]);
  });
});
