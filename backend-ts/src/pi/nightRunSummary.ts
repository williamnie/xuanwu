import type { IssueStateDiagnostic } from "./issueStateManager.ts";

export type NightRunIssueSummary = Record<string, unknown> & {
  error?: string; evidence_links?: Record<string, string>; id: number; status: string; title: string;
};

export type NightRunIssueCategories = {
  blocked: NightRunIssueSummary[];
  completed: NightRunIssueSummary[];
  failed: NightRunIssueSummary[];
  needs_user: NightRunIssueSummary[];
};

type NightRunSummaryInput = {
  allIssues: Array<Record<string, unknown>>;
  completedIssues: Array<Record<string, unknown>>;
  delegationID: string;
  diagnostics: IssueStateDiagnostic[];
  failedIssues: Array<Record<string, unknown>>;
  heartbeatIDs: string[];
  projectLabel: string;
  source: string;
  window: { since: string; until: string };
};

export function buildNightRunSummary(input: NightRunSummaryInput): {
  issue_categories: NightRunIssueCategories;
  summary_text_zh: string;
} {
  const issue_categories = categorizeIssues(input);
  return { issue_categories, summary_text_zh: chineseSummary(input, issue_categories) };
}

function categorizeIssues(input: NightRunSummaryInput): NightRunIssueCategories {
  const all = input.allIssues.map(toIssueSummary).filter(isIssueSummary);
  const completed = input.completedIssues.map(toIssueSummary).filter(isIssueSummary);
  const failed = input.failedIssues.map(toIssueSummary).filter(isIssueSummary);
  const severities = severitiesByIssue(input.diagnostics);
  return {
    blocked: all.filter((issue) => severities.get(issue.id)?.has("blocked")),
    completed,
    failed,
    needs_user: all.filter((issue) => severities.get(issue.id)?.has("needs_user"))
  };
}

function chineseSummary(input: NightRunSummaryInput, categories: NightRunIssueCategories): string {
  const total = input.allIssues.length;
  const lines = [
    `夜间执行总结：${input.projectLabel || "全部项目"}，窗口 ${input.window.since} 至 ${input.window.until}。`,
    `来源：${input.source || "manual"}；Delegation：${input.delegationID || "无"}；Heartbeat：${input.heartbeatIDs.join(", ") || "无"}。`
  ];
  if (total === 0) return [...lines, "本窗口无活动，生成空摘要。"].join("\n");
  lines.push(`结果：完成 ${categories.completed.length}，失败 ${categories.failed.length}，需用户 ${categories.needs_user.length}，阻塞 ${categories.blocked.length}，总计 ${total}。`);
  lines.push(...categoryLines("完成", categories.completed, false));
  lines.push(...categoryLines("失败", categories.failed, true));
  lines.push(...categoryLines("需用户", categories.needs_user, true));
  lines.push(...categoryLines("阻塞", categories.blocked, true));
  return lines.join("\n");
}

function categoryLines(label: string, issues: NightRunIssueSummary[], includeReason: boolean): string[] {
  if (issues.length === 0) return [`${label}：无。`];
  return [`${label}：`].concat(issues.map((issue) => `- ${issueLine(issue, includeReason)}`));
}

function issueLine(issue: NightRunIssueSummary, includeReason: boolean): string {
  const title = clean(issue.title) || `Issue ${issue.id}`;
  const reason = includeReason && clean(issue.error) ? `；原因：${clean(issue.error)}` : "";
  return `#${issue.id} ${title}${reason}；链接：${linksText(issue.evidence_links)}`;
}

function linksText(links: Record<string, string> | undefined): string {
  const entries = Object.entries(links ?? {}).filter(([, value]) => clean(value) !== "");
  if (entries.length === 0) return "无";
  return entries.map(([key, value]) => `${key}=${value}`).join("，");
}

function severitiesByIssue(diagnostics: IssueStateDiagnostic[]): Map<number, Set<IssueStateDiagnostic["severity"]>> {
  const map = new Map<number, Set<IssueStateDiagnostic["severity"]>>();
  for (const item of diagnostics) {
    const severities = map.get(item.issue_id) ?? new Set<IssueStateDiagnostic["severity"]>();
    severities.add(item.severity);
    map.set(item.issue_id, severities);
  }
  return map;
}

function toIssueSummary(value: Record<string, unknown>): NightRunIssueSummary | undefined {
  const id = typeof value.id === "number" && Number.isSafeInteger(value.id) ? value.id : 0;
  if (id <= 0) return undefined;
  return {
    ...value,
    error: clean(value.error),
    evidence_links: recordOfStrings(value.evidence_links),
    id,
    status: clean(value.status),
    title: clean(value.title)
  };
}

function isIssueSummary(value: NightRunIssueSummary | undefined): value is NightRunIssueSummary {
  return value !== undefined;
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clean(entry)]));
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
