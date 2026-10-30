import type { WorkID } from "../../xuanwu/coreDomainContracts.ts";

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function issueIDToWorkID(issueID: number): WorkID {
  if (!Number.isSafeInteger(issueID) || issueID <= 0) throw new Error("issue id must be a positive integer");
  return `xw:work:issues:${issueID}`;
}

export function workIDToIssueID(workID: string): number {
  const match = /^xw:work:issues:([1-9][0-9]*)$/.exec(workID);
  if (!match) throw new Error(`${workID} is not a canonical Issue-backed Work id`);
  const issueID = Number(match[1]);
  if (!Number.isSafeInteger(issueID)) throw new Error(`${workID} is not a canonical Issue-backed Work id`);
  return issueID;
}
