import type { Issue } from "../db/repositories/issues.ts";
import { redactSensitiveText } from "../util/redact.ts";

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export function issueReportSummary(issue: Issue): Record<string, unknown> {
  const sessionID = issue.codex_thread_id || issue.latest_run?.provider_session_id || issue.latest_run?.codex_thread_id || "";
  return {
    evidence_links: evidenceLinks(issue, sessionID),
    error: safeText(issue.error),
    id: issue.id,
    status: issue.status,
    title: safeText(issue.title),
    updated_at: issue.updated_at
  };
}

function evidenceLinks(issue: Issue, sessionID: string): Record<string, string> {
  return {
    audit: `/api/pi/audit-events?project_id=${encodeURIComponent(issue.project_id)}&issue_id=${issue.id}`,
    issue: `/api/issues/${issue.id}`,
    runs: `/api/issues/${issue.id}/runs`,
    ...(sessionID ? { session: `/api/sessions/codex:${encodeURIComponent(sessionID)}` } : {})
  };
}

function safeText(value: string): string {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}
