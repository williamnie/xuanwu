import type { RunnerDatabase } from "../db/database.ts";
import { listPiMemoryItems } from "../db/repositories/pi.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { ProjectFindingCategory } from "./projectFindings.ts";

export type FailurePatternMatch = {
  category: ProjectFindingCategory;
  recommendation: string;
};

type FailurePattern = FailurePatternMatch & { match: string };

const VALID_CATEGORIES = new Set(["blocked", "needs_user", "transient", "verification_needed"]);

export function matchFailurePattern(db: RunnerDatabase, projectID: string, detail: string): FailurePatternMatch | undefined {
  const text = detail.toLowerCase();
  if (text === "") return undefined;
  return loadFailurePatterns(db, projectID).find((pattern) => text.includes(pattern.match.toLowerCase()));
}

function loadFailurePatterns(db: RunnerDatabase, projectID: string): FailurePattern[] {
  return [
    ...listPiMemoryItems(db, { disabled: 0, scope: "project", scopeId: projectID }),
    ...listPiMemoryItems(db, { disabled: 0, scope: "global" })
  ].filter((item) => item.kind === "failure_pattern").flatMap((item) => parseFailurePattern(item.content));
}

function parseFailurePattern(content: string): FailurePattern[] {
  const parsed = parseJsonObject(content);
  if (!parsed) return [{ match: content.trim(), category: "blocked", recommendation: "Review known failure pattern before retrying." }];
  const match = cleanString(parsed.match || parsed.pattern || parsed.needle);
  if (match === "") return [];
  return [{
    match,
    category: categoryValue(parsed.category),
    recommendation: redactSensitiveText(cleanString(parsed.recommendation || parsed.action || parsed.note))
  }];
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(content) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function categoryValue(value: unknown): ProjectFindingCategory {
  const text = cleanString(value);
  return VALID_CATEGORIES.has(text) ? text as ProjectFindingCategory : "blocked";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
