/**
 * MMStar TSV ingestion: a bounded, stateful parser for the committed dataset.
 *
 * The file is RFC 4180-style TSV: fields are tab-separated, and fields that
 * contain newlines or tabs (the `question` column) are double-quoted with
 * doubled quotes for literal quotes. The base64 image column is unquoted.
 *
 * Parsing is incremental (`push`/`finish`) so the runner can stream a 59 MB file
 * without holding every intermediate value, and bounds on records, fields,
 * question size, image size, and total input reject runaway input instead of
 * growing without limit. Validation failures accumulate into a single error with
 * row paths rather than stopping at the first malformed row.
 */
import type { ValidationIssue } from "@mmstar/config";
import { ValidationError } from "@mmstar/config";

export const DATASET_COLUMNS = [
  "index",
  "question",
  "answer",
  "category",
  "l2_category",
  "bench",
  "image",
] as const;

export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export interface FixtureImage {
  mediaType: ImageMediaType;
  /** Raw base64 (no data URI prefix) exactly as committed in the dataset. */
  base64: string;
  byteLength: number;
}

export interface FixtureRecord {
  /** Canonical decimal index from the dataset, unique across fixtures. */
  fixtureId: string;
  index: number;
  question: string;
  /** Expected option letter; kept for scoring/audit, never sent to a model. */
  answer: string;
  category: string;
  l2Category: string;
  bench: string;
  image: FixtureImage;
}

/** Prompt-safe projection: no expected answer or dataset-internal IDs. */
export interface PromptFixtureInput {
  fixtureId: string;
  question: string;
  image: {
    mediaType: ImageMediaType;
    base64: string;
  };
}

export interface DatasetCount {
  name: string;
  count: number;
}

export interface DatasetSummary {
  fixtureCount: number;
  categories: DatasetCount[];
  l2Categories: DatasetCount[];
  benches: DatasetCount[];
  imageMediaTypes: DatasetCount[];
}

export interface ParsedDataset {
  fixtures: FixtureRecord[];
  summary: DatasetSummary;
}

export interface DatasetParseOptions {
  maxRecords: number;
  maxFieldChars: number;
  maxQuestionChars: number;
  maxImageBytes: number;
  maxTotalChars: number;
  /** Stop collecting after this many failures; the error still reports them all. */
  maxFailures: number;
}

export const DATASET_PARSE_DEFAULTS: DatasetParseOptions = {
  maxRecords: 20_000,
  maxFieldChars: 8_000_000,
  maxQuestionChars: 65_536,
  maxImageBytes: 8_000_000,
  maxTotalChars: 256_000_000,
  maxFailures: 50,
};

export class DatasetParseError extends ValidationError {
  constructor(issues: readonly ValidationIssue[]) {
    super("MMStar.tsv", issues);
    this.name = "DatasetParseError";
  }
}

const INDEX_REGEX = /^(0|[1-9][0-9]*)$/;
const ANSWER_REGEX = /^[A-Z]$/;
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Base64 characters needed to inspect 18 decoded bytes (enough for all magic numbers). */
const IMAGE_HEAD_CHARS = 24;

type ParserState = "field" | "quoted" | "afterQuote";

export class DatasetTsvParser {
  private readonly options: DatasetParseOptions;
  private state: ParserState = "field";
  private readonly fieldParts: string[] = [];
  private readonly rowFields: string[] = [];
  private readonly fixtureIds = new Set<string>();
  private readonly failures: ValidationIssue[] = [];
  private headerSeen = false;
  private aborted = false;
  private totalChars = 0;
  private completedRows = 0;
  private emitted: FixtureRecord[] = [];

  constructor(options: Partial<DatasetParseOptions> = {}) {
    this.options = { ...DATASET_PARSE_DEFAULTS, ...options };
  }

  get failureCount(): number {
    return this.failures.length;
  }

