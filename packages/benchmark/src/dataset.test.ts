import { readFileSync } from "node:fs";
import { sha256Hex } from "@mmstar/config";
import { describe, expect, it } from "vitest";
import type { FixtureRecord } from "./dataset";
import {
  DATASET_COLUMNS,
  DatasetParseError,
  DatasetTsvParser,
  parseDatasetTsv,
  toPromptFixture,
} from "./dataset";

const DATASET_URL = new URL("../../../MMStar.tsv", import.meta.url);
/** Frozen source hash of the committed dataset; a change here must be deliberate. */
const DATASET_SHA256 = "38a99f4a33743665e6990961a9a0072b07f7ac6a74d1555b43c4f82145377cb4";

const JPEG_BASE64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]).toString("base64");

function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function row(index: number, question: string, image = JPEG_BASE64, answer = "A"): string {
  return [
    String(index),
    quoted(question),
    answer,
    "coarse perception",
    "image scene and topic",
    "MMBench",
    image,
  ].join("\t");
}

function dataset(rows: string[], eol = "\n"): string {
  return `${[DATASET_COLUMNS.join("\t"), ...rows].join(eol)}${eol}`;
}

describe("DatasetTsvParser", () => {
  it("parses quoted fields with newlines, tabs, escaped quotes, and CRLF", () => {
    const question = 'Which one?\r\nOptions: A: "alpha"\tB: beta';
    const text = dataset([row(0, question)], "\r\n");
    const { fixtures } = parseDatasetTsv(text);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]?.question).toBe('Which one?\nOptions: A: "alpha"\tB: beta');
    expect(fixtures[0]?.fixtureId).toBe("0");
    expect(fixtures[0]?.answer).toBe("A");
    expect(fixtures[0]?.image.mediaType).toBe("image/jpeg");
    expect(fixtures[0]?.image.byteLength).toBeGreaterThan(0);
  });

  it("produces identical results when chunks split anywhere", () => {
    const text = dataset([row(0, 'Line one\nLine "two"\ttab'), row(1, "simple")]);
    const expected = parseDatasetTsv(text).fixtures;

    for (const size of [1, 3, 7, 13]) {
      const parser = new DatasetTsvParser();
      const collected: FixtureRecord[] = [];
      for (let offset = 0; offset < text.length; offset += size) {
        collected.push(...parser.push(text.slice(offset, offset + size)));
      }
      parser.finish();
      expect(collected).toEqual(expected);
    }
  });

  it("accepts a final row without a trailing newline and ignores blank lines", () => {
    const text = `${DATASET_COLUMNS.join("\t")}\n\n${row(0, "one")}`;
    const { fixtures } = parseDatasetTsv(text);
    expect(fixtures.map((fixture) => fixture.fixtureId)).toEqual(["0"]);
  });

  it("reports duplicates, malformed rows, and invalid images with row paths", () => {
    const cases: Array<{ text: string; code: string }> = [
      { text: dataset([row(0, "one"), row(0, "two")]), code: "duplicate_fixture" },
      {
        text: dataset([row(0, "one", "not-base64!!")]),
        code: "invalid_image",
      },
      {
        text: dataset([
          row(0, "one", Buffer.from("GIF89a padding padding padding").toString("base64")),
        ]),
        code: "invalid_image",
      },
      { text: dataset(["0\tone\tA\tcategory\tl2\tbench"]), code: "invalid_columns" },
      { text: dataset([row(0, "   ")]), code: "missing_field" },
      { text: dataset([row(0, "one", JPEG_BASE64, "E1")]), code: "invalid_answer" },
      { text: `${["wrong", "header"].join("\t")}\n${row(0, "one")}`, code: "invalid_header" },
      { text: `${DATASET_COLUMNS.join("\t")}\n0\t"unclosed`, code: "unterminated_quote" },
      { text: dataset([row(0, "one")]), code: "field_too_large" },
    ];

    for (const testCase of cases) {
      const options = testCase.code === "field_too_large" ? { maxFieldChars: 8 } : {};
      try {
        parseDatasetTsv(testCase.text, options);
        throw new Error(`expected ${testCase.code} to throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(DatasetParseError);
        const codes = (error as DatasetParseError).issues.map((issue) => issue.code);
        expect(codes).toContain(testCase.code);
      }
    }
  });

  it("reports the data row number for malformed rows", () => {
    try {
      parseDatasetTsv(dataset([row(0, "one"), row(0, "two")]));
      throw new Error("expected duplicate fixture to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetParseError);
      const issue = (error as DatasetParseError).issues[0];
      expect(issue?.code).toBe("duplicate_fixture");
      expect(issue?.path).toBe("row 3");
    }
  });

  it("parses and validates the committed dataset", { timeout: 120_000 }, async () => {
    const text = readFileSync(DATASET_URL, "utf8");
    const { fixtures, summary } = parseDatasetTsv(text);

    expect(summary.fixtureCount).toBe(1500);
    expect(summary.categories).toEqual([
      { name: "coarse perception", count: 250 },
      { name: "fine-grained perception", count: 250 },
      { name: "instance reasoning", count: 250 },
      { name: "logical reasoning", count: 250 },
      { name: "math", count: 250 },
      { name: "science & technology", count: 250 },
    ]);
    expect(summary.l2Categories).toHaveLength(18);
    expect(summary.imageMediaTypes).toEqual([{ name: "image/jpeg", count: 1500 }]);
    expect(new Set(fixtures.map((fixture) => fixture.fixtureId)).size).toBe(1500);
    expect(Math.min(...fixtures.map((fixture) => fixture.index))).toBe(0);
    expect(Math.max(...fixtures.map((fixture) => fixture.index))).toBe(1499);
    expect(Math.max(...fixtures.map((fixture) => fixture.question.length))).toBeLessThanOrEqual(
      1802,
    );

    expect(await sha256Hex(text)).toBe(DATASET_SHA256);
  });

  it("projects fixtures to prompt input without the expected answer", () => {
    const fixture = parseDatasetTsv(dataset([row(0, "one", JPEG_BASE64, "C")])).fixtures[0];
    expect(fixture).toBeDefined();
    const prompt = toPromptFixture(fixture as FixtureRecord);
    expect("answer" in prompt).toBe(false);
    expect(JSON.stringify(prompt)).not.toContain("expectedAnswer");
    expect(prompt.image.base64).toBe(JPEG_BASE64);
    expect(prompt.question).toBe("one");
  });
});
