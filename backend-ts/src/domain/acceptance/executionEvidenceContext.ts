import { createHash, createHmac, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { release } from "node:os";
import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";

export const EXECUTION_EVIDENCE_CONTEXT_EVENT = "issue.execution_evidence_context.v1";
// 重启后不猜测环境仍相同；HMAC 也避免把环境变量或低熵配置明文写到账本。
const hostKey = randomBytes(32);
export type ExecutionEvidenceContext = {
  scope: "repository_and_host";
  project_id: string;
  work_id: string;
  repository: string;
  input_fingerprint: string;
  environment_fingerprint: string;
};

export function captureExecutionEvidenceContext(db: RunnerDatabase, issueID: number): ExecutionEvidenceContext | null {
  const issue = getIssue(db, issueID);
  const project = issue && getProject(db, issue.project_id);
  if (!issue || !project) return null;
  let repository: string;
  try { repository = realpathSync(project.cwd); } catch { return null; }
  const profile = issue.agent_profile_id || project.default_agent_profile_id;
  const profileRow = profile ? db.sqlite.query("select * from agent_profiles where id=?").get(profile) : null;
  if (profile && !profileRow) return null;
  const humanInput = db.sqlite.query<{ id: number; payload: string }, [number]>(`
    select id,payload from issue_events where issue_id=? and type in
      ('issue.comment','issue.human_review_answered.v1') order by id desc limit 1
  `).get(issueID);
  return {
    scope: "repository_and_host", project_id: project.id, work_id: `xw:work:issues:${issueID}`, repository,
    input_fingerprint: digest({ title: issue.title, description: issue.description, source_excerpt: issue.source_excerpt,
      source_session_id: issue.source_session_id, source_turn_id: issue.source_turn_id,
      workflow: issue.workflow_snapshot_json, human_input: humanInput }),
    environment_fingerprint: createHmac("sha256", hostKey).update(stableJson({
      env: process.env, platform: process.platform, arch: process.arch, release: release(),
      versions: process.versions, executable: process.execPath, repository,
      provider: project.provider, config: project.provider_config_json, profile: profileRow,
      model: project.model, approval: project.approval_policy, sandbox: project.sandbox,
      policy: project.execution_policy_json, skills: [project.default_skill_policy, issue.required_skill_intents, issue.recommended_skill_intents],
      mcp: [project.default_mcp_policy, issue.required_mcp_capabilities, issue.recommended_mcp_capabilities],
      tier: issue.service_tier || project.default_service_tier
    })).digest("hex")
  };
}

export function recordExecutionEvidenceContext(db: RunnerDatabase, issueID: number, runID: string,
  phase: "start" | "terminal", context = captureExecutionEvidenceContext(db, issueID)): void {
  recordIssueEvent(db, issueID, EXECUTION_EVIDENCE_CONTEXT_EVENT, { run_id: runID, phase, context });
}

export function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