  /** Consume one chunk and return fixtures completed inside it. */
  push(chunk: string): FixtureRecord[] {
    if (this.aborted) return [];
    this.emitted = [];
    this.totalChars += chunk.length;
    if (this.totalChars > this.options.maxTotalChars) {
      this.addFailure(
        "",
        "dataset_too_large",
        `dataset exceeds the ${this.options.maxTotalChars}-character parse limit`,
      );
      this.aborted = true;
      return this.emitted;
    }

    let i = 0;
    const len = chunk.length;
    while (i < len && !this.aborted) {
      const code = chunk.charCodeAt(i);

      // Carriage returns are ignored everywhere: CRLF is normalized to LF, and
      // a CR inside a quoted field is dropped.
      if (code === 13) {
        i += 1;
        continue;
      }

      if (this.state === "quoted") {
        if (code === 34) {
          // A doubled quote escapes one literal quote; when the closing quote is
          // the last character of a chunk, `afterQuote` handles a doubled quote
          // that starts the next chunk.
          if (i + 1 < len && chunk.charCodeAt(i + 1) === 34) {
            this.fieldParts.push('"');
            i += 2;
            continue;
          }
          this.state = "afterQuote";
          i += 1;
          continue;
        }
        const start = i;
        while (i < len) {
          const current = chunk.charCodeAt(i);
          if (current === 34 || current === 13) break;
          i += 1;
        }
        this.fieldParts.push(chunk.slice(start, i));
        continue;
      }

      if (this.state === "afterQuote") {
        if (code === 34) {
          this.fieldParts.push('"');
          this.state = "quoted";
          i += 1;
          continue;
        }
        if (code === 9) {
          this.endField();
          i += 1;
          continue;
        }
        if (code === 10) {
          this.endRow();
          i += 1;
          continue;
        }
        this.addFailure(
          this.rowPath(),
          "malformed_quote",
          "unexpected character after a closing quote",
        );
        this.aborted = true;
        return this.emitted;
      }

      // Unquoted field: scan up to the next tab, newline, CR, or quote.
      const start = i;
      while (i < len) {
        const current = chunk.charCodeAt(i);
        if (current === 9 || current === 10 || current === 13 || current === 34) break;
        i += 1;
      }
      if (i > start) this.fieldParts.push(chunk.slice(start, i));
      if (i >= len) continue;

      const current = chunk.charCodeAt(i);
      if (current === 9) {
        this.endField();
        i += 1;
        continue;
      }
      if (current === 10) {
        this.endRow();
        i += 1;
        continue;
      }
      if (current === 13) {
        i += 1;
        continue;
      }

      // A quote may only open a field at position zero; otherwise the row is malformed.
      if (this.fieldParts.length === 0) {
        this.state = "quoted";
        i += 1;
        continue;
      }
      this.addFailure(
        this.rowPath(),
        "malformed_quote",
        "unexpected quote inside an unquoted field",
      );
      this.aborted = true;
      return this.emitted;
    }

    return this.emitted;
  }

  /** Finalize parsing; throws `DatasetParseError` when any failure was recorded. */
  finish(): void {
    if (this.aborted) throw new DatasetParseError(this.failures);
    if (!this.headerSeen) {
      this.addFailure(
        "row 1",
        "missing_header",
        `missing header row; expected columns ${DATASET_COLUMNS.join(", ")}`,
      );
    } else if (this.state === "quoted") {
      this.addFailure(
        this.rowPath(),
        "unterminated_quote",
        "quoted field is not closed before end of input",
      );
    } else if (this.state !== "field" || this.fieldParts.length > 0 || this.rowFields.length > 0) {
      // Final row without a trailing newline.
      this.endRow();
    }
    if (this.failures.length > 0) throw new DatasetParseError(this.failures);
  }

  private rowPath(): string {
    return `row ${this.completedRows + 1}`;
  }

