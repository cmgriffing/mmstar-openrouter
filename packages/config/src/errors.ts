/**
 * Validation issue and error contracts.
 *
 * Issues are plain data with a stable machine-readable code and an actionable
 * message so CLI output, tests, and future UI can render them without parsing
 * prose. `path` uses dot/bracket notation (`models.gpt.reasoningModes[1]`), or
 * "" for the document root.
 */
export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export class ValidationError extends Error {
  readonly source: string;
  readonly issues: readonly ValidationIssue[];

  constructor(source: string, issues: readonly ValidationIssue[]) {
    super(formatValidationIssues(source, issues));
    this.name = "ValidationError";
    this.source = source;
    this.issues = issues;
  }
}

export function formatValidationIssues(source: string, issues: readonly ValidationIssue[]): string {
  const count = issues.length === 1 ? "1 validation issue" : `${issues.length} validation issues`;
  const lines = [`${source}: ${count}`];
  for (const issue of issues) {
    lines.push(`  ${issue.path === "" ? "<root>" : issue.path}: ${issue.message} [${issue.code}]`);
  }
  return lines.join("\n");
}
