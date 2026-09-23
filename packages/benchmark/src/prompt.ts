/**
 * Versioned prompt contract.
 *
 * The prompt is built only from the answer-free `PromptFixtureInput` projection:
 * the expected option letter is never part of model input. Changing the
 * instruction or its shape requires a `PROMPT_VERSION` bump so frozen manifests
 * remain interpretable.
 */
import type { PromptFixtureInput } from "./dataset";

export const PROMPT_VERSION = 1;

export const PROMPT_INSTRUCTION =
  'Answer the multiple-choice question about the image. Reply with only the letter of the correct option (for example "A") and nothing else.';

export interface PromptPayload {
  promptVersion: typeof PROMPT_VERSION;
  instruction: string;
  question: string;
  image: PromptFixtureInput["image"];
}

export function buildPrompt(fixture: PromptFixtureInput): PromptPayload {
  return {
    promptVersion: PROMPT_VERSION,
    instruction: PROMPT_INSTRUCTION,
    question: fixture.question,
    image: {
      mediaType: fixture.image.mediaType,
      base64: fixture.image.base64,
    },
  };
}