  private addFailure(path: string, code: string, message: string): void {
    if (this.failures.length >= this.options.maxFailures) {
      this.aborted = true;
      return;
    }
    this.failures.push({ path, code, message });
    if (this.failures.length >= this.options.maxFailures) this.aborted = true;
  }

  private endField(): void {
    const value = this.fieldParts.join("");
    this.fieldParts.length = 0;
    this.state = "field";
    if (value.length > this.options.maxFieldChars) {
      this.addFailure(
        this.rowPath(),
        "field_too_large",
        `field exceeds the ${this.options.maxFieldChars}-character limit`,
      );
      this.aborted = true;
    }
    this.rowFields.push(value);
  }

  private endRow(): void {
    this.endField();
    this.state = "field";
    const row = this.completedRows + 1;
    const path = `row ${row}`;
    const fields = this.rowFields.splice(0, this.rowFields.length);

    if (!this.headerSeen) {
      this.headerSeen = true;
      const header = fields.map((field, index) =>
        index === 0 ? field.replace(/^\uFEFF/, "") : field,
      );
      const matches =
        header.length === DATASET_COLUMNS.length &&
        DATASET_COLUMNS.every((column, index) => header[index] === column);
      if (!matches) {
        this.addFailure(
          path,
          "invalid_header",
          `expected columns ${DATASET_COLUMNS.join(", ")}; found ${header.join(", ") || "<empty>"}`,
        );
        this.aborted = true;
      }
      this.completedRows = row;
      return;
    }

    if (fields.length === 1 && (fields[0] ?? "").trim() === "") {
      this.completedRows = row; // blank line
      return;
    }

    if (this.fixtureIds.size >= this.options.maxRecords) {
      this.addFailure(
        path,
        "dataset_too_large",
        `dataset exceeds the ${this.options.maxRecords}-fixture parse limit`,
      );
      this.aborted = true;
      this.completedRows = row;
      return;
    }

    const record = this.acceptRecord(fields, path);
    this.completedRows = row;
    if (record !== null) this.emitted.push(record);
  }

  private acceptRecord(fields: readonly string[], path: string): FixtureRecord | null {
    const before = this.failures.length;

    if (fields.length !== DATASET_COLUMNS.length) {
      this.addFailure(
        path,
        "invalid_columns",
        `expected ${DATASET_COLUMNS.length} columns; found ${fields.length}`,
      );
      return null;
    }

    const rawIndex = fields[0] ?? "";
    const rawQuestion = fields[1] ?? "";
    const rawAnswer = fields[2] ?? "";
    const rawCategory = fields[3] ?? "";
    const rawL2Category = fields[4] ?? "";
    const rawBench = fields[5] ?? "";
    const rawImage = fields[6] ?? "";

    if (!INDEX_REGEX.test(rawIndex)) {
      this.addFailure(
        path,
        "invalid_index",
        `index ${JSON.stringify(rawIndex)} must be a non-negative integer without leading zeros`,
      );
    } else if (this.fixtureIds.has(rawIndex)) {
      this.addFailure(path, "duplicate_fixture", `duplicate fixture ID "${rawIndex}"`);
    }

    if (rawQuestion.trim() === "") {
      this.addFailure(path, "missing_field", "question must not be empty");
    } else if (rawQuestion.length > this.options.maxQuestionChars) {
      this.addFailure(
        path,
        "question_too_large",
        `question exceeds the ${this.options.maxQuestionChars}-character limit`,
      );
    }

    const answer = rawAnswer.trim().toUpperCase();
    if (!ANSWER_REGEX.test(answer)) {
      this.addFailure(
        path,
        "invalid_answer",
        `answer ${JSON.stringify(rawAnswer)} must be a single option letter`,
      );
    }

    const category = rawCategory.trim();
    if (category === "") this.addFailure(path, "missing_field", "category must not be empty");
    const l2Category = rawL2Category.trim();
    if (l2Category === "") this.addFailure(path, "missing_field", "l2_category must not be empty");
    const bench = rawBench.trim();
    if (bench === "") this.addFailure(path, "missing_field", "bench must not be empty");

    const image = inspectImageBase64(rawImage, this.options.maxImageBytes);
    if ("message" in image) {
      this.addFailure(path, "invalid_image", image.message);
    }

    if (this.failures.length !== before) return null;

    this.fixtureIds.add(rawIndex);
    return {
      fixtureId: rawIndex,
      index: Number(rawIndex),
      question: rawQuestion,
      answer,
      category,
      l2Category,
      bench,
      image: (image as { image: FixtureImage }).image,
    };
  }
}

