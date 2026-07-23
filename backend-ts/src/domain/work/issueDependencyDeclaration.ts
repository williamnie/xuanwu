const DEPENDENCY_HEADING = /^#{1,6}\s*(?:依赖|dependencies?)\s*$/i;
const NEXT_HEADING = /^#{1,6}\s+/;
const ISSUE_REFERENCE = /(?:\bIssue\s*)?#(\d+)\b/gi;
const NO_DEPENDENCY = /^(?:[-*]\s*)?(?:无|没有|none|n\/a|not applicable)[。.\s]*$/i;

export type IssueDependencyDeclaration = {
  error: string;
  issue_ids: number[];
  present: boolean;
};

export function normalizeIssueDependencyDeclaration(
  explicit: unknown,
  description: string
): IssueDependencyDeclaration {
  if (explicit !== undefined) {
    if (!Array.isArray(explicit)) {
      throw new Error("depends_on_issue_ids 必须是正整数数组");
    }
    return {
      error: "",
      issue_ids: uniquePositiveIssueIDs(explicit),
      present: true
    };
  }
  return parseIssueDependencyDeclaration(description);
}

export function parseIssueDependencyDeclaration(description: string): IssueDependencyDeclaration {
  const lines = description.replace(/\r\n?/g, "\n").split("\n");
  const headingIndex = lines.findIndex((line) => DEPENDENCY_HEADING.test(line.trim()));
  if (headingIndex < 0) return { error: "", issue_ids: [], present: false };
  const section: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (NEXT_HEADING.test(lines[index]!.trim())) break;
    section.push(lines[index]!);
  }
  const content = section.join("\n").trim();
  if (content === "" || content.split("\n").every((line) => line.trim() === "" || NO_DEPENDENCY.test(line.trim()))) {
    return { error: "", issue_ids: [], present: true };
  }
  const ids = [...content.matchAll(ISSUE_REFERENCE)].map((match) => Number.parseInt(match[1]!, 10));
  if (ids.length === 0) {
    return {
      error: "依赖章节存在，但没有可解析的 Issue #<id> 引用",
      issue_ids: [],
      present: true
    };
  }
  return { error: "", issue_ids: uniquePositiveIssueIDs(ids), present: true };
}

function uniquePositiveIssueIDs(values: unknown[]): number[] {
  const ids = values.map((value) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error("depends_on_issue_ids 必须只包含正整数");
    }
    return value;
  });
  return [...new Set(ids)].sort((left, right) => left - right);
}
