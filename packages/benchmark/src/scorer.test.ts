import { describe, expect, it } from "vitest";
import { createOptionScorer } from "./scorer";

const scorer = createOptionScorer();

function score(
  responseText: string | null,
  expectedAnswer = "A",
  finishReason: string | null = "stop",
) {
  return scorer.score({ responseText, finishReason, expectedAnswer });
}

describe("createOptionScorer", () => {
  it("scores a bare option letter against the expected answer", () => {
    expect(score("A")).toMatchObject({ outcome: "correct", parsedAnswer: "A" });
    expect(score("B")).toMatchObject({ outcome: "incorrect", parsedAnswer: "B" });
  });

  it("parses the letter through markdown emphasis and punctuation", () => {
    expect(score("**C**")).toMatchObject({ outcome: "incorrect", parsedAnswer: "C" });
    expect(score("`D`.")).toMatchObject({ outcome: "incorrect", parsedAnswer: "D" });
    expect(score("(B)")).toMatchObject({ outcome: "incorrect", parsedAnswer: "B" });
  });

  it("parses a letter named in answer prose", () => {
    expect(score("The answer is D.")).toMatchObject({ outcome: "incorrect", parsedAnswer: "D" });
    expect(score("Correct answer: A")).toMatchObject({ outcome: "correct", parsedAnswer: "A" });
  });

  it("treats repeated mention of one option as an unambiguous answer", () => {
    expect(score("A. Option A.")).toMatchObject({ outcome: "correct", parsedAnswer: "A" });
  });

  it("classifies multiple distinct option letters as ambiguous", () => {
    const result = score(
      "Options: A: the suitcase, B: the cat, C: the bed, D: the book. The answer is D.",
    );
    expect(result.outcome).toBe("ambiguous");
    expect(result.parsedAnswer).toBeNull();
  });

  it("rejects lowercase letters because the instruction requires an option letter", () => {
    expect(score("a")).toMatchObject({ outcome: "invalid", parsedAnswer: null });
  });

  it("classifies a refusal with no option letter as refused", () => {
    expect(score("I cannot answer this question.")).toMatchObject({
      outcome: "refused",
      parsedAnswer: null,
    });
    expect(score("I'm unable to help with that.")).toMatchObject({ outcome: "refused" });
  });

  it("classifies prose without an option letter as invalid", () => {
    expect(score("The image shows a suitcase and a book.")).toMatchObject({
      outcome: "invalid",
      parsedAnswer: null,
    });
    expect(score(null)).toMatchObject({ outcome: "invalid", parsedAnswer: null });
  });

  it("classifies a length-truncated response as truncated before parsing", () => {
    expect(score("A", "A", "length")).toMatchObject({ outcome: "truncated", parsedAnswer: null });
  });

  it("classifies a content-filtered response as refused", () => {
    expect(score("A", "A", "content_filter")).toMatchObject({
      outcome: "refused",
      parsedAnswer: null,
    });
  });

  it("reports the scorer version on every result", () => {
    expect(score("A").scorerVersion).toBe(1);
  });
});