function inspectImageBase64(
  value: string,
  maxImageBytes: number,
): { image: FixtureImage } | { message: string } {
  if (value.startsWith("data:")) {
    return { message: "image must be raw base64 bytes, not a data URI" };
  }
  if (value === "") return { message: "image must not be empty" };
  if (value.length % 4 !== 0 || !BASE64_REGEX.test(value)) {
    return { message: "image is not valid base64" };
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const byteLength = (value.length / 4) * 3 - padding;
  if (byteLength > maxImageBytes) {
    return { message: `decoded image is ${byteLength} bytes; limit is ${maxImageBytes}` };
  }
  if (value.length < IMAGE_HEAD_CHARS) {
    return { message: "decoded image is too short to contain a supported image header" };
  }

  const head = atob(value.slice(0, IMAGE_HEAD_CHARS));
  const byte = (index: number): number => head.charCodeAt(index);
  let mediaType: ImageMediaType | null = null;
  if (byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff) {
    mediaType = "image/jpeg";
  } else if (
    byte(0) === 0x89 &&
    byte(1) === 0x50 &&
    byte(2) === 0x4e &&
    byte(3) === 0x47 &&
    byte(4) === 0x0d &&
    byte(5) === 0x0a &&
    byte(6) === 0x1a &&
    byte(7) === 0x0a
  ) {
    mediaType = "image/png";
  } else if (
    byte(0) === 0x52 &&
    byte(1) === 0x49 &&
    byte(2) === 0x46 &&
    byte(3) === 0x46 &&
    byte(8) === 0x57 &&
    byte(9) === 0x45 &&
    byte(10) === 0x42 &&
    byte(11) === 0x50
  ) {
    mediaType = "image/webp";
  }

  if (mediaType === null) {
    return { message: "unsupported image format; expected JPEG, PNG, or WebP" };
  }
  return { image: { mediaType, base64: value, byteLength } };
}

/** Convert a fixture into the answer-free projection sent to providers. */
export function toPromptFixture(fixture: FixtureRecord): PromptFixtureInput {
  return {
    fixtureId: fixture.fixtureId,
    question: fixture.question,
    image: {
      mediaType: fixture.image.mediaType,
      base64: fixture.image.base64,
    },
  };
}

export function summarizeDataset(fixtures: readonly FixtureRecord[]): DatasetSummary {
  return {
    fixtureCount: fixtures.length,
    categories: countBy(fixtures, (fixture) => fixture.category),
    l2Categories: countBy(fixtures, (fixture) => fixture.l2Category),
    benches: countBy(fixtures, (fixture) => fixture.bench),
    imageMediaTypes: countBy(fixtures, (fixture) => fixture.image.mediaType),
  };
}

function countBy(
  fixtures: readonly FixtureRecord[],
  key: (fixture: FixtureRecord) => string,
): DatasetCount[] {
  const counts = new Map<string, number>();
  for (const fixture of fixtures) {
    const name = key(fixture);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, count]) => ({ name, count }));
}

/** Parse a complete dataset string; convenience wrapper over `DatasetTsvParser`. */
export function parseDatasetTsv(
  text: string,
  options: Partial<DatasetParseOptions> = {},
): ParsedDataset {
  const parser = new DatasetTsvParser(options);
  const fixtures = parser.push(text);
  parser.finish();
  return { fixtures, summary: summarizeDataset(fixtures) };
}
