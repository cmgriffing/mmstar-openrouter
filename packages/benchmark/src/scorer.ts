/**
 * Versioned scorer contract and deterministic option parser.
 *
 * `createOptionScorer` is the implementation chunk 4 added: a response is
 * classified as a terminal outcome exactly once, and an incorrect (or
 * ambiguous, invalid, refused, or truncated) answer never triggers a quality
 * retry. The expected answer is compared locally and is never sent upstream.
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

/**
 * MMStar questions offer exactly four options, so an unambiguous answer is one
 * distinct letter among A-D. The parser is deliberately narrow: lowercase
 * prose, question echoes, and any other letter are not answers.
 */
export const OPTION_LETTERS = ["A", "B", "C", "D"] as const;

const OPTION_REGEX = /(?<![A-Za-z])([A-D])(?![A-Za-z])/g;

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bi(?:\s+am|'m)?\s+(?:cannot|can't|can not|unable|not able|must decline|have to decline)\b/i,
  /\bunable to (?:answer|help|assist|determine)\b/i,
];

/** Deterministic option parser and outcome classifier for this benchmark. */
export function createOptionScorer(): Scorer {
  return {
    version: SCORER_VERSION,
    score(input: ScoreInput): ScoreResult {
      const base = { scorerVersion: SCORER_VERSION } as const;
      if (input.finishReason === "length") {
        return { ...base, outcome: "truncated", parsedAnswer: null };
      }
      if (input.finishReason === "content_filter") {
        return { ...base, outcome: "refused", parsedAnswer: null };
      }

      const letters =
        input.responseText === null ? new Set<string>() : parseOptionLetters(input.responseText);
      if (letters.size === 1) {
        const [parsedAnswer] = letters;
        if (parsedAnswer === undefined) return { ...base, outcome: "invalid", parsedAnswer: null };
        return {
          ...base,
          outcome: parsedAnswer === input.expectedAnswer ? "correct" : "incorrect",
          parsedAnswer,
        };
      }
      if (letters.size > 1) return { ...base, outcome: "ambiguous", parsedAnswer: null };
      if (input.responseText !== null && isRefusal(input.responseText)) {
        return { ...base, outcome: "refused", parsedAnswer: null };
      }
      return { ...base, outcome: "invalid", parsedAnswer: null };
    },
  };
}

function parseOptionLetters(text: string): Set<string> {
  const letters = new Set<string>();
  for (const match of text.matchAll(OPTION_REGEX)) {
    const letter = match[1];
    if (letter !== undefined) letters.add(letter);
  }
  return letters;
}

function isRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}
