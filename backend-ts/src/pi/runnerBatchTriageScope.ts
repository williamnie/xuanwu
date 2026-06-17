export type BatchTriageScopeKind = "all" | "issue_refs";
export type BatchTriageScope = {
  issueIds: number[];
  kind: BatchTriageScopeKind;
};

const MAX_PARSED_RANGE_SIZE = 50;
const ISSUE_RANGE_PATTERN = /#\s*(\d+)(?:\s*[-~～—–]\s*#?\s*(\d+))?/g;

export function parseBatchTriageScope(value: unknown, explicitIssueIds: unknown = undefined): BatchTriageScope {
  const inputIds = positiveUniqueIntegers(explicitIssueIds);
  if (inputIds.length > 1) return scope("issue_refs", inputIds);
  const issueIds = issueIdsFromPhrase(cleanString(value));
  if (issueIds.length > 1) return scope("issue_refs", issueIds);
  return scope("all", []);
}

function issueIdsFromPhrase(text: string): number[] {
  const ids: number[] = [];
  for (const match of text.matchAll(ISSUE_RANGE_PATTERN)) {
    ids.push(...issueIdsForMatch(match[1], match[2]));
  }
  return unique(ids);
}

function issueIdsForMatch(startValue: string | undefined, endValue: string | undefined): number[] {
  const start = positiveInteger(startValue);
  const end = positiveInteger(endValue);
  if (!start) return [];
  if (!end) return [start];
  const [from, to] = start <= end ? [start, end] : [end, start];
  if (to - from + 1 > MAX_PARSED_RANGE_SIZE) return [];
  return Array.from({ length: to - from + 1 }, (_unused, index) => from + index);
}

function positiveUniqueIntegers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return unique(value.map((item) => positiveInteger(item)).filter((item) => item > 0));
}

function positiveInteger(value: unknown): number {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : 0;
  const raw = Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
}

function unique(values: number[]): number[] {
  return [...new Set(values)];
}

function scope(kind: BatchTriageScopeKind, issueIds: number[]): BatchTriageScope {
  return { issueIds, kind };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
