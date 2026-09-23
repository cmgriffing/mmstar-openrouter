/**
 * Versioned scorer contract.
 *
 * Deterministic option parsing and outcome classification land in chunk 4. This
 * module fixes the interface and version so persisted outcomes stay attributable
 * to a scoring rule: an incorrect answer is terminal and never triggers a
 * quality retry, and ambiguous, invalid, refused, or truncated responses are
 * distinct classifications rather than transport failures.
 */
import type { OutcomeKind } from "@mmstar/results";

export const SCORER_VERSION = 1;

export interface ScoreInput {
  /** Model response text, or null when the provider returned no content. */
  responseText: string | null;
  /** Provider finish reason when reported, else null. */
  finishReason: string | null;
  expectedAnswer: string;
}

export interface ScoreResult {
  scorerVersion: typeof SCORER_VERSION;
  outcome: OutcomeKind;
  parsedAnswer: string | null;
}

export interface Scorer {
  readonly version: typeof SCORER_VERSION;
  score(input: ScoreInput): ScoreResult;
}
